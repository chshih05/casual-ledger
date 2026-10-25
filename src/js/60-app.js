// Ledger stored in this browser. Cloud sync (55/70/80-*.js) only runs for the personal book after Google sign-in.
const $ = id => document.getElementById(id);
const clone = x => JSON.parse(JSON.stringify(x));
// 儲存時的複製：紀錄可能有上萬筆，只複製陣列、紀錄物件和上一版共用（修改紀錄一律換成新物件，
// 不在原物件上改）；其他資料量小，整份複製。修改時間表另外淺複製。
function cloneForCommit(s) {
  const {records,entityTimes,...rest}=s,next=clone(rest);
  next.records=records.slice();
  next.entityTimes={...entityTimes};
  return next;
}
const MAX_AMOUNT = 999999999;
const BOOK_PREFIX = 'minimal_expense_v3_';
// Only the personal book remains; `book` keeps the existing storage key (minimal_expense_v3_personal).
let book = 'personal', storageBlocked = false, persistedRaw = null, loadIssue = '';
let state, modalState = null, searchQuery = '', searchAcrossMonths = false;
let merchantMgrQuery = '', merchantMgrShowAll = false;
let keypadOpen = true, lastDeletedRecord = null;
window.__selectedIconKey = 'dinner';

function today(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y,m,d] = s.split('-').map(Number);
  if (y < 1900 || y > 2199) return false;
  const date = new Date(y,m-1,d);
  return date.getFullYear()===y && date.getMonth()===m-1 && date.getDate()===d;
}
function evaluateSimpleMath(expr) {
  const invalid = {valid:false,value:0,isExpression:false};
  if (typeof expr !== 'string' || expr.length > 100) return invalid;
  let s=expr.replace(/＋/g,'+').replace(/－/g,'-').replace(/\s/g,'');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:[+-](?:\d+|\d{1,3}(?:,\d{3})+))*$/.test(s)) return invalid;
  s=s.replace(/,/g,'');
  const tokens=s.match(/[+-]?\d+/g);
  let value=0;
  for (const token of tokens) {
    const number=Number(token);
    if (!Number.isSafeInteger(number) || Math.abs(number)>MAX_AMOUNT) return invalid;
    value+=number;
    if (!Number.isSafeInteger(value) || Math.abs(value)>MAX_AMOUNT) return invalid;
  }
  return {valid:value>0,value,isExpression:/[+-]/.test(s)};
}
function uid(prefix='rec') {
  return prefix+'_'+(globalThis.crypto?.randomUUID?.() || Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));
}
function freshBook() {
  const s=getInitialState();
  s.records=[]; s.merchants=[]; s.archivedMerchants=[]; s.merchantTypes={};
  s.schemaVersion=3;
  return s;
}
// The sample (demo) book was removed; clear its leftover data from this browser.
function removeSampleBook() {
  try { for (const key of ['demo','demo_before_import','demo_last_backup','active']) localStorage.removeItem(BOOK_PREFIX+key); } catch {}
}
function validateBackup(input) {
  if (input?.format && input.format!=='daily-ledger') throw new Error('這不是支援的記帳備份格式。');
  if (input?.format && input.version!==3) throw new Error('此備份版本尚不支援。');
  const src=input?.format==='daily-ledger' ? input.data : input;
  if (!src || !Array.isArray(src.records) || !Array.isArray(src.categories) || !Array.isArray(src.merchants)) throw new Error('缺少紀錄、分類或店家資料。');
  if (src.records.length>100000 || src.categories.length>500 || src.merchants.length>10000) throw new Error('備份資料量超過此版本上限。');
  const safeString=(v,max=200)=>typeof v==='string' && v.length<=max;
  const cats=new Map();
  for (const c of src.categories) {
    if (!c || !safeString(c.id,100) || !/^[\w-]+$/.test(c.id) || cats.has(c.id) || !safeString(c.name,40) || !c.name.trim() || !['expense','income'].includes(c.type) || !Number.isFinite(c.order)) throw new Error('分類資料格式錯誤或代碼重複。');
    // Keep icon keys from newer versions so a device on an older version does not overwrite them while syncing.
    cats.set(c.id,{id:c.id,type:c.type,name:c.name.trim(),icon:Object.hasOwn(ICONS,c.icon)||(typeof c.icon==='string'&&/^[\w-]{1,60}$/.test(c.icon))?c.icon:'other',order:c.order,...(c.type==='expense'&&LedgerSyncCore.validBudget(c.budget)?{budget:c.budget}:{})});
  }
  if (!['expense','income'].every(t=>[...cats.values()].some(c=>c.type===t))) throw new Error('必須保留支出及收入分類。');
  const ids=new Set(),okDates=new Set(),dateOk=d=>okDates.has(d)||(validDate(d)&&okDates.add(d));
  const records=src.records.map((r,i)=> {
    if (!r || !safeString(r.id,100) || !/^[\w-]+$/.test(r.id) || ids.has(r.id) || !dateOk(r.date) || cats.get(r.categoryId)?.type!==r.type || !Number.isSafeInteger(r.amount) || r.amount<=0 || r.amount>MAX_AMOUNT || !safeString(r.merchant,100) || !safeString(r.note,1000)) throw new Error(`第 ${i+1} 筆紀錄內容不完整、日期或金額無效。`);
    ids.add(r.id);
    return {id:r.id,seq:Number.isSafeInteger(r.seq)?r.seq:i+1,type:r.type,date:r.date,categoryId:r.categoryId,amount:r.amount,merchant:r.merchant.trim(),note:r.note};
  });
  if (!src.merchants.every(m=>safeString(m,100)&&m.trim())) throw new Error('店家名稱格式錯誤。');
  // 固定收支規則：格式不符的略過，不影響帳本其他資料。分類被刪掉的規則保留，
  // 設定頁會提示「分類已刪除，請修改」，修好之前不會自動記帳。
  const ruleIds=new Set(),recurring=[];
  for (const raw of Array.isArray(src.recurring)?src.recurring:[]) {
    if(!raw||typeof raw!=='object')continue;
    const r=LedgerSyncCore.canon.rule(raw);
    if(!LedgerSyncCore.validEntityData('pref',r.id,r)||ruleIds.has(r.id))continue;
    ruleIds.add(r.id);recurring.push(r);
  }
  const merchants=[...new Set([...src.merchants.map(m=>m.trim()),...records.map(r=>r.merchant).filter(Boolean)])];
  const archived=Array.isArray(src.archivedMerchants)?src.archivedMerchants.filter(m=>merchants.includes(m)):[];
  // 沒有標明類型的名稱：只出現在收入紀錄的算收入來源，其餘算店家（一次掃過全部紀錄）。
  const usedAs=new Map();
  for (const r of records) if (r.merchant) { const u=usedAs.get(r.merchant)||{expense:false,income:false}; u[r.type]=true; usedAs.set(r.merchant,u); }
  const merchantTypes=Object.create(null);
  for (const m of merchants) { const u=usedAs.get(m); merchantTypes[m]=src.merchantTypes?.[m]==='income'||(u&&u.income&&!u.expense)?'income':'expense'; }
  return {schemaVersion:3,currentMonth:today().slice(0,7),activeView:'home',previousView:'home',settingsPage:'',statsType:'expense',statsPeriod:'month',catMgrType:'expense',merchantMgrType:'expense',pendingSyncIds:[],isOfflineSim:false,categories:[...cats.values()],records,recurring,merchants,archivedMerchants:[...new Set(archived)],merchantTypes,preferences:{homeHeaderMode:['expense_only','expense_and_income','full_net'].includes(src.preferences?.homeHeaderMode)?src.preferences.homeHeaderMode:'expense_only',enableSaveAndNext:src.preferences?.enableSaveAndNext===true,monthlyBudget:LedgerSyncCore.validBudget(src.preferences?.monthlyBudget)?src.preferences.monthlyBudget:0},entityTimes:sanitizeEntityTimes(src.entityTimes)};
}
// Last-change time of each record, category, merchant and preference; used to pick the newer side in sync conflicts.
function sanitizeEntityTimes(raw) {
  const out={};
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) return out;
  for (const [key,value] of Object.entries(raw)) {
    if (key.length<=220 && /^(rec|cat|mer|pref):/.test(key) && Number.isFinite(value) && value>=0) Object.defineProperty(out,key,{value,enumerable:true,writable:true,configurable:true});
  }
  return out;
}
function storageKey() { return BOOK_PREFIX+book; }
// 舊的儲存方式：整本帳是 localStorage 裡的一段 JSON。現在只在搬進資料庫前讀取，
// 以及瀏覽器無法使用資料庫時沿用（見 58-store.js）。
function loadBook() {
  storageBlocked=false; loadIssue=''; persistedRaw=null;
  try {
    persistedRaw=localStorage.getItem(storageKey());
    if (!persistedRaw) return freshBook();
    const rawData=JSON.parse(persistedRaw);
    const loaded=validateBackup(rawData);
    // Remove legacy unfinished input without changing any saved records.
    if (Object.hasOwn(rawData,'draft')) {
      delete rawData.draft;
      const cleaned=JSON.stringify(rawData);
      try { localStorage.setItem(storageKey(),cleaned); persistedRaw=cleaned; }
      catch { loadIssue='舊版未完成輸入已忽略，但暫時無法清理本機儲存。'; }
    }
    return loaded;
  } catch(e) {
    storageBlocked=Boolean(persistedRaw);
    loadIssue=storageBlocked ? '原有資料無法讀取，已停止覆寫。請匯出原始資料保留後，再匯入有效備份。' : '瀏覽器無法使用本機儲存。可填寫與匯出，但關閉前請務必下載備份。';
    return freshBook();
  }
}
function showStorageError(message) { $('storageError').textContent=message; $('storageError').classList.remove('hidden'); updateSyncStatusUI(); }
function commit(mutator, opts={}) {
  if (storageBlocked) { showStorageError(loadIssue || '原有資料無法讀取，已停止覆寫。'); return false; }
  LedgerSyncCore.snapshot(state);
  const next=cloneForCommit(state); mutator(next);
  if (opts.stamp!==false) LedgerSyncCore.stampTimes(state,next,Date.now());
  try { LedgerStore.save(state,next); }
  catch(e) { showStorageError(e.message?.includes('另一個')?e.message:'儲存失敗，輸入內容仍保留在此頁。請重試，或到設定下載備份；尚未安全寫入的內容請勿關閉。'); return false; }
  state=next; $('storageError').classList.add('hidden');
  LedgerSync.afterCommit(opts); updateSyncStatusUI(); return true;
}
function updateSyncStatusUI() {
  if (!$('syncText')) return;
  const failed=!$('storageError').classList.contains('hidden');
  const view=failed?{text:'儲存需注意',tone:'warn'}:LedgerSync.badge();
  const dot={ok:'bg-incomeGreen',warn:'bg-warnAmber',danger:'sync-dot-danger',accent:'bg-accent animate-pulse',muted:'bg-textMuted'}[view.tone]||'bg-incomeGreen';
  $('syncText').textContent=view.text;
  $('syncDot').className='w-1.5 h-1.5 rounded-full '+dot;
  LedgerSync.renderPanel();
  // 設定第一頁的同步與備份卡片，內容沿用同步分頁剛算好的文字。
  $('settingsSyncDot').className='w-2 h-2 rounded-full shrink-0 '+dot;
  $('settingsSyncText').textContent=view.text;
  $('settingsSyncSummary').textContent=$('syncSummary').textContent;
  $('btnSettingsSyncAction').textContent=canSyncNow()?'立即同步':'前往設定';
  $('settingsBackupAge').textContent=$('backupAge').textContent;
}
const canSyncNow=()=>LedgerSync.isLinked()&&!$('btnSyncNow').classList.contains('hidden');
// 設定分頁：進入時加一筆瀏覽紀錄，Android 返回手勢會回到設定第一頁，而不是離開網頁。
let settingsHistory=false,skipNextPop=false;
function openSettingsPage(page='') {
  discardForm();
  if(!page)leaveSettingsPage();
  else if(!settingsHistory){try{history.pushState({ledgerSettings:page},'');settingsHistory=true;}catch{}}
  state.activeView='settings';state.settingsPage=page;
  renderAll();window.scrollTo({top:0});
}
// 離開設定分頁時收回剛才加的瀏覽紀錄，之後按返回才不會停在原地。
function leaveSettingsPage() {
  if(settingsHistory){settingsHistory=false;skipNextPop=true;try{history.back();}catch{skipNextPop=false;}}
  state.settingsPage='';
}
function onSettingsPopState() {
  if(skipNextPop){skipNextPop=false;return;}
  if(!settingsHistory)return;
  settingsHistory=false;
  if(state.activeView==='settings'&&state.settingsPage){state.settingsPage='';renderAll();window.scrollTo({top:0});}
}
function showToast(msg,ms=2800) {
  $('toastBox').textContent=msg; $('toastBox').classList.remove('hidden');
  clearTimeout(window.__toastTimer); window.__toastTimer=setTimeout(()=>$('toastBox').classList.add('hidden'),ms);
}
function filteredHomeRecords() {
  const q=searchQuery.trim().toLocaleLowerCase();
  const rows=searchAcrossMonths && q ? state.records.slice().sort((a,b)=>b.date.localeCompare(a.date)||a.seq-b.seq):getMonthRecords();
  return q?rows.filter(r=>[r.merchant,r.note,getCategoryById(r.categoryId).name].some(t=>t.toLocaleLowerCase().includes(q))):rows;
}
function renderAll() {
  // 只重畫目前看得到的頁面，其他頁面切過去時才重畫；帳本大時切換與儲存比較快。
  const view=state.activeView;
  renderHeader();
  if(view==='home')renderHome();else if(view==='stats')renderStats();else if(view==='settings')renderSettings();
  updateBottomNav();updateSyncStatusUI();
  $('btnSyncBadge').classList.toggle('hidden',state.activeView==='record');
  $('statsMerchantList').parentElement.querySelector('h3').textContent=state.statsType==='income'?'收入來源累積金額':'店家累積金額';
  $('statsMerchantList').parentElement.querySelector('span').textContent='點擊查看明細';
}
function discardForm() {
  modalState=null;
  ['inputAmountExpr','inputMerchantSearch','inputRecordNote','inputRecordDate','inputInlineCatName'].forEach(id=>{if($(id))$(id).value='';});
  $('inlineAddCatPanel').classList.add('hidden');
}
function emptyForm(type='expense',date=today()) { return {editingRecordId:null,type,categoryId:'',date,amountExpr:'',selectedMerchant:'',note:''}; }
function openNewRecordModal() {
  state.previousView=state.activeView==='record'?'home':state.activeView;
  modalState=emptyForm();
  state.activeView='record'; keypadOpen=true;
  renderAll();renderRecordModal();window.scrollTo({top:0});
}
function openEditRecordModal(id) {
  const rec=state.records.find(r=>r.id===id); if(!rec)return;
  state.previousView=state.activeView==='record'?'home':state.activeView;
  modalState={editingRecordId:id,type:rec.type,categoryId:rec.categoryId,date:rec.date,amountExpr:String(rec.amount),selectedMerchant:rec.merchant,note:rec.note};
  state.activeView='record';keypadOpen=false;
  renderAll();renderRecordModal();window.scrollTo({top:0});
}
function closeRecordPage() {
  discardForm();state.activeView=state.previousView||'home';renderAll();
}
function setKeypad(open) {
  keypadOpen=open; $('builtInKeypad').classList.toggle('hidden',!open);
  $('btnToggleKeypad').textContent=open?'收起數字鍵盤':'展開數字鍵盤';
  $('btnToggleKeypad').setAttribute('aria-expanded',String(open));
}
function renderRecordModal() {
  const d=modalState,isEdit=Boolean(d.editingRecordId),cat=state.categories.find(c=>c.id===d.categoryId);
  $('modalTitleText').textContent=isEdit?'編輯紀錄':'記一筆';
  ['expense','income'].forEach(t=>{const b=$(t==='expense'?'modalTypeExpense':'modalTypeIncome');b.className='px-3 py-1 rounded-lg font-semibold '+(t===d.type?'bg-accent text-bgMain':'text-textMuted');b.setAttribute('aria-pressed',String(t===d.type));});
  $('step1CategoryGrid').innerHTML='';
  getCategoriesByType(d.type).forEach(c=>{
    const b=document.createElement('button');b.type='button';b.className='flex flex-col items-center justify-center gap-1 py-2 px-1 rounded-xl border '+(c.id===d.categoryId?'bg-accentSoft border-accent text-accent':'bg-bgInput border-borderSubtle text-textMain');
    b.innerHTML=(ICONS[c.icon]||ICONS.other)+`<span class="text-xs">${escapeHtml(c.name)}</span>`;
    b.setAttribute('aria-pressed',String(c.id===d.categoryId));
    b.onclick=()=>{d.categoryId=c.id;keypadOpen=true;renderRecordModal();$('inputAmountExpr').focus();};
    $('step1CategoryGrid').appendChild(b);
  });
  $('step1CategoryGrid').classList.remove('hidden');
  $('categoryPrompt').classList.toggle('hidden',Boolean(cat));
  $('categoryPrompt').textContent='選擇分類，填入金額';
  $('step2CatIcon').innerHTML=cat?(ICONS[cat.icon]||ICONS.other):'';
  $('step2CatName').textContent=cat?.name||'尚未選擇';
  $('step2DetailSection').classList.remove('hidden');
  $('inputAmountExpr').value=d.amountExpr;$('inputMerchantSearch').value=d.selectedMerchant;$('inputRecordNote').value=d.note;
  $('inputRecordDate').value=d.date; $('inputRecordDate').hidden=true;
  $('btnDateToggle').textContent=(d.date===today()?'今天':d.date)+' ▾';
  $('merchantFieldLabel').textContent=d.type==='income'?'收入來源':'店家';
  $('inputMerchantSearch').placeholder=d.type==='income'?'搜尋或輸入收入來源':'搜尋或輸入店家名稱';
  $('inputRecordNote').placeholder=d.type==='income'?'例如：十月份薪資':'例如：大麥克套餐、衛生紙';
  $('btnDeleteRecordInModal').classList.toggle('hidden',!isEdit);
  $('btnSaveAndNextRecord').classList.toggle('hidden',isEdit||!state.preferences.enableSaveAndNext);
  $('recordFormError').classList.add('hidden');
  renderIconPickers();setKeypad(keypadOpen);updateCalcPreviewAndRecommendations();
}
// 「常用」只看最近 6 個月：設定頁列出最常用的 12 個，記帳頁推薦 8 個；搜尋時仍包含所有店家。
const RECENT_MONTHS=6,SETTINGS_FREQUENT_LIMIT=12,RECORD_SUGGEST_LIMIT=8;
function recentSince(now=new Date()) { return today(new Date(now.getFullYear(),now.getMonth()-RECENT_MONTHS,now.getDate())); }
function getRecommendedMerchants(categoryId,amount,keyword='') {
  const type=state.categories.find(c=>c.id===categoryId)?.type||'expense',since=recentSince(),archived=new Set(state.archivedMerchants);
  const amounts=new Map(),recent=new Map();
  for(const r of state.records){
    if(r.categoryId!==categoryId||!r.merchant||archived.has(r.merchant))continue;
    if(!amounts.has(r.merchant))amounts.set(r.merchant,[]);
    amounts.get(r.merchant).push(r.amount);
    if(r.date>=since)recent.set(r.merchant,(recent.get(r.merchant)||0)+1);
  }
  const q=keyword.trim().toLocaleLowerCase();
  // 沒輸入時只推薦最近 6 個月在這個分類用過的；輸入文字時搜尋全部，不常用的也找得到。
  let names=[...recent.keys()];
  if(q){
    const usedForType=new Set(state.records.filter(r=>r.type===type&&r.merchant).map(r=>r.merchant));
    names=state.merchants.filter(m=>!archived.has(m)&&(state.merchantTypes[m]===type||usedForType.has(m))&&m.toLocaleLowerCase().includes(q));
  }
  return names.map(name=>{
    const list=amounts.get(name)||[], nearest=list.length?Math.min(...list.map(a=>Math.abs(a-amount))):Infinity;
    const frequency=Math.min(20,Math.log2((recent.get(name)||0)+1)*5);
    const similarity=amount>0?60*Math.exp(-nearest/Math.max(30,amount*.25)):0;
    return {name,count:recent.get(name)||0,score:similarity+frequency};
  }).sort((a,b)=>b.score-a.score||b.count-a.count||a.name.localeCompare(b.name,'zh-TW')).slice(0,RECORD_SUGGEST_LIMIT);
}
// 設定頁的店家清單：預設只列最近 6 個月最常用的 12 個；搜尋或「顯示全部」時列出全部（含不常用、已停用）。
function merchantManagerRows() {
  const type=state.merchantMgrType==='income'?'income':'expense',since=recentSince(),archived=new Set(state.archivedMerchants),usage=new Map();
  for(const r of state.records){
    if(!r.merchant)continue;
    const u=usage.get(r.merchant)||{recent:0,last:''};
    if(r.date>=since)u.recent++;
    if(r.date>u.last)u.last=r.date;
    usage.set(r.merchant,u);
  }
  const all=state.merchants.filter(name=>(state.merchantTypes[name]==='income'?'income':'expense')===type).map(name=>{
    const u=usage.get(name),added=ownTime(state.entityTimes,'mer:'+name);
    // 手動新增、還沒用過的名稱：新增後 6 個月內也算常用。
    const fresh=!u&&added!==undefined&&today(new Date(added))>=since;
    return {name,used:Boolean(u),archived:archived.has(name),recent:u?u.recent:fresh?1:0,last:u?u.last:fresh?today(new Date(added)):''};
  }).sort((a,b)=>b.recent-a.recent||b.last.localeCompare(a.last)||a.name.localeCompare(b.name,'zh-TW'));
  const q=merchantMgrQuery.trim().toLocaleLowerCase();
  if(q)return {rows:all.filter(m=>m.name.toLocaleLowerCase().includes(q)),total:all.length,query:q};
  return {rows:merchantMgrShowAll?all:all.filter(m=>m.recent>0&&!m.archived).slice(0,SETTINGS_FREQUENT_LIMIT),total:all.length,query:''};
}
function renderMerchantManager() {
  const income=state.merchantMgrType==='income',{rows,total,query}=merchantManagerRows(),list=$('settingsMerchantList');
  ['expense','income'].forEach(t=>{const b=$(t==='expense'?'merMgrTabExpense':'merMgrTabIncome'),on=income===(t==='income');b.classList.toggle('bg-accent',on);b.classList.toggle('text-bgMain',on);b.classList.toggle('text-textMuted',!on);b.setAttribute('aria-pressed',String(on));});
  list.innerHTML='';list.classList.toggle('merchant-list-scroll',Boolean(query)||merchantMgrShowAll);
  rows.forEach(m=>{
    const row=document.createElement('div');row.className='flex items-center justify-between px-3 py-2 rounded-xl bg-bgInput border border-borderSubtle text-xs';
    const meta=m.archived?'已停用':!m.used?(m.recent?'新加入':'尚未使用'):m.recent?`近半年 ${m.recent} 次`:`上次 ${m.last}`;
    row.innerHTML=`<span>${escapeHtml(m.name)} <span class="text-textDim">· ${meta}</span></span><div class="flex gap-1"></div>`;
    [['rename','改名'],['merge','合併'],[m.archived?'restore':'archive',m.archived?'恢復':'停用']].forEach(([a,t])=>{const b=document.createElement('button');b.textContent=t;b.className='px-2 text-accent';b.onclick=()=>handleMerchantAction(a,m.name);row.lastElementChild.appendChild(b);});
    list.appendChild(row);
  });
  if(!rows.length){const p=document.createElement('p');p.className='text-xs text-textMuted';p.textContent=query?`找不到「${merchantMgrQuery.trim()}」。`:total?'最近 6 個月沒有常用的，按「顯示全部」可以看到全部。':income?'還沒有收入來源。記收入時輸入來源名稱就會自動加入。':'還沒有店家。記帳時輸入店家名稱就會自動加入。';list.appendChild(p);}
  const more=$('btnMerchantShowAll');
  more.classList.toggle('hidden',Boolean(query)||!total||(!merchantMgrShowAll&&rows.length>=total));
  more.textContent=merchantMgrShowAll?'只顯示常用':`顯示全部（共 ${total} 個）`;
  $('inputManageNewMerchant').placeholder=income?'新增收入來源名稱...':'新增店家名稱...';
  $('btnManageAddMerchant').textContent=income?'新增來源':'新增店家';
}
function updateCalcPreviewAndRecommendations() {
  const parsed=evaluateSimpleMath(modalState.amountExpr);
  $('calcPreviewBadge').classList.toggle('hidden',!parsed.valid||!parsed.isExpression);
  $('calcPreviewBadge').textContent=`= NT$ ${formatMoney(parsed.value)}`;
  renderMerchantChips(parsed.valid?parsed.value:0);
}
function renderMerchantChips(amount) {
  const input=$('inputMerchantSearch').value.trim(),source=modalState.type==='income';
  $('btnClearMerchant').classList.toggle('hidden',!input);
  const results=getRecommendedMerchants(modalState.categoryId,amount,input);
  $('merchantRecHint').textContent=input?(results.length?'搜尋結果':'可直接儲存這個名稱'):(amount>0?(source?'推薦來源':'依金額推薦'):(source?'常用來源':'常用店家'));
  const box=$('merchantChipsContainer');box.innerHTML='';
  results.forEach(item=>{
    const b=document.createElement('button');b.type='button';b.className='px-3 py-2 rounded-xl text-sm border '+(input===item.name?'bg-accent text-bgMain border-accent':'bg-bgInput text-textMain border-borderSubtle');b.textContent=item.name;
    b.onclick=()=>{modalState.selectedMerchant=item.name;$('inputMerchantSearch').value=item.name;renderMerchantChips(amount);};box.appendChild(b);
  });
  if (!input && !results.length) { const p=document.createElement('p');p.className='text-xs text-textMuted';p.textContent='累積紀錄後，這裡會出現推薦。也可以留白。';box.appendChild(p); }
}
function formError(msg) { $('recordFormError').textContent=msg;$('recordFormError').classList.remove('hidden'); }
function handleSaveRecord(keepOpenForNext=false) {
  const d=modalState,parsed=evaluateSimpleMath(d.amountExpr);
  if (!state.categories.some(c=>c.id===d.categoryId&&c.type===d.type)) return formError('請先選擇分類。');
  if (!parsed.valid) return formError('請完成加減算式，金額須為 1～999,999,999 元的整數。');
  if (!validDate(d.date)) return formError('請選擇有效日期。');
  if (d.selectedMerchant.trim().length>100||d.note.length>1000) return formError('店家／來源限 100 字，備註限 1,000 字。');
  if (d.editingRecordId&&!state.records.some(r=>r.id===d.editingRecordId)) return formError('這筆紀錄已被刪除（可能是在其他裝置），無法儲存修改。請返回後重新記一筆。');
  const rec={id:d.editingRecordId||uid(),seq:d.editingRecordId?state.records.find(r=>r.id===d.editingRecordId).seq:getNextSeq(),type:d.type,date:d.date,categoryId:d.categoryId,amount:parsed.value,merchant:d.selectedMerchant.trim(),note:d.note.trim()};
  const before=state;
  if (!commit(s=>{
    const index=s.records.findIndex(r=>r.id===rec.id);if(index<0)s.records.push(rec);else s.records[index]=rec;
    if(rec.merchant&&!s.merchants.includes(rec.merchant)){s.merchants.push(rec.merchant);Object.defineProperty(s.merchantTypes,rec.merchant,{value:rec.type,enumerable:true,writable:true,configurable:true});}
    s.currentMonth=rec.date.slice(0,7);
  })) return formError('尚未儲存成功。請查看上方提示並重試，輸入內容仍保留。');
  const notice=budgetAlert(before,rec);
  showToast(notice?`${LedgerSync.savedMessage()}。${notice}`:LedgerSync.savedMessage(),notice?5000:undefined);searchQuery='';$('recordSearch').value='';
  if(keepOpenForNext){modalState=emptyForm(d.type,d.date);renderAll();renderRecordModal();window.scrollTo({top:0});}
  else {modalState=null;state.activeView=state.previousView||'home';renderAll();}
}
function archiveMerchant(s,name) { if(!s.archivedMerchants.includes(name))s.archivedMerchants.push(name); }
function renameMerchant(s,name,target) {
  const type=s.merchantTypes[name]||'expense';
  s.records=s.records.map(r=>r.merchant===name?{...r,merchant:target}:r);
  (s.recurring||[]).forEach(r=>{if(r.merchant===name)r.merchant=target;});
  s.merchants=[...new Set(s.merchants.map(m=>m===name?target:m))];
  s.archivedMerchants=s.archivedMerchants.filter(m=>m!==name&&m!==target);
  delete s.merchantTypes[name];s.merchantTypes[target]=type;
}
function handleMerchantAction(action,name) {
  if(action==='archive'||action==='restore'){
    if(commit(s=>{if(action==='archive')archiveMerchant(s,name);else s.archivedMerchants=s.archivedMerchants.filter(m=>m!==name);})){renderAll();showToast(action==='archive'?'已停用，歷史紀錄保留':'已恢復推薦');}return;
  }
  openDialog({title:action==='merge'?'合併店家／來源':'修改名稱',message:action==='merge'?'輸入要合併至的既有名稱。相關紀錄會集中統計，金額與備註保持不變。':'改名會更新所有相關紀錄。若名稱已存在，請使用「合併」。',inputValue:action==='merge'?'':name,onConfirm:value=>{
    const target=value.trim();if(!target||target.length>100||target===name)return showToast('請輸入不同的有效名稱。'),false;
    if(action==='merge'&&!state.merchants.includes(target))return showToast('找不到目標名稱，請輸入既有店家／來源。'),false;
    if(action==='rename'&&state.merchants.includes(target))return showToast('名稱已存在，請改用合併。'),false;
    if(!commit(s=>renameMerchant(s,name,target)))return false;renderAll();showToast('已更新，歷史金額保留');
  }});
}
function handleCategoryAction(action,id) {
  const cat=getCategoryById(id),list=getCategoriesByType(cat.type);
  if(action==='icon'){openCategoryIconPicker(cat);return;}
  if(action==='delete'){
    if(state.records.some(r=>r.categoryId===id))return showToast('紀錄仍使用此分類，請先改到其他分類。');
    if((state.recurring||[]).some(r=>r.categoryId===id))return showToast('固定收支還在使用這個分類，請先修改或刪除。');
    if(list.length<=1)return showToast('至少保留一個分類。');
    openDialog({title:'刪除未使用分類？',message:cat.name,onConfirm:()=>{if(!commit(s=>s.categories=s.categories.filter(c=>c.id!==id)))return false;renderAll();}});return;
  }
  openDialog({title:'修改分類名稱',message:'歷史紀錄會顯示新名稱。',inputValue:cat.name,onConfirm:value=>{
    const name=value.trim();if(!name||name.length>40||state.categories.some(c=>c.type===cat.type&&c.id!==id&&c.name===name))return showToast('名稱須為 1～40 字，且不可與同類型分類重複。'),false;
    if(!commit(s=>s.categories.find(c=>c.id===id).name=name))return false;renderAll();
  }});
}
const GRIP_ICON='<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
// 依畫面上的順序重新編號（1、2、3…）並存檔；focusId 是用鍵盤移動時要保留焦點的分類。
function saveCategoryOrder(ids,focusId) {
  if(!commit(s=>ids.forEach((id,i)=>{const c=s.categories.find(c=>c.id===id);if(c)c.order=i+1;})))return renderSettings();
  renderAll();
  if(focusId)$('settingsCategoryList').querySelector(`.category-row[data-id="${CSS.escape(focusId)}"] .drag-handle`)?.focus();
}
// 分類拖曳排序：按住左邊的把手上下拖，經過相鄰分類的一半就交換位置，放開後一次存檔；
// 拖到畫面上下緣會自動捲動。用鍵盤時，在把手上按上下鍵移動一格。
function setupCategoryDrag() {
  const list=$('settingsCategoryList');
  let drag=null;
  const rowIds=()=>[...list.querySelectorAll('.category-row')].map(r=>r.dataset.id);
  // 列在清單中移動後，調整起點讓它仍停在手指下。
  function shift(move) { const before=drag.row.offsetTop;move();drag.originY+=drag.row.offsetTop-before; }
  function place(y) {
    const row=drag.row;
    row.style.transform=`translateY(${y-drag.originY}px)`;
    const rect=row.getBoundingClientRect(),mid=rect.top+rect.height/2,prev=row.previousElementSibling,next=row.nextElementSibling;
    const middle=el=>el.getBoundingClientRect().top+el.offsetHeight/2;
    if(next&&mid>middle(next)){shift(()=>list.insertBefore(next,row));place(y);}
    else if(prev&&mid<middle(prev)){shift(()=>list.insertBefore(row,prev));place(y);}
  }
  function autoScroll() {
    if(!drag)return;
    const y=drag.lastY,top=70,bottom=window.innerHeight-130;   // 底部留給導覽列
    const speed=y<top?-Math.ceil((top-y)/6):y>bottom?Math.ceil((y-bottom)/6):0;
    if(speed){const before=window.scrollY;window.scrollBy(0,speed);const moved=window.scrollY-before;if(moved){drag.originY-=moved;place(y);}}
    drag.raf=requestAnimationFrame(autoScroll);
  }
  function move(e) { if(!drag)return;e.preventDefault();drag.lastY=e.clientY;place(e.clientY); }
  function finish(save) {
    if(!drag)return;
    const {row,before,raf}=drag;drag=null;
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',drop);window.removeEventListener('pointercancel',cancel);
    row.classList.remove('dragging');row.style.transform='';
    const ids=rowIds();
    if(save&&ids.join()!==before.join())saveCategoryOrder(ids);else renderSettings();
  }
  const drop=()=>finish(true),cancel=()=>finish(false);
  list.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('.drag-handle');
    if(!handle||drag||e.button>0)return;
    e.preventDefault();
    drag={row:handle.closest('.category-row'),originY:e.clientY,lastY:e.clientY,before:rowIds(),raf:0};
    drag.row.classList.add('dragging');
    try{handle.setPointerCapture(e.pointerId);}catch{}
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',drop);window.addEventListener('pointercancel',cancel);
    drag.raf=requestAnimationFrame(autoScroll);
  });
  list.addEventListener('keydown',e=>{
    const handle=e.target.closest('.drag-handle');
    if(!handle||(e.key!=='ArrowUp'&&e.key!=='ArrowDown'))return;
    e.preventDefault();
    const ids=rowIds(),id=handle.closest('.category-row').dataset.id,i=ids.indexOf(id),j=i+(e.key==='ArrowUp'?-1:1);
    if(j<0||j>=ids.length)return;
    [ids[i],ids[j]]=[ids[j],ids[i]];
    saveCategoryOrder(ids,id);
  });
}
function renderSettings() {
  $('settingsHome').classList.toggle('hidden',Boolean(state.settingsPage));
  document.querySelectorAll('.settings-page').forEach(el=>el.classList.toggle('hidden',el.dataset.page!==state.settingsPage));
  document.querySelectorAll('.setting-header-btn').forEach(b=>{const yes=b.dataset.mode===state.preferences.homeHeaderMode;b.classList.toggle('border-accent',yes);b.classList.toggle('bg-accentSoft',yes);b.querySelector('.mode-check').textContent=yes?'✓':'';b.setAttribute('aria-pressed',String(yes));});
  $('toggleSaveAndNext').setAttribute('aria-checked',String(state.preferences.enableSaveAndNext));
  $('toggleSaveAndNext').classList.toggle('bg-accent',state.preferences.enableSaveAndNext);
  $('toggleSaveAndNextDot').style.left=state.preferences.enableSaveAndNext?'22px':'4px';
  ['expense','income'].forEach(t=>{$(t==='expense'?'catMgrTabExpense':'catMgrTabIncome').classList.toggle('bg-accent',state.catMgrType===t);$(t==='expense'?'catMgrTabExpense':'catMgrTabIncome').classList.toggle('text-bgMain',state.catMgrType===t);});
  const list=$('settingsCategoryList');list.innerHTML='';
  getCategoriesByType(state.catMgrType).forEach(c=>{
    const row=document.createElement('div');row.className='category-row flex items-center justify-between px-3 py-2 rounded-xl bg-bgInput border border-borderSubtle text-xs';row.dataset.id=c.id;
    row.innerHTML=`<span class="flex items-center gap-2"><button type="button" class="drag-handle" aria-label="拖曳調整「${escapeHtml(c.name)}」的順序，也可以用上下鍵">${GRIP_ICON}</button>${ICONS[c.icon]||ICONS.other}<span>${escapeHtml(c.name)}</span></span><div class="flex gap-1"></div>`;
    const actions=row.lastElementChild;
    [['icon','圖示'],['rename','改名'],['delete','刪除']].forEach(([a,text])=>{const b=document.createElement('button');b.textContent=text;b.className='px-2 text-accent';b.setAttribute('aria-label',c.name+' '+text);b.onclick=()=>handleCategoryAction(a,c.id);actions.appendChild(b);});
    list.appendChild(row);
  });
  renderMerchantManager();
  $('btnUndoImport').classList.toggle('hidden',!LedgerStore.hasSnapshot('before_import'));
  if(state.settingsPage==='data')renderCsvRanges();
  if(state.settingsPage==='budget')renderBudgetSettings();
  if(state.settingsPage==='recurring')renderRecurringSettings();
  renderIconPickers();
}
function addCategory(inline=false) {
  const input=$(inline?'inputInlineCatName':'inputNewCategoryName'),name=input.value.trim(),type=inline?modalState.type:state.catMgrType;
  if(!name||name.length>40||state.categories.some(c=>c.type===type&&c.name===name))return showToast('分類名稱須為 1～40 字，且不可重複。');
  const id=uid('cat'),order=Math.max(0,...getCategoriesByType(type).map(c=>c.order))+1;
  if(!commit(s=>s.categories.push({id,type,name,order,icon:selectedIcon(inline?'inlineIconPickerGrid':'settingsIconPickerGrid')})))return;
  input.value='';if(inline){modalState.categoryId=id;$('inlineAddCatPanel').classList.add('hidden');renderRecordModal();}else renderAll();
}
let dialogReturnFocus=null;
function openDialog({title,message,inputValue,inputMode='text',textareaValue,hideCancel=false,checkbox,confirmText='確認',onConfirm}) {
  dialogReturnFocus=document.activeElement;
  $('dialogIconPicker').classList.add('hidden');
  $('dialogTitle').textContent=title;$('dialogMessage').textContent=message||'';
  $('dialogInput').classList.toggle('hidden',inputValue===undefined);$('dialogInput').value=inputValue||'';$('dialogInput').inputMode=inputMode;
  $('dialogTextarea').classList.toggle('hidden',textareaValue===undefined);$('dialogTextarea').value=textareaValue||'';
  $('dialogCheckWrap').classList.toggle('hidden',!checkbox);$('dialogCheck').checked=Boolean(checkbox?.checked);$('dialogCheckLabel').textContent=checkbox?.label||'';
  $('dialogBtnCancel').classList.toggle('hidden',hideCancel);$('dialogBtnConfirm').textContent=confirmText;
  $('dialogBtnConfirm').onclick=async()=>{if(onConfirm && await onConfirm($('dialogInput').value,$('dialogCheck').checked)===false)return;closeDialog();};
  $('modalDialog').classList.remove('hidden');(inputValue!==undefined?$('dialogInput'):$('dialogBtnConfirm')).focus();
}
function closeDialog() {$('modalDialog').classList.add('hidden');dialogReturnFocus?.focus?.();}
function backupEnvelope(s=state) { return {format:'daily-ledger',version:3,book,exportedAt:new Date().toISOString(),data:{...clone(s),activeView:'home',previousView:'home'}}; }
function downloadText(text,name,type='application/json') {
  const url=URL.createObjectURL(new Blob([text],{type:type+';charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function exportBackup() {
  try {
    if(LedgerStore.unreadable())return showToast('目前讀不到帳本，無法下載備份。請完全關閉網頁後重新開啟。');
    const text=storageBlocked&&LedgerStore.rawExport()?LedgerStore.rawExport():JSON.stringify(backupEnvelope(),null,2);
    downloadText(text,`記帳-備份-${today()}.json`);
    $('backupStatus').textContent='已送出備份下載，請確認檔案已存入下載資料夾。';
    try{localStorage.setItem(storageKey()+'_last_backup',String(Date.now()));}catch{}
  }catch(e){showToast('無法下載，請重試或更換瀏覽器。');}
}
// CSV 給試算表看：日期由舊到新，同一天依記帳先後。文字開頭是 = + - @ 時前面加 '，避免試算表把它當成公式執行。
const CSV_HEADER=['日期','類型','分類','金額','店家／收入來源','備註'];
function csvCell(value) {
  let s=String(value??'');
  if(typeof value==='string'&&/^[=+\-@\t\r]/.test(s))s="'"+s;
  return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
}
function recordsCsv(records) {
  const rows=records.slice().sort((a,b)=>a.date.localeCompare(b.date)||(Number(a.seq)||0)-(Number(b.seq)||0))
    .map(r=>[r.date,r.type==='income'?'收入':'支出',getCategoryById(r.categoryId)?.name||'',r.amount,r.merchant,r.note]);
  return [CSV_HEADER,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
// 匯出範圍：全部、首頁目前的月份、有紀錄的每一年（值是日期開頭，'' 代表全部）。
function csvRanges() {
  const count=prefix=>state.records.reduce((n,r)=>n+(r.date.startsWith(prefix)?1:0),0);
  const [y,m]=state.currentMonth.split('-'),years=[...new Set(state.records.map(r=>r.date.slice(0,4)))].sort().reverse();
  return [{value:'',label:'全部紀錄',count:state.records.length},{value:state.currentMonth,label:`${y} 年 ${Number(m)} 月`,count:count(state.currentMonth)},...years.map(y=>({value:y,label:`${y} 年`,count:count(y)}))]
    .filter((o,i)=>i===0||o.count>0);
}
function renderCsvRanges() {
  const select=$('csvRange'),keep=select.value;
  select.innerHTML=csvRanges().map(o=>`<option value="${o.value}">${o.label}（${o.count.toLocaleString('zh-TW')} 筆）</option>`).join('');
  if([...select.options].some(o=>o.value===keep))select.value=keep;
}
function exportCsv() {
  const prefix=$('csvRange').value,records=state.records.filter(r=>r.date.startsWith(prefix));
  if(!records.length)return showToast('這個範圍沒有紀錄。');
  const name=`隨便記-紀錄-${prefix||'全部-'+today()}.csv`;
  try{downloadText('\ufeff'+recordsCsv(records),name,'text/csv');}catch{return showToast('無法下載，請重試或更換瀏覽器。');}
  $('csvStatus').textContent=`已匯出 ${records.length.toLocaleString('zh-TW')} 筆紀錄：${name}`;
}
const DEMO_MERCHANT_NAMES=new Set(getInitialState().merchants);
function importOrigin(raw) {
  const env=raw&&raw.format==='daily-ledger'?raw:null,at=env?Date.parse(env.exportedAt):NaN;
  return {book:env&&['demo','personal'].includes(env.book)?env.book:'',exportedAt:Number.isFinite(at)?at:0};
}
function ownTime(times,key) { return times&&Object.hasOwn(times,key)&&Number.isFinite(times[key])?times[key]:undefined; }
function recordSignature(r) { return [r.type,r.date,r.categoryId,r.amount,r.merchant,r.note].join('\u0001'); }
// Demo-book merchants are only sample suggestions; keep them out of the personal book unless a kept record uses them.
function skipDemoMerchant(name,imported,origin,used) {
  return book==='personal'&&DEMO_MERCHANT_NAMES.has(name)&&!used.has(name)&&(origin.book==='demo'||imported.records.some(r=>LedgerSyncCore.isDemoSeedRecord(r)));
}
// Merge a backup into the current book: never deletes, skips records that already exist, and keeps demo samples out of the personal book.
function planImportMerge(current,imported,origin) {
  const next=clone(current),plan={added:0,same:0,updated:0,keptCurrent:0,duplicates:0,demoSkipped:0,newCategories:0,newMerchants:0};
  next.entityTimes={...(current.entityTimes||{})};
  const times=imported.entityTimes||{},setTime=(key,value)=>Object.defineProperty(next.entityTimes,key,{value,enumerable:true,writable:true,configurable:true});
  const importedTime=key=>ownTime(times,key)??origin.exportedAt;
  const catMap=new Map();
  for (const c of imported.categories.slice().sort((a,b)=>a.order-b.order)) {
    const sameId=next.categories.find(x=>x.id===c.id);
    if(sameId&&sameId.type===c.type){catMap.set(c.id,c.id);continue;}
    const sameName=next.categories.find(x=>x.type===c.type&&x.name===c.name);
    if(sameName){catMap.set(c.id,sameName.id);continue;}
    const id=sameId?uid('cat'):c.id,order=Math.max(0,...next.categories.filter(x=>x.type===c.type).map(x=>x.order))+1;
    next.categories.push({id,type:c.type,name:c.name,icon:c.icon,order,...(c.budget?{budget:c.budget}:{})});setTime('cat:'+id,importedTime('cat:'+c.id));catMap.set(c.id,id);plan.newCategories++;
  }
  const at=new Map(next.records.map((r,i)=>[r.id,i])),sigs=new Map(),used=new Set();
  for (const r of next.records){const k=recordSignature(r);sigs.set(k,(sigs.get(k)||0)+1);}
  for (const src of imported.records) {
    if(book==='personal'&&LedgerSyncCore.isDemoSeedRecord(src)){plan.demoSkipped++;continue;}
    const r={...src,categoryId:catMap.get(src.categoryId)||src.categoryId},key='rec:'+r.id;
    if(r.merchant)used.add(r.merchant);
    if(at.has(r.id)){
      const cur=next.records[at.get(r.id)];
      if(JSON.stringify(LedgerSyncCore.canon.rec(cur))===JSON.stringify(LedgerSyncCore.canon.rec(r))){plan.same++;continue;}
      // Only replace an existing record when both sides carry change times and the backup is newer.
      const bt=ownTime(times,key),ct=ownTime(current.entityTimes,key);
      if(bt!==undefined&&ct!==undefined&&bt>ct){next.records[at.get(r.id)]=r;setTime(key,bt);plan.updated++;}else plan.keptCurrent++;
      continue;
    }
    const sig=recordSignature(r);
    if(sigs.get(sig)>0){sigs.set(sig,sigs.get(sig)-1);plan.duplicates++;continue;}
    next.records.push(r);at.set(r.id,next.records.length-1);setTime(key,importedTime(key));plan.added++;
  }
  next.recurring=next.recurring||[];
  for (const r of imported.recurring||[]) {
    if(next.recurring.some(x=>x.id===r.id))continue;
    next.recurring.push({...r,categoryId:catMap.get(r.categoryId)||r.categoryId});setTime('pref:'+r.id,importedTime('pref:'+r.id));
    if(r.merchant)used.add(r.merchant);
  }
  for (const name of imported.merchants) {
    if(next.merchants.includes(name)||skipDemoMerchant(name,imported,origin,used))continue;
    next.merchants.push(name);
    Object.defineProperty(next.merchantTypes,name,{value:imported.merchantTypes[name]==='income'?'income':'expense',enumerable:true,writable:true,configurable:true});
    if(imported.archivedMerchants.includes(name))next.archivedMerchants.push(name);
    setTime('mer:'+name,importedTime('mer:'+name));plan.newMerchants++;
  }
  validateBackup(clone(next));
  return {next,plan};
}
// Replace the whole book with the backup (the previous behaviour), still keeping demo samples out of the personal book.
function planImportReplace(current,imported,origin) {
  const next=clone(imported);
  if(book==='personal'){
    next.records=next.records.filter(r=>!LedgerSyncCore.isDemoSeedRecord(r));
    const used=new Set(next.records.map(r=>r.merchant)),keep=name=>!skipDemoMerchant(name,imported,origin,used);
    next.merchants=next.merchants.filter(keep);next.archivedMerchants=next.archivedMerchants.filter(keep);
  }
  // Treat everything the replacement changes as changed now, so it wins over older copies on other devices.
  next.entityTimes={...(current.entityTimes||{})};
  validateBackup(clone(next));
  return next;
}
function importSummary(imported,plan,origin) {
  const lines=[`備份內容：${imported.records.length} 筆紀錄、${imported.categories.length} 個分類${origin.book==='demo'?'（來自示例帳本）':''}。`];
  lines.push(`合併到目前帳本：新增 ${plan.added} 筆紀錄${plan.newCategories?`、${plan.newCategories} 個分類`:''}${plan.newMerchants?`、${plan.newMerchants} 個店家／來源`:''}。`);
  if(plan.same)lines.push(`${plan.same} 筆已在帳本中，不會重複。`);
  if(plan.duplicates)lines.push(`${plan.duplicates} 筆與現有紀錄的日期、金額、分類、店家、備註都相同，視為重複而略過。`);
  if(plan.updated)lines.push(`${plan.updated} 筆改用備份中較新的版本。`);
  if(plan.keptCurrent)lines.push(`${plan.keptCurrent} 筆與目前內容不同，保留目前版本。`);
  if(plan.demoSkipped)lines.push(`已排除 ${plan.demoSkipped} 筆示例資料，不會放進個人帳本${LedgerSync.isLinked()?'，也不會上傳':''}。`);
  lines.push('合併不會刪除目前的紀錄；匯入前的帳本會保留一份，可在設定還原。');
  return lines.join('\n');
}
async function installImport(imported) {
  if(storageBlocked)return showToast('請先下載原始資料，保留後再處理損毀的帳本。'),false;
  try {
    if(!LedgerStore.isCurrent())throw new Error('帳本已被其他分頁修改，請重新開啟。');
    // Save the full current ledger before replacing it; a failed rollback write blocks import.
    await LedgerStore.saveSnapshot('before_import',JSON.stringify(state));
  }catch(e){showStorageError('無法保存匯入前帳本，因此未進行匯入。');return false;}
  if(!commit(s=>Object.assign(s,clone(imported))))return false;
  // 匯入的資料量可能很大，等確實寫進裝置再回報完成。
  try{await LedgerStore.flush();}catch{return false;}
  modalState=null;lastDeletedRecord=null;$('undoBar').classList.add('hidden');searchQuery='';$('recordSearch').value='';renderAll();showToast('匯入完成，可在設定還原匯入前帳本');return true;
}
async function prepareImport(file) {
  if(!file)return;
  if(file.size>20*1024*1024)return showToast('備份檔案不可超過 20 MB。');
  try {
    const raw=JSON.parse(await file.text()),imported=validateBackup(raw),origin=importOrigin(raw),merge=planImportMerge(state,imported,origin),linked=LedgerSync.isLinked();
    openDialog({title:'確認匯入備份',message:importSummary(imported,merge.plan,origin),confirmText:'匯入',
      checkbox:{label:`改為完全取代目前帳本（備份中沒有的紀錄會被刪除${linked?'，其他裝置也會一併刪除':''}）`,checked:false},
      onConfirm:(_,replace)=>{
        if(!replace)return installImport(merge.next);
        const next=planImportReplace(state,imported,origin);
        LedgerSync.acknowledgeBulkChange(state.records.length);
        return installImport(next);
      }});
  }catch(e){showToast('未匯入：'+e.message);}
}
function removeRecord() {
  const rec=state.records.find(r=>r.id===modalState?.editingRecordId);if(!rec)return;
  if(!commit(s=>{s.records=s.records.filter(r=>r.id!==rec.id);}))return;
  lastDeletedRecord=rec;modalState=null;state.activeView=state.previousView||'home';renderAll();
  $('undoBarText').textContent=`已刪除 ${rec.merchant||getCategoryById(rec.categoryId).name} $${formatMoney(rec.amount)}`;
  $('undoBar').classList.remove('hidden');clearTimeout(window.__undoTimer);
  window.__undoTimer=setTimeout(()=>{$('undoBar').classList.add('hidden');lastDeletedRecord=null;},10000);
}
function handleKeypadInput(key) {
  let s=modalState.amountExpr;
  if(key==='CLEAR')s='';else if(key==='BACK')s=s.slice(0,-1);
  else if(key==='+'||key==='-'){if(!s)return;s=/[+-]$/.test(s)?s.slice(0,-1)+key:s+key;}
  else if(s.length<100)s=s==='0'?key:s+key;
  modalState.amountExpr=s;$('inputAmountExpr').value=s;updateCalcPreviewAndRecommendations();
}
window.addEventListener('DOMContentLoaded',async()=>{
  removeSampleBook();
  // 帳本從資料庫讀出來之後才綁定按鈕與畫面；同步（80-sync-ui.js）也等到這時才開始。
  try{state=await LedgerStore.open();}
  catch(e){console.error('ledger open failed',e);storageBlocked=true;loadIssue='無法開啟帳本，請重新開啟網頁。';state=freshBook();}
  const on=(id,event,fn)=>$(id).addEventListener(event,fn);
  on('navBtnHome','click',()=>{discardForm();leaveSettingsPage();state.activeView='home';renderAll();});on('navBtnStats','click',()=>{discardForm();leaveSettingsPage();state.activeView='stats';renderAll();});on('navBtnSettings','click',()=>openSettingsPage(''));
  on('btnSyncBadge','click',()=>openSettingsPage('sync'));
  document.querySelectorAll('[data-settings-page]').forEach(b=>b.onclick=()=>openSettingsPage(b.dataset.settingsPage));
  on('btnSettingsBack','click',()=>openSettingsPage(''));
  on('btnSettingsSyncAction','click',()=>{if(canSyncNow())$('btnSyncNow').click();else openSettingsPage('sync');});
  on('btnSettingsBackup','click',()=>{exportBackup();updateSyncStatusUI();});
  window.addEventListener('popstate',onSettingsPopState);
  setupCategoryDrag();
  const monthStep=n=>{const [y,m]=state.currentMonth.split('-').map(Number),d=new Date(y,m-1+n*(isYearStats()?12:1),1);state.currentMonth=today(d).slice(0,7);renderAll();};
  on('btnPrevMonth','click',()=>monthStep(-1));on('btnNextMonth','click',()=>monthStep(1));
  on('recordSearch','input',e=>{searchQuery=e.target.value;renderHome();});on('searchAllMonths','change',e=>{searchAcrossMonths=e.target.checked;renderHome();});
  on('btnOpenAddModal','click',openNewRecordModal);
  on('btnCloseRecordModal','click',closeRecordPage);
  ['expense','income'].forEach(t=>on(t==='expense'?'modalTypeExpense':'modalTypeIncome','click',()=>{
    if(modalState.type===t)return;
    modalState.type=t;modalState.categoryId='';modalState.selectedMerchant='';renderRecordModal();
  }));
  on('btnChangeCategoryInStep2','click',()=>{$('inlineAddCatPanel').classList.toggle('hidden');renderIconPickers();});
  on('btnCloseInlineAddCat','click',()=>$('inlineAddCatPanel').classList.add('hidden'));
  on('btnConfirmInlineAddCat','click',()=>addCategory(true));on('btnAddNewCategory','click',()=>addCategory(false));
  on('inputAmountExpr','focus',()=>setKeypad(true));on('btnToggleKeypad','click',()=>setKeypad(!keypadOpen));
  on('inputAmountExpr','input',e=>{modalState.amountExpr=e.target.value;updateCalcPreviewAndRecommendations();});
  document.querySelectorAll('.keypad-btn').forEach(b=>b.onclick=()=>handleKeypadInput(b.dataset.key));
  on('btnKeypadBackspaceTop','click',()=>handleKeypadInput('BACK'));
  on('btnApplyCalcNow','click',()=>{const p=evaluateSimpleMath(modalState.amountExpr);if(!p.valid)return formError('請先完成有效算式。');modalState.amountExpr=String(p.value);$('inputAmountExpr').value=modalState.amountExpr;updateCalcPreviewAndRecommendations();});
  on('inputMerchantSearch','focus',()=>setKeypad(false));on('inputRecordNote','focus',()=>setKeypad(false));
  on('inputMerchantSearch','input',e=>{modalState.selectedMerchant=e.target.value;updateCalcPreviewAndRecommendations();});
  on('btnClearMerchant','click',()=>{modalState.selectedMerchant='';$('inputMerchantSearch').value='';updateCalcPreviewAndRecommendations();});
  on('inputRecordNote','input',e=>{modalState.note=e.target.value;});
  on('btnDateToggle','click',()=>{$('inputRecordDate').hidden=!$('inputRecordDate').hidden;if(!$('inputRecordDate').hidden)$('inputRecordDate').focus();});
  on('inputRecordDate','change',e=>{modalState.date=e.target.value;$('btnDateToggle').textContent=(modalState.date===today()?'今天':modalState.date||'選擇日期')+' ▾';});
  on('btnSaveRecord','click',()=>handleSaveRecord(false));on('btnSaveAndNextRecord','click',()=>handleSaveRecord(true));on('btnDeleteRecordInModal','click',removeRecord);
  on('btnUndoDelete','click',()=>{if(!lastDeletedRecord)return;const r=lastDeletedRecord;if(!commit(s=>{if(!s.records.some(x=>x.id===r.id))s.records.push(r);} ))return;lastDeletedRecord=null;$('undoBar').classList.add('hidden');renderAll();showToast('已復原紀錄');});
  ['expense','income'].forEach(t=>{on(t==='expense'?'statsTabExpense':'statsTabIncome','click',()=>{state.statsType=t;renderAll();});on(t==='expense'?'catMgrTabExpense':'catMgrTabIncome','click',()=>{state.catMgrType=t;renderSettings();});});
  ['month','year'].forEach(p=>on(p==='month'?'statsPeriodMonth':'statsPeriodYear','click',()=>{state.statsPeriod=p;renderAll();}));
  on('btnCloseDrilldown','click',()=>$('modalDrilldown').classList.add('hidden'));
  document.querySelectorAll('.setting-header-btn').forEach(b=>b.onclick=()=>{if(commit(s=>s.preferences.homeHeaderMode=b.dataset.mode))renderAll();});
  on('toggleSaveAndNext','click',()=>{if(commit(s=>s.preferences.enableSaveAndNext=!s.preferences.enableSaveAndNext))renderSettings();});
  on('btnManageAddMerchant','click',()=>{const name=$('inputManageNewMerchant').value.trim();if(!name||name.length>100||state.merchants.includes(name))return showToast('請輸入尚未存在的名稱（最多 100 字）。');const type=state.merchantMgrType==='income'?'income':'expense';if(commit(s=>{s.merchants.push(name);Object.defineProperty(s.merchantTypes,name,{value:type,enumerable:true,writable:true,configurable:true});})){$('inputManageNewMerchant').value='';renderSettings();showToast(`已新增「${name}」`);}});
  ['expense','income'].forEach(t=>on(t==='expense'?'merMgrTabExpense':'merMgrTabIncome','click',()=>{state.merchantMgrType=t;merchantMgrShowAll=false;renderMerchantManager();}));
  on('merchantMgrSearch','input',e=>{merchantMgrQuery=e.target.value;renderMerchantManager();});
  on('btnMerchantShowAll','click',()=>{merchantMgrShowAll=!merchantMgrShowAll;renderMerchantManager();});
  on('btnEditTotalBudget','click',()=>editBudget(''));
  on('btnHomeBudgetMore','click',()=>{state.activeView='stats';state.statsPeriod='month';state.statsType='expense';renderAll();window.scrollTo({top:0});});
  on('btnStatsBudgetEdit','click',()=>openSettingsPage('budget'));
  on('btnCompareMore','click',()=>{compareShowAll=!compareShowAll;renderStats();});
  setupTrendTooltip();
  setupRecurringForm();
  on('btnExportJsonDemo','click',exportBackup);on('btnExportCsv','click',exportCsv);on('btnImportBackup','click',()=>$('backupFile').click());
  on('backupFile','change',e=>{prepareImport(e.target.files[0]);e.target.value='';});
  on('btnUndoImport','click',async()=>{
    try{const raw=await LedgerStore.loadSnapshot('before_import');if(!raw)return;const previous=validateBackup(JSON.parse(raw));previous.entityTimes={...(state.entityTimes||{})};openDialog({title:'還原匯入前帳本？',message:`將恢復 ${previous.records.length} 筆紀錄。目前帳本會成為下一份可還原版本。${LedgerSync.isLinked()?'\n這個變更也會同步到其他裝置。':''}`,onConfirm:()=>{LedgerSync.acknowledgeBulkChange(state.records.length);return installImport(previous);}});}catch(e){showToast('無法讀取還原資料：'+e.message);}
  });
  on('dialogBtnCancel','click',closeDialog);
  document.addEventListener('keydown',e=>{
    const modal=!$('modalDialog').classList.contains('hidden')?$('modalDialog'):!$('modalDrilldown').classList.contains('hidden')?$('modalDrilldown'):null;
    if(e.key==='Escape'){if(modal?.id==='modalDialog')closeDialog();else if(modal)modal.classList.add('hidden');else if(state.activeView==='record')closeRecordPage();}
    if(e.key==='Tab'&&modal){const nodes=[...modal.querySelectorAll('button,input,textarea')].filter(x=>!x.hidden&&!x.classList.contains('hidden')&&!x.disabled);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
  });
  LedgerStore.watchOtherTabs(()=>showStorageError('帳本已在另一個分頁變更。請先下載帳本備份，再重新開啟，避免覆蓋。'));
  window.addEventListener('pagehide',()=>{if(state.activeView==='record'){discardForm();state.activeView=state.previousView||'home';renderAll();}});
  renderAll();if(loadIssue)showStorageError(loadIssue);
  markLedgerReady();
  ledgerReady.then(()=>{document.documentElement.dataset.ready='1';});
  scheduleRecurring();
});

