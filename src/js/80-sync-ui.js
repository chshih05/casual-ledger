// 雲端同步的流程與畫面：Google 登入、首次連結確認、自動同步、狀態顯示、衝突紀錄。
// 只有個人帳本會同步；示例帳本、直接開啟的 HTML 檔、尚未填入 Firebase 設定時都只存在本機。
const LedgerSync = (() => {
  'use strict';
  const Core = LedgerSyncCore;
  const DEBOUNCE_MS = 1200;
  const INTERVAL_MS = 5 * 60 * 1000;
  const MAX_RETRY_MS = 10 * 60 * 1000;
  const QUOTA_RETRY_MS = 60 * 60 * 1000;
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const fileMode = location.protocol === 'file:';
  const config = typeof LEDGER_FIREBASE_CONFIG === 'object' && LEDGER_FIREBASE_CONFIG ? LEDGER_FIREBASE_CONFIG : null;
  let configured = Boolean(config && config.apiKey && config.projectId && config.appId);

  const MESSAGES = {
    offline: '目前離線。已儲存的資料留在此裝置，恢復連線後會自動上傳。',
    'sdk-load': '無法載入同步元件（可能沒有網路）。帳本仍可在此裝置使用，恢復連線後再試。',
    permission: '雲端拒絕存取。請確認登入的是你的帳號，且 Firebase 安全規則已正確發布。',
    unauthenticated: '登入已失效，請重新登入後繼續同步。',
    quota: '已達 Firebase 今日的免費用量。資料先保留在此裝置，額度重置後（約台灣時間下午 3～4 點）會自動補傳。',
    'no-database': '找不到雲端資料庫。請確認 Firebase 專案已建立 Firestore 資料庫。',
    'needs-setup': '雲端資料庫還需要額外設定才能讀取。請把這段訊息提供給維護者。',
    'unauthorized-domain': '這個網址尚未加入 Firebase 的「授權網域」，所以無法登入。',
    'provider-disabled': 'Firebase 專案尚未啟用 Google 登入。',
    'popup-blocked': '瀏覽器擋下了登入視窗。請再按一次登入，或允許此網站開啟彈出式視窗。',
    'popup-closed': '登入視窗已關閉，尚未登入。',
    'invalid-config': 'Firebase 設定值有誤，請重新複製「網頁應用程式」的設定。',
    'local-save': '此裝置無法寫入資料，已暫停同步以保護帳本。請先下載完整備份。',
    'invalid-remote': '雲端資料與此版本的格式不符，已停止套用以保護帳本。請先下載完整備份並回報。',
    'book-changed': '已切換帳本，同步暫停。',
    'not-linked': '此裝置的帳本尚未連結雲端帳號。',
    unknown: '同步時發生未預期的錯誤，資料仍保留在此裝置。',
  };
  const TRANSIENT = new Set(['offline', 'sdk-load', 'book-changed', 'popup-closed']);

  let backend = null, backendPromise = null, engine = null, testFactory = null;
  let account = null, authKnown = false, linkRequested = false, busy = false;
  let phase = 'idle', lastResult = null, lastError = null, heldDeletes = 0, bulkAck = null;
  let pendingSet = new Set(), metaCache = null, showConflicts = false;
  let debounceTimer = null, retryTimer = null, retryDelay = 0;

  const el = id => document.getElementById(id);
  const metaKey = () => BOOK_PREFIX + 'personal_sync';

  function deviceId() {
    const key = BOOK_PREFIX + 'device_id';
    try {
      let id = localStorage.getItem(key);
      if (!id) { id = uid('dev'); localStorage.setItem(key, id); }
      return id;
    } catch {
      return (window.__ledgerDeviceId = window.__ledgerDeviceId || uid('dev'));
    }
  }

  function loadMeta() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(metaKey()) || 'null'); } catch { raw = null; }
    const meta = Core.normalizeMeta(raw, deviceId());
    metaCache = { uid: meta.uid, email: meta.email, conflicts: meta.conflicts.length, lastSyncAt: meta.lastSyncAt, skipped: meta.skipped };
    return meta;
  }

  function saveMeta(meta) {
    try {
      localStorage.setItem(metaKey(), JSON.stringify(meta));
      metaCache = { uid: meta.uid, email: meta.email, conflicts: meta.conflicts.length, lastSyncAt: meta.lastSyncAt, skipped: meta.skipped };
      return true;
    } catch {
      return false;
    }
  }

  const info = () => metaCache || (loadMeta(), metaCache);
  // 沒有 Firebase 設定或直接開啟 HTML 檔時，一律視為只存本機。
  const isLinked = () => book === 'personal' && configured && !fileMode && Boolean(info().uid);
  const mismatch = () => Boolean(account && info().uid && info().uid !== account.uid);

  function toError(e, fallback = 'unknown') {
    let code = e instanceof Core.SyncError ? e.code : (backend ? backend.classify(e) : LedgerFirebase.classify(e));
    if (code === 'unknown') code = fallback;
    if (code === 'unknown') console.warn('sync error', e);
    return { code, message: MESSAGES[code] || MESSAGES.unknown, detail: e && e.detail, at: Date.now() };
  }

  function canSync() {
    return configured && !fileMode && Boolean(backend && engine && account) && book === 'personal'
      && !storageBlocked && info().uid === account.uid;
  }

  function refreshPending() {
    if (!isLinked()) { pendingSet = new Set(); return; }
    try {
      pendingSet = new Set(Core.computePending(state, loadMeta()).map(p => p.key));
    } catch {
      pendingSet = new Set();
    }
  }

  function rerender() {
    if (state.activeView === 'record') updateSyncStatusUI();
    else renderAll();
  }

  // ---------- 雲端連線 ----------
  function createEngine() {
    return Core.createEngine({
      backend,
      ledger: { get: ledgerForSync, apply: applyFromSync },
      metaStore: { load: loadMeta, save: saveMeta },
      bulkAck: () => bulkAck,
    });
  }

  function ledgerForSync() {
    if (book !== 'personal') throw new Core.SyncError('book-changed', MESSAGES['book-changed']);
    return state;
  }

  // 套用雲端變更前先用匯入備份的檢查規則驗證，確保帳本下次仍能正常開啟。
  function applyFromSync(mutator) {
    if (book !== 'personal') throw new Core.SyncError('book-changed', MESSAGES['book-changed']);
    try {
      return commit(next => {
        mutator(next);
        validateBackup(clone(next));
      }, { stamp: false, source: 'sync' });
    } catch (e) {
      if (e instanceof Core.SyncError) throw e;
      console.warn('sync apply rejected', e);
      throw new Core.SyncError('invalid-remote', MESSAGES['invalid-remote']);
    }
  }

  function startBackend() {
    if (backend) return Promise.resolve(backend);
    if (backendPromise) return backendPromise;
    const factory = testFactory || (opts => LedgerFirebase.create(config, opts));
    backendPromise = factory({ onAuth })
      .then(b => {
        backend = b;
        engine = createEngine();
        if (lastError && lastError.code === 'sdk-load') lastError = null;
        render();
        if (account) schedule(0);
        return b;
      })
      .catch(e => {
        backendPromise = null;
        lastError = toError(e, 'sdk-load');
        render();
        throw e;
      });
    return backendPromise;
  }

  function onAuth(user) {
    account = user;
    authKnown = true;
    if (user && book === 'personal' && !mismatch()) {
      if (info().uid === user.uid) schedule(0);
      else if (linkRequested) { linkRequested = false; setTimeout(promptLink, 0); }
    }
    render();
  }

  async function signIn() {
    linkRequested = true;
    busy = true;
    lastError = null;
    render();
    try {
      const b = await startBackend();
      if (account) {
        linkRequested = false;
        if (!info().uid) promptLink(); else schedule(0);
      } else {
        await b.signIn();
      }
    } catch (e) {
      linkRequested = false;
      lastError = toError(e);
    } finally {
      busy = false;
      render();
    }
  }

  function promptLink() {
    if (!account || book !== 'personal' || info().uid) return render();
    const count = state.records.filter(r => !Core.isDemoSeedRecord(r)).length;
    if (!count) return link();
    openDialog({
      title: '連結此裝置的帳本？',
      message: `此裝置的個人帳本有 ${count} 筆紀錄。\n連結後會與 ${account.email || '這個 Google 帳號'} 的雲端帳本合併成同一本，相同的紀錄不會重複。之後在任何一台裝置新增、修改或刪除，都會同步到其他裝置。\n示例帳本不會上傳。`,
      checkbox: { label: '連結前先下載此裝置的完整備份（建議）', checked: true },
      confirmText: '連結並同步',
      onConfirm: (_, backupFirst) => {
        if (backupFirst) exportBackup();
        link();
      },
    });
  }

  function link() {
    const meta = loadMeta();
    meta.uid = account.uid;
    meta.email = account.email || '';
    meta.linkedAt = Date.now();
    if (!saveMeta(meta)) {
      lastError = toError(new Core.SyncError('local-save'));
      return render();
    }
    refreshPending();
    schedule(0);
    rerender();
  }

  function signOut() {
    const n = pendingSet.size;
    openDialog({
      title: '登出 Google 帳號？',
      message: n
        ? `還有 ${n} 項變更尚未上傳。登出後不會再同步，但資料仍保留在此裝置；之後用同一個帳號登入，會繼續上傳。`
        : '登出後此裝置不再同步，帳本仍保留在此裝置。之後用同一個帳號登入，即可繼續同步。',
      confirmText: '登出',
      onConfirm: async () => {
        try { await backend.signOut(); } catch (e) { lastError = toError(e); }
        render();
      },
    });
  }

  function unlink() {
    openDialog({
      title: '解除此裝置的連結？',
      message: '此裝置的帳本會保留，但不再對應雲端帳本，也不會刪除雲端資料。之後再登入時，會重新詢問是否合併。',
      confirmText: '解除連結',
      onConfirm: () => {
        try { localStorage.removeItem(metaKey()); } catch {}
        metaCache = null;
        lastError = null; lastResult = null; heldDeletes = 0; showConflicts = false;
        refreshPending();
        rerender();
      },
    });
  }

  // ---------- 自動同步 ----------
  function schedule(delay = DEBOUNCE_MS) {
    if (!canSync()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSync, delay);
  }

  function scheduleRetry(code) {
    clearTimeout(retryTimer);
    retryDelay = code === 'quota' ? QUOTA_RETRY_MS : Math.min(MAX_RETRY_MS, Math.max(30000, retryDelay * 2));
    retryTimer = setTimeout(() => schedule(0), retryDelay);
  }

  function withLock(fn) {
    // 同一台裝置開了多個分頁時，只讓一個分頁同步。
    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request('daily-ledger-sync', { ifAvailable: true }, lock => (lock ? fn() : null));
    }
    return fn();
  }

  async function runSync() {
    clearTimeout(debounceTimer);
    if (!canSync()) return render();
    phase = 'syncing';
    updateSyncStatusUI();
    try {
      const result = await withLock(() => engine.sync());
      if (result) {
        lastResult = result;
        lastError = null;
        retryDelay = 0;
        heldDeletes = result.heldDeletes;
        if (result.conflicts) showToast(`有 ${result.conflicts} 項在不同裝置都改過，已保留較新的版本，可在設定查看`);
      }
    } catch (e) {
      lastError = toError(e);
      if (lastError.code === 'offline' || lastError.code === 'quota') scheduleRetry(lastError.code);
    } finally {
      phase = 'idle';
      refreshPending();
      rerender();
    }
  }

  // 使用者確認過的大量變更（匯入取代、還原、確認刪除），10 分鐘內不再暫停刪除。
  function acknowledgeBulkChange(count) {
    if (!isLinked()) return;
    bulkAck = { count: Math.max(1, count) + 50, until: Date.now() + 10 * 60 * 1000 };
  }

  function confirmHeldDeletes() {
    openDialog({
      title: `確認刪除 ${heldDeletes} 筆紀錄？`,
      message: '這些刪除會同步到所有裝置。若不是你要的，請先不要確認，改用「還原匯入前帳本」或匯入備份找回。',
      confirmText: '確認刪除並同步',
      onConfirm: () => {
        acknowledgeBulkChange(heldDeletes);
        schedule(0);
      },
    });
  }

  // ---------- 衝突紀錄 ----------
  function describe(key, data, del) {
    const [kind] = Core.splitKey(key);
    if (del || !data) return '（已刪除）';
    if (kind === 'rec') {
      const who = data.merchant || getCategoryById(data.categoryId).name;
      return `${data.date.slice(5).replace('-', '/')} ${who} ${data.type === 'income' ? '+' : ''}$${formatMoney(data.amount)}${data.note ? '・' + data.note : ''}`;
    }
    if (kind === 'cat') return `分類「${data.name}」`;
    if (kind === 'mer') return `${data.type === 'income' ? '收入來源' : '店家'}「${data.name}」${data.archived ? '（已停用）' : ''}`;
    return '首頁顯示與記帳偏好';
  }

  const kindLabel = key => ({ rec: '紀錄', cat: '分類', mer: '店家／來源', pref: '偏好設定' })[Core.splitKey(key)[0]] || '項目';

  function useOtherVersion(index) {
    const c = loadMeta().conflicts[index];
    if (!c) return;
    openDialog({
      title: '改用另一個版本？',
      message: `${kindLabel(c.key)}：${describe(c.key, c.other.data, c.other.del)}\n會取代目前的版本，並同步到其他裝置。`,
      confirmText: '改用這個版本',
      onConfirm: () => {
        const ok = commit(s => {
          Core.applyEntity(s, c.key, c.other.del ? null : c.other.data);
          Core.repairInvariants(s);
        });
        if (!ok) return false;
        const meta = loadMeta();
        meta.conflicts.splice(index, 1);
        saveMeta(meta);
        renderAll();
        showToast('已改用另一個版本');
      },
    });
  }

  function renderConflicts(box) {
    const list = loadMeta().conflicts;
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<p class="text-xs text-textMuted">目前沒有衝突紀錄。</p>';
      return;
    }
    list.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'sync-conflict';
      const when = new Date(c.at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      row.innerHTML = `<div class="text-xs text-textMuted">${escapeHtml(when)}・${escapeHtml(kindLabel(c.key))}</div>
        <div class="text-sm">目前：${escapeHtml(describe(c.key, c.keptData, !c.keptData))}</div>
        <div class="text-xs text-textMuted">另一版本：${escapeHtml(describe(c.key, c.other.data, c.other.del))}</div>`;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'action';
      b.textContent = '改用另一版本';
      b.onclick = () => useOtherVersion(i);
      row.appendChild(b);
      box.appendChild(row);
    });
  }

  // ---------- 狀態顯示 ----------
  function badge() {
    if (book !== 'personal') return { text: '示例・不同步', tone: 'muted' };
    if (!isLinked()) return { text: '僅存本機', tone: 'ok' };
    const n = pendingSet.size;
    if (mismatch()) return { text: '同步暫停', tone: 'danger' };
    if (phase === 'syncing') return { text: '同步中…', tone: 'accent' };
    if (lastError && !TRANSIENT.has(lastError.code)) return { text: '同步失敗', tone: 'danger' };
    if (heldDeletes) return { text: '待確認刪除', tone: 'warn' };
    if (n) return { text: `待同步 ${n}`, tone: 'warn' };
    if (lastError) return { text: '離線', tone: 'muted' };
    if (authKnown && !account) return { text: '已登出', tone: 'muted' };
    if (!backend) return { text: '連線中…', tone: 'muted' };
    return { text: '已同步', tone: 'ok' };
  }

  const formatTime = ms => (ms ? new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未同步');

  function render() {
    updateSyncStatusUI();
  }

  function renderPanel() {
    if (!el('syncSection')) return;
    const m = info(), n = pendingSet.size, linked = isLinked();
    const show = (id, on, text) => {
      el(id).classList.toggle('hidden', !on);
      if (text !== undefined) el(id).textContent = text;
    };
    let summary = '', accountLine = '', error = '';
    const buttons = { signIn: false, now: false, deletes: false, conflicts: false, signOut: false, unlink: false };
    let signInText = '使用 Google 登入並同步', nowText = '立即同步';

    if (book !== 'personal') {
      summary = '示例帳本不會同步，也不會上傳。切換到個人帳本後，才能使用雲端同步。';
    } else if (fileMode) {
      summary = '目前是直接開啟的 HTML 檔案，無法使用 Google 登入。請改用網站網址開啟才能同步；帳本仍存在此瀏覽器。';
    } else if (!configured) {
      summary = '同步服務尚未設定。完成 Firebase 專案設定並填入設定值後，這裡會出現「使用 Google 登入」。目前帳本只存在此瀏覽器。';
    } else if (mismatch()) {
      summary = `此裝置的個人帳本已連結 ${m.email || '另一個帳號'}，與目前登入的 ${account.email || '帳號'} 不同。為避免兩本帳本混在一起，已停止同步。`;
      buttons.signOut = buttons.unlink = true;
    } else if (!linked) {
      if (account) {
        summary = `已登入 ${account.email}，尚未連結此裝置的帳本。`;
        buttons.now = buttons.signOut = true;
        nowText = '連結並同步';
      } else {
        summary = '登入後，個人帳本會同步到你 Google 帳號專屬的雲端空間；其他裝置用同一個帳號登入，就會看到同一本帳本。示例帳本不會上傳。';
        buttons.signIn = true;
      }
    } else if (authKnown && !account) {
      summary = `此裝置的帳本已連結 ${m.email}，但目前已登出，變更不會上傳。${n ? `尚有 ${n} 項變更等待上傳。` : ''}`;
      buttons.signIn = buttons.unlink = true;
      signInText = '重新登入';
    } else if (!account) {
      summary = backendPromise ? '正在連線同步服務…' : `此裝置的帳本已連結 ${m.email}。${n ? `有 ${n} 項變更等待上傳。` : ''}`;
      buttons.now = !backendPromise;
      nowText = '重新連線';
    } else {
      summary = phase === 'syncing' ? '同步中…' : (n ? `有 ${n} 項變更等待上傳。` : '已同步。');
      summary += ` 最後同步：${formatTime(m.lastSyncAt)}`;
      accountLine = `帳號：${account.email}`;
      buttons.now = buttons.signOut = true;
      buttons.deletes = heldDeletes > 0;
      buttons.conflicts = m.conflicts > 0;
    }
    if (book === 'personal' && lastError && configured && !fileMode) error = lastError.message;
    if (heldDeletes && buttons.deletes) error = `偵測到一次刪除 ${heldDeletes} 筆紀錄。為避免誤刪同步到所有裝置，這些刪除尚未上傳。確認是你要刪除的，再按「確認刪除並同步」。`;
    if (m.skipped && linked) error += `${error ? '\n' : ''}有 ${m.skipped} 筆雲端資料格式不符，已略過。`;

    el('syncSummary').textContent = summary;
    show('syncAccount', Boolean(accountLine), accountLine);
    show('syncError', Boolean(error), error);
    show('btnSyncSignIn', buttons.signIn, busy ? '登入中…' : signInText);
    el('btnSyncSignIn').disabled = busy;
    show('btnSyncNow', buttons.now, nowText);
    el('btnSyncNow').disabled = phase === 'syncing';
    show('btnSyncConfirmDeletes', buttons.deletes);
    show('btnSyncConflicts', buttons.conflicts, `衝突紀錄（${m.conflicts}）`);
    show('btnSyncSignOut', buttons.signOut);
    show('btnSyncUnlink', buttons.unlink);
    const conflictBox = el('syncConflictList');
    conflictBox.classList.toggle('hidden', !(showConflicts && buttons.conflicts));
    if (showConflicts && buttons.conflicts) renderConflicts(conflictBox);

    el('syncChip').textContent = badge().text;
    renderBackupTexts(linked);
    // 打開設定頁時先在背景載入同步元件，按下登入時才能立刻開啟登入視窗（避免被瀏覽器擋下）。
    if (state.activeView === 'settings' && configured && !fileMode && book === 'personal' && !backend && !backendPromise && !lastError) {
      startBackend().catch(() => {});
    }
  }

  function renderBackupTexts(linked) {
    if (!el('backupIntro')) return;
    el('backupIntro').textContent = linked
      ? '資料存放於此瀏覽器，並同步到你 Google 帳號專屬的雲端空間。同步不是備份：在任何裝置刪除，其他裝置也會刪除。'
      : '資料存放於此瀏覽器，目前沒有雲端同步。';
    el('backupHint').textContent = linked
      ? '請定期下載完整備份，誤刪時可以匯入找回。清除瀏覽器資料只會移除此裝置的副本，但尚未上傳的變更會一併遺失。'
      : '更換裝置前，請下載備份並在新裝置匯入。清除瀏覽器資料可能移除本機帳本。';
    let last = 0;
    try { last = Number(localStorage.getItem(storageKey() + '_last_backup')) || 0; } catch {}
    const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
    el('backupAge').textContent = days === null ? '此裝置尚未下載過備份。' : `此裝置上次下載備份：${days === 0 ? '今天' : `${days} 天前`}。`;
  }

  function savedMessage() {
    if (!isLinked() || !configured || fileMode) return '已儲存在此瀏覽器';
    if (!account) return '已儲存在此裝置；登入後會同步';
    return navigator.onLine === false ? '已儲存在此裝置，恢復連線後會同步' : '已儲存，正在同步';
  }

  function afterCommit(opts = {}) {
    refreshPending();
    if (opts.source !== 'sync') schedule(DEBOUNCE_MS);
  }

  function onBookChanged() {
    metaCache = null;
    lastError = null; lastResult = null; heldDeletes = 0; showConflicts = false; bulkAck = null;
    refreshPending();
    if (book === 'personal' && configured && !fileMode && info().uid) {
      startBackend().then(() => schedule(0)).catch(() => {});
    }
    render();
  }

  function init() {
    el('btnSyncSignIn').onclick = signIn;
    el('btnSyncNow').onclick = () => {
      lastError = null;
      if (!backend) return startBackend().catch(() => {});
      if (!info().uid && account) return promptLink();
      runSync();
    };
    el('btnSyncSignOut').onclick = signOut;
    el('btnSyncUnlink').onclick = unlink;
    el('btnSyncConfirmDeletes').onclick = confirmHeldDeletes;
    el('btnSyncConflicts').onclick = () => { showConflicts = !showConflicts; renderPanel(); };
    window.addEventListener('online', () => { lastError = null; if (backend) schedule(300); else if (isLinked()) startBackend().catch(() => {}); render(); });
    window.addEventListener('offline', render);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
    setInterval(() => { if (document.visibilityState === 'visible') schedule(0); }, INTERVAL_MS);
    refreshPending();
    if (configured && !fileMode && book === 'personal' && info().uid) startBackend().catch(() => {});
    rerender();
  }

  window.addEventListener('DOMContentLoaded', init);

  // 本機測試專用：讓自動測試改用模擬雲端。正式網址上不提供。
  const testApi = isLocalHost ? {
    useBackend(factory) {
      testFactory = factory;
      configured = true;
      backend = null; backendPromise = null; engine = null; account = null; authKnown = false;
      lastError = null; lastResult = null; heldDeletes = 0; metaCache = null;
    },
    start: () => startBackend(),
    sync: () => runSync(),
    signIn: () => signIn(),
    snapshot: () => ({ phase, account, lastError, lastResult, heldDeletes, pending: [...pendingSet], meta: loadMeta(), badge: badge() }),
  } : undefined;

  return {
    badge, renderPanel, afterCommit, savedMessage, onBookChanged, acknowledgeBulkChange,
    isLinked, isPending: key => pendingSet.has(key), __test: testApi,
  };
})();
