// 畫面測試：在 iframe 中開啟建置好的網頁（docs/index.html），模擬點擊與輸入。
// 測試只在本機測試網址執行，使用獨立的瀏覽器儲存空間，不會碰到正式帳本。
(() => {
  const { test, assert, eq, sleep, waitFor } = T;
  const PREFIX = 'minimal_expense_v3_';
  const APP_URL = '../docs/index.html?nosw&test';
  const DB_NAME = 'casual-ledger'; // 帳本資料庫（58-store.js）
  let frame = null;

  async function clearStorage() {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    // 舊的測試頁面關閉後才會放開資料庫，刪除會等到那時才完成。
    await new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(DB_NAME);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
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
      // 存在裝置上的帳本（等資料庫寫完再讀；還沒存過任何東西時是 null）。
      stored: () => w.eval('LedgerStore.__test.read()'),
      badge: () => $('syncText').textContent.trim(),
      sync: () => w.eval('LedgerSync.__test'),
    };
    return a;
  }

  // 網頁從資料庫讀出帳本、同步也準備好之後，會在 <html> 標上 data-ready。
  const appReady = w => w.document.documentElement.dataset.ready === '1';

  async function openApp({ clear = true, query = '' } = {}) {
    if (frame) { frame.remove(); frame = null; }
    if (clear) await clearStorage();
    frame = document.createElement('iframe');
    frame.title = '受測網頁';
    document.getElementById('stage').appendChild(frame);
    await new Promise(resolve => { frame.onload = resolve; frame.src = `${APP_URL}${query}&r=${Math.random()}`; });
    const w = frame.contentWindow;
    await waitFor(() => appReady(w), { message: '網頁沒有完成載入' });
    return wrap(w);
  }

  async function reloadApp() {
    await new Promise(resolve => { frame.onload = resolve; frame.contentWindow.location.reload(); });
    const w = frame.contentWindow;
    await waitFor(() => appReady(w), { message: '網頁沒有完成載入' });
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

  // 打開設定的某個分頁：設定第一頁 → 點清單上的項目。
  function openSettings(a, page) {
    a.click('navBtnSettings');
    if (page) a.click(a.d.querySelector(`[data-settings-page="${page}"]`));
  }

  async function linkWithFakeCloud(a, cloud, options = {}) {
    a.sync().useBackend(fakeBackendFactory(cloud, options));
    openSettings(a, 'sync');
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
    openSettings(a, 'sync');
    assert(a.text('syncSummary').includes('同步服務尚未設定'), a.text('syncSummary'));
    assert(!a.visible('btnSyncSignIn'), '未設定時不應出現登入按鈕');
  });

  test('畫面｜舊的示例帳本資料會被清除，自己的帳本保留', async () => {
    await clearStorage();
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
    openSettings(a, 'sync');
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
    eq((await a.stored()), null, '不應寫入帳本');
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
    const saved = (await a.stored()).records;
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
    eq((await a.stored()), null, '未儲存的內容不應寫入');
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
    eq((await a.stored()).records.length, 1, '只保留已儲存的紀錄');
    assert(!JSON.stringify((await a.stored())).includes('"draft"'), '不應保存草稿');
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
    eq((await a.stored()).records[0].amount, 150);
    eq(a.ev('state.records[0].amount'), 150);
  });

  test('畫面｜「儲存並再記一筆」在設定開啟後才出現', async () => {
    const a = await personalApp();
    a.click('btnOpenAddModal');
    assert(!a.visible('btnSaveAndNextRecord'), '預設不顯示');
    a.click('btnCloseRecordModal');
    openSettings(a, 'general');
    a.click('toggleSaveAndNext');
    a.click('btnOpenAddModal');
    assert(a.visible('btnSaveAndNextRecord'), '開啟後應顯示');
    a.$('step1CategoryGrid').querySelectorAll('button')[0].click();
    a.type('inputAmountExpr', '60');
    a.click('btnSaveAndNextRecord');
    eq(a.ev('state.activeView'), 'record', '應留在記帳頁');
    eq(a.$('inputAmountExpr').value, '');
    eq((await a.stored()).records.length, 1);
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

  // ---------- 設定：第一頁與分頁 ----------
  test('設定｜第一頁有同步與備份卡片和分頁清單，點進分頁後可以返回', async () => {
    const a = await personalApp();
    a.click('navBtnSettings');
    assert(a.visible('settingsHome') && a.visible('btnSettingsBackup'), '第一頁應顯示同步與備份卡片');
    eq(a.text('settingsSyncText'), '僅存本機');
    eq([...a.d.querySelectorAll('.settings-menu-title')].map(t => t.textContent), ['記帳與首頁', '預算', '固定收支', '分類', '店家與收入來源', '雲端同步', '資料與備份', '關於此網頁']);
    a.click(a.d.querySelector('[data-settings-page="categories"]'));
    assert(!a.visible('settingsHome'), '進入分頁後隱藏第一頁');
    assert(a.visible('settingsCategoryList'), '應顯示分類管理');
    assert(!a.visible('syncSection'), '其他分頁不顯示');
    assert(a.visible('settingsSubHeader') && !a.visible('headerTitleOnly'));
    eq(a.text('settingsPageTitle'), '分類');
    a.click('btnSettingsBack');
    assert(a.visible('settingsHome') && !a.visible('settingsCategoryList'), '返回設定第一頁');
    assert(a.visible('headerTitleOnly') && !a.visible('settingsSubHeader'));
  });

  test('設定｜Android 返回手勢從分頁回到設定第一頁', async () => {
    const a = await personalApp();
    openSettings(a, 'merchants');
    assert(a.visible('settingsMerchantList'));
    a.w.history.back();
    await waitFor(() => a.visible('settingsHome'), { message: '返回後應回到設定第一頁' });
    eq(a.ev('state.activeView'), 'settings', '仍停在設定，不會離開網頁');
  });

  test('設定｜頂部的同步狀態直接打開雲端同步分頁；第一頁可以直接下載備份', async () => {
    const a = await personalApp();
    a.click('btnSyncBadge');
    eq(a.ev('state.settingsPage'), 'sync');
    assert(a.visible('syncSection'));
    a.click('btnSettingsBack');
    eq(a.text('settingsBackupAge'), '此裝置尚未下載過備份。');
    a.click('btnSettingsBackup');
    eq(a.text('settingsBackupAge'), '此裝置上次下載備份：今天。');
    a.click('navBtnHome');
    a.click('navBtnSettings');
    assert(a.visible('settingsHome'), '從其他頁回到設定時顯示第一頁');
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
    openSettings(a, 'about');
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
    openSettings(a, 'about');
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
    openSettings(a, 'merchants');
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
    openSettings(a, 'merchants');
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
    openSettings(a, 'categories');
    a.click('btnAddCategory');
    const picker = a.$('categoryEditorIcons');
    assert(!picker.querySelector('select') && !picker.textContent.includes('大方向'), '不應再有大方向／細項的選單或標籤');
  });

  test('圖示｜點大分類只顯示該組，搜尋時找全部大分類', async () => {
    const a = await personalApp();
    openSettings(a, 'categories');
    a.click('btnAddCategory');
    const id = 'categoryEditorIcons';
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

  test('圖示｜新增收入分類時先顯示「收入」大分類；修改分類時直接顯示目前圖示的大分類', async () => {
    const a = await personalApp();
    const id = 'categoryEditorIcons';
    openSettings(a, 'categories');
    a.click('btnAddCategory');
    eq(a.text('catEditorTitle'), '新增支出分類');
    eq(activeChip(a, id), '全部');
    a.click('btnCatEditorCancel');
    a.click('catMgrTabIncome');
    eq(a.text('btnAddCategory'), '＋ 新增收入分類');
    a.click('btnAddCategory');
    eq(a.text('catEditorTitle'), '新增收入分類');
    eq(activeChip(a, id), '收入');
    eq(pickerGroups(a, id), ['收入']);
    eq(a.ev(`selectedIcon("${id}")`), 'income');
    a.click('btnCatEditorCancel');
    const salary = [...a.$('settingsCategoryList').querySelectorAll('.category-row')].find(r => r.textContent.includes('薪資'));
    a.click(salary.querySelector('.category-edit'));
    eq(a.text('catEditorTitle'), '編輯分類');
    eq(activeChip(a, id), '收入', '修改時顯示目前圖示所在的大分類');
    a.click('btnCatEditorCancel');
    a.click('btnOpenAddModal');
    a.click('modalTypeIncome');
    a.click(a.$('step1CategoryGrid').querySelector('.category-add-tile'));
    eq(activeChip(a, id), '收入', '記帳頁新增收入分類也先顯示收入');
  });

  // ---------- 分類：新增與修改（同一個畫面） ----------
  const typeName = (a, value) => { a.$('catEditorName').value = value; a.$('catEditorName').dispatchEvent(new a.w.Event('input', { bubbles: true })); };
  const categoryRow = (a, name) => [...a.$('settingsCategoryList').querySelectorAll('.category-row')].find(r => r.firstElementChild.lastElementChild.textContent === name);

  test('分類｜記帳頁分類最後一格就是「＋ 新增」：打名稱自動建議圖示，新增後直接選取', async () => {
    const a = await personalApp();
    a.click('btnOpenAddModal');
    const tiles = () => [...a.$('step1CategoryGrid').querySelectorAll('button')];
    eq(tiles().at(-1).textContent.trim(), '新增');
    assert(!a.$('btnChangeCategoryInStep2') && !a.$('inlineAddCatPanel'), '不再有角落的小按鈕與展開的面板');
    a.click(tiles().at(-1));
    assert(a.visible('modalCategory'));
    eq(a.text('catEditorTitle'), '新增支出分類');
    eq(a.d.activeElement.id, 'catEditorName', '先打名稱');
    eq(a.text('btnCatEditorSave'), '新增並選取');
    eq(a.ev('selectedIcon("categoryEditorIcons")'), 'other', '還沒打名稱時是「其他」，不會預設成不相關的圖示');
    typeName(a, '加油');
    eq(a.ev('selectedIcon("categoryEditorIcons")'), 'fuel');
    typeName(a, '隨便');
    eq([a.ev('selectedIcon("categoryEditorIcons")'), a.text('catEditorHint')], ['other', ''], '名稱對不到圖示時換回「其他」，不留下和名稱無關的圖示');
    typeName(a, '加油');
    eq(a.text('catEditorPreview'), '加油', '上方預覽在記帳頁的樣子');
    assert(a.text('catEditorHint').includes('已依名稱選了「加油」圖示'), a.text('catEditorHint'));
    a.click('btnCatEditorSave');
    assert(!a.visible('modalCategory'));
    const cat = a.ev('state.categories.find(c => c.name === "加油")');
    eq([cat.type, cat.icon, cat.order], ['expense', 'fuel', 11]);
    eq(a.ev('modalState.categoryId'), cat.id, '新增後直接選取');
    eq(a.text('step2CatName'), '加油');
    eq(tiles().at(-2).textContent.trim(), '加油', '排在最後，「＋ 新增」仍是最後一格');
    eq(a.text('toastBox'), '已新增「加油」');
  });

  test('分類｜常見分類一鍵套用；先挑圖示時帶入圖示名稱；自己挑過圖示後，打名稱不再換圖示', async () => {
    const a = await personalApp();
    openSettings(a, 'categories');
    a.click('btnAddCategory');
    const chips = () => [...a.$('catEditorSuggest').querySelectorAll('.cat-suggest')];
    assert(chips().length > 5);
    a.click(chips().find(c => c.textContent === '寵物'));
    eq(a.$('catEditorName').value, '寵物');
    eq(a.ev('selectedIcon("categoryEditorIcons")'), 'pet');
    eq(chips().find(c => c.textContent === '寵物').getAttribute('aria-pressed'), 'true');
    typeName(a, '');
    a.click(a.$('categoryEditorIcons').querySelector('.icon-option[data-icon="coffee"]'));
    eq(a.$('catEditorName').value, '咖啡', '名稱還空著時帶入圖示名稱');
    typeName(a, '加油錢');
    eq(a.ev('selectedIcon("categoryEditorIcons")'), 'coffee', '自己挑的圖示不會被名稱建議蓋掉');
    a.click('btnCatEditorSave');
    eq(a.ev('state.categories.find(c => c.name === "加油錢").icon'), 'coffee');
    eq(a.text('toastBox'), '已新增「加油錢」');
    a.ev(`commit(s => s.categories.push({ id: 'cat_pet', type: 'expense', name: '寵物', icon: 'pet', order: 99 }))`);
    a.click('btnAddCategory');
    assert(!chips().some(c => c.textContent === '寵物'), '已經有的分類不再出現在常見分類');
  });

  test('分類｜名稱空白或重複時在畫面上提示、不關閉；Esc 或點背景可以關閉', async () => {
    const a = await personalApp();
    openSettings(a, 'categories');
    a.click('btnAddCategory');
    a.click('btnCatEditorSave');
    eq(a.text('catEditorError'), '請輸入分類名稱。');
    assert(a.visible('modalCategory'));
    typeName(a, '午餐');
    a.click('btnCatEditorSave');
    eq(a.text('catEditorError'), '已經有「午餐」這個分類了。');
    typeName(a, '午餐2');
    assert(!a.visible('catEditorError'), '修改名稱後清掉錯誤');
    a.d.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(!a.visible('modalCategory'));
    assert(!a.ev('state.categories.some(c => c.name === "午餐2")'), '按 Esc 不會儲存');
    a.click('btnAddCategory');
    const backdrop = a.$('modalCategory');
    backdrop.dispatchEvent(new a.w.PointerEvent('pointerdown', { bubbles: true }));
    a.click(backdrop);
    assert(!a.visible('modalCategory'), '點背景關閉');
  });

  test('分類｜設定頁點分類就能改名、換圖示；有紀錄使用時不能刪除，沒有就能刪', async () => {
    const a = await personalApp();
    addRecord(a, { cat: 0, amount: '50' });
    openSettings(a, 'categories');
    a.click(categoryRow(a, '午餐').querySelector('.drag-handle'));
    assert(!a.visible('modalCategory'), '點把手不會打開編輯');
    a.click(categoryRow(a, '早餐').firstElementChild.lastElementChild);
    eq(a.text('catEditorTitle'), '編輯分類');
    eq(a.$('catEditorName').value, '早餐');
    assert(!a.visible('catEditorSuggestWrap'), '修改時不顯示常見分類');
    eq(a.$('categoryEditorIcons').querySelector('.icon-chip[aria-pressed="true"]').textContent, '餐飲', '直接顯示目前圖示所在的大分類');
    typeName(a, '早午餐');
    eq(a.ev('selectedIcon("categoryEditorIcons")'), 'breakfast', '改名不會自動換掉原本的圖示');
    a.click(a.$('categoryEditorIcons').querySelector('.icon-option[data-icon="bread"]'));
    a.click('btnCatEditorSave');
    eq(a.ev('getCategoryById("cat_breakfast")'), { id: 'cat_breakfast', type: 'expense', name: '早午餐', icon: 'bread', order: 1 });
    eq(a.text('toastBox'), '已更新分類');
    a.click(categoryRow(a, '早午餐').querySelector('.category-edit'));
    a.click('btnCatEditorDelete');
    eq(a.text('catEditorError'), '還有紀錄使用這個分類，請先把那些紀錄改到其他分類。');
    a.click('btnCatEditorCancel');
    a.click(categoryRow(a, '晚餐').querySelector('.category-edit'));
    a.click('btnCatEditorDelete');
    eq(a.text('dialogTitle'), '刪除分類？');
    a.click('dialogBtnConfirm');
    await waitFor(() => !a.visible('modalDialog'));
    assert(!a.visible('modalCategory'));
    assert(!a.ev('state.categories.some(c => c.id === "cat_dinner")'));
  });

  test('分類｜依名稱建議圖示：完全相同優先，收入分類優先用收入圖示', async () => {
    const a = await personalApp();
    const s = (name, type = 'expense') => a.ev(`suggestIcon(${JSON.stringify(name)}, '${type}')`);
    eq(['加油', '宵夜', '停車費', 'Netflix', '房租', '孝親費', '寵物美容'].map(n => s(n)), ['fuel', 'dinner', 'parking', 'streaming', 'rent', 'elder', 'pet_care']);
    eq(['水電瓦斯', '手機費', '看醫生'].map(n => s(n)), ['electricity', 'phone', 'doctor']);
    eq(s('利息', 'income'), 'bank', '收入的利息是利息股息');
    eq(s('利息'), 'loan', '支出的利息是貸款');
    eq(s('隨便'), null);
    eq(a.ev('Object.entries(CATEGORY_SUGGESTIONS).flatMap(([type, list]) => list.filter(([name, key]) => suggestIcon(name, type) !== key).map(([name]) => name))'), [], '常見分類的名稱和建議的圖示一致');
  });

  // ---------- 店家：以前的所有紀錄 ----------
  const ymd = (month, d) => { const [y, m] = month.split('-').map(Number); return `${y}/${m}/${d}`; };
  async function historyApp() {
    const a = await personalApp();
    const k = monthsFromNow(a);
    const rec = (id, date, amount, merchant, categoryId = 'cat_lunch') => ({ id, seq: 1, type: 'expense', date, categoryId, amount, merchant, note: '' });
    await importBackup(a, { records: [
      rec('h1', `${k(0)}-01`, 100, '全家'), rec('h2', `${k(-1)}-05`, 200, '全家', 'cat_drink'), rec('h3', `${k(-1)}-20`, 300, '全家'),
      rec('h4', `${k(-3)}-02`, 400, '全家'), rec('h5', `${k(0)}-01`, 999, '7-11'),
      { ...rec('h6', `${k(0)}-02`, 50, '全家', 'cat_salary'), type: 'income' },
    ], categories: defaultCategories(a), merchants: [] });
    return { a, k };
  }

  test('店家｜統計頁點店家先看這段期間，可以切到全部時間：依月份分組、平均與最近一次；只算同一種類型', async () => {
    const { a, k } = await historyApp();
    a.click('navBtnStats');
    a.click([...a.$('statsMerchantList').children].find(b => b.textContent.includes('全家')));
    eq(a.$('drilldownList').children.length, 1, '這個月只有 1 筆');
    assert(a.visible('drilldownScope'));
    a.click(a.$('drilldownScope').querySelector('[data-scope="all"]'));
    eq(a.text('drilldownTitle'), '全家 — 所有紀錄');
    eq(a.text('drilldownSubtitle'), '共 4 筆・合計 NT$ 1,000・平均每筆 NT$ 250', '同一家店記成收入的退款不算在支出裡');
    eq(a.text('drilldownVisits'), `最近一次 ${ymd(k(0), 1)}・第一次 ${ymd(k(-3), 2)}`);
    eq([...a.$('drilldownList').querySelectorAll('.drilldown-month')].map(h => [...h.children].map(s => s.textContent).join(' | ')),
      [k(0), k(-1), k(-3)].map((m, i) => `${Number(m.slice(0, 4))} 年 ${Number(m.slice(5))} 月 | ${['1 筆・NT$ 100', '2 筆・NT$ 500', '1 筆・NT$ 400'][i]}`));
    a.click(a.$('drilldownScope').querySelector('[data-scope="period"]'));
    eq(a.$('drilldownList').children.length, 1, '切回這段期間');
  });

  test('店家｜設定頁的「紀錄」與記帳頁的連結都能看到以前的紀錄；記帳頁開的只能看，不會打斷正在記的這一筆', async () => {
    const { a } = await historyApp();
    openSettings(a, 'merchants');
    const row = [...a.$('settingsMerchantList').children].find(r => r.textContent.includes('全家'));
    a.click([...row.querySelectorAll('button')].find(b => b.textContent === '紀錄'));
    eq(a.text('drilldownTitle'), '全家 — 所有紀錄');
    assert(!a.visible('drilldownScope'), '直接看全部時間');
    eq(a.$('drilldownList').querySelectorAll('button').length, 4, '從設定頁開的可以點進去修改');
    a.click('btnCloseDrilldown');
    a.click('btnOpenAddModal');
    a.click(a.$('step1CategoryGrid').querySelectorAll('button')[1]);
    a.type('inputAmountExpr', '55');
    a.type('inputMerchantSearch', '全家');
    eq(a.text('btnMerchantHistory'), '看「全家」以前的 4 筆紀錄 ›');
    a.click('btnMerchantHistory');
    assert(a.visible('modalDrilldown'));
    eq(a.$('drilldownList').querySelectorAll('button').length, 0, '只能看，不會跳去修改別筆');
    a.click('btnCloseDrilldown');
    eq(a.ev('modalState.amountExpr'), '55', '正在記的內容還在');
    a.type('inputMerchantSearch', '新店家');
    assert(!a.visible('btnMerchantHistory'), '沒有紀錄的店家不顯示連結');
    a.click('modalTypeIncome');
    a.click(a.$('step1CategoryGrid').querySelectorAll('button')[0]);
    a.type('inputMerchantSearch', '全家');
    eq(a.text('btnMerchantHistory'), '看「全家」以前的 1 筆紀錄 ›', '記收入時只算收入');
  });

  // ---------- 分類：拖曳排序 ----------
  const categoryRows = a => [...a.$('settingsCategoryList').querySelectorAll('.category-row')].map(r => r.firstElementChild.lastElementChild.textContent);
  const middleY = el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
  function pointer(a, el, type, y) {
    el.dispatchEvent(new a.w.PointerEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: y, pointerId: 7, button: 0, isPrimary: true, pointerType: 'touch' }));
  }

  test('分類｜按住把手拖曳調整順序，放開才存檔，記帳頁的分類跟著變', async () => {
    const a = await personalApp();
    openSettings(a, 'categories');
    eq(categoryRows(a).slice(0, 3), ['早餐', '午餐', '晚餐']);
    assert(!/[↑↓]/.test(a.text('settingsCategoryList')), '不再有上移／下移按鈕');
    const rows = a.$('settingsCategoryList').querySelectorAll('.category-row');
    const handle = rows[0].querySelector('.drag-handle');
    const startY = middleY(handle);
    pointer(a, handle, 'pointerdown', startY);
    assert(rows[0].classList.contains('dragging'), '拖曳中的分類要浮起來');
    pointer(a, handle, 'pointermove', startY + middleY(rows[2]) - middleY(rows[0]) + 6);
    eq(categoryRows(a).slice(0, 3), ['午餐', '晚餐', '早餐'], '拖過晚餐的一半就換到晚餐後面');
    eq(a.ev('getCategoryById("cat_breakfast").order'), 1, '還沒放開前不存檔');
    pointer(a, handle, 'pointerup', startY + middleY(rows[2]) - middleY(rows[0]) + 6);
    eq(a.ev('getCategoriesByType("expense").map(c => c.name)').slice(0, 4), ['午餐', '晚餐', '早餐', '飲料點心']);
    eq((await a.stored()).categories.filter(c => c.type === 'expense').sort((x, y) => x.order - y.order).map(c => c.name).slice(0, 3), ['午餐', '晚餐', '早餐'], '重新整理後也保留');
    eq(a.ev('getCategoriesByType("income").map(c => c.order)'), [1, 2, 3], '收入分類的順序不受影響');
    assert(!a.$('settingsCategoryList').querySelector('.dragging'), '放開後恢復原狀');
    a.click('btnOpenAddModal');
    eq([...a.$('step1CategoryGrid').querySelectorAll('button')].slice(0, 3).map(b => b.textContent.trim()), ['午餐', '晚餐', '早餐']);
  });

  test('分類｜拖曳中取消（例如來電）不改順序；沒有移動就不存檔', async () => {
    const a = await personalApp();
    openSettings(a, 'categories');
    const rows = a.$('settingsCategoryList').querySelectorAll('.category-row');
    const handle = rows[1].querySelector('.drag-handle');
    const startY = middleY(handle);
    pointer(a, handle, 'pointerdown', startY);
    pointer(a, handle, 'pointermove', startY - 200);
    eq(categoryRows(a)[0], '午餐');
    pointer(a, handle, 'pointercancel', startY - 200);
    eq(categoryRows(a).slice(0, 3), ['早餐', '午餐', '晚餐'], '取消後回到原本的順序');
    const before = a.ev('JSON.stringify(state.entityTimes)');
    const again = a.$('settingsCategoryList').querySelectorAll('.drag-handle')[1];
    pointer(a, again, 'pointerdown', startY);
    pointer(a, again, 'pointerup', startY);
    eq(a.ev('JSON.stringify(state.entityTimes)'), before, '沒有移動不算修改');
  });

  test('分類｜在把手上按上下鍵也能移動，焦點留在同一個分類', async () => {
    const a = await personalApp();
    openSettings(a, 'categories');
    const key = (name, k) => {
      const handle = [...a.$('settingsCategoryList').querySelectorAll('.category-row')].find(r => r.firstElementChild.lastElementChild.textContent === name).querySelector('.drag-handle');
      handle.focus();
      handle.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    };
    key('晚餐', 'ArrowUp');
    eq(categoryRows(a).slice(0, 3), ['早餐', '晚餐', '午餐']);
    eq(a.d.activeElement.closest('.category-row').dataset.id, 'cat_dinner', '焦點跟著晚餐');
    key('早餐', 'ArrowUp');
    eq(categoryRows(a).slice(0, 3), ['早餐', '晚餐', '午餐'], '第一個不能再往上');
    key('早餐', 'ArrowDown');
    eq(a.ev('getCategoriesByType("expense").map(c => c.name)').slice(0, 3), ['晚餐', '早餐', '午餐']);
    assert(/拖曳調整「早餐」的順序/.test(a.d.activeElement.getAttribute('aria-label')));
  });

  // ---------- 預算 ----------
  async function confirmDialog(a, value) {
    a.$('dialogInput').value = value;
    a.click('dialogBtnConfirm');
    await sleep(0);
  }
  const budgetRows = (a, id) => [...a.$(id).querySelectorAll('.budget-row')].map(r => [
    r.querySelector('.budget-name').textContent.trim(),
    r.querySelector('.budget-amount').textContent.trim(),
    r.querySelector('.budget-meter').dataset.status,
    [...r.querySelector('.budget-note').children].map(x => x.textContent.trim()).join(' '),
  ]);

  // 這個月：午餐 2,600／3,000（快用完）、飲料 1,200／1,000（超出）、晚餐 8,000；總預算 20,000。
  async function budgetApp() {
    const a = await personalApp();
    const month = a.ev('today()').slice(0, 7);
    const rec = (id, categoryId, amount, day = '01') => ({ id, seq: 1, type: 'expense', date: `${month}-${day}`, categoryId, amount, merchant: '', note: '' });
    const cats = defaultCategories(a).map(c => c.id === 'cat_lunch' ? { ...c, budget: 3000 } : c.id === 'cat_drink' ? { ...c, budget: 1000 } : c.id === 'cat_transport' ? { ...c, budget: 2000 } : c);
    await importBackup(a, {
      records: [rec('rec_l', 'cat_lunch', 2600), rec('rec_d', 'cat_drink', 1200), rec('rec_n', 'cat_dinner', 8000), { ...rec('rec_s', 'cat_salary', 50000), type: 'income' }],
      categories: cats, merchants: [],
      preferences: { homeHeaderMode: 'expense_only', enableSaveAndNext: false, monthlyBudget: 20000 },
    }, { replace: true });
    return { a, month };
  }

  test('預算｜在設定的「預算」分頁設定總預算與分類預算，留白就取消', async () => {
    const a = await personalApp();
    openSettings(a, 'budget');
    eq(a.text('budgetTotalValue'), '未設定');
    assert(!a.text('budgetCategoryList').includes('薪資'), '只列支出分類');
    a.click('btnEditTotalBudget');
    eq(a.text('dialogTitle'), '每月總預算');
    eq(a.$('dialogInput').inputMode, 'numeric', '手機跳出數字鍵盤');
    await confirmDialog(a, 'NT$ 20,000');
    await waitFor(() => !a.visible('modalDialog'));
    eq(a.ev('state.preferences.monthlyBudget'), 20000);
    eq(a.text('budgetTotalValue'), 'NT$ 20,000');
    const lunch = () => [...a.$('budgetCategoryList').children].find(r => r.textContent.includes('午餐')).querySelector('button');
    a.click(lunch());
    eq(a.text('dialogTitle'), '「午餐」每月預算');
    await confirmDialog(a, '3000');
    await waitFor(() => !a.visible('modalDialog'));
    eq(a.ev('getCategoryById("cat_lunch").budget'), 3000);
    eq((await a.stored()).categories.find(c => c.id === 'cat_lunch').budget, 3000, '存進帳本');
    eq((await a.stored()).preferences.monthlyBudget, 20000);
    eq(a.text('budgetCategorySum'), '分類預算合計 NT$ 3,000。');
    a.click(lunch());
    await confirmDialog(a, '12.5');
    assert(a.visible('modalDialog'), '格式錯誤時不關閉');
    eq(a.text('toastBox'), '請輸入 0～999,999,999 的整數金額。');
    await confirmDialog(a, '');
    await waitFor(() => !a.visible('modalDialog'));
    assert(!('budget' in a.ev('getCategoryById("cat_lunch")')), '留白取消分類預算');
    eq(lunch().textContent, '設定');
  });

  test('預算｜首頁顯示總預算與快用完／超出的分類，統計頁按月看支出時列出全部', async () => {
    const { a, month } = await budgetApp();
    a.click('navBtnHome');
    assert(a.visible('homeBudgetCard'));
    eq(a.text('homeBudgetTitle'), '本月預算');
    const [y, m] = month.split('-').map(Number), day = Number(a.ev('today()').slice(8));
    const daysLeft = new Date(y, m, 0).getDate() - day + 1;
    eq(budgetRows(a, 'homeBudgetBody'), [
      ['總預算', 'NT$ 11,800 / 20,000', 'ok', `剩 NT$ 8,200 還有 ${daysLeft} 天，每天約 NT$ ${Math.floor(8200 / daysLeft).toLocaleString('zh-TW')}`],
      ['午餐', 'NT$ 2,600 / 3,000', 'near', '快用完 剩 NT$ 400'],
      ['飲料點心', 'NT$ 1,200 / 1,000', 'over', '超出 NT$ 200'],
    ]);
    assert(a.$('homeBudgetBody').querySelector('.budget-pace'), '這個月的總預算標出「今天」的位置');
    eq(a.$('homeBudgetBody').querySelector('.budget-more').textContent, '其他 1 個分類預算都還在範圍內');
    a.click('btnHomeBudgetMore');
    eq(a.ev('state.activeView'), 'stats');
    assert(a.visible('statsBudgetSection'));
    eq(budgetRows(a, 'statsBudgetList').map(r => r[0]), ['總預算', '午餐', '飲料點心', '交通']);
    eq(budgetRows(a, 'statsBudgetList')[3].slice(1), ['NT$ 0 / 2,000', 'ok', '剩 NT$ 2,000']);
    a.click('statsTabIncome');
    assert(!a.visible('statsBudgetSection'), '收入統計不顯示預算');
    a.click('statsTabExpense');
    a.click('statsPeriodYear');
    assert(!a.visible('statsBudgetSection'), '整年統計不顯示預算');
    a.click('statsPeriodMonth');
    a.click('btnPrevMonth');
    eq(a.text('statsBudgetTitle'), `${new Date(y, m - 2, 1).getMonth() + 1} 月預算`);
    assert(!a.$('statsBudgetList').querySelector('.budget-pace'), '過去的月份沒有「今天」');
    a.click('btnStatsBudgetEdit');
    eq(a.ev('state.settingsPage'), 'budget');
  });

  test('預算｜記帳後快用完或超出時提醒一次，已經超出就不再重複提醒', async () => {
    const a = await personalApp();
    const cats = defaultCategories(a).map(c => c.id === 'cat_lunch' ? { ...c, budget: 1000 } : c);
    await importBackup(a, { records: [], categories: cats, merchants: [], preferences: { monthlyBudget: 0 } }, { replace: true });
    addRecord(a, { cat: 1, amount: '700' });
    eq(a.text('toastBox'), '已儲存在此瀏覽器', '還沒到八成不提醒');
    addRecord(a, { cat: 1, amount: '150' });
    eq(a.text('toastBox'), '已儲存在此瀏覽器。「午餐」本月預算已用 85%');
    addRecord(a, { cat: 1, amount: '200' });
    eq(a.text('toastBox'), '已儲存在此瀏覽器。「午餐」本月預算已超出 NT$ 50');
    addRecord(a, { cat: 1, amount: '10' });
    eq(a.text('toastBox'), '已儲存在此瀏覽器', '已經超出不重複提醒');
    addRecord(a, { cat: 2, amount: '5000' });
    eq(a.text('toastBox'), '已儲存在此瀏覽器', '沒有預算的分類不提醒');
  });

  test('預算｜沒有設定預算時首頁不顯示預算卡片；備份還原後預算還在', async () => {
    const a = await personalApp();
    assert(!a.visible('homeBudgetCard'));
    const { a: b } = await budgetApp();
    const env = b.ev('backupEnvelope()');
    eq(env.data.preferences.monthlyBudget, 20000);
    eq(env.data.categories.find(c => c.id === 'cat_lunch').budget, 3000);
    const c = await personalApp();
    await importBackup(c, env, { replace: true });
    eq(c.ev('state.preferences.monthlyBudget'), 20000);
    eq(c.ev('getCategoryById("cat_drink").budget'), 1000);
  });

  // ---------- 統計比較 ----------
  // 把「今天」固定在 2026-10-15，比較的期間才不會隨測試日期改變。
  async function compareApp() {
    const a = await personalApp();
    const real = a.w.today;
    a.w.today = d => d ? real(d) : '2026-10-15';
    const rec = (id, date, categoryId, amount, type = 'expense') => ({ id, seq: 1, type, date, categoryId, amount, merchant: '', note: '' });
    await importBackup(a, { records: [
      rec('o1', '2026-10-03', 'cat_lunch', 300), rec('o2', '2026-10-10', 'cat_dinner', 500),
      rec('s1', '2026-09-05', 'cat_lunch', 200), rec('s2', '2026-09-14', 'cat_dinner', 400), rec('s3', '2026-09-25', 'cat_dinner', 1000),
      rec('y1', '2025-03-01', 'cat_transport', 500), rec('y2', '2025-11-01', 'cat_transport', 9999),
      rec('i1', '2026-10-05', 'cat_salary', 50000, 'income'), rec('i2', '2026-09-05', 'cat_salary', 40000, 'income'),
    ], categories: defaultCategories(a), merchants: [] });
    a.ev("state.currentMonth = '2026-10'");
    a.click('navBtnStats');
    return a;
  }
  const compareRows = a => [...a.$('statsCompareList').querySelectorAll('.compare-row')].map(r => [
    r.querySelector('.compare-name').textContent.trim(), r.querySelector('.compare-delta').textContent.trim(),
    r.querySelector('.compare-delta').dataset.tone, r.querySelector('.compare-detail').textContent.trim(),
  ]);
  const deltaChipText = a => { const c = a.$('statsCompareText').querySelector('.stats-delta'); return c ? [c.textContent, c.dataset.tone] : null; };

  test('統計比較｜這個月還沒過完時，只和上個月的同一段日子比（支出變多標紅色）', async () => {
    const a = await compareApp();
    eq(a.text('statsTotalValue'), 'NT$ 800');
    eq(a.$('statsCompareText').lastElementChild.textContent, '比上月同期（1～15 日）多 NT$ 200', '9/25 那筆不算進同期');
    eq(deltaChipText(a), ['▲ 33%', 'bad']);
    eq(a.text('statsAverage'), '日均 NT$ 53');
    eq(a.text('statsCompareTitle'), '和上月比較');
    eq(a.text('statsCompareHint'), '兩邊都只算 1～15 日');
    eq(compareRows(a), [
      ['晚餐', '▲ NT$ 100', 'bad', '10 月 NT$ 500・9 月同期 NT$ 400'],
      ['午餐', '▲ NT$ 100', 'bad', '10 月 NT$ 300・9 月同期 NT$ 200'],
    ]);
    a.click('statsTabIncome');
    eq(a.$('statsCompareText').lastElementChild.textContent, '比上月同期（1～15 日）多 NT$ 10,000');
    eq(deltaChipText(a), ['▲ 25%', 'good'], '收入變多是好消息');
    a.click('statsTabExpense');
    a.click('btnPrevMonth');
    eq(a.$('statsCompareText').lastElementChild.textContent, '上月沒有支出', '過去的月份整個月比較');
    eq(deltaChipText(a), null);
    eq(a.text('statsAverage'), '日均 NT$ 53', '9 月 1,600 ÷ 30 天');
    eq(compareRows(a)[0], ['晚餐', '▲ NT$ 1,400', 'bad', '9 月 NT$ 1,400・8 月 NT$ 0']);
  });

  test('統計比較｜整年時和去年同期比；變化小的分類可以展開全部', async () => {
    const a = await compareApp();
    a.click('statsPeriodYear');
    eq(a.$('statsCompareText').lastElementChild.textContent, '比去年同期（1/1～10/15）多 NT$ 1,900', '去年 11 月那筆不算');
    eq(deltaChipText(a), ['▲ 380%', 'bad']);
    eq(a.text('statsAverage'), `月均 NT$ ${Math.round(2400 / (9 + 15 / 31)).toLocaleString('zh-TW')}`);
    eq(a.text('statsCompareTitle'), '和去年比較');
    eq(compareRows(a).map(r => [r[0], r[1], r[2]]), [['晚餐', '▲ NT$ 1,900', 'bad'], ['午餐', '▲ NT$ 500', 'bad'], ['交通', '▼ NT$ 500', 'good']], '差額一樣時，這段期間金額大的排前面');
    assert(!a.visible('btnCompareMore'), '分類不多時不需要展開');
    a.ev('compareShowAll = false');
    const many = a.ev('getCategoriesByType("expense").length');
    assert(many > 5);
    a.ev(`commit(s => getCategoriesByType("expense").forEach((c, i) => s.records.push({ id: 'm' + i, seq: 1, type: 'expense', date: '2026-02-0' + (i % 9 + 1), categoryId: c.id, amount: 10 + i, merchant: '', note: '' })))`);
    a.ev('renderAll()');
    eq(compareRows(a).length, 5, '預設只列變化最大的 5 個');
    eq(a.text('btnCompareMore'), `顯示全部 ${many} 個分類`);
    a.click('btnCompareMore');
    eq(compareRows(a).length, many);
  });

  test('統計比較｜近 12 個月走勢：目前月份突出顯示，點長條切換月份，整年時不顯示', async () => {
    const a = await compareApp();
    assert(a.visible('statsTrendSection'));
    const cols = () => [...a.$('statsTrendChart').querySelectorAll('.trend-col')];
    eq(cols().map(c => c.dataset.month), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    eq(cols().map(c => c.getAttribute('aria-current')).lastIndexOf('true'), 11);
    eq(cols()[10].getAttribute('aria-label'), '2026 年 9 月 NT$ 1,600');
    eq(cols()[0].querySelector('.trend-bar').style.height, '100%', '最高的月份是滿格');
    eq(a.text('statsTrendAvg'), `月平均 NT$ ${Math.round((9999 + 1600) / 2).toLocaleString('zh-TW')}`, '只算有紀錄、已過完的月份');
    eq(a.text('statsTrendRange'), '2025/11～2026/10・點長條切換到那個月');
    cols()[10].dispatchEvent(new a.w.PointerEvent('pointerover', { bubbles: true }));
    assert(a.visible('statsTrendTip'));
    eq(a.text('statsTrendTip'), 'NT$ 1,6002026 年 9 月');
    a.click(cols()[10]);
    eq(a.ev('state.currentMonth'), '2026-09');
    eq(a.text('statsTotalValue'), 'NT$ 1,600');
    assert(!a.visible('statsTrendTip'), '切換後收起提示');
    a.click('statsTabIncome');
    eq(a.text('statsTrendTitle'), '近 12 個月收入');
    a.click('statsPeriodYear');
    assert(!a.visible('statsTrendSection'));
  });

  // ---------- 固定收支 ----------
  const addMonths = (y, m, k) => { const d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const firstOf = month => { const [yy, mm] = month.split('-').map(Number); return `${yy}/${mm}/1`; };
  // 以真正的今天為準算出前後幾個月，測試不會因為執行日期不同而失敗。
  const monthsFromNow = a => { const [y, m] = a.ev('today()').split('-').map(Number); return n => addMonths(y, m, n); };
  const ruleRecords = a => a.ev('state.records.filter(r => isRuleRecord(r.id)).map(r => r.date).sort()');
  const ruleButton = (a, text) => [...a.$('ruleList').querySelectorAll('.rule-actions button')].find(b => b.textContent === text);
  function setToday(a, date) { const real = a.ev('today'); a.w.today = d => d ? real(d) : date; }
  function fillRule(a, { type, amount, merchant = '', note = '', freq, start, end = '' }) {
    if (type === 'income') a.click('ruleTypeIncome');
    a.type('ruleAmount', amount);
    a.type('ruleMerchant', merchant);
    a.type('ruleNote', note);
    if (freq) { a.$('ruleFreq').value = freq; a.$('ruleFreq').dispatchEvent(new a.w.Event('change', { bubbles: true })); }
    a.type('ruleStart', start);
    a.type('ruleEnd', end);
  }

  test('固定收支｜新增每月規則：先補記到今天為止的，之後到期自動記一筆，首頁標示「固定」', async () => {
    const a = await personalApp();
    const k = monthsFromNow(a);
    openSettings(a, 'recurring');
    eq(a.text('ruleList'), '還沒有固定收支。按「新增」設定房租、訂閱或薪水。');
    a.click('btnAddRule');
    assert(a.visible('ruleEditor'));
    eq(a.$('ruleCategory').value, 'cat_bills', '支出預設「帳單固定」');
    fillRule(a, { amount: '12,000', merchant: '房東', note: '房租', start: `${k(-2)}-01` });
    eq(a.text('rulePreview'), `每月 1 日記一筆。儲存後會先補記 3 筆（${firstOf(k(-2))}～${firstOf(k(0))}），已經記過或刪掉的日期會略過。`);
    a.click('btnRuleSave');
    eq(a.text('toastBox'), '已自動記下 3 筆固定收支');
    assert(!a.visible('ruleEditor'));
    eq(ruleRecords(a), [k(-2), k(-1), k(0)].map(x => `${x}-01`));
    const rule = a.ev('state.recurring[0]');
    eq([rule.next, rule.amount, rule.day, rule.merchant, rule.note], [`${k(1)}-01`, 12000, 1, '房東', '房租']);
    const id = `rec_${rule.id}_${k(0).replace('-', '')}01`;
    eq(a.ev(`state.records.find(r => r.id === '${id}').seq`), 0);
    eq(a.ev(`state.entityTimes['rec:${id}']`), new Date(`${k(0)}-01T00:00:00`).getTime(), '修改時間固定為到期日');
    assert(a.ev('state.merchants').includes('房東'));
    eq([...a.$('ruleList').querySelectorAll('.rule-sub')].map(x => x.textContent), ['房租', '每月 1 日', `下次 ${firstOf(k(1))}`]);
    a.click('navBtnHome');
    assert(a.$('homeRecordList').textContent.includes('固定'), '首頁標示「固定」');
    setToday(a, `${k(1)}-01`);
    a.ev('scheduleRecurring()');
    eq(a.text('toastBox'), '已自動記下 1 筆固定收支');
    a.ev('scheduleRecurring()');
    eq(ruleRecords(a).length, 4, '同一天不會重複記');
    const b = await reloadApp();
    eq(b.ev('state.records.filter(r => isRuleRecord(r.id)).length'), 4, '重新開啟也不會重複');
  });

  test('固定收支｜暫停期間不記帳，繼續後不補記；刪除規則時已記下的紀錄保留', async () => {
    const a = await personalApp();
    const k = monthsFromNow(a);
    openSettings(a, 'recurring');
    a.click('btnAddRule');
    fillRule(a, { type: 'income', amount: '50000', merchant: '公司', start: `${k(-2)}-01` });
    eq(a.$('ruleCategory').value, 'cat_salary', '收入預設「薪資」');
    eq(a.text('ruleMerchantLabel'), '收入來源');
    a.click('btnRuleSave');
    eq(ruleRecords(a).length, 3);
    eq(a.ev('state.records.filter(r => isRuleRecord(r.id)).every(r => r.type === "income" && r.categoryId === "cat_salary")'), true);
    a.click(ruleButton(a, '暫停'));
    eq(a.text('toastBox'), '已暫停，暫停期間不會自動記帳');
    assert(a.text('ruleList').includes('已暫停'));
    setToday(a, `${k(2)}-15`);
    a.ev('scheduleRecurring()');
    eq(ruleRecords(a).length, 3, '暫停中不記帳');
    a.click(ruleButton(a, '繼續'));
    eq(a.text('toastBox'), '已繼續');
    eq(ruleRecords(a).length, 3, '暫停期間的不補記');
    eq(a.ev('state.recurring[0].next'), `${k(3)}-01`);
    a.click(ruleButton(a, '刪除'));
    eq(a.text('dialogTitle'), '刪除固定收支？');
    a.click('dialogBtnConfirm');
    await waitFor(() => !a.visible('modalDialog'));
    eq(a.ev('state.recurring'), []);
    eq(ruleRecords(a).length, 3, '已經記下的紀錄保留');
  });

  test('固定收支｜刪掉自動記下的紀錄不會再補回來；修改規則只影響之後的紀錄', async () => {
    const a = await personalApp();
    const k = monthsFromNow(a);
    openSettings(a, 'recurring');
    a.click('btnAddRule');
    fillRule(a, { amount: '300', merchant: '中華電信', start: `${k(-1)}-01` });
    a.click('btnRuleSave');
    eq(ruleRecords(a), [`${k(-1)}-01`, `${k(0)}-01`]);
    const ruleId = a.ev('state.recurring[0].id');
    a.ev(`commit(s => { s.records = s.records.filter(r => r.date !== '${k(-1)}-01'); })`);
    a.click(ruleButton(a, '修改'));
    eq(a.text('ruleEditorTitle'), '修改固定收支');
    eq(a.$('ruleStart').value, `${k(1)}-01`, '顯示下次日期');
    a.type('ruleAmount', '350');
    a.type('ruleStart', `${k(-1)}-01`);
    assert(a.text('rulePreview').includes('修改只影響之後的紀錄'));
    a.click('btnRuleSave');
    eq(a.text('toastBox'), '已儲存固定收支', '刪掉的與已經記過的日期都略過');
    eq(ruleRecords(a), [`${k(0)}-01`]);
    eq(a.ev(`state.records.find(r => r.id === 'rec_${ruleId}_${k(0).replace('-', '')}01').amount`), 300, '已經記下的不改');
    setToday(a, `${k(1)}-01`);
    a.ev('scheduleRecurring()');
    eq(a.ev(`state.records.find(r => r.date === '${k(1)}-01').amount`), 350, '之後的用新金額');
  });

  test('固定收支｜表單檢查與結束日期；31 日遇到小月記在月底，2/29 遇到平年記在 2/28', async () => {
    const a = await personalApp();
    const k = monthsFromNow(a);
    openSettings(a, 'recurring');
    a.click('btnAddRule');
    fillRule(a, { amount: '0', start: `${k(0)}-01` });
    a.click('btnRuleSave');
    eq(a.text('ruleError'), '金額須為 1～999,999,999 的整數。');
    fillRule(a, { amount: '100', start: `${k(0)}-01`, end: `${k(-1)}-01` });
    a.click('btnRuleSave');
    eq(a.text('ruleError'), '結束日期不能早於第一次的日期。');
    fillRule(a, { amount: '100', start: `${k(-3)}-01`, end: `${k(-2)}-15` });
    a.click('btnRuleSave');
    eq(ruleRecords(a), [`${k(-3)}-01`, `${k(-2)}-01`], '只記到結束日期');
    assert(a.text('ruleList').includes('已結束'));
    assert(!ruleButton(a, '暫停'), '已結束的規則不需要暫停');
    const seq = (rule, from, n) => { const out = [from]; while (out.length < n) out.push(a.ev(`nextDue(${JSON.stringify(rule)}, '${out.at(-1)}')`)); return out; };
    eq(seq({ freq: 'month', day: 31 }, '2026-01-31', 4), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    eq(seq({ freq: 'month', day: 30 }, '2027-12-30', 3), ['2027-12-30', '2028-01-30', '2028-02-29']);
    eq(seq({ freq: 'year', day: 29 }, '2028-02-29', 5), ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
    eq(a.ev(`ruleSchedule({ freq: 'year', day: 29, next: '2029-02-28' })`), '每年 2 月 29 日');
    eq(a.ev(`ruleSchedule({ freq: 'month', day: 31, next: '2026-04-30' })`), '每月 31 日（沒有這天的月份記在月底）');
    eq(a.ev(`dueDates({ freq: 'month', day: 1, next: '2000-01-01' }, '2026-10-25').dates.length`), 120, '一次最多補記 120 筆');
  });

  test('固定收支｜分類被固定收支使用時不能刪除；店家改名時規則一起改', async () => {
    const a = await personalApp();
    a.ev(`commit(s => { s.merchants.push('中華電信'); s.merchantTypes['中華電信'] = 'expense'; s.recurring.push({ id: 'rule_t', type: 'expense', categoryId: 'cat_bills', amount: 300, merchant: '中華電信', note: '', freq: 'month', day: 1, next: '2099-01-01' }); })`);
    openSettings(a, 'categories');
    const row = [...a.$('settingsCategoryList').querySelectorAll('.category-row')].find(r => r.textContent.includes('帳單固定'));
    a.click(row.querySelector('.category-edit'));
    a.click('btnCatEditorDelete');
    eq(a.text('catEditorError'), '固定收支還在使用這個分類，請先修改或刪除。');
    assert(a.ev('state.categories.some(c => c.id === "cat_bills")'));
    a.ev(`commit(s => renameMerchant(s, '中華電信', '中華電信 4G'))`);
    eq(a.ev('state.recurring[0].merchant'), '中華電信 4G');
  });

  test('固定收支｜備份包含規則；格式錯誤的規則略過，分類被刪掉的規則保留並提示修改', async () => {
    const a = await personalApp();
    const rule = { id: 'rule_bak', type: 'expense', categoryId: 'cat_bills', amount: 990, merchant: '', note: '', freq: 'year', day: 3, next: '2099-03-03' };
    a.ev(`commit(s => s.recurring.push(${JSON.stringify(rule)}))`);
    const env = a.ev('backupEnvelope()');
    eq(env.data.recurring, [rule]);
    const b = await personalApp();
    const orphan = { ...rule, id: 'rule_orphan', categoryId: 'cat_nope', next: '2000-01-01' };
    env.data.recurring.push({ ...rule, id: 'rule_bad', day: 40 }, orphan);
    await importBackup(b, env);
    eq(b.ev('state.recurring'), [rule, orphan], '格式錯誤的略過，其他照常匯入');
    assert(typeof b.ev(`state.entityTimes['pref:rule_bak']`) === 'number', '帶上修改時間，才會同步到其他裝置');
    eq(b.ev('runRecurring()'), 0, '分類不存在的規則不會自動記帳');
    openSettings(b, 'recurring');
    assert(b.text('ruleList').includes('分類已刪除，請修改'));
    const c = await reloadApp();
    eq(c.ev('state.recurring.length'), 2, '重新開啟後規則還在');
  });

  test('固定收支｜有連結雲端時：規則與自動記下的紀錄都會上傳；其他裝置新增的規則同步後也會記帳', async () => {
    const a = await personalApp();
    const k = monthsFromNow(a);
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.badge() === '已同步');
    openSettings(a, 'recurring');
    a.click('btnAddRule');
    fillRule(a, { amount: '599', merchant: 'Netflix', start: `${k(-1)}-01` });
    a.click('btnRuleSave');
    const ruleId = a.ev('state.recurring[0].id');
    await waitFor(() => cloud.live('rec').length === 2 && cloud.docs.has(`pref:${ruleId}`), { message: '規則與紀錄應上傳' });
    eq(cloud.docs.get(`pref:${ruleId}`).d.next, `${k(1)}-01`);
    await waitFor(() => a.badge() === '已同步');
    cloud.put('pref:rule_pc', { id: 'rule_pc', type: 'expense', categoryId: 'cat_daily', amount: 99, merchant: '', note: '', freq: 'month', day: 1, next: `${k(0)}-01` });
    await a.sync().sync();
    await waitFor(() => a.ev(`state.records.some(r => r.id === 'rec_rule_pc_${k(0).replace('-', '')}01')`), { message: '同步後補記其他裝置的規則' });
    eq(a.sync().snapshot().meta.conflicts.length, 0);
  });

  // ---------- 匯出 CSV ----------
  test('CSV｜日期由舊到新、同一天依記帳先後；逗號、引號、換行正確跳脫，像公式的文字不會被執行', async () => {
    const a = await personalApp();
    const rec = (id, seq, date, categoryId, amount, merchant, note, type = 'expense') => ({ id, seq, type, date, categoryId, amount, merchant, note });
    await importBackup(a, { records: [
      rec('rec_b', 2, '2026-03-02', 'cat_lunch', 120, '麥當勞', '大麥克, 薯條'),
      rec('rec_a', 1, '2026-03-02', 'cat_breakfast', 75, '7-11', '說"好喝"'),
      rec('rec_c', 3, '2026-02-28', 'cat_salary', 52000, '公司', '=HYPERLINK("x")', 'income'),
      rec('rec_d', 4, '2026-03-05', 'cat_dinner', 90, '+886 小吃', '第一行\n第二行'),
    ], categories: defaultCategories(a), merchants: [] });
    eq(a.ev('recordsCsv(state.records)'), [
      '日期,類型,分類,金額,店家／收入來源,備註',
      `2026-02-28,收入,薪資,52000,公司,"'=HYPERLINK(""x"")"`,
      '2026-03-02,支出,早餐,75,7-11,"說""好喝"""',
      '2026-03-02,支出,午餐,120,麥當勞,"大麥克, 薯條"',
      `2026-03-05,支出,晚餐,90,'+886 小吃,"第一行\n第二行"`,
      ''].join('\r\n'));
  });

  test('CSV｜在「資料與備份」選範圍匯出：全部、首頁目前的月份、有紀錄的每一年', async () => {
    const { a, y } = await statsApp();
    const downloads = [];
    a.w.downloadText = (text, name, type) => downloads.push({ text, name, type });
    openSettings(a, 'data');
    eq([...a.$('csvRange').options].map(o => o.textContent), ['全部紀錄（6 筆）', `${y} 年 3 月（3 筆）`, `${y} 年（5 筆）`, `${y - 1} 年（1 筆）`]);
    a.$('csvRange').value = `${y}-03`;
    a.click('btnExportCsv');
    eq(downloads.length, 1);
    eq(downloads[0].name, `隨便記-紀錄-${y}-03.csv`);
    eq(downloads[0].type, 'text/csv');
    assert(downloads[0].text.startsWith('﻿日期,類型,分類'), '開頭要有 BOM，Excel 開啟中文才不會亂碼');
    eq(downloads[0].text.trim().split('\r\n').length, 4, '標題列加 3 筆');
    eq(a.text('csvStatus'), `已匯出 3 筆紀錄：隨便記-紀錄-${y}-03.csv`);
    a.ev('renderAll()');
    eq(a.$('csvRange').value, `${y}-03`, '畫面更新時保留選擇的範圍');
    a.$('csvRange').value = '';
    a.click('btnExportCsv');
    eq(downloads[1].name, `隨便記-紀錄-全部-${a.ev('today()')}.csv`);
    eq(downloads[1].text.trim().split('\r\n').length, 7);
  });

  test('CSV｜還沒有紀錄時提示，不下載空檔案', async () => {
    const a = await personalApp();
    const downloads = [];
    a.w.downloadText = (...args) => downloads.push(args);
    openSettings(a, 'data');
    eq([...a.$('csvRange').options].map(o => o.textContent), ['全部紀錄（0 筆）']);
    a.click('btnExportCsv');
    eq(downloads.length, 0);
    eq(a.text('toastBox'), '這個範圍沒有紀錄。');
  });

  // ---------- 儲存：IndexedDB ----------
  const journal = () => JSON.parse(localStorage.getItem(PREFIX + 'personal_journal') || 'null');
  const rowKeys = async a => (await a.ev('LedgerStore.__test.rows()')).map(r => r.k);
  const legacyLedger = (a, extra = {}) => Object.assign({
    records: [{ id: 'rec_old_1', seq: 1, type: 'expense', date: '2026-09-01', categoryId: 'cat_lunch', amount: 90, merchant: '便當店', note: '舊版' }],
    categories: defaultCategories(a).map(c => c.id === 'cat_lunch' ? { ...c, name: '中餐', budget: 2000 } : c),
    merchants: ['便當店'], archivedMerchants: [], merchantTypes: { 便當店: 'expense' },
    preferences: { homeHeaderMode: 'full_net', enableSaveAndNext: true, monthlyBudget: 15000 },
    recurring: [{ id: 'rule_old', type: 'expense', categoryId: 'cat_bills', amount: 500, merchant: '', note: '網路', freq: 'month', day: 9, next: '2099-01-09' }],
    entityTimes: { 'rec:rec_old_1': 1700000000000, 'cat:cat_lunch': 1700000000001, 'rec:rec_gone': 1700000000002 },
  }, extra);

  test('儲存｜帳本存在資料庫，記一筆只寫入那一筆；原本的 localStorage 位置換成標記', async () => {
    const a = await personalApp();
    eq(a.ev('LedgerStore.mode()'), 'idb');
    eq(JSON.parse(localStorage.getItem(PREFIX + 'personal')).store, 'indexeddb', '舊版網頁讀到標記會停止寫入，不會當成空帳本');
    eq(await a.stored(), null, '還沒儲存任何東西');
    addRecord(a, { amount: '120' });
    const keys = await rowKeys(a);
    assert(keys.includes('pref:main') && keys.includes('cat:cat_lunch'), '第一次儲存寫入整本帳');
    a.ev('LedgerStore.__test.pause()');
    addRecord(a, { amount: '35' });
    const id = a.ev('state.records.find(r => r.amount === 35).id');
    eq(journal().b.at(-1).c.map(c => c[0]), [`rec:${id}`], '只寫入新的那一筆');
    assert(!(await rowKeys(a)).includes(`rec:${id}`), '暫停時還沒寫進資料庫');
    await a.ev('LedgerStore.__test.resume()');
    assert((await rowKeys(a)).includes(`rec:${id}`));
    eq(journal().b, [], '寫進資料庫後清掉變更日誌');
    eq((await a.stored()).records.map(r => r.amount).sort(), [120, 35]);
  });

  test('儲存｜寫進資料庫之前網頁被關掉：重新開啟時從變更日誌補寫，紀錄不會不見', async () => {
    let a = await personalApp();
    addRecord(a, { amount: '50' });
    await a.ev('LedgerStore.flush()');
    a.ev('LedgerStore.__test.pause()');
    addRecord(a, { amount: '77', note: '關掉前記的' });
    eq(journal().b.length, 1);
    a = await reloadApp();
    eq(a.ev('state.records.map(r => r.note).sort()'), ['', '關掉前記的']);
    await a.ev('LedgerStore.flush()');
    eq(journal().b, []);
    eq((await a.stored()).records.length, 2);
  });

  test('儲存｜舊版存在 localStorage 的帳本會完整搬進資料庫（含修改時間、預算、固定收支、匯入前帳本）', async () => {
    const first = await personalApp();
    const old = legacyLedger(first);
    await clearStorage();
    localStorage.setItem(PREFIX + 'personal', JSON.stringify(old));
    localStorage.setItem(PREFIX + 'personal_before_import', JSON.stringify({ ...old, records: [] }));
    let a = await openApp({ clear: false });
    eq(a.ev('LedgerStore.mode()'), 'idb');
    eq(a.ev('state.records.map(r => r.id)'), ['rec_old_1']);
    eq(a.ev('getCategoryById("cat_lunch")'), { id: 'cat_lunch', type: 'expense', name: '中餐', icon: 'lunch', order: 2, budget: 2000 });
    eq(a.ev('state.preferences'), { homeHeaderMode: 'full_net', enableSaveAndNext: true, monthlyBudget: 15000 });
    eq(a.ev('state.recurring.map(r => r.id)'), ['rule_old']);
    const sorted = o => Object.fromEntries(Object.entries(o).sort());
    eq(sorted(a.ev('state.entityTimes')), sorted(old.entityTimes), '修改時間（含已刪除項目）都保留，同步判斷新舊才正確');
    eq(JSON.parse(localStorage.getItem(PREFIX + 'personal')).store, 'indexeddb');
    eq(localStorage.getItem(PREFIX + 'personal_before_import'), null, '匯入前帳本也搬進資料庫');
    assert(a.ev('LedgerStore.hasSnapshot("before_import")'));
    a = await reloadApp();
    eq(a.ev('state.records.map(r => r.id)'), ['rec_old_1'], '重新開啟從資料庫讀出');
    eq(a.ev('getCategoryById("cat_lunch").name'), '中餐');
    assert(a.ev('(() => { try { validateBackup(JSON.parse(localStorage.getItem("minimal_expense_v3_personal"))); return false; } catch { return true; } })()'),
      '舊版程式讀到標記會判定無法讀取，停止寫入與同步');
  });

  test('儲存｜另一個分頁改過帳本時停止寫入，避免互相覆蓋', async () => {
    const a = await personalApp();
    addRecord(a, { amount: '10' });
    localStorage.setItem(PREFIX + 'personal_journal', JSON.stringify({ rev: 'other-tab', b: [] }));
    await waitFor(() => a.visible('storageError'), { message: '應提示帳本已在另一個分頁變更' });
    assert(a.text('storageError').includes('另一個分頁'));
    addRecord(a, { amount: '20' });
    eq(a.text('recordFormError'), '尚未儲存成功。請查看上方提示並重試，輸入內容仍保留。');
    eq((await a.stored()).records.map(r => r.amount), [10]);
  });

  test('儲存｜瀏覽器不能用資料庫時，沿用 localStorage 存整本帳', async () => {
    let a = await openApp({ query: '&noidb' });
    eq(a.ev('LedgerStore.mode()'), 'local');
    addRecord(a, { amount: '66' });
    eq((await a.stored()).records.map(r => r.amount), [66]);
    eq(JSON.parse(localStorage.getItem(PREFIX + 'personal')).records.length, 1);
    a = await openApp({ clear: false, query: '&noidb' });
    eq(a.ev('state.records.map(r => r.amount)'), [66]);
    a = await openApp({ clear: false });
    eq(a.ev('LedgerStore.mode()'), 'idb', '之後可以用資料庫時自動搬過去');
    eq(a.ev('state.records.map(r => r.amount)'), [66]);
  });

  test('儲存｜已經搬進資料庫、這次卻打不開時：停止寫入並提示，不會當成空帳本，也不能下載空的備份', async () => {
    let a = await personalApp();
    addRecord(a, { amount: '88' });
    await a.ev('LedgerStore.flush()');
    a = await openApp({ clear: false, query: '&noidb' });
    assert(a.visible('storageError') && a.text('storageError').includes('無法開啟帳本資料庫'), a.text('storageError'));
    let downloads = 0;
    a.w.downloadText = () => { downloads++; };
    a.ev('exportBackup()');
    eq(downloads, 0);
    eq(a.text('toastBox'), '目前讀不到帳本，無法下載備份。請完全關閉網頁後重新開啟。');
    addRecord(a, { amount: '1' });
    eq(a.ev('state.records.length'), 0, '不能寫入');
    a = await openApp({ clear: false });
    eq(a.ev('state.records.map(r => r.amount)'), [88], '能開啟時帳本都還在');
  });

  test('儲存｜資料庫已有帳本、localStorage 又出現舊格式帳本時：合併進資料庫，不刪任何紀錄', async () => {
    let a = await personalApp();
    addRecord(a, { amount: '500', note: '資料庫裡的' });
    await a.ev('LedgerStore.flush()');
    localStorage.setItem(PREFIX + 'personal', JSON.stringify(legacyLedger(a)));
    a = await reloadApp();
    eq(a.ev('state.records.map(r => r.note).sort()'), ['舊版', '資料庫裡的']);
    eq(JSON.parse(localStorage.getItem(PREFIX + 'personal')).store, 'indexeddb');
  });

  test('儲存｜資料庫連線中斷（例如 iPhone 在背景太久）：自動重新連線再寫入，不用重新整理', async () => {
    const a = await personalApp();
    addRecord(a, { amount: '10' });
    await a.ev('LedgerStore.flush()');
    a.ev('LedgerStore.__test.breakConnection()');
    addRecord(a, { amount: '20' });
    await a.ev('LedgerStore.flush()');
    assert(!a.visible('storageError'), a.text('storageError'));
    eq((await a.stored()).records.map(r => r.amount).sort(), [10, 20]);
    addRecord(a, { amount: '30' });
    eq((await a.stored()).records.length, 3, '重新連線後照常儲存');
  });

  test('儲存｜重新連線也失敗時停止儲存並提示，畫面上的帳本仍可下載備份', async () => {
    const a = await personalApp();
    addRecord(a, { amount: '10' });
    await a.ev('LedgerStore.flush()');
    a.ev('LedgerStore.__test.breakConnection()');
    a.ev('LedgerStore.__test.failNextOpen()');
    addRecord(a, { amount: '20' });
    let failed = false;
    try { await a.ev('LedgerStore.flush()'); } catch { failed = true; }
    assert(failed, '寫入應失敗');
    assert(a.visible('storageError') && a.text('storageError').includes('無法寫入帳本資料庫'), a.text('storageError'));
    addRecord(a, { amount: '30' });
    eq(a.ev('state.records.length'), 2, '停止儲存後不再接受新的紀錄');
    const downloads = [];
    a.w.downloadText = text => downloads.push(text);
    a.ev('exportBackup()');
    eq(JSON.parse(downloads[0]).data.records.length, 2, '備份包含還沒寫進資料庫的那一筆');
    const b = await reloadApp();
    eq(b.ev('state.records.map(r => r.amount).sort()'), [10, 20], '變更日誌裡的那一筆，重新開啟後補寫回來');
  });

  test('儲存｜同步：雲端的變更確實寫進資料庫後才保存同步狀態', async () => {
    const a = await personalApp();
    const cloud = createFakeCloud();
    await linkWithFakeCloud(a, cloud);
    await waitFor(() => a.badge() === '已同步');
    a.ev('LedgerStore.__test.pause()');
    cloud.put('rec:rec_cloud', { id: 'rec_cloud', seq: 1, type: 'expense', date: a.ev('today()'), categoryId: 'cat_daily', amount: 320, merchant: '', note: '雲端來的' });
    const running = a.sync().sync();
    await sleep(150);
    eq(a.ev('state.records.length'), 1, '畫面上已經有了');
    assert(!a.sync().snapshot().meta.shadow['rec:rec_cloud'], '還沒寫進資料庫前，不能記成已同步');
    await a.ev('LedgerStore.__test.resume()');
    await running;
    assert(a.sync().snapshot().meta.shadow['rec:rec_cloud'], '寫進資料庫後記成已同步');
    eq((await a.stored()).records.map(r => r.id), ['rec_cloud']);
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
    eq((await a.stored()).entityTimes[`rec:${id}`], env.data.entityTimes[`rec:${id}`], '重新開啟後應保留修改時間');
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
    openSettings(a, 'data');
    assert(a.visible('btnUndoImport'), '應可還原');
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
    eq((await a.stored()).records.length, 1, '已按儲存的紀錄必須保存在本機');
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
    eq((await a.stored()).records.length, 1);
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
    openSettings(a, 'sync');
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
    openSettings(a, 'sync');
    assert(a.text('syncError').includes('雲端拒絕存取'), a.text('syncError'));
    eq((await a.stored()).records.length, 1);
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
    a.click('navBtnHome');
    a.click(a.d.querySelector('.record-item-btn'));
    a.type('inputRecordNote', '手機改的');
    a.click('btnSaveRecord');
    await waitFor(() => a.badge().startsWith('待同步'));
    cloud.put(`rec:${rec.id}`, Object.assign({}, rec, { note: '電腦較晚改的' }), { t: Date.now() + 60000 });
    cloud.offline = false;
    await a.sync().sync();
    eq(a.ev('state.records[0].note'), '電腦較晚改的');
    openSettings(a, 'sync');
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
    openSettings(a, 'sync');
    a.click('btnSyncConfirmDeletes');
    await waitFor(() => a.visible('modalDialog'));
    a.click('dialogBtnConfirm');
    await waitFor(() => cloud.live('rec').length === 2, { message: '確認後應同步刪除' });
  });
})();
