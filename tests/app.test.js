// 畫面測試：在 iframe 中開啟建置好的網頁（docs/index.html），模擬點擊與輸入。
// 測試只在本機測試網址執行，使用獨立的瀏覽器儲存空間，不會碰到正式帳本。
(() => {
  const { test, assert, eq, sleep, waitFor } = T;
  const PREFIX = 'minimal_expense_v3_';
  const APP_URL = '../docs/index.html?nosw';
  let frame = null;

  function clearStorage() {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  }

  function wrap(w) {
    const d = w.document;
    const $ = id => d.getElementById(id);
    const a = {
      w, d, $,
      ev: code => w.eval(code),
      click(target) {
        const el = typeof target === 'string' ? $(target) : target;
        assert(el, `找不到 ${target}`);
        el.click();
      },
      type(id, value) {
        const el = $(id);
        el.value = value;
        el.dispatchEvent(new w.Event('input', { bubbles: true }));
      },
      visible(target) {
        const el = typeof target === 'string' ? $(target) : target;
        return Boolean(el) && el.getClientRects().length > 0;
      },
      text: id => $(id).textContent.trim(),
      stored: (book = 'personal') => JSON.parse(w.localStorage.getItem(PREFIX + book) || 'null'),
      badge: () => $('syncText').textContent.trim(),
      sync: () => w.eval('LedgerSync.__test'),
    };
    return a;
  }

  async function openApp({ clear = true } = {}) {
    if (clear) clearStorage();
    if (frame) frame.remove();
    frame = document.createElement('iframe');
    frame.title = '受測網頁';
    document.getElementById('stage').appendChild(frame);
    await new Promise(resolve => { frame.onload = resolve; frame.src = `${APP_URL}&r=${Math.random()}`; });
    const w = frame.contentWindow;
    await waitFor(() => w.eval('typeof state === "object" && state !== null'));
    return wrap(w);
  }

  async function reloadApp() {
    await new Promise(resolve => { frame.onload = resolve; frame.contentWindow.location.reload(); });
    const w = frame.contentWindow;
    await waitFor(() => w.eval('typeof state === "object" && state !== null'));
    return wrap(w);
  }

  async function personalApp() {
    const a = await openApp();
    a.click('btnStartPersonal');
    eq(a.ev('book'), 'personal');
    return a;
  }

  function addRecord(a, { cat = 0, amount = '120', merchant = '', note = '', type = 'expense' } = {}) {
    a.click('btnOpenAddModal');
    if (type === 'income') a.click('modalTypeIncome');
    a.$('step1CategoryGrid').querySelectorAll('button')[cat].click();
    a.type('inputAmountExpr', amount);
    if (merchant) a.type('inputMerchantSearch', merchant);
    if (note) a.type('inputRecordNote', note);
    a.click('btnSaveRecord');
  }

  function backupFile(a, payload) {
    return new a.w.File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });
  }

  async function importBackup(a, payload, { replace = false } = {}) {
    await a.ev('prepareImport')(backupFile(a, payload));
    await waitFor(() => a.visible('modalDialog'), { message: '匯入確認視窗沒有出現' });
    const message = a.text('dialogMessage');
    a.$('dialogCheck').checked = replace;
    a.click('dialogBtnConfirm');
    await waitFor(() => !a.visible('modalDialog'));
    return message;
  }

  function defaultCategories(a) {
    return a.ev('getInitialState().categories');
  }

  async function linkWithFakeCloud(a, cloud, options = {}) {
    a.sync().useBackend(fakeBackendFactory(cloud, options));
    a.click('navBtnSettings');
    await waitFor(() => a.visible('btnSyncSignIn'), { message: '沒有出現登入按鈕' });
    a.click('btnSyncSignIn');
  }

  // ---------- 既有功能 ----------
  test('畫面｜開啟時是示例帳本，標示不同步；未設定同步時清楚說明只存本機', async () => {
    const a = await openApp();
    eq(a.badge(), '示例・不同步');
    a.click('btnStartPersonal');
    eq(a.badge(), '僅存本機');
    a.click('navBtnSettings');
    assert(a.text('syncSummary').includes('同步服務尚未設定'), a.text('syncSummary'));
    assert(!a.visible('btnSyncSignIn'), '未設定時不應出現登入按鈕');
  });

  test('畫面｜沒有 Firebase 設定時，即使留有舊的連結資料也只顯示「僅存本機」', async () => {
    let a = await personalApp();
    a.w.localStorage.setItem(PREFIX + 'personal_sync', JSON.stringify({ v: 1, uid: 'u1', email: 'me@example.com', shadow: {}, conflicts: [] }));
    a = await reloadApp();
    eq(a.badge(), '僅存本機');
    a.click('navBtnSettings');
    assert(a.text('syncSummary').includes('同步服務尚未設定'), a.text('syncSummary'));
    assert(a.text('backupIntro').includes('目前沒有雲端同步'), a.text('backupIntro'));
  });

  test('畫面｜首頁只顯示本月支出總額，最近紀錄依日期分組', async () => {
    const a = await openApp();
    assert(a.visible('homeTotalExpense'), '應顯示本月支出總額');
    assert(!a.visible('homeExtraSummary'), '預設不顯示收入與結餘');
    const groups = a.$('homeRecordList').children.length;
    assert(groups >= 2, '示例紀錄應依日期分成多組');
  });

  test('畫面｜記一筆：分類與金額在同一張卡片，且不預先選分類', async () => {
    const a = await personalApp();
    a.click('btnOpenAddModal');
    assert(a.$('step1CategorySection').contains(a.$('singleAmountBox')), '金額應在分類卡片內');
    eq(a.$('step1CategoryGrid').querySelectorAll('[aria-pressed="true"]').length, 0, '不應預選分類');
    a.$('step1CategoryGrid').querySelectorAll('button')[2].click();
    assert(a.visible('step1CategoryGrid'), '選完分類後分類仍持續顯示');
    eq(a.$('step1CategoryGrid').querySelectorAll('[aria-pressed="true"]').length, 1);
  });

  test('畫面｜沒選分類不能儲存', async () => {
    const a = await personalApp();
    a.click('btnOpenAddModal');
    a.type('inputAmountExpr', '100');
    a.click('btnSaveRecord');
    eq(a.text('recordFormError'), '請先選擇分類。');
    eq(a.stored(), null, '不應寫入帳本');
  });

  test('畫面｜用數字鍵盤輸入 85＋35，儲存為 120 元', async () => {
    const a = await personalApp();
    a.click('btnOpenAddModal');
    a.$('step1CategoryGrid').querySelectorAll('button')[2].click();
    for (const key of ['8', '5', '+', '3', '5']) a.d.querySelector(`#builtInKeypad [data-key="${key}"]`).click();
    eq(a.text('calcPreviewBadge'), '= NT$ 120');
    a.type('inputMerchantSearch', '麥當勞');
    a.type('inputRecordNote', '大麥克套餐');
    a.click('btnSaveRecord');
    const saved = a.stored().records;
    eq(saved.length, 1);
    eq([saved[0].amount, saved[0].merchant, saved[0].note], [120, '麥當勞', '大麥克套餐']);
    eq(a.text('toastBox'), '已儲存在此瀏覽器');
    eq(a.ev('state.activeView'), 'home');
  });

  test('畫面｜離開記帳頁直接捨棄未儲存內容', async () => {
    const a = await personalApp();
    a.click('btnOpenAddModal');
    a.$('step1CategoryGrid').querySelectorAll('button')[1].click();
    a.type('inputAmountExpr', '99');
    a.type('inputRecordNote', '還沒儲存');
    a.click('btnCloseRecordModal');
    eq(a.ev('state.activeView'), 'home');
    eq(a.stored(), null, '未儲存的內容不應寫入');
    a.click('btnOpenAddModal');
    eq(a.$('inputAmountExpr').value, '');
    eq(a.$('inputRecordNote').value, '');
    eq(a.$('step1CategoryGrid').querySelectorAll('[aria-pressed="true"]').length, 0);
  });

  test('畫面｜重新整理後不保留草稿，也不詢問恢復', async () => {
    let a = await personalApp();
    addRecord(a, { amount: '50' });
    a.click('btnOpenAddModal');
    a.$('step1CategoryGrid').querySelectorAll('button')[1].click();
    a.type('inputAmountExpr', '77');
    a = await reloadApp();
    eq(a.ev('state.activeView'), 'home');
    assert(!a.visible('modalDialog'), '不應詢問是否恢復草稿');
    eq(a.stored().records.length, 1, '只保留已儲存的紀錄');
    assert(!JSON.stringify(a.stored()).includes('"draft"'), '不應保存草稿');
    a.click('btnOpenAddModal');
    eq(a.$('inputAmountExpr').value, '');
  });

  test('畫面｜編輯既有紀錄後未儲存就離開，原紀錄保留', async () => {
    const a = await personalApp();
    addRecord(a, { amount: '150', merchant: '全聯' });
    a.click(a.d.querySelector('.record-item-btn'));
    eq(a.$('inputAmountExpr').value, '150');
    a.type('inputAmountExpr', '999');
    a.click('btnCloseRecordModal');
    eq(a.stored().records[0].amount, 150);
    eq(a.ev('state.records[0].amount'), 150);
  });

  test('畫面｜「儲存並再記一筆」在設定開啟後才出現', async () => {
    const a = await personalApp();
    a.click('btnOpenAddModal');
    assert(!a.visible('btnSaveAndNextRecord'), '預設不顯示');
    a.click('btnCloseRecordModal');
    a.click('navBtnSettings');
    a.click('toggleSaveAndNext');
    a.click('btnOpenAddModal');
    assert(a.visible('btnSaveAndNextRecord'), '開啟後應顯示');
    a.$('step1CategoryGrid').querySelectorAll('button')[0].click();
    a.type('inputAmountExpr', '60');
    a.click('btnSaveAndNextRecord');
    eq(a.ev('state.activeView'), 'record', '應留在記帳頁');
    eq(a.$('inputAmountExpr').value, '');
    eq(a.stored().records.length, 1);
  });

  test('畫面｜數字鍵盤可以收起與展開', async () => {
    const a = await personalApp();
    a.click('btnOpenAddModal');
    assert(a.visible('builtInKeypad'));
    a.click('btnToggleKeypad');
    assert(!a.visible('builtInKeypad'), '應收起');
    eq(a.text('btnToggleKeypad'), '展開數字鍵盤');
  });

  test('畫面｜收入顯示「收入來源」欄位', async () => {
    const a = await personalApp();
    a.click('btnOpenAddModal');
    a.click('modalTypeIncome');
    eq(a.text('merchantFieldLabel'), '收入來源');
  });

  // ---------- 資料層調整 ----------
  test('資料｜儲存時記錄每筆的修改時間，備份會帶上帳本類型與修改時間', async () => {
    const a = await personalApp();
    addRecord(a, { amount: '88' });
    const id = a.ev('state.records[0].id');
    assert(typeof a.ev(`state.entityTimes['rec:${id}']`) === 'number', '應記錄修改時間');
    const env = a.ev('backupEnvelope()');
    eq(env.book, 'personal');
    assert(typeof env.data.entityTimes[`rec:${id}`] === 'number', '備份應包含修改時間');
    eq(a.stored().entityTimes[`rec:${id}`], env.data.entityTimes[`rec:${id}`], '重新開啟後應保留修改時間');
  });

  test('資料｜未知的圖示代碼會保留（避免舊版裝置蓋掉新版圖示）', async () => {
    const a = await openApp();
    const cats = defaultCategories(a);
    cats[0].icon = 'future_icon_2027';
    const loaded = a.ev('validateBackup')({ records: [], categories: cats, merchants: [] });
    eq(loaded.categories[0].icon, 'future_icon_2027');
  });

  test('匯入｜合併：已有的不重複、排除示例資料、不刪除現有紀錄', async () => {
    const a = await personalApp();
    addRecord(a, { amount: '185', merchant: '麥當勞', note: '大麥克套餐' });
    const mine = a.ev('state.records[0]');
    const other = { id: 'rec_new_1', seq: 5, type: 'expense', date: '2026-10-20', categoryId: 'cat_daily', amount: 320, merchant: '好市多', note: '衛生紙' };
    const other2 = { id: 'rec_new_2', seq: 6, type: 'income', date: '2026-10-05', categoryId: 'cat_salary', amount: 52000, merchant: '公司薪轉', note: '' };
    const demo = { id: 'rec_3', seq: 103, type: 'expense', date: '2026-10-24', categoryId: 'cat_dinner', amount: 185, merchant: '麥當勞', note: '大麥克套餐' };
    const backup = { format: 'daily-ledger', version: 3, exportedAt: '2026-10-20T10:00:00.000Z', data: {
      records: [mine, other, other2, demo], categories: defaultCategories(a), merchants: ['麥當勞', '好市多', '公司薪轉', '家樂福', '星巴克'],
      merchantTypes: { 公司薪轉: 'income' }, archivedMerchants: [] } };
    const message = await importBackup(a, backup);
    assert(message.includes('新增 2 筆紀錄'), message);
    assert(message.includes('1 筆已在帳本中'), message);
    assert(message.includes('已排除 1 筆示例資料'), message);
    eq(a.ev('state.records.length'), 3);
    assert(!a.ev('state.records.some(r => r.id === "rec_3")'), '示例紀錄不應進入個人帳本');
    assert(a.ev('state.merchants.includes("家樂福")'), '自己新增的店家應匯入');
    assert(!a.ev('state.merchants.includes("星巴克")'), '沒有紀錄使用的示例店家不應匯入');
    eq(a.ev('state.merchantTypes["公司薪轉"]'), 'income');
    const again = await importBackup(a, backup);
    assert(again.includes('新增 0 筆紀錄'), again);
    eq(a.ev('state.records.length'), 3, '再次匯入不應重複');
  });

  test('匯入｜內容完全相同但代碼不同的紀錄視為重複', async () => {
    const a = await personalApp();
    addRecord(a, { amount: '65', merchant: '50嵐', note: '四季春' });
    const mine = a.ev('state.records[0]');
    const copy = Object.assign({}, mine, { id: 'rec_copy_from_other_phone' });
    const message = await importBackup(a, { records: [copy], categories: defaultCategories(a), merchants: ['50嵐'] });
    assert(message.includes('1 筆與現有紀錄'), message);
    eq(a.ev('state.records.length'), 1);
  });

  test('匯入｜示例帳本的備份不會把示例店家帶進個人帳本', async () => {
    const a = await openApp();
    const demoBackup = a.ev('backupEnvelope()');
    a.click('btnStartPersonal');
    const message = await importBackup(a, demoBackup);
    assert(message.includes('來自示例帳本'), message);
    eq(a.ev('state.records.length'), 0);
    eq(a.ev('state.merchants.length'), 0, '示例店家不應匯入');
  });

  test('匯入｜可改為完全取代（舊行為），並可還原匯入前帳本', async () => {
    const a = await personalApp();
    addRecord(a, { amount: '10' });
    addRecord(a, { amount: '20' });
    const only = { id: 'rec_only', seq: 1, type: 'expense', date: '2026-10-01', categoryId: 'cat_lunch', amount: 110, merchant: '', note: '' };
    const demo = { id: 'rec_1', seq: 101, type: 'expense', date: '2026-10-24', categoryId: 'cat_lunch', amount: 110, merchant: '', note: '便當' };
    await importBackup(a, { records: [only, demo], categories: defaultCategories(a), merchants: [] }, { replace: true });
    eq(a.ev('state.records.map(r => r.id)'), ['rec_only']);
    assert(a.visible('btnUndoImport') || a.$('btnUndoImport').classList.contains('hidden') === false, '應可還原');
    a.click('navBtnSettings');
    a.click('btnUndoImport');
    await waitFor(() => a.visible('modalDialog'));
    a.click('dialogBtnConfirm');
    await waitFor(() => a.ev('state.records.length') === 2, { message: '應還原為匯入前的 2 筆' });
  });

  test('匯入｜舊版備份（沒有外層格式）仍可匯入', async () => {
    const a = await personalApp();
    const legacy = { records: [{ id: 'rec_1700000000000', seq: 1, type: 'expense', date: '2026-09-30', categoryId: 'cat_dinner', amount: 240, merchant: '全聯', note: '火鍋料' }], categories: defaultCategories(a), merchants: ['全聯'] };
    const message = await importBackup(a, legacy);
    assert(message.includes('新增 1 筆紀錄'), message);
    eq(a.ev('state.records[0].id'), 'rec_1700000000000', '時間戳記代碼不是示例資料');
  });

  // ---------- 同步（模擬雲端） ----------
  test('同步畫面｜登入後自動上傳，狀態顯示已同步', async () => {
    const a = await personalApp();
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.badge() === '已同步', { message: `狀態：${a.badge()}` });
    assert(cloud.docs.has('pref:main') && cloud.docs.has('cat:cat_dinner'), '分類與偏好應上傳');
    assert(a.text('syncAccount').includes('me@example.com'));
    addRecord(a, { amount: '45', merchant: '全家' });
    eq(a.text('toastBox'), '已儲存，正在同步');
    await waitFor(() => cloud.live('rec').length === 1, { message: '紀錄應自動上傳' });
    await waitFor(() => a.badge() === '已同步');
  });

  test('同步畫面｜本機已有紀錄時，連結前先詢問，並可選擇先下載備份', async () => {
    const a = await personalApp();
    addRecord(a, { amount: '30' });
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.visible('modalDialog'), { message: '應詢問是否連結' });
    assert(a.text('dialogMessage').includes('1 筆紀錄'), a.text('dialogMessage'));
    assert(a.$('dialogCheck').checked, '預設勾選先下載備份');
    eq(cloud.pushCalls, 0, '確認前不應上傳');
    a.$('dialogCheck').checked = false;
    a.click('dialogBtnConfirm');
    await waitFor(() => cloud.live('rec').length === 1 && a.badge() === '已同步', { message: `狀態：${a.badge()}` });
  });

  test('同步畫面｜離線時顯示待同步，恢復連線後自動補傳', async () => {
    const a = await personalApp();
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.badge() === '已同步');
    a.click('navBtnHome');
    cloud.offline = true;
    addRecord(a, { amount: '85+35', merchant: '八方雲集' });
    await waitFor(() => a.badge().startsWith('待同步'), { message: `狀態：${a.badge()}` });
    assert(a.$('homeRecordList').textContent.includes('待同步'), '紀錄旁應標示待同步');
    eq(a.stored().records.length, 1, '已按儲存的紀錄必須保存在本機');
    cloud.offline = false;
    a.w.dispatchEvent(new a.w.Event('online'));
    await waitFor(() => a.badge() === '已同步', { message: `狀態：${a.badge()}` });
    assert(!a.$('homeRecordList').textContent.includes('待同步'), '同步後不應再標示');
    eq(cloud.live('rec')[0].d.amount, 120);
  });

  test('同步畫面｜重新開啟網頁後，待同步資料仍會補傳', async () => {
    let a = await personalApp();
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.badge() === '已同步');
    cloud.offline = true;
    addRecord(a, { amount: '70' });
    await waitFor(() => a.badge().startsWith('待同步'));
    a = await reloadApp();
    eq(a.stored().records.length, 1);
    cloud.offline = false;
    a.sync().useBackend(fakeBackendFactory(cloud, { signedIn: true }));
    await a.sync().start();
    await waitFor(() => cloud.live('rec').length === 1 && a.badge() === '已同步', { message: `狀態：${a.badge()}` });
  });

  test('同步畫面｜另一台裝置的變更會出現在畫面上', async () => {
    const a = await personalApp();
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.badge() === '已同步');
    a.click('navBtnHome');
    const today = a.ev('today()');
    cloud.put('rec:rec_from_pc', { id: 'rec_from_pc', seq: 1, type: 'expense', date: today, categoryId: 'cat_daily', amount: 320, merchant: '好市多', note: '衛生紙' });
    cloud.put('mer:好市多', { name: '好市多', type: 'expense', archived: false });
    await a.sync().sync();
    await waitFor(() => a.$('homeRecordList').textContent.includes('好市多'), { message: '應顯示電腦新增的紀錄' });
    eq(a.badge(), '已同步');
  });

  test('同步畫面｜不同帳號登入時停止同步，避免兩本帳本混在一起', async () => {
    const a = await personalApp();
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.badge() === '已同步');
    const pushes = cloud.pushCalls;
    a.sync().useBackend(fakeBackendFactory(cloud, { user: { uid: 'u2', email: 'other@example.com' }, signedIn: true }));
    await a.sync().start();
    addRecord(a, { amount: '12' });
    await sleep(1600);
    eq(a.badge(), '同步暫停');
    a.click('navBtnSettings');
    assert(a.text('syncSummary').includes('不同'), a.text('syncSummary'));
    eq(cloud.pushCalls, pushes, '不應上傳到另一個帳號');
  });

  test('同步畫面｜示例帳本即使已登入也不會上傳', async () => {
    const a = await personalApp();
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.badge() === '已同步');
    a.click('btnSwitchBook');
    eq(a.ev('book'), 'demo');
    const pushes = cloud.pushCalls;
    addRecord(a, { amount: '999' });
    await sleep(1600);
    eq(cloud.pushCalls, pushes, '示例帳本不應觸發上傳');
    eq(a.badge(), '示例・不同步');
    assert(!cloud.live('rec').some(d => d.d.amount === 999));
  });

  test('同步畫面｜雲端拒絕存取時顯示同步失敗與原因，資料仍留在本機', async () => {
    const a = await personalApp();
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.badge() === '已同步');
    cloud.failNext = 'permission-denied';
    addRecord(a, { amount: '64' });
    await waitFor(() => a.badge() === '同步失敗', { message: `狀態：${a.badge()}` });
    a.click('navBtnSettings');
    assert(a.text('syncError').includes('雲端拒絕存取'), a.text('syncError'));
    eq(a.stored().records.length, 1);
    a.click('btnSyncNow');
    await waitFor(() => a.badge() === '已同步', { message: '按立即同步後應恢復' });
  });

  test('同步畫面｜衝突時保留較新版本，可在設定改用另一版本', async () => {
    const a = await personalApp();
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.badge() === '已同步');
    addRecord(a, { amount: '100', note: '原本' });
    await waitFor(() => cloud.live('rec').length === 1 && a.badge() === '已同步', { message: `狀態：${a.badge()}` });
    const rec = a.ev('state.records[0]');
    cloud.offline = true;
    a.click(a.d.querySelector('.record-item-btn'));
    a.type('inputRecordNote', '手機改的');
    a.click('btnSaveRecord');
    await waitFor(() => a.badge().startsWith('待同步'));
    cloud.put(`rec:${rec.id}`, Object.assign({}, rec, { note: '電腦較晚改的' }), { t: Date.now() + 60000 });
    cloud.offline = false;
    await a.sync().sync();
    eq(a.ev('state.records[0].note'), '電腦較晚改的');
    a.click('navBtnSettings');
    await waitFor(() => a.visible('btnSyncConflicts'));
    a.click('btnSyncConflicts');
    assert(a.$('syncConflictList').textContent.includes('手機改的'), a.$('syncConflictList').textContent);
    a.click(a.$('syncConflictList').querySelector('button'));
    await waitFor(() => a.visible('modalDialog'));
    a.click('dialogBtnConfirm');
    await waitFor(() => a.ev('state.records[0].note') === '手機改的');
    await waitFor(() => cloud.live('rec')[0].d.note === '手機改的', { message: '改用的版本應同步到雲端' });
  });

  test('同步畫面｜一次刪除大量紀錄時先暫停，確認後才同步刪除', async () => {
    const a = await personalApp();
    const cloud = createFakeCloud();
    const records = Array.from({ length: 25 }, (_, i) => ({ id: `rec_many_${i}`, seq: i + 1, type: 'expense', date: '2026-10-10', categoryId: 'cat_lunch', amount: 100 + i, merchant: '', note: `第 ${i} 筆` }));
    await importBackup(a, { records, categories: defaultCategories(a), merchants: [] });
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.visible('modalDialog'));
    a.$('dialogCheck').checked = false;
    a.click('dialogBtnConfirm');
    await waitFor(() => cloud.live('rec').length === 25 && a.badge() === '已同步', { message: `狀態：${a.badge()}` });
    a.ev('commit(s => { s.records = s.records.slice(0, 2); })');
    await waitFor(() => a.badge() === '待確認刪除', { message: `狀態：${a.badge()}` });
    eq(cloud.live('rec').length, 25, '確認前雲端不應刪除');
    a.click('navBtnSettings');
    a.click('btnSyncConfirmDeletes');
    await waitFor(() => a.visible('modalDialog'));
    a.click('dialogBtnConfirm');
    await waitFor(() => cloud.live('rec').length === 2, { message: '確認後應同步刪除' });
  });
})();
