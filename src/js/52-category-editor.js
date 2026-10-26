// 分類編輯：新增與修改用同一個畫面。參考熱門記帳 App 的做法：
// - 在需要的地方新增：記帳頁分類最後面就有「＋ 新增」，新增後直接選取（Monzo 從交易直接建立分類）。
// - 先打名稱，圖示依名稱自動建議；上方即時預覽在記帳頁的樣子（Rocket Money、Wallet 都是名稱優先）。
// - 名稱和圖示都由使用者自己決定，不提供現成的常見分類；先挑圖示時，名稱自動帶入圖示名稱。
// - 設定頁點分類就能改名、換圖示或刪除，不再分成三個按鈕（Money Manager 的編輯畫面）。
const CAT_PICKER='categoryEditorIcons';
let catEditor=null; // {mode:'add'|'edit', type, id, from:'record'|'settings', iconTouched, hint, returnFocus}
const defaultCategoryIcon=type=>type==='income'?'income':'other';

function openCategoryEditor({mode='add',type='expense',id=null,from='settings'}={}) {
  const cat=mode==='edit'?state.categories.find(c=>c.id===id):null;
  if(mode==='edit'&&!cat)return;
  type=cat?cat.type:type;
  catEditor={mode,type,id,from,iconTouched:mode==='edit',hint:'',returnFocus:document.activeElement};
  // 新增收入分類先顯示「收入」大分類；修改時直接顯示目前圖示所在的大分類，不用往下找。
  const picker=pickerState(CAT_PICKER),key=cat?(Object.hasOwn(ICONS,cat.icon)?cat.icon:'other'):defaultCategoryIcon(type);
  Object.assign(picker,{key,group:cat?(ICON_CATALOG.find(i=>i.key===key)?.group||''):type==='income'?'收入':'',reveal:true,onPick:onCategoryIconPick});
  $('catEditorTitle').textContent=cat?'編輯分類':type==='income'?'新增收入分類':'新增支出分類';
  $('catEditorName').value=cat?cat.name:'';
  $('catEditorError').classList.add('hidden');
  $('btnCatEditorDelete').classList.toggle('hidden',!cat);
  $('btnCatEditorSave').textContent=cat?'儲存':from==='record'?'新增並選取':'新增';
  $('modalCategory').classList.remove('hidden');
  renderIconPicker(CAT_PICKER);
  updateCategoryPreview();
  $('catEditorName').focus();
}
function closeCategoryEditor() {
  if(!catEditor)return;
  const back=catEditor.returnFocus;
  catEditor=null;
  $('modalCategory').classList.add('hidden');
  if(back?.isConnected)back.focus?.();
}
function categoryEditorError(message) {
  $('catEditorError').textContent=message;
  $('catEditorError').classList.toggle('hidden',!message);
}
function updateCategoryPreview() {
  if(!catEditor)return;
  const name=$('catEditorName').value.trim(),key=selectedIcon(CAT_PICKER);
  const preview=$('catEditorPreview');
  preview.innerHTML=`${ICONS[key]||ICONS.other}<span></span>`;
  preview.lastElementChild.textContent=name||(catEditor.type==='income'?'收入分類':'新分類');
  preview.classList.toggle('is-empty',!name);
  $('catEditorHint').textContent=catEditor.hint;
}
// 打名稱時：還沒自己挑過圖示，就依名稱換成最相近的圖示；找不到相近的就換回預設圖示，不留下和名稱無關的圖示。
function onCategoryNameInput() {
  if(!catEditor)return;
  categoryEditorError('');
  if(!catEditor.iconTouched){
    const key=suggestIcon($('catEditorName').value,catEditor.type);
    selectPickerIcon(CAT_PICKER,key||defaultCategoryIcon(catEditor.type));
    catEditor.hint=key?`已依名稱選了「${ICON_LABELS[key]}」圖示，可以在下面改選。`:'';
  }
  updateCategoryPreview();
}
// 自己挑了圖示之後，名稱就不再改變圖示；名稱還空著時帶入圖示名稱，方便直接儲存或修改。
function onCategoryIconPick(key) {
  if(!catEditor)return;
  catEditor.iconTouched=true;catEditor.hint='';
  const input=$('catEditorName');
  if(!input.value.trim()){input.value=ICON_LABELS[key]||'';input.select();}
  categoryEditorError('');
  updateCategoryPreview();
}
function saveCategoryEditor() {
  const ed=catEditor;if(!ed)return;
  const name=$('catEditorName').value.trim(),icon=selectedIcon(CAT_PICKER);
  const error=!name?'請輸入分類名稱。':name.length>40?'名稱最多 40 個字。':state.categories.some(c=>c.type===ed.type&&c.id!==ed.id&&c.name===name)?`已經有「${name}」這個分類了。`:'';
  if(error){categoryEditorError(error);$('catEditorName').focus();return;}
  if(ed.mode==='edit'){
    if(!state.categories.some(c=>c.id===ed.id))return closeCategoryEditor(); // 已在其他裝置刪除
    if(!commit(s=>{const c=s.categories.find(x=>x.id===ed.id);if(c){c.name=name;c.icon=icon;}}))return;
    closeCategoryEditor();renderAll();showToast('已更新分類');return;
  }
  const id=uid('cat'),order=Math.max(0,...getCategoriesByType(ed.type).map(c=>c.order))+1;
  if(!commit(s=>s.categories.push({id,type:ed.type,name,icon,order})))return;
  closeCategoryEditor();
  if(ed.from==='record'&&modalState&&modalState.type===ed.type){modalState.categoryId=id;keypadOpen=true;renderAll();renderRecordModal();$('inputAmountExpr').focus();}
  else renderAll();
  showToast(`已新增「${name}」`);
}
// 刪除：有紀錄或固定收支在用的分類不能刪，每種類型至少留一個。
function deleteFromCategoryEditor() {
  const ed=catEditor;if(!ed)return;
  const cat=state.categories.find(c=>c.id===ed.id);
  if(!cat)return closeCategoryEditor(); // 已在其他裝置刪除
  if(state.records.some(r=>r.categoryId===ed.id))return categoryEditorError('還有紀錄使用這個分類，請先把那些紀錄改到其他分類。');
  if((state.recurring||[]).some(r=>r.categoryId===ed.id))return categoryEditorError('固定收支還在使用這個分類，請先修改或刪除。');
  if(getCategoriesByType(cat.type).length<=1)return categoryEditorError('至少要保留一個分類。');
  openDialog({title:'刪除分類？',message:`「${cat.name}」沒有紀錄使用，刪除後不會影響帳本。`,confirmText:'刪除',onConfirm:()=>{
    if(!commit(s=>s.categories=s.categories.filter(c=>c.id!==ed.id)))return false;
    closeCategoryEditor();renderAll();showToast('已刪除分類');
  }});
}
function setupCategoryEditor() {
  $('btnCatEditorClose').onclick=closeCategoryEditor;
  $('btnCatEditorCancel').onclick=closeCategoryEditor;
  $('btnCatEditorSave').onclick=saveCategoryEditor;
  $('btnCatEditorDelete').onclick=deleteFromCategoryEditor;
  $('catEditorName').addEventListener('input',onCategoryNameInput);
  $('catEditorName').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();saveCategoryEditor();}});
  // 點背景關閉（只在按下與放開都在背景上時，避免拖曳選字時誤關）。
  let downOnBackdrop=false;
  $('modalCategory').addEventListener('pointerdown',e=>{downOnBackdrop=e.target===e.currentTarget;});
  $('modalCategory').addEventListener('click',e=>{if(downOnBackdrop&&e.target===e.currentTarget)closeCategoryEditor();downOnBackdrop=false;});
}
