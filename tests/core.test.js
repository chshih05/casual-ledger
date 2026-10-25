// 同步核心測試：用兩台「模擬裝置」和一個模擬雲端，驗證上傳、下載、離線補傳、
// 重試不重複、跨裝置衝突、刪除與資料完整性。
(() => {
  const Core = LedgerSyncCore;
  const { test, assert, eq } = T;

  function personalBook() {
    return {
      records: [], merchants: [], archivedMerchants: [], merchantTypes: {},
      preferences: { homeHeaderMode: 'expense_only', enableSaveAndNext: false },
      categories: [
        { id: 'cat_breakfast', type: 'expense', name: '早餐', icon: 'breakfast', order: 1 },
        { id: 'cat_dinner', type: 'expense', name: '晚餐', icon: 'dinner', order: 2 },
        { id: 'cat_daily', type: 'expense', name: '日用品', icon: 'daily', order: 3 },
        { id: 'cat_salary', type: 'income', name: '薪資', icon: 'salary', order: 1 },
        { id: 'cat_other_inc', type: 'income', name: '其他收入', icon: 'other', order: 2 },
      ],
    };
  }

  function device(cloud, name, initial = personalBook()) {
    let s = structuredClone(initial);
    let metaValue = null;
    const d = {
      clock: 1000,
      get state() { return s; },
      // 等同網頁的「儲存」：記錄變更時間
      commit(mutator) {
        const next = structuredClone(s);
        mutator(next);
        Core.stampTimes(s, next, d.clock);
        s = next;
      },
      link(uid = 'u1') {
        const m = Core.normalizeMeta(metaValue, 'dev_' + name);
        m.uid = uid;
        metaValue = m;
      },
      meta: () => metaValue,
      pending: () => Core.computePending(s, Core.normalizeMeta(metaValue, 'dev_' + name), d.clock),
      sync: () => d.engine.sync(),
    };
    d.engine = Core.createEngine({
      backend: cloud,
      ledger: {
        get: () => s,
        apply: mutator => { const next = structuredClone(s); mutator(next); s = next; return true; },
      },
      metaStore: {
        load: () => Core.normalizeMeta(structuredClone(metaValue), 'dev_' + name),
        save: m => { metaValue = structuredClone(m); return true; },
      },
      now: () => d.clock,
      pageSize: 50,
    });
    d.link();
    return d;
  }

  const rec = (id, extra = {}) => Object.assign({ id, seq: 1, type: 'expense', date: '2026-10-24', categoryId: 'cat_dinner', amount: 185, merchant: '麥當勞', note: '大麥克套餐' }, extra);
  const addRecord = (dev, r) => dev.commit(s => {
    s.records.push(r);
    if (r.merchant && !s.merchants.includes(r.merchant)) { s.merchants.push(r.merchant); s.merchantTypes[r.merchant] = r.type; }
  });
  const find = (dev, id) => dev.state.records.find(r => r.id === id);

  function checkInvariants(s) {
    const cats = new Map(s.categories.map(c => [c.id, c]));
    for (const r of s.records) {
      assert(cats.has(r.categoryId), `紀錄 ${r.id} 找不到分類 ${r.categoryId}`);
      eq(cats.get(r.categoryId).type, r.type, `紀錄 ${r.id} 的分類類型不符`);
      if (r.merchant) assert(s.merchants.includes(r.merchant), `店家清單缺少「${r.merchant}」`);
    }
    for (const type of ['expense', 'income']) assert(s.categories.some(c => c.type === type), `缺少${type}分類`);
  }

  test('核心｜內容雜湊固定，且不會與刪除代號相同', () => {
    eq(Core.hashString('abc'), Core.hashString('abc'));
    assert(Core.hashString('abc') !== Core.hashString('abd'), '不同內容應有不同雜湊');
    assert(Core.hashString('').startsWith('h'), '雜湊應以 h 開頭');
  });

  test('核心｜只記錄真正改變的項目時間，刪除也記錄時間', () => {
    const before = personalBook();
    before.records.push(rec('rec_a'), rec('rec_b', { amount: 50 }));
    const next = structuredClone(before);
    next.records[0].amount = 190;
    next.records.splice(1, 1);
    Core.stampTimes(before, next, 5000);
    eq(next.entityTimes['rec:rec_a'], 5000, '修改的紀錄要記時間');
    eq(next.entityTimes['rec:rec_b'], 5000, '刪除的紀錄要記時間');
    eq(next.entityTimes['cat:cat_dinner'], undefined, '沒變的分類不應記時間');
  });

  test('核心｜匯入時指定的原始時間會保留', () => {
    const before = personalBook();
    const next = structuredClone(before);
    next.records.push(rec('rec_old'));
    next.entityTimes = { 'rec:rec_old': 0 };
    Core.stampTimes(before, next, 9000);
    eq(next.entityTimes['rec:rec_old'], 0);
  });

  test('核心｜A 裝置記帳後，B 裝置可讀到同一本帳本', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    addRecord(a, rec('rec_1a'));
    a.commit(s => { s.preferences.homeHeaderMode = 'full_net'; });
    await a.sync();
    eq(a.pending().length, 0, 'A 上傳後不應有待同步');
    await b.sync();
    eq(find(b, 'rec_1a').amount, 185);
    eq(b.state.merchants, ['麥當勞']);
    eq(b.state.preferences.homeHeaderMode, 'full_net');
    eq(b.pending().length, 0, 'B 下載後不應有待同步');
    checkInvariants(b.state);
  });

  test('核心｜離線時保留待同步資料，恢復連線後補傳', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    await a.sync();
    cloud.offline = true;
    addRecord(a, rec('rec_off', { amount: 85 + 35 }));
    let failed = null;
    try { await a.sync(); } catch (e) { failed = e; }
    eq(cloud.classify(failed), 'offline', '離線時應回報離線');
    assert(a.pending().some(p => p.key === 'rec:rec_off'), '離線時紀錄應仍在待同步');
    cloud.offline = false;
    await a.sync();
    eq(a.pending().length, 0);
    await b.sync();
    eq(find(b, 'rec_off').amount, 120);
  });

  test('核心｜已寫入但回應遺失時重試，不會產生重複資料', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A');
    addRecord(a, rec('rec_retry'));
    cloud.dropAckNext = true;
    let failed = false;
    try { await a.sync(); } catch { failed = true; }
    assert(failed, '第一次應回報逾時');
    const writes = cloud.writes;
    await a.sync();
    eq(cloud.writes, writes, '重試不應再次寫入相同內容');
    eq(cloud.live('rec').length, 1, '雲端只應有一筆');
    eq(a.pending().length, 0);
  });

  test('核心｜修改與刪除會同步到其他裝置，雲端保留刪除前內容', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    addRecord(a, rec('rec_x'));
    await a.sync(); await b.sync();
    a.clock = 2000;
    a.commit(s => { s.records[0].amount = 200; });
    await a.sync(); await b.sync();
    eq(find(b, 'rec_x').amount, 200, '修改應同步');
    a.clock = 3000;
    a.commit(s => { s.records = []; });
    await a.sync(); await b.sync();
    eq(find(b, 'rec_x'), undefined, '刪除應同步');
    const doc = cloud.docs.get('rec:rec_x');
    assert(doc.del && doc.d.amount === 200, '雲端刪除紀錄應保留最後內容');
  });

  test('核心｜兩台都改同一筆：保留較新的修改，另一版本留在衝突紀錄', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    addRecord(a, rec('rec_c'));
    await a.sync(); await b.sync();
    a.clock = 2000; a.commit(s => { s.records[0].note = 'A 的備註'; });
    b.clock = 3000; b.commit(s => { s.records[0].note = 'B 的備註（較新）'; });
    await a.sync();
    await b.sync();
    await a.sync();
    eq(find(a, 'rec_c').note, 'B 的備註（較新）');
    eq(find(b, 'rec_c').note, 'B 的備註（較新）');
    const conflicts = b.meta().conflicts;
    eq(conflicts.length, 1, 'B 應記錄一筆衝突');
    eq(conflicts[0].other.data.note, 'A 的備註', '被取代的版本應保留');
    eq(a.pending().length + b.pending().length, 0);
  });

  test('核心｜先同步的一方若修改較新，仍以較新的為準', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    addRecord(a, rec('rec_d'));
    await a.sync(); await b.sync();
    a.clock = 5000; a.commit(s => { s.records[0].amount = 500; });
    b.clock = 3000; b.commit(s => { s.records[0].amount = 300; });
    await b.sync();
    await a.sync();
    await b.sync();
    eq(find(a, 'rec_d').amount, 500);
    eq(find(b, 'rec_d').amount, 500);
  });

  test('核心｜一台刪除、一台修改：依時間決定，被捨棄的版本可找回', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    addRecord(a, rec('rec_e'));
    await a.sync(); await b.sync();
    a.clock = 4000; a.commit(s => { s.records = []; });
    b.clock = 3000; b.commit(s => { s.records[0].amount = 999; });
    await a.sync(); await b.sync(); await a.sync();
    eq(find(a, 'rec_e'), undefined);
    eq(find(b, 'rec_e'), undefined);
    eq(b.meta().conflicts[0].other.data.amount, 999, '修改的版本應留在衝突紀錄');
  });

  test('核心｜兩台做了相同修改，不算衝突', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    addRecord(a, rec('rec_same'));
    await a.sync(); await b.sync();
    a.clock = 2000; a.commit(s => { s.records[0].amount = 150; });
    b.clock = 2500; b.commit(s => { s.records[0].amount = 150; });
    await a.sync(); await b.sync();
    eq(b.meta().conflicts.length, 0);
    eq(b.pending().length, 0);
  });

  test('核心｜分類在另一台被刪除但仍有紀錄使用時，自動保留分類', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    await a.sync(); await b.sync();
    a.clock = 2000; a.commit(s => { s.categories = s.categories.filter(c => c.id !== 'cat_daily'); });
    b.clock = 2500; addRecord(b, rec('rec_daily', { categoryId: 'cat_daily', merchant: '好市多', note: '衛生紙' }));
    await a.sync(); await b.sync(); await a.sync();
    for (const d of [a, b]) {
      checkInvariants(d.state);
      assert(d.state.categories.some(c => c.id === 'cat_daily' && c.name === '日用品'), '分類應以原名稱保留');
      assert(find(d, 'rec_daily'), '紀錄應存在');
    }
  });

  test('核心｜兩台各刪掉最後的收入分類時，自動補回一個收入分類', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    await a.sync(); await b.sync();
    a.commit(s => { s.categories = s.categories.filter(c => c.id !== 'cat_salary'); });
    b.commit(s => { s.categories = s.categories.filter(c => c.id !== 'cat_other_inc'); });
    await a.sync(); await b.sync(); await a.sync();
    checkInvariants(a.state);
    checkInvariants(b.state);
  });

  test('核心｜店家改名與另一台的離線新紀錄同時發生，資料仍完整', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    addRecord(a, rec('rec_m1', { merchant: '7-11' }));
    await a.sync(); await b.sync();
    a.clock = 2000;
    a.commit(s => {
      s.records.forEach(r => { if (r.merchant === '7-11') r.merchant = '7-ELEVEN'; });
      s.merchants = s.merchants.map(m => (m === '7-11' ? '7-ELEVEN' : m));
      s.merchantTypes['7-ELEVEN'] = 'expense';
      delete s.merchantTypes['7-11'];
    });
    b.clock = 2500; addRecord(b, rec('rec_m2', { merchant: '7-11', amount: 45 }));
    await a.sync(); await b.sync(); await a.sync();
    for (const d of [a, b]) checkInvariants(d.state);
    eq(find(b, 'rec_m1').merchant, '7-ELEVEN');
    eq(find(a, 'rec_m2').merchant, '7-11');
  });

  test('核心｜示例資料永遠不會上傳', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A');
    addRecord(a, rec('rec_3', { note: '示例' }));
    addRecord(a, rec('rec_real'));
    await a.sync();
    assert(!cloud.docs.has('rec:rec_3'), '示例紀錄 rec_3 不應上傳');
    assert(cloud.docs.has('rec:rec_real'), '一般紀錄應上傳');
  });

  test('核心｜一次大量刪除會先暫停上傳刪除，確認後才同步', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    for (let i = 0; i < 50; i++) addRecord(a, rec(`rec_bulk_${i}`, { amount: 100 + i }));
    await a.sync(); await b.sync();
    a.clock = 5000;
    a.commit(s => { s.records = s.records.slice(30); });
    addRecord(a, rec('rec_after', { amount: 77 }));
    const result = await a.sync();
    eq(result.heldDeletes, 30, '應暫停 30 筆刪除');
    await b.sync();
    eq(b.state.records.length, 51, 'B 不應被刪除，但應收到新紀錄');
    a.meta().bulkAck = { count: 30, until: a.clock + 60000 }; // 等同使用者按下「確認刪除並同步」
    const r2 = await a.sync();
    eq(r2.heldDeletes, 0, '確認後不再暫停');
    await b.sync();
    eq(b.state.records.length, 21);
  });

  test('核心｜新裝置加入時，預設分類不會覆蓋雲端已改名的分類', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A');
    a.clock = 2000;
    a.commit(s => { s.categories.find(c => c.id === 'cat_dinner').name = '晚飯'; });
    await a.sync();
    const b = device(cloud, 'B');
    await b.sync();
    eq(b.state.categories.find(c => c.id === 'cat_dinner').name, '晚飯');
    eq(b.meta().conflicts.length, 0, '未修改過的預設值不算衝突');
    await a.sync();
    eq(a.state.categories.find(c => c.id === 'cat_dinner').name, '晚飯');
  });

  test('核心｜大量資料分頁下載完整', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A');
    a.commit(s => {
      for (let i = 0; i < 130; i++) s.records.push(rec(`rec_page_${i}`, { amount: i + 1 }));
      s.merchants.push('麥當勞'); s.merchantTypes['麥當勞'] = 'expense';
    });
    await a.sync();
    const b = device(cloud, 'B');
    await b.sync();
    eq(b.state.records.length, 130);
    eq(b.pending().length, 0);
  });

  test('核心｜分頁讀取途中同一筆又被修改，只採用最新版本且不算衝突', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A');
    addRecord(a, rec('rec_p0', { amount: 100 }));
    await a.sync();
    cloud.put('rec:rec_p0', rec('rec_p0', { amount: 200 }), { t: 2000 });
    for (let i = 1; i <= 60; i++) cloud.put(`rec:rec_p${i}`, rec(`rec_p${i}`, { amount: i }));
    const pull = cloud.pull;
    let first = true;
    cloud.pull = async options => {
      const page = await pull(options);
      if (first) { first = false; cloud.put('rec:rec_p0', rec('rec_p0', { amount: 300 }), { t: 3000 }); }
      return page;
    };
    await a.sync();
    cloud.pull = pull;
    eq(find(a, 'rec_p0').amount, 300);
    eq(a.meta().conflicts.length, 0, '不應誤判為衝突');
    eq(a.pending().length, 0);
  });

  test('核心｜格式錯誤的雲端資料會略過，其餘照常套用', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A');
    cloud.put('rec:rec_bad', rec('rec_bad', { amount: -5 }));
    cloud.put('rec:rec_ok', rec('rec_ok'));
    cloud.put('mer:麥當勞', { name: '麥當勞', type: 'expense', archived: false });
    await a.sync();
    assert(!find(a, 'rec_bad'), '錯誤資料不應套用');
    assert(find(a, 'rec_ok'), '正確資料應套用');
    eq(a.meta().skipped, 1);
  });

  test('核心｜重新從頭讀取雲端不會造成變動或衝突', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A'), b = device(cloud, 'B');
    addRecord(a, rec('rec_again'));
    await a.sync(); await b.sync();
    const before = JSON.stringify(b.state.records);
    const m = b.meta(); m.cursor = null;
    await b.sync();
    eq(JSON.stringify(b.state.records), before);
    eq(b.meta().conflicts.length, 0);
  });

  test('核心｜同步途中又有新變更，結束後會再同步一次', async () => {
    const cloud = createFakeCloud();
    const a = device(cloud, 'A');
    const push = cloud.push;
    let edited = false;
    cloud.push = async (changes, options) => {
      if (!edited) { edited = true; addRecord(a, rec('rec_during', { amount: 33 })); a.engine.sync(); }
      return push(changes, options);
    };
    addRecord(a, rec('rec_first'));
    await a.sync();
    cloud.push = push;
    eq(a.pending().length, 0, '同步中新增的紀錄也應上傳');
    assert(cloud.docs.has('rec:rec_during'));
  });
})();
