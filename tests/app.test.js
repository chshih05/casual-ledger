// 畫面測試：在 iframe 中開啟建置好的網頁（docs/index.html），模擬點擊與輸入。
// 測試只在本機測試網址執行，使用獨立的瀏覽器儲存空間，不會碰到正式帳本。
(() => {
  const { test, assert, eq, sleep, waitFor } = T;
  const PREFIX = 'minimal_expense_v3_';
  const APP_URL = '../docs/index.html?nosw&test';
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
  test('畫面｜開啟時直接是自己的帳本、沒有示例資料；未設定同步時清楚說明只存本機', async () => {
    const a = await openApp();
    eq(a.ev('state.records.length'), 0, '不應有示例紀錄');
    eq(a.ev('state.merchants.length'), 0, '不應有示例店家');
    assert(!a.$('btnStartPersonal') && !a.$('btnSwitchBook'), '不應再有切換示例帳本的按鈕');
    eq(a.badge(), '僅存本機');
    a.click('navBtnSettings');
    assert(a.text('syncSummary').includes('同步服務尚未設定'), a.text('syncSummary'));
    assert(!a.visible('btnSyncSignIn'), '未設定時不應出現登入按鈕');
  });

  test('畫面｜舊的示例帳本資料會被清除，自己的帳本保留', async () => {
    clearStorage();
    const personal = { records: [{ id: 'rec_keep_me', seq: 1, type: 'expense', date: '2026-10-01', categoryId: 'cat_lunch', amount: 90, merchant: '', note: '保留' }],
      categories: (await openApp()).ev('getInitialState().categories'), merchants: [] };
    localStorage.setItem(PREFIX + 'demo', JSON.stringify({ records: [], categories: personal.categories, merchants: ['麥當勞'] }));
    localStorage.setItem(PREFIX + 'demo_before_import', '{}');
    localStorage.setItem(PREFIX + 'active', 'demo');
    localStorage.setItem(PREFIX + 'personal', JSON.stringify(personal));
    const a = await openApp({ clear: false });
    for (const key of ['demo', 'demo_before_import', 'active']) eq(localStorage.getItem(PREFIX + key), null, `${key} 應已清除`);
    eq(a.ev('state.records.map(r => r.id)'), ['rec_keep_me']);
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
    const month = a.ev('today()').slice(0, 7);
    const day = d => ({ id: `rec_day_${d}`, seq: d, type: 'expense', date: `${month}-0${d}`, categoryId: 'cat_lunch', amount: 100 * d, merchant: '', note: '' });
    await importBackup(a, { records: [day(1), day(2)], categories: defaultCategories(a), merchants: [] });
    assert(a.visible('homeTotalExpense'), '應顯示本月支出總額');
    eq(a.text('homeTotalExpense'), '300');
    assert(!a.visible('homeExtraSummary'), '預設不顯示收入與結餘');
    eq(a.$('homeRecordList').children.length, 2, '兩天的紀錄應分成兩組');
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

  // ---------- 統計：按月與整年度 ----------
  function yearRecords(y) {
    const rec = (id, date, amount, categoryId = 'cat_lunch', type = 'expense') => ({ id, seq: 1, type, date, categoryId, amount, merchant: '', note: '' });
    return [
      rec('rec_y_jan', `${y}-01-15`, 100),
      rec('rec_y_mar1', `${y}-03-02`, 250, 'cat_dinner'),
      rec('rec_y_mar2', `${y}-03-20`, 50),
      rec('rec_y_dec', `${y}-12-31`, 1000, 'cat_transport'),
      rec('rec_prev_dec', `${y - 1}-12-31`, 7000),
      rec('rec_y_salary', `${y}-03-05`, 52000, 'cat_salary', 'income'),
    ];
  }

  async function statsApp() {
    const a = await personalApp();
    const y = Number(a.ev('today()').slice(0, 4));
    await importBackup(a, { records: yearRecords(y), categories: defaultCategories(a), merchants: [] });
    a.ev(`state.currentMonth = '${y}-03'`);
    a.click('navBtnStats');
    return { a, y };
  }

  test('統計｜切換整年度：合計整年（不含其他年份與收入），左右切換以年為單位', async () => {
    const { a, y } = await statsApp();
    eq(a.text('currentMonthLabel'), `${y} 年 3 月`);
    eq(a.text('statsTotalValue'), 'NT$ 300', '按月只算 3 月');
    assert(!a.visible('statsMonthlySection'), '按月時不顯示每月金額');
    a.click('statsPeriodYear');
    eq(a.text('currentMonthLabel'), `${y} 年`);
    eq(a.text('statsTotalTitle'), '全年總支出');
    eq(a.text('statsTotalValue'), 'NT$ 1,400', '整年不含去年與收入');
    eq(a.$('statsPeriodYear').getAttribute('aria-pressed'), 'true');
    eq(a.$('statsCategoryList').children.length, 3, '整年有三個分類');
    a.click('btnPrevMonth');
    eq(a.text('currentMonthLabel'), `${y - 1} 年`);
    eq(a.text('statsTotalValue'), 'NT$ 7,000');
    a.click('btnNextMonth');
    a.click('statsTabIncome');
    eq(a.text('statsTotalTitle'), '全年總收入');
    eq(a.text('statsTotalValue'), 'NT$ 52,000');
    a.click('navBtnHome');
    eq(a.text('currentMonthLabel'), `${y} 年 3 月`, '首頁仍按月顯示');
    assert(!a.visible('statsPeriodToggle'), '首頁不顯示月／年切換');
    eq(a.text('homeTotalExpense'), '300');
  });

  test('統計｜整年度列出 1～12 月金額，點月份回到該月統計', async () => {
    const { a, y } = await statsApp();
    a.click('statsPeriodYear');
    assert(a.visible('statsMonthlySection'), '整年度應顯示每月金額');
    const rows = [...a.$('statsMonthlyList').children].map(b => b.textContent.replace(/\s+/g, ' ').trim());
    eq(rows.length, 12);
    eq([rows[0], rows[1], rows[2], rows[11]], ['1 月 NT$ 100', '2 月 NT$ 0', '3 月 NT$ 300', '12 月 NT$ 1,000']);
    a.click(a.$('statsMonthlyList').children[11]);
    eq(a.ev('state.statsPeriod'), 'month');
    eq(a.text('currentMonthLabel'), `${y} 年 12 月`);
    eq(a.text('statsTotalValue'), 'NT$ 1,000');
    assert(!a.visible('statsMonthlySection'));
  });

  test('統計｜整年度明細：點分類列出這一年的紀錄', async () => {
    const { a, y } = await statsApp();
    a.click('statsPeriodYear');
    const lunch = [...a.$('statsCategoryList').children].find(b => b.textContent.includes('午餐'));
    a.click(lunch);
    assert(a.visible('modalDrilldown'));
    eq(a.$('drilldownList').children.length, 2, '1 月與 3 月的午餐，不含去年');
    assert(a.text('drilldownSubtitle').startsWith(`${y} 年・共 2 筆・合計 NT$ 150`), a.text('drilldownSubtitle'));
  });

  // ---------- 版本更新 ----------
  function fakeWorker() {
    const posted = [];
    return { posted, postMessage: m => posted.push(m) };
  }

  test('版本更新｜剛開啟還沒操作時，有新版本就直接更新', async () => {
    const a = await personalApp();
    const worker = fakeWorker();
    a.ev('LedgerUpdate.__test').offer(worker);
    eq(worker.posted, ['SKIP_WAITING'], '應直接換成新版本');
  });

  test('版本更新｜正在記帳時不打斷：顯示頂部更新按鈕，回到首頁也不會突然重新開啟', async () => {
    const a = await personalApp();
    const worker = fakeWorker();
    a.click('btnOpenAddModal');
    a.$('step1CategoryGrid').querySelectorAll('button')[0].click();
    a.type('inputAmountExpr', '88');
    a.ev('LedgerUpdate.__test').offer(worker);
    eq(worker.posted, [], '記帳中不應自動更新');
    assert(a.visible('btnTopUpdate'), '應顯示頂部更新按鈕');
    a.click('btnTopUpdate');
    await waitFor(() => a.visible('modalDialog'), { message: '記帳中按更新應先確認' });
    assert(a.text('dialogMessage').includes('捨棄'), a.text('dialogMessage'));
    a.click('dialogBtnCancel');
    eq(worker.posted, [], '取消後不更新');
    eq(a.$('inputAmountExpr').value, '88', '輸入內容保留');
    a.click('btnCloseRecordModal');
    eq(worker.posted, [], '回到首頁也不會突然重新開啟');
    a.click('navBtnSettings');
    eq(a.text('appUpdateStatus'), '有新版本可以使用。');
    a.click('btnApplyUpdate');
    eq(worker.posted, ['SKIP_WAITING']);
  });

  test('版本更新｜已經開始操作時，等下次進入網頁才自動更新', async () => {
    const a = await personalApp();
    const worker = fakeWorker();
    a.d.dispatchEvent(new a.w.PointerEvent('pointerdown', { bubbles: true }));
    a.ev('LedgerUpdate.__test').offer(worker);
    eq(worker.posted, [], '操作中不應自動更新');
    assert(a.visible('btnTopUpdate'));
    a.ev('LedgerUpdate.__test').enter();
    eq(worker.posted, ['SKIP_WAITING'], '重新進入網頁、還沒操作時自動更新');
  });

  test('版本更新｜更新後重新開啟只提示一次「已更新到最新版本」', async () => {
    let a = await personalApp();
    a.w.sessionStorage.setItem('ledger_updated_from', 'old-version');
    a = await reloadApp();
    eq(a.text('toastBox'), '已更新到最新版本');
    eq(a.w.sessionStorage.getItem('ledger_updated_from'), null);
    a = await reloadApp();
    assert(!a.visible('toastBox'), '只提示一次');
    a.click('navBtnSettings');
    eq(a.text('appUpdateStatus'), '直接開啟檔案或測試網址時不會檢查新版本。');
    assert(!a.visible('btnCheckUpdate') && !a.visible('btnTopUpdate'));
  });

  // ---------- 常用店家：只看最近 6 個月 ----------
  function daysAgo(a, n) { return a.ev(`today(new Date(Date.now() - ${n} * 86400000))`); }
  function shopRecords(a, name, count, { ago = 10, categoryId = 'cat_lunch', type = 'expense' } = {}) {
    return Array.from({ length: count }, (_, i) => ({ id: `rec_${encodeURIComponent(name).replace(/%/g, '')}_${i}`, seq: i + 1, type,
      date: daysAgo(a, ago + i), categoryId, amount: 100, merchant: name, note: '' }));
  }
  const chipNames = a => [...a.$('merchantChipsContainer').querySelectorAll('button')].map(b => b.textContent);
  // 每列的名稱與狀態（不含右邊的按鈕）
  const managerRows = a => [...a.$('settingsMerchantList').children].map(r => (r.firstElementChild || r).textContent.replace(/\s+/g, ' ').trim());

  test('店家｜記帳頁沒打字時推薦最近 6 個月在這個分類用過的（最多 8 個），很久沒用的打字才找得到', async () => {
    const a = await personalApp();
    const shops = 'ABCDEFGHIJ'.split('').map(c => c + '店');
    // 甲店、乙店次數多到推薦分數同為上限，仍依次數排先後（依名稱的話乙店會排前面）
    const records = shops.flatMap((name, i) => shopRecords(a, name, 10 - i))
      .concat(shopRecords(a, '乙店', 16), shopRecords(a, '甲店', 20), shopRecords(a, '老店', 5, { ago: 270 }));
    await importBackup(a, { records, categories: defaultCategories(a), merchants: [...shops, '甲店', '乙店', '老店'] });
    a.click('btnOpenAddModal');
    a.$('step1CategoryGrid').querySelectorAll('button')[1].click();   // 午餐
    eq(chipNames(a), ['甲店', '乙店', ...shops.slice(0, 6)], '依最近次數推薦前 8 個');
    a.type('inputMerchantSearch', '老');
    eq(chipNames(a), ['老店'], '9 個月前用過的店打字仍找得到');
  });

  test('店家｜設定頁只列最近常用的 12 個，搜尋與「顯示全部」找得到不常用與已停用的', async () => {
    const a = await personalApp();
    const shops = Array.from({ length: 15 }, (_, i) => `店${String(i + 1).padStart(2, '0')}`);
    const records = shops.flatMap((name, i) => shopRecords(a, name, 15 - i))
      .concat(shopRecords(a, '舊店甲', 3, { ago: 300 }), shopRecords(a, '舊店乙', 2, { ago: 400 }), shopRecords(a, '停用店', 20))
      .concat(shopRecords(a, '公司', 1, { categoryId: 'cat_salary', type: 'income' }));
    await importBackup(a, { records, categories: defaultCategories(a), merchants: [...shops, '舊店甲', '舊店乙', '停用店', '公司'],
      merchantTypes: { 公司: 'income' }, archivedMerchants: ['停用店'] });
    a.click('navBtnSettings');
    let rows = managerRows(a);
    eq(rows.length, 12, '只列 12 個');
    assert(rows[0].startsWith('店01 · 近半年 15 次'), rows[0]);
    assert(!rows.some(r => /舊店|停用店|公司/.test(r)), '不常用、已停用、收入來源不在常用清單');
    eq(a.text('btnMerchantShowAll'), '顯示全部（共 18 個）');
    a.type('merchantMgrSearch', '舊店');
    rows = managerRows(a);
    eq(rows.length, 2);
    assert(rows[0].startsWith('舊店甲 · 上次 '), rows[0]);
    assert(!a.visible('btnMerchantShowAll'), '搜尋時不顯示「顯示全部」');
    a.type('merchantMgrSearch', '');
    a.click('btnMerchantShowAll');
    rows = managerRows(a);
    eq(rows.length, 18, '顯示全部');
    assert(rows.some(r => r.startsWith('停用店 · 已停用')), rows.join('\n'));
    eq(a.text('btnMerchantShowAll'), '只顯示常用');
  });

  test('店家｜收入來源分開管理，新增的名稱歸到目前的分頁', async () => {
    const a = await personalApp();
    a.click('navBtnSettings');
    a.click('merMgrTabIncome');
    assert(a.text('settingsMerchantList').includes('還沒有收入來源'), a.text('settingsMerchantList'));
    a.$('inputManageNewMerchant').value = '家教';
    a.click('btnManageAddMerchant');
    eq(a.text('toastBox'), '已新增「家教」');
    eq(a.ev('state.merchantTypes["家教"]'), 'income');
    eq(managerRows(a), ['家教 · 新加入']);
    a.click('merMgrTabExpense');
    assert(!a.text('settingsMerchantList').includes('家教'), '收入來源不出現在店家分頁');
  });

  // ---------- 新增分類的圖示：依大分類分組 ----------
  const pickerGroups = (a, id) => [...a.$(id).querySelectorAll('.icon-group-section h4')].map(h => h.textContent);
  const activeChip = (a, id) => a.$(id).querySelector('.icon-chip[aria-pressed="true"]').textContent;

  test('圖示｜依大分類分組：沒有大方向／細項，每個圖示只出現一次，通用圖示排在各組第一個', async () => {
    const a = await personalApp();
    eq(a.ev('ICON_GROUPS'), ['餐飲', '交通', '購物', '日用生活', '帳單', '醫療', '娛樂運動', '旅遊', '學習工作', '家庭寵物', '人情', '財務', '收入', '其他']);
    eq(a.ev('ICON_CATALOG.length'), 126);
    eq(a.ev('new Set(ICON_CATALOG.map(i => i.key)).size'), 126, '每個圖示只出現一次');
    assert(a.ev('ICON_CATALOG.every(i => Object.hasOwn(ICONS, i.key) && !("level" in i))'), '都有圖案，也沒有大方向／細項欄位');
    eq(a.ev('ICON_GROUPS.map(g => ICON_CATALOG.find(i => i.group === g).key)'),
      ['food', 'transport_general', 'shopping', 'home', 'bills', 'medical', 'entertainment', 'travel', 'education', 'family', 'social', 'finance', 'income', 'other']);
    assert(a.ev('getInitialState().categories.every(c => ICON_CATALOG.some(i => i.key === c.icon))'), '預設分類用的圖示都還選得到');
    a.click('navBtnSettings');
    const picker = a.$('settingsIconPickerGrid');
    assert(!picker.querySelector('select') && !picker.textContent.includes('大方向'), '不應再有大方向／細項的選單或標籤');
  });

  test('圖示｜點大分類只顯示該組，搜尋時找全部大分類', async () => {
    const a = await personalApp();
    a.click('navBtnSettings');
    const id = 'settingsIconPickerGrid';
    a.click(a.$(id).querySelector('.icon-chip[data-group="交通"]'));
    eq(pickerGroups(a, id), ['交通']);
    eq(a.$(id).querySelector('.icon-results-count').textContent, '顯示 12／126 個圖示');
    const search = a.$(id).querySelector('.icon-search');
    search.value = '咖啡';
    search.dispatchEvent(new a.w.Event('input', { bubbles: true }));
    eq(pickerGroups(a, id), ['餐飲'], '搜尋不受選中的大分類限制');
    eq(activeChip(a, id), '全部');
    a.click(a.$(id).querySelector('.icon-chip[data-group="財務"]'));
    eq(search.value, '', '點大分類會清除搜尋字');
    eq(pickerGroups(a, id), ['財務']);
  });

  test('圖示｜新增收入分類時先顯示「收入」大分類', async () => {
    const a = await personalApp();
    a.click('navBtnSettings');
    const id = 'settingsIconPickerGrid';
    eq(activeChip(a, id), '全部');
    a.click('catMgrTabIncome');
    eq(activeChip(a, id), '收入');
    eq(pickerGroups(a, id), ['收入']);
    eq(a.ev('selectedIcon("settingsIconPickerGrid")'), 'income');
    a.click(a.$(id).querySelector('.icon-chip[data-group="其他"]'));
    a.ev('renderAll()');
    eq(activeChip(a, id), '其他', '畫面更新時不會蓋掉自己點的大分類');
    a.click('catMgrTabExpense');
    eq(activeChip(a, id), '全部');
    eq(a.ev('selectedIcon("settingsIconPickerGrid")'), 'dinner');
    a.click('btnOpenAddModal');
    a.click('modalTypeIncome');
    a.click('btnChangeCategoryInStep2');
    eq(activeChip(a, 'inlineIconPickerGrid'), '收入', '記帳頁新增收入分類也先顯示收入');
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

  test('匯入｜舊的示例帳本備份不會把示例紀錄與店家帶進帳本', async () => {
    const a = await openApp();
    const demoBackup = { format: 'daily-ledger', version: 3, book: 'demo', exportedAt: new Date().toISOString(), data: a.ev('getInitialState()') };
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
