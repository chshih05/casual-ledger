// 帳本儲存：存在瀏覽器內建的資料庫（IndexedDB），每筆紀錄、分類、店家、設定與固定收支各自一列，
// 儲存時只寫入有變更的列，帳本再大，記一筆也只寫那一筆。
// localStorage 只放一小段「變更日誌」：還沒寫進資料庫的變更（網頁在寫入途中被關掉時，下次開啟會補寫），
// 以及帳本版本號（另一個分頁改過帳本時停止寫入，避免互相覆蓋）。
// 瀏覽器無法使用 IndexedDB 時（例如部分無痕模式），沿用舊方式把整本帳存成 localStorage 裡的一段文字。
let markLedgerReady;
const ledgerReady = new Promise(resolve => { markLedgerReady = resolve; });

const LedgerStore = (() => {
  'use strict';
  const DB_NAME = 'casual-ledger';
  const DB_VERSION = 1;
  const ROWS = 'entities';       // {k: 項目代號（例如 rec:…、cat:…）, d: 內容（已刪除為 null）, t: 修改時間}
  const SNAPSHOTS = 'snapshots'; // {id, data}：匯入前帳本（JSON 文字）
  const OPEN_TIMEOUT_MS = 8000;
  const JOURNAL_LIMIT = 400000;  // 一次變更超過這個大小（例如匯入整本帳）就不放進日誌，改等資料庫寫完
  const RETRY_MS = 1500;
  // 舊的 localStorage 帳本搬進資料庫後，原位置改放這段標記：還沒更新的舊版網頁讀到時會停止寫入與同步，
  // 不會把它當成空帳本（否則可能把雲端的紀錄當成「已刪除」）。
  const MOVED = { store: 'indexeddb', note: '帳本已搬到瀏覽器資料庫（IndexedDB），請重新整理網頁以使用新版。' };
  const testMode = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && new URLSearchParams(location.search).has('test');
  const keys = {
    legacy: () => BOOK_PREFIX + book,
    legacySnapshot: () => BOOK_PREFIX + book + '_before_import',
    legacySnapshotReason: () => BOOK_PREFIX + book + '_before_import_reason',
    journal: () => BOOK_PREFIX + book + '_journal',
  };

  let mode = 'local';          // 'idb'：資料庫；'local'：舊方式（整本帳存在 localStorage）
  let db = null;
  let rev = '';                // 這個分頁最後寫入（或讀到）的帳本版本號
  let journalOk = true;        // localStorage 可以寫入（不能寫時只靠資料庫）
  let seeded = false;          // 資料庫裡已經有整本帳；還沒有時，第一次儲存寫入全部項目
  let queue = [];              // 還沒寫進資料庫的變更 {id, c: [[k, d, t], …], journaled}
  let flushing = null, failures = 0, closedByOther = false;
  let pauseGate = null;        // 測試用：暫停寫入資料庫，模擬寫到一半
  let failOpen = false;        // 測試用：下一次開啟資料庫失敗
  let snapshots = new Map();     // 匯入前帳本：代號 → 存下的原因（例如 'reset'；舊版存的沒有原因）
  let rawRows = null;          // 讀不出來的內容，保留給「下載完整備份」
  let unreadable = false;      // 開啟時讀不到資料庫：畫面上是空帳本，不能當成備份下載

  const newRev = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const own = (obj, k) => (obj && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);
  const define = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
  function isMoved(raw) { try { return JSON.parse(raw)?.store === MOVED.store; } catch { return false; } }

  // ---------- IndexedDB 基本操作 ----------
  const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const finished = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('資料庫交易中斷'));
  });
  function openDb() {
    return new Promise((resolve, reject) => {
      if (testMode && new URLSearchParams(location.search).has('noidb')) return reject(new Error('測試：不使用資料庫'));
      if (failOpen) { failOpen = false; return reject(new Error('測試：開啟資料庫失敗')); }
      if (typeof indexedDB === 'undefined' || !indexedDB) return reject(new Error('瀏覽器不支援 IndexedDB'));
      let settled = false;
      const fail = e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } };
      const timer = setTimeout(() => fail(new Error('開啟資料庫逾時')), OPEN_TIMEOUT_MS);
      let r;
      try { r = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return fail(e); }
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(ROWS)) d.createObjectStore(ROWS, { keyPath: 'k' });
        if (!d.objectStoreNames.contains(SNAPSHOTS)) d.createObjectStore(SNAPSHOTS, { keyPath: 'id' });
      };
      r.onsuccess = () => {
        const d = r.result;
        if (settled) { d.close(); return; }
        settled = true; clearTimeout(timer);
        // 另一個分頁要升級或刪除資料庫時，讓出連線，這一頁停止寫入。
        d.onversionchange = () => { d.close(); if (db === d) { db = null; closedByOther = true; lost('帳本資料庫已在其他分頁更新，請重新開啟網頁。'); } };
        resolve(d);
      };
      r.onerror = () => fail(r.error || new Error('無法開啟資料庫'));
    });
  }
  const readAll = name => request(db.transaction(name, 'readonly').objectStore(name).getAll());

  // ---------- 帳本 ↔ 資料列 ----------
  function rowsFromState(s) {
    const map = LedgerSyncCore.entityMap(s), times = s.entityTimes || {}, rows = [];
    for (const [k, e] of map) rows.push([k, e.data, own(times, k)]);
    for (const k of Object.keys(times)) if (!map.has(k)) rows.push([k, null, times[k]]);
    return rows;
  }
  function stateFromRows(rows) {
    const src = { records: [], categories: [], merchants: [], archivedMerchants: [], merchantTypes: {}, preferences: {}, recurring: [], entityTimes: {} };
    for (const row of rows) {
      if (typeof row.t === 'number') define(src.entityTimes, row.k, row.t);
      const d = row.d;
      if (!d) continue;
      const kind = row.k.slice(0, row.k.indexOf(':'));
      if (kind === 'rec') src.records.push(d);
      else if (kind === 'cat') src.categories.push(d);
      else if (kind === 'mer') { src.merchants.push(d.name); define(src.merchantTypes, d.name, d.type); if (d.archived) src.archivedMerchants.push(d.name); }
      else if (row.k === LedgerSyncCore.PREF_KEY) src.preferences = d;
      else if (LedgerSyncCore.isRuleKey(row.k)) src.recurring.push(d);
    }
    src.records.sort((a, b) => a.date.localeCompare(b.date) || (Number(a.seq) || 0) - (Number(b.seq) || 0));
    return validateBackup(src);
  }
  // 兩本帳的內容與修改時間完全相同（搬家後讀回來比對用）。
  function sameLedger(a, b) {
    const text = s => JSON.stringify(rowsFromState(s).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
    return text(a) === text(b);
  }
  function putRows(store, changes) {
    for (const [k, d, t] of changes) {
      if (d === null && typeof t !== 'number') store.delete(k);
      else store.put(typeof t === 'number' ? { k, d, t } : { k, d });
    }
  }
  async function replaceAll(s) {
    const tx = db.transaction(ROWS, 'readwrite'), store = tx.objectStore(ROWS);
    store.clear();
    putRows(store, rowsFromState(s));
    await finished(tx);
  }

  // ---------- 變更日誌（localStorage） ----------
  function readJournal(raw) {
    try {
      const j = JSON.parse(raw === undefined ? localStorage.getItem(keys.journal()) : raw);
      return { rev: typeof j?.rev === 'string' ? j.rev : '', b: Array.isArray(j?.b) ? j.b : [] };
    } catch { return { rev: '', b: [] }; }
  }
  function writeJournal(j) {
    if (j.b.length || j.rev) localStorage.setItem(keys.journal(), JSON.stringify(j));
    else localStorage.removeItem(keys.journal());
  }
  function forgetJournal(ids) {
    if (!journalOk || !ids.length) return;
    try { const j = readJournal(); j.b = j.b.filter(b => !ids.includes(b.id)); writeJournal(j); } catch {}
  }

  // ---------- 開啟 ----------
  // 開啟時只記下問題，等畫面準備好再由 60-app.js 顯示；開啟之後發生的問題立刻顯示。
  function blocked(message, readable = false) { storageBlocked = true; loadIssue = message; unreadable = !readable; return freshBook(); }
  function lost(message) { storageBlocked = true; loadIssue = message; showStorageError(message); }
  function checkLocalStorage() {
    try { const k = BOOK_PREFIX + 'probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch { return false; }
  }
  async function open() {
    rawRows = null; queue = []; seeded = false;
    journalOk = checkLocalStorage();
    let legacyRaw = null;
    try { legacyRaw = localStorage.getItem(keys.legacy()); } catch {}
    const moved = legacyRaw !== null && isMoved(legacyRaw);
    try { db = await openDb(); }
    catch (e) {
      console.warn('IndexedDB unavailable', e);
      db = null;
      if (moved) return blocked('無法開啟帳本資料庫。請完全關閉網頁（或瀏覽器）後重新開啟；帳本仍在這台裝置上。');
      mode = 'local';
      return loadBook();
    }
    mode = 'idb';
    try {
      let rows = await readAll(ROWS);
      snapshots = new Map((await readAll(SNAPSHOTS)).map(s => [s.id, s.reason || '']));
      if (legacyRaw !== null && !moved) {
        // 舊版存在 localStorage 的帳本：搬進資料庫，讀回來比對無誤後，原位置才換成標記。
        const legacy = loadBook();
        if (storageBlocked) return useLegacy(legacy);
        let expected = legacy;
        // 不正常的情況（資料庫已經有另一本帳，例如只清掉了 localStorage）：以資料庫為主，
        // 把舊帳本合併進來，不刪任何紀錄。
        if (rows.length && !sameLedger(stateFromRows(rows), legacy)) expected = planImportMerge(stateFromRows(rows), legacy, importOrigin(null)).next;
        if (!rows.length || expected !== legacy) await replaceAll(expected);
        rows = await readAll(ROWS);
        if (!sameLedger(stateFromRows(rows), expected)) throw new Error('搬移後讀回的帳本不符');
        const snap = localStorage.getItem(keys.legacySnapshot());
        if (snap) await putSnapshot('before_import', snap, localStorage.getItem(keys.legacySnapshotReason()) || '');
        localStorage.setItem(keys.legacy(), JSON.stringify(MOVED));
        localStorage.removeItem(keys.legacySnapshot());
        localStorage.removeItem(keys.legacySnapshotReason());
        persistedRaw = null;
      } else if (journalOk && !moved) {
        localStorage.setItem(keys.legacy(), JSON.stringify(MOVED));
      }
      // 補寫上次還沒寫進資料庫的變更。
      const byKey = new Map(rows.map(r => [r.k, r]));
      const journal = journalOk ? readJournal() : { rev: '', b: [] };
      for (const batch of journal.b) {
        for (const [k, d, t] of batch.c) {
          if (d === null && typeof t !== 'number') byKey.delete(k);
          else byKey.set(k, typeof t === 'number' ? { k, d, t } : { k, d });
        }
        queue.push({ id: batch.id, c: batch.c, journaled: true });
      }
      rev = journal.rev || newRev();
      if (journalOk && !journal.rev) writeJournal({ rev, b: journal.b });
      seeded = byKey.size > 0;
      let state;
      try { state = seeded ? stateFromRows([...byKey.values()]) : freshBook(); }
      catch (e) {
        console.warn('ledger rows invalid', e);
        rawRows = JSON.stringify([...byKey.values()]);
        return blocked('原有資料無法讀取，已停止覆寫。請匯出原始資料保留後，再匯入有效備份。', true);
      }
      if (queue.length) flush().catch(() => {});
      askPersistent();
      return state;
    } catch (e) {
      console.warn('IndexedDB load failed', e);
      try { db.close(); } catch {}
      db = null;
      if (moved) return blocked('無法讀取帳本資料庫。請完全關閉網頁（或瀏覽器）後重新開啟；帳本仍在這台裝置上。');
      return useLegacy(loadBook());
    }
  }
  function useLegacy(state) {
    if (db) { try { db.close(); } catch {} }
    db = null; mode = 'local';
    return state;
  }
  // 請瀏覽器把這個網站的資料視為重要、空間不足時不要自動清除（不支援或拒絕都沒關係）。
  function askPersistent() {
    try { navigator.storage?.persisted?.().then(p => { if (!p) navigator.storage.persist?.().catch(() => {}); }).catch(() => {}); } catch {}
  }

  // ---------- 儲存 ----------
  // 由 commit() 呼叫，必須同步完成；失敗時丟出錯誤，帳本維持原狀。
  function save(prev, next) {
    if (mode === 'local') {
      const raw = JSON.stringify({ ...next, activeView: 'home', previousView: 'home' });
      if (localStorage.getItem(keys.legacy()) !== persistedRaw) throw new Error('另一個分頁已修改帳本。請先下載目前帳本，再重新開啟。');
      localStorage.setItem(keys.legacy(), raw);
      persistedRaw = raw;
      return;
    }
    if (!db) throw new Error('帳本資料庫無法使用，請重新開啟網頁。');
    const changes = seeded ? LedgerSyncCore.diffEntities(prev, next) : rowsFromState(next);
    if (!changes.length) return;
    const batch = { id: newRev(), c: changes, journaled: false };
    if (journalOk) {
      const j = readJournal();
      if (j.rev !== rev) throw new Error('另一個分頁已修改帳本。請先下載目前帳本，再重新開啟。');
      const nextRev = newRev(), entry = { id: batch.id, c: changes };
      // 一般的變更很小，先寫進日誌再回報「已儲存」；大批變更（例如匯入）由呼叫端等資料庫寫完。
      if (changes.length <= 2000 && JSON.stringify(entry).length <= JOURNAL_LIMIT) { writeJournal({ rev: nextRev, b: [...j.b, entry] }); batch.journaled = true; }
      else writeJournal({ rev: nextRev, b: j.b });
      rev = nextRev;
    }
    queue.push(batch);
    seeded = true;
    flush().catch(() => {});
  }
  // 等所有變更寫進資料庫；寫入失敗時回傳失敗的 Promise。
  function flush() {
    if (mode === 'local' || (!queue.length && !flushing)) return Promise.resolve();
    if (!flushing) flushing = runFlush().finally(() => { flushing = null; });
    return flushing;
  }
  // 寫入失敗時：重新連線資料庫後再試一次（iPhone 在背景太久，連線可能被中斷）；這段期間的儲存先排隊。
  // 重試仍失敗（例如裝置空間不足）就停止儲存，避免畫面上的帳本和裝置上的不一致。
  async function runFlush() {
    while (queue.length) {
      if (pauseGate) await pauseGate.promise;
      const batches = queue.slice();
      try {
        if (!db) throw new Error('帳本資料庫無法使用');
        const tx = db.transaction(ROWS, 'readwrite'), store = tx.objectStore(ROWS);
        for (const b of batches) putRows(store, b.c);
        await finished(tx);
      } catch (e) {
        console.warn('ledger write failed', e);
        if (closedByOther || failures++ > 0) { writeStopped(); throw e; }
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
        try { const fresh = await openDb(); try { db?.close(); } catch {} db = fresh; }
        catch (err) { writeStopped(); throw err; }
        continue;
      }
      failures = 0;
      queue = queue.filter(b => !batches.includes(b));
      forgetJournal(batches.filter(b => b.journaled).map(b => b.id));
    }
  }
  function writeStopped() {
    if (!closedByOther) lost('無法寫入帳本資料庫（可能是裝置空間不足）。已停止儲存以保護資料，請先下載完整備份。');
  }

  // ---------- 匯入前帳本 ----------
  // 匯入、還原、刪除所有紀錄、全部重置之前的整本帳（只留最近一份）。reason 記下是哪一種，畫面依此顯示還原按鈕。
  async function putSnapshot(id, data, reason = '') {
    const tx = db.transaction(SNAPSHOTS, 'readwrite');
    tx.objectStore(SNAPSHOTS).put({ id, data, reason });
    await finished(tx);
    snapshots.set(id, reason);
  }
  async function saveSnapshot(id, data, reason = '') {
    if (mode === 'local') {
      localStorage.setItem(keys.legacySnapshot(), data);
      try { localStorage.setItem(keys.legacySnapshotReason(), reason); } catch {}
      return;
    }
    if (!db) throw new Error('帳本資料庫無法使用');
    await putSnapshot(id, data, reason);
  }
  async function loadSnapshot(id) {
    if (mode === 'local') return localStorage.getItem(keys.legacySnapshot());
    if (!db) throw new Error('帳本資料庫無法使用');
    const row = await request(db.transaction(SNAPSHOTS, 'readonly').objectStore(SNAPSHOTS).get(id));
    return row ? row.data : null;
  }
  function hasSnapshot(id) {
    if (mode === 'local') { try { return Boolean(localStorage.getItem(keys.legacySnapshot())); } catch { return false; } }
    return snapshots.has(id);
  }
  function snapshotReason(id) {
    if (mode === 'local') { try { return localStorage.getItem(keys.legacySnapshotReason()) || ''; } catch { return ''; } }
    return snapshots.get(id) || '';
  }

  // ---------- 另一個分頁 ----------
  // 帳本在另一個分頁被修改時通知（這一頁的畫面已經過時，繼續寫入會互相覆蓋）。
  function isCurrent() {
    try {
      if (mode === 'local') return localStorage.getItem(keys.legacy()) === persistedRaw;
      return !journalOk || readJournal().rev === rev;
    } catch { return false; }
  }
  function watchOtherTabs(onChange) {
    window.addEventListener('storage', e => {
      if (mode === 'local') { if (e.key === keys.legacy() && e.newValue !== persistedRaw) onChange(); return; }
      if (e.key === keys.journal() && readJournal(e.newValue).rev !== rev) onChange();
    });
  }

  // 本機測試專用：模擬寫入途中關掉網頁、讀出存在裝置上的帳本。正式網址上不提供。
  const testApi = testMode ? {
    pause() { if (!pauseGate) { let open; pauseGate = { promise: new Promise(r => { open = r; }), open }; } },
    resume() { const gate = pauseGate; pauseGate = null; gate?.open(); return flush(); },
    pending: () => queue.length,
    // 模擬連線被中斷（例如 iPhone 在背景太久）與重新連線失敗。
    breakConnection() { db.close(); },
    failNextOpen() { failOpen = true; },
    // 存在裝置上的帳本（還沒存過任何東西時是 null）；暫停寫入時讀到的是資料庫目前的內容。
    async read() {
      if (mode === 'local') { const raw = localStorage.getItem(keys.legacy()); return raw ? JSON.parse(raw) : null; }
      if (!pauseGate) await flush();
      const rows = await readAll(ROWS);
      return rows.length ? stateFromRows(rows) : null;
    },
    rows: () => readAll(ROWS),
  } : undefined;

  return {
    DB_NAME, open, save, flush, saveSnapshot, loadSnapshot, hasSnapshot, snapshotReason, isCurrent, watchOtherTabs,
    mode: () => mode, rawExport: () => (mode === 'local' ? persistedRaw : rawRows), unreadable: () => unreadable, __test: testApi,
  };
})();
