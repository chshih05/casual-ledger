// 返回手勢：Android 的返回手勢（以及瀏覽器的上一頁）關掉最上面的畫面，而不是離開網頁。
// 記帳頁、設定分頁、明細、分類編輯與對話框，每開一層就加一筆瀏覽紀錄（history.pushState）；
// 用畫面上的按鈕關閉時，收回對應的紀錄，之後按返回才不會停在原地。
// 開關畫面的地方很多，這裡不在每個地方各自處理，而是觀察這幾個畫面的 class，統一比對開了幾層。
const LedgerBack = (() => {
  'use strict';
  const shown = id => { const el = document.getElementById(id); return Boolean(el) && !el.classList.contains('hidden'); };
  // 由上而下排列：按返回時先關最上層。
  const LAYERS = [
    { isOpen: () => shown('modalDialog'), close: () => closeDialog() },
    { isOpen: () => shown('modalCategory'), close: () => closeCategoryEditor() },
    { isOpen: () => shown('modalDrilldown'), close: () => closeDrilldown() },
    { isOpen: () => state.activeView === 'record', close: () => closeRecordPage() },
    { isOpen: () => state.activeView === 'settings' && Boolean(state.settingsPage), close: () => openSettingsPage('') },
  ];
  const WATCH = ['modalDialog', 'modalCategory', 'modalDrilldown', 'modalRecord', 'viewSettings', 'settingsHome'];
  const MOVE_TIMEOUT_MS = 1000;
  let depth = 0;        // 目前停在第幾筆加上去的紀錄；網頁原本的那一筆是第 0 層
  let moving = false;   // 自己呼叫 history.go() 移動、還沒抵達
  let moveTimer = null;

  const openCount = () => LAYERS.filter(layer => layer.isOpen()).length;
  const entryDepth = () => Number(history.state && history.state.ledgerLayer) || 0;

  // 畫面開關之後：多開了幾層就加幾筆紀錄；用按鈕關掉的層，收回對應的紀錄。
  // 同一個動作裡先關後開（例如從明細點紀錄進入修改），只比對最後的層數，原本那筆紀錄直接沿用。
  function sync() {
    // 收回紀錄要等瀏覽器移動完成；移動途中又開了畫面，抵達後再加紀錄，順序才不會錯亂。
    if (moving) return;
    const want = openCount();
    if (want > depth) {
      try { while (depth < want) { history.pushState({ ledgerLayer: depth + 1 }, ''); depth++; } } catch {}
    } else if (want < depth) {
      move(want - depth);
    }
  }
  function move(delta) {
    moving = true;
    clearTimeout(moveTimer);
    // 萬一瀏覽器沒有移動（沒有觸發 popstate），不要一直等下去。
    moveTimer = setTimeout(arrived, MOVE_TIMEOUT_MS);
    try { history.go(delta); } catch { arrived(); }
  }
  // 移動完成：以實際停在的那一筆為準，再比對一次開著的層數。
  function arrived() {
    clearTimeout(moveTimer);
    moving = false;
    depth = entryDepth();
    sync();
  }

  // 按了返回（或上一頁、下一頁）。
  function onPopState() {
    if (moving) return arrived();
    const at = entryDepth();
    if (at === depth) return;
    // 下一頁：不重新打開已經關掉的畫面，退回原本的位置。
    if (at > depth) return move(depth - at);
    depth = at;
    for (let guard = 0; openCount() > at && guard < LAYERS.length; guard++) LAYERS.find(layer => layer.isOpen()).close();
  }

  function init() {
    // 重新整理後可能停在之前加的紀錄上，但畫面已經回到首頁：把這一筆當成第 0 層。
    try { if (entryDepth()) history.replaceState({ ledgerLayer: 0 }, ''); } catch {}
    const observer = new MutationObserver(sync);
    for (const id of WATCH) observer.observe(document.getElementById(id), { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('popstate', onPopState);
    sync();
  }

  // busy：自己呼叫的 history.go() 還沒抵達（測試按返回前先等它，兩次移動才不會疊在一起）。
  return { init, openCount, busy: () => moving };
})();
