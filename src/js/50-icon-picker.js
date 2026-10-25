const iconPickerStates=new Map();
const ICON_GROUPS=[...new Set(ICON_CATALOG.map(item=>item.group))];
function pickerState(id) {
  if(!iconPickerStates.has(id))iconPickerStates.set(id,{key:'dinner',query:'',group:'',type:'',reveal:false});
  return iconPickerStates.get(id);
}
// 有輸入搜尋字時找全部大分類；沒有時只顯示選中的大分類。
function filteredIcons(picker) {
  const words=picker.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return ICON_CATALOG.filter(item=>(words.length||!picker.group||item.group===picker.group)&&words.every(word=>`${item.label} ${item.group} ${item.key} ${item.keywords}`.toLocaleLowerCase().includes(word)));
}
function selectedIcon(id) { return pickerState(id).key; }
// 新增收入分類時先顯示「收入」大分類；只在切換支出／收入時重設，不蓋掉使用者自己點的大分類。
function syncPickerType(id) {
  const type=id==='settingsIconPickerGrid'?state.catMgrType:id==='inlineIconPickerGrid'?(modalState?.type||'expense'):'';
  const picker=pickerState(id);
  if(!type||picker.type===type)return;
  const first=!picker.type;
  Object.assign(picker,{type,group:type==='income'?'收入':'',query:'',reveal:true});
  if(type==='income')picker.key='income';else if(!first)picker.key='dinner';
}
function renderIconPickers() {
  ['inlineIconPickerGrid','settingsIconPickerGrid','dialogIconPicker'].forEach(id=>{
    const host=document.getElementById(id);if(!host)return;
    if(id==='dialogIconPicker'&&host.classList.contains('hidden'))return;
    const picker=pickerState(id);
    syncPickerType(id);
    if(!host.dataset.ready){
      host.dataset.ready='true';
      host.innerHTML=`<p class="icon-picker-intro">依大分類挑一個圖示，分類名稱由你決定。</p>
        <input type="search" class="icon-search" aria-label="搜尋分類圖示" placeholder="搜尋：咖啡、停車、保險…" autocomplete="off" />
        <div class="icon-group-chips" role="group" aria-label="圖示大分類">${['',...ICON_GROUPS].map(group=>`<button type="button" class="icon-chip" data-group="${escapeHtml(group)}">${group?escapeHtml(group):'全部'}</button>`).join('')}</div>
        <div class="icon-selected" aria-live="polite"></div><div class="icon-results-count" aria-live="polite"></div><div class="icon-results"></div>`;
      host.querySelector('.icon-search').oninput=e=>{picker.query=e.target.value;renderPickerResults(id);};
      host.querySelectorAll('.icon-chip').forEach(chip=>chip.onclick=()=>{picker.group=chip.dataset.group;picker.query='';host.querySelector('.icon-search').value='';renderPickerResults(id);});
    }
    host.querySelector('.icon-search').value=picker.query;
    renderPickerResults(id);
  });
}
function renderPickerResults(id) {
  const host=document.getElementById(id),picker=pickerState(id),items=filteredIcons(picker);
  const active=picker.query.trim()?'':picker.group,chips=host.querySelector('.icon-group-chips');
  chips.querySelectorAll('.icon-chip').forEach(chip=>chip.setAttribute('aria-pressed',String(chip.dataset.group===active)));
  // 預設跳到「收入」這類排在後面的大分類時，把按鈕捲到看得見的位置；畫面還沒顯示時等下次再捲。
  if(picker.reveal&&chips.clientWidth){
    const chip=chips.querySelector('.icon-chip[aria-pressed="true"]');
    chips.scrollLeft+=chip.getBoundingClientRect().left-chips.getBoundingClientRect().left-8;
    picker.reveal=false;
  }
  host.querySelector('.icon-selected').innerHTML=`${ICONS[picker.key]}<span>已選：${escapeHtml(ICON_LABELS[picker.key])}</span>`;
  host.querySelector('.icon-results-count').textContent=`顯示 ${items.length}／${ICON_CATALOG.length} 個圖示`;
  const results=host.querySelector('.icon-results');results.innerHTML='';
  if(!items.length){const empty=document.createElement('p');empty.className='icon-empty';empty.textContent='找不到相符圖示，試試其他關鍵字。';results.appendChild(empty);return;}
  for(const group of ICON_GROUPS){
    const groupItems=items.filter(item=>item.group===group);if(!groupItems.length)continue;
    const section=document.createElement('section');section.className='icon-group-section';
    const title=document.createElement('h4');title.textContent=group;section.appendChild(title);
    const grid=document.createElement('div');grid.className='icon-options';
    groupItems.forEach(item=>{
      const button=document.createElement('button');button.type='button';button.className='icon-option';button.dataset.icon=item.key;
      button.setAttribute('aria-pressed',String(picker.key===item.key));button.setAttribute('aria-label',item.label);
      button.title=item.label+' · '+item.keywords;
      button.innerHTML=`${ICONS[item.key]}<span>${escapeHtml(item.label)}</span>`;
      button.onclick=()=>{
        picker.key=item.key;
        // Update the selection in place, retaining scroll position and keyboard focus.
        results.querySelectorAll('.icon-option').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.icon===item.key)));
        host.querySelector('.icon-selected').innerHTML=`${ICONS[item.key]}<span>已選：${escapeHtml(item.label)}</span>`;
      };
      grid.appendChild(button);
    });
    section.appendChild(grid);results.appendChild(section);
  }
}
function openCategoryIconPicker(category) {
  const picker=pickerState('dialogIconPicker');
  Object.assign(picker,{key:Object.hasOwn(ICONS,category.icon)?category.icon:'other',query:'',group:'',reveal:true});
  openDialog({title:`更換「${category.name}」圖示`,message:'只更換圖示，分類名稱、金額與歷史紀錄保持不變。',onConfirm:()=>{
    const key=selectedIcon('dialogIconPicker');
    if(!Object.hasOwn(ICONS,key))return false;
    if(!commit(s=>{const c=s.categories.find(c=>c.id===category.id);if(c)c.icon=key;}))return false;
    renderAll();showToast('已更換分類圖示');
  }});
  document.getElementById('dialogIconPicker').classList.remove('hidden');
  renderIconPickers();document.querySelector('#dialogIconPicker .icon-search').focus();
}
