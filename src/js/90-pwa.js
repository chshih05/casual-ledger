// 網站離線載入與版本更新：註冊 Service Worker，手機沒有網路時也能開啟記帳頁（帳目本來就存在本機）。
// 每次進入網頁（開啟、或從其他 App 切回來）都檢查網站有沒有新版本。剛進入、還沒操作而且停在首頁時，
// 直接換成新版本；正在記帳、開著對話框或已經開始操作時不打斷，改在頂部顯示「有新版本・點此更新」，
// 下次進入網頁時再自動更新。
const LedgerUpdate = (() => {
  'use strict';
  const APP_VERSION = '__BUILD_VERSION__';
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const supported = 'serviceWorker' in navigator && (location.protocol === 'https:' || isLocalHost)
    && !new URLSearchParams(location.search).has('nosw');
  const UPDATED_KEY = 'ledger_updated_from';
  const STATUS_TEXT = {
    unsupported: '直接開啟檔案或測試網址時不會檢查新版本。',
    checking: '正在檢查有沒有新版本…',
    downloading: '發現新版本，正在下載…',
    ready: '有新版本可以使用。',
    error: '目前無法取得新版本（可能沒有網路），下次開啟網頁時會再試。',
  };
  let reg = null, waiting = null, outdated = false, applying = false, touched = false;
  let checking = false, failed = false, checkedAt = 0;
  let controller = supported ? navigator.serviceWorker.controller : null;

  const el = id => document.getElementById(id);
  const closed = id => el(id).classList.contains('hidden');
  const clock = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  function status() {
    if (waiting || outdated) return 'ready';
    if (!supported) return 'unsupported';
    if (reg && reg.installing) return 'downloading';
    if (checking || (!checkedAt && !failed)) return 'checking';
    return failed ? 'error' : 'latest';
  }

  function render() {
    if (!el('appUpdateStatus')) return;
    const now = status();
    el('appUpdateStatus').textContent = now === 'latest'
      ? `已是最新版本（${clock(checkedAt)} 檢查）。每次開啟網頁都會自動檢查。`
      : STATUS_TEXT[now];
    el('btnTopUpdate').classList.toggle('hidden', now !== 'ready');
    el('btnApplyUpdate').classList.toggle('hidden', now !== 'ready');
    el('btnCheckUpdate').classList.toggle('hidden', now !== 'latest' && now !== 'error');
  }

  // 剛進入網頁、還沒點任何東西，而且停在首頁沒有開著對話框時，重新開啟不會打斷任何操作。
  function quiet() {
    return !touched && typeof state === 'object' && state !== null && state.activeView === 'home'
      && ['modalDialog', 'modalDrilldown', 'undoBar'].every(closed);
  }

  function apply() {
    if (!waiting && !outdated) return;
    applying = true;
    try { sessionStorage.setItem(UPDATED_KEY, APP_VERSION); } catch {}
    if (waiting) waiting.postMessage('SKIP_WAITING'); // 新版本接手後（controllerchange）重新開啟
    else location.reload();
  }

  function ready() {
    if (quiet()) apply();
    render();
  }

  // 已經下載好的新版本直接處理；否則請瀏覽器重新下載 sw.js 比對，內容不同就會開始下載新版本。
  async function check() {
    if (applying) return;
    if (reg && reg.waiting && navigator.serviceWorker.controller) waiting = reg.waiting;
    if (waiting || outdated) return ready();
    if (!reg || checking) return;
    checking = true;
    render();
    try {
      await reg.update();
      failed = false;
      checkedAt = Date.now();
    } catch {
      failed = true;
    }
    checking = false;
    render();
  }

  function entered() {
    touched = false;
    check();
  }

  function watch(worker) {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        waiting = worker;
        ready();
        return;
      }
      // 下載中斷，或拿到的檔案不是同一版（見 sw.js）：這次放棄，下次進入網頁再試。
      if (worker.state === 'redundant' && worker !== waiting) failed = true;
      render();
    });
    render();
  }

  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    document.addEventListener(type, () => { touched = true; }, { capture: true, passive: true });
  }

  window.addEventListener('DOMContentLoaded', () => {
    el('btnTopUpdate').addEventListener('click', () => {
      if (state.activeView !== 'record') return apply();
      openDialog({ title: '更新到新版本？', message: '網頁會重新開啟，這筆還沒儲存的內容會被捨棄。', confirmText: '更新', onConfirm: apply });
    });
    el('btnApplyUpdate').addEventListener('click', apply);
    el('btnCheckUpdate').addEventListener('click', () => check());
    let from = null;
    try { from = sessionStorage.getItem(UPDATED_KEY); sessionStorage.removeItem(UPDATED_KEY); } catch {}
    if (from && from !== APP_VERSION) showToast('已更新到最新版本');
    render();
  });

  if (supported) {
    window.addEventListener('load', async () => {
      try {
        reg = await navigator.serviceWorker.register('sw.js');
      } catch (e) {
        console.warn('service worker registration failed', e);
        failed = true;
        render();
        return;
      }
      reg.addEventListener('updatefound', () => { if (reg.installing) watch(reg.installing); });
      // 第一次開啟（還沒有 Service Worker）時，網頁直接取自網站，本來就是最新版本。
      if (navigator.serviceWorker.controller) check();
      else { checkedAt = Date.now(); render(); }
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const previous = controller;
      controller = navigator.serviceWorker.controller;
      if (applying) { location.reload(); return; }
      // 另一個分頁已經換成新版本，這一頁仍是舊版。
      if (previous) { outdated = true; waiting = null; ready(); }
    });

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') entered(); });
    window.addEventListener('pageshow', e => { if (e.persisted) entered(); });
    window.addEventListener('online', () => { if (failed) check(); });
  }

  // 本機測試專用：模擬「新版本已下載好」與「重新進入網頁」。正式網址上不提供。
  const testApi = isLocalHost ? {
    offer(worker) { waiting = worker; ready(); },
    enter: entered,
    snapshot: () => ({ status: status(), applying, touched }),
  } : undefined;

  return { check, __test: testApi };
})();
