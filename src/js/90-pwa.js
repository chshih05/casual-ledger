// 網站離線載入：註冊 Service Worker，手機沒有網路時也能開啟記帳頁（帳目本來就存在本機）。
// 有新版本時不自動重新整理（避免中斷記帳），改在設定頁顯示「更新並重新開啟」。
(() => {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const allowed = 'serviceWorker' in navigator && (location.protocol === 'https:' || local)
    && !new URLSearchParams(location.search).has('nosw');
  if (!allowed) return;
  let waiting = null, updateRequested = false;

  function offerUpdate(worker) {
    waiting = worker;
    const box = document.getElementById('appUpdateBox');
    if (box) box.classList.remove('hidden');
  }

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
    } catch (e) {
      console.warn('service worker registration failed', e);
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) location.reload();
  });

  document.addEventListener('click', e => {
    if (e.target && e.target.id === 'btnApplyUpdate' && waiting) {
      updateRequested = true;
      waiting.postMessage('SKIP_WAITING');
    }
  });
})();
