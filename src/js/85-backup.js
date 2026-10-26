// 備份提醒與雲端自動備份。同步不是備份：在任何一台裝置刪除，其他裝置也會刪除。
// - 提醒：很久沒備份、又記了不少筆時，在首頁提醒下載完整備份（沒有連結雲端也適用）。
// - 雲端自動備份：有連結 Google 雲端同步時，每週在雲端另存一份完整備份（users/{uid}/backups/{週代號}）。
//   和同步的資料分開，安全規則只允許新增、不能修改或刪除，誤刪或同步出錯時可以在設定頁找回。
const LedgerBackup = (() => {
  'use strict';
  const DAY_MS = 86400000;
  const REMIND_AFTER_DAYS = 30;        // 距離上次備份超過這麼多天，
  const REMIND_MIN_CHANGES = 30;       // 而且之後新增、修改或刪除了這麼多筆，才提醒
  const SNOOZE_DAYS = 7;               // 按「稍後提醒」之後幾天內不再提醒
  const RETRY_AFTER_ERROR_MS = DAY_MS; // 雲端備份失敗（例如安全規則還沒更新）後，隔多久再試
  const PART_BYTES = 900000;           // 每段內容的上限：Firestore 一份文件最多 1 MiB
  const MAX_PARTS = 10;
  const LIST_LIMIT = 8;                // 設定頁列出最近幾份
  const APP_VERSION = '__BUILD_VERSION__';
  const ERROR_TEXT = {
    rules: '雲端拒絕儲存備份：Firebase 的安全規則還沒更新。請把 firestore.rules 的新內容貼到 Firebase 主控台並發布（步驟見 README）；在那之前請記得下載備份。',
    'too-large': '帳本太大，無法存成雲端備份，請改用「下載完整備份」。',
    other: '上次雲端備份沒有成功，之後同步時會再試一次。',
  };
  const keys = {
    lastDownload: () => storageKey() + '_last_backup',
    snooze: () => storageKey() + '_backup_snooze',
    cloud: () => BOOK_PREFIX + 'personal_cloud_backup',
  };
  let running = false;
  let list = null; // 設定頁的雲端備份清單：null 是收起；{loading} 讀取中；{items} 或 {error}

  const readNumber = key => { try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; } };
  const formatWhen = ms => new Date(ms).toLocaleString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const shortDay = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };

  // 這台裝置記得的雲端備份狀態：{uid, week, at, records}，失敗時另有 {error, errorAt}；只對同一個雲端帳號有效。
  function cloudInfo(uid = LedgerSync.linkedUid()) {
    if (!uid) return null;
    try {
      const info = JSON.parse(localStorage.getItem(keys.cloud()) || 'null');
      return info && info.uid === uid ? info : null;
    } catch { return null; }
  }
  function saveCloudInfo(info) { try { localStorage.setItem(keys.cloud(), JSON.stringify(info)); } catch {} }

  // ISO 週（週一開始），例如 2026-W44：同一週只存一份，兩台裝置也不會各存一份。
  function weekId(date = new Date()) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const week = Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  // ---------- 首頁提醒 ----------
  function reminder(now = Date.now()) {
    if (storageBlocked || !state.records.length || now < readNumber(keys.snooze())) return null;
    const cloud = cloudInfo(), last = Math.max(readNumber(keys.lastDownload()), (cloud && cloud.at) || 0);
    if (last && now - last < REMIND_AFTER_DAYS * DAY_MS) return null;
    // 上次備份之後新增、修改或刪除的紀錄；從沒備份過就是全部紀錄。
    const times = state.entityTimes || {};
    const changed = last ? Object.keys(times).filter(k => k.startsWith('rec:') && times[k] > last).length : state.records.length;
    return changed >= REMIND_MIN_CHANGES ? { changed, days: last ? Math.floor((now - last) / DAY_MS) : null } : null;
  }
  function renderReminder() {
    const r = reminder();
    $('backupReminder').classList.toggle('hidden', !r);
    if (!r) return;
    $('backupReminderText').textContent = r.days === null
      ? `還沒有下載過備份，帳本已經有 ${r.changed} 筆紀錄。下載一份存到雲端硬碟或電腦，換手機或誤刪時可以找回。`
      : `上次備份是 ${r.days} 天前，之後新增或修改了 ${r.changed} 筆。下載一份新的備份，誤刪時可以找回。`;
  }

  // ---------- 備份內容：壓縮後分段 ----------
  async function pack(text) {
    const raw = new TextEncoder().encode(text);
    let bytes = raw, enc = 'json';
    if (typeof CompressionStream === 'function') {
      try {
        bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        enc = 'gzip';
      } catch { bytes = raw; enc = 'json'; }
    }
    const parts = [];
    for (let i = 0; i < bytes.length; i += PART_BYTES) parts.push(bytes.slice(i, i + PART_BYTES));
    return { enc, size: raw.length, parts };
  }
  async function unpack(enc, parts) {
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; }
    if (enc === 'json') return new TextDecoder().decode(bytes);
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }
  function deviceLabel() { try { return (localStorage.getItem(BOOK_PREFIX + 'device_id') || '').slice(0, 80); } catch { return ''; } }

  // ---------- 雲端自動備份 ----------
  // 每次同步成功後檢查：這一週還沒有備份就存一份。同一週已經有（這台或其他裝置存的）就只記下來。
  async function afterSync() {
    const backend = LedgerSync.readyBackend(), uid = LedgerSync.linkedUid();
    if (!backend || !uid || typeof backend.saveBackup !== 'function') return;
    // 還有等待確認的大量刪除時先不存，避免把還沒確認的刪除存成備份。
    if (running || storageBlocked || LedgerSync.heldDeletes() || !state.records.length) return;
    const week = weekId(), info = cloudInfo(uid);
    if (info && info.week === week) return;
    if (info && info.errorAt && Date.now() - info.errorAt < RETRY_AFTER_ERROR_MS) return;
    running = true;
    try {
      const existing = await backend.getBackup(week);
      if (existing) { saveCloudInfo({ uid, week, at: existing.at, records: existing.records }); return; }
      const packed = await pack(JSON.stringify(backupEnvelope()));
      if (packed.parts.length > MAX_PARTS) { saveCloudInfo({ ...(info || {}), uid, error: 'too-large', errorAt: Date.now() }); return; }
      const meta = { t: Date.now(), records: state.records.length, size: packed.size, enc: packed.enc, dev: deviceLabel(), app: APP_VERSION };
      await backend.saveBackup(week, meta, packed.parts);
      saveCloudInfo({ uid, week, at: meta.t, records: meta.records });
    } catch (e) {
      // 離線就等下次同步再試；其他錯誤（例如安全規則還沒更新）隔一段時間再試，期間在設定頁說明。
      const code = backend.classify(e);
      if (code === 'unknown') console.warn('cloud backup failed', e);
      if (code !== 'offline') saveCloudInfo({ ...(cloudInfo(uid) || {}), uid, error: code === 'permission' ? 'rules' : 'other', errorAt: Date.now() });
    } finally {
      running = false;
      refresh();
    }
  }

  // ---------- 設定頁：資料與備份 ----------
  // 設定第一頁「備份」卡片後面接的一句話。
  function cloudSummary() {
    const info = cloudInfo();
    return info && info.at ? `雲端備份：${shortDay(info.at)}。` : '';
  }
  function renderSection() {
    const uid = LedgerSync.linkedUid(), info = cloudInfo(uid), ready = Boolean(LedgerSync.readyBackend());
    let status;
    if (!uid) status = '連結 Google 雲端同步後，每週會自動在雲端另存一份完整備份。這份備份不會被同步或刪除影響，誤刪時可以從這裡找回。';
    else if (info && info.at) status = `每週自動備份一次。最近一次：${formatWhen(info.at)}（${info.records.toLocaleString('zh-TW')} 筆紀錄）。`;
    else status = '每週自動備份一次，下次同步完成後會存第一份。';
    if (uid && !ready) status += '登入後可以查看與還原。';
    $('cloudBackupStatus').textContent = status;
    const error = uid && info && info.error ? ERROR_TEXT[info.error] || ERROR_TEXT.other : '';
    $('cloudBackupError').textContent = error;
    $('cloudBackupError').classList.toggle('hidden', !error);
    const button = $('btnCloudBackupList');
    button.classList.toggle('hidden', !uid);
    button.disabled = !ready || Boolean(list && list.loading);
    button.textContent = list && !list.loading ? '收起雲端備份' : '查看雲端備份';
    renderList();
  }
  function note(text) { const p = document.createElement('p'); p.className = 'text-xs text-textMuted'; p.textContent = text; return p; }
  function renderList() {
    const box = $('cloudBackupList');
    box.classList.toggle('hidden', !list);
    box.innerHTML = '';
    if (!list) return;
    if (list.loading) return box.appendChild(note('讀取中…'));
    if (list.error) return box.appendChild(note(list.error));
    if (!list.items.length) return box.appendChild(note('雲端還沒有備份。'));
    for (const item of list.items) {
      const row = document.createElement('div');
      row.className = 'cloud-backup-row';
      const label = document.createElement('span');
      label.textContent = `${formatWhen(item.at)}・${item.records.toLocaleString('zh-TW')} 筆紀錄`;
      const actions = document.createElement('div');
      actions.className = 'cloud-backup-actions';
      for (const [text, run] of [['還原', restore], ['下載', download]]) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'action'; b.textContent = text;
        b.setAttribute('aria-label', `${text}${formatWhen(item.at)}的雲端備份`);
        b.onclick = () => run(item);
        actions.appendChild(b);
      }
      row.append(label, actions);
      box.appendChild(row);
    }
  }
  async function toggleList() {
    if (list) { list = null; return renderSection(); }
    const backend = LedgerSync.readyBackend();
    if (!backend) return;
    list = { loading: true };
    renderSection();
    try {
      list = { items: await backend.listBackups(LIST_LIMIT) };
      // 讀得到雲端備份，表示安全規則已經更新：不用等隔天，馬上再試著存這一週的備份。
      const uid = LedgerSync.linkedUid(), info = cloudInfo(uid);
      if (info && info.error === 'rules') {
        const { error, errorAt, ...rest } = info;
        saveCloudInfo(rest);
        afterSync().catch(() => {});
      }
    } catch (e) {
      list = { error: backend.classify(e) === 'permission' ? ERROR_TEXT.rules : '無法讀取雲端備份（可能沒有網路），請稍後再試。' };
    }
    renderSection();
  }
  // 下載並解開一份雲端備份；雲端或網路的錯誤換成看得懂的說明。
  async function fetchText(item) {
    const backend = LedgerSync.readyBackend();
    if (!backend) throw new Error('請先登入雲端同步。');
    let parts;
    try { parts = await backend.loadBackup(item.id); }
    catch { throw new Error('讀不到雲端備份（可能沒有網路），請稍後再試。'); }
    if (parts.length !== item.parts) throw new Error('雲端備份不完整。');
    return unpack(item.enc, parts);
  }
  // 還原：和匯入備份檔一樣先列出會怎麼合併，確認後才寫入（預設合併，也可以改為完全取代）。
  async function restore(item) {
    try { prepareImportText(await fetchText(item), { title: `從雲端備份還原（${formatWhen(item.at)}）` }); }
    catch (e) { showToast('無法還原：' + e.message); }
  }
  async function download(item) {
    try { downloadText(await fetchText(item), `記帳-雲端備份-${item.id}.json`); }
    catch (e) { showToast('無法下載：' + e.message); }
  }

  function refresh() {
    renderReminder();
    if (state.activeView === 'settings' && state.settingsPage === 'data') renderSection();
    updateSyncStatusUI();
  }

  window.addEventListener('DOMContentLoaded', () => {
    $('btnReminderBackup').onclick = () => { exportBackup(); refresh(); };
    $('btnReminderLater').onclick = () => {
      try { localStorage.setItem(keys.snooze(), String(Date.now() + SNOOZE_DAYS * DAY_MS)); } catch {}
      renderReminder();
    };
    $('btnCloudBackupList').onclick = toggleList;
  });

  return { afterSync, renderReminder, renderSection, cloudSummary, weekId, pack, unpack };
})();
