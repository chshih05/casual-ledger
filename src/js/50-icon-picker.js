const iconPickerStates=new Map();
const ICON_GROUPS=[...new Set(ICON_CATALOG.map(item=>item.group))];
function pickerState(id) {
  if(!iconPickerStates.has(id))iconPickerStates.set(id,{key:'dinner',query:'',group:'',level:''});
  return iconPickerStates.get(id);
}
function filteredIcons(picker) {
  const words=picker.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return ICON_CATALOG.filter(item=>(!picker.group||item.group===picker.group)&&(!picker.level||item.level===picker.level)&&words.every(word=>`${item.label} ${item.group} ${item.key} ${item.keywords}`.toLocaleLowerCase().includes(word)));
}
function selectedIcon(id) { return pickerState(id).key; }
function renderIconPickers() {
  ['inlineIconPickerGrid','settingsIconPickerGrid','dialogIconPicker'].forEach(id=>{
    const host=document.getElementById(id);if(!host)return;
    if(id==='dialogIconPicker'&&host.classList.contains('hidden'))return;
    const picker=pickerState(id);
    if(!host.dataset.ready){
      host.dataset.ready='true';
      host.innerHTML=`<p class="icon-picker-intro">可選大方向或細項，分類名稱由你決定。</p>
        <input type="search" class="icon-search" aria-label="搜尋分類圖示" placeholder="搜尋：咖啡、停車、保險…" autocomplete="off" />
        <div class="icon-filter-row"><select class="icon-group" aria-label="圖示主題"><option value="">全部主題</option>${ICON_GROUPS.map(group=>`<option>${escapeHtml(group)}</option>`).join('')}</select>
        <select class="icon-level" aria-label="圖示粗細程度"><option value="">大方向＋細項</option><option value="broad">只看大方向</option><option value="detail">只看細項</option></select></div>
        <div class="icon-selected" aria-live="polite"></div><div class="icon-results-count" aria-live="polite"></div><div class="icon-results"></div>`;
      host.querySelector('.icon-search').oninput=e=>{picker.query=e.target.value;renderPickerResults(id);};
      host.querySelector('.icon-group').onchange=e=>{picker.group=e.target.value;renderPickerResults(id);};
      host.querySelector('.icon-level').onchange=e=>{picker.level=e.target.value;renderPickerResults(id);};
    }
    host.querySelector('.icon-search').value=picker.query;
    host.querySelector('.icon-group').value=picker.group;
    host.querySelector('.icon-level').value=picker.level;
    renderPickerResults(id);
  });
}
function renderPickerResults(id) {
  const host=document.getElementById(id),picker=pickerState(id),items=filteredIcons(picker);
  host.querySelector('.icon-selected').innerHTML=`${ICONS[picker.key]}<span>已選：${escapeHtml(ICON_LABELS[picker.key])}</span>`;
  host.querySelector('.icon-results-count').textContent=`顯示 ${items.length}／${ICON_CATALOG.length} 個圖示`;
  const results=host.querySelector('.icon-results');results.innerHTML='';
  if(!items.length){const empty=document.createElement('p');empty.className='icon-empty';empty.textContent='找不到相符圖示，試試其他關鍵字或選擇全部主題。';results.appendChild(empty);return;}
  for(const group of ICON_GROUPS){
    const groupItems=items.filter(item=>item.group===group);if(!groupItems.length)continue;
    const section=document.createElement('section');section.className='icon-group-section';
    const title=document.createElement('h4');title.textContent=group;section.appendChild(title);
    const grid=document.createElement('div');grid.className='icon-options';
    groupItems.forEach(item=>{
      const button=document.createElement('button');button.type='button';button.className='icon-option';button.dataset.icon=item.key;
      button.setAttribute('aria-pressed',String(picker.key===item.key));button.setAttribute('aria-label',`${item.label}（${item.level==='broad'?'大方向':'細項'}）`);
      button.title=item.label+' · '+item.keywords;
      button.innerHTML=`${ICONS[item.key]}<span>${escapeHtml(item.label)}</span>${item.level==='broad'?'<small>大方向</small>':''}`;
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
  Object.assign(picker,{key:Object.hasOwn(ICONS,category.icon)?category.icon:'other',query:'',group:'',level:''});
  openDialog({title:`更換「${category.name}」圖示`,message:'只更換圖示，分類名稱、金額與歷史紀錄保持不變。',onConfirm:()=>{
    const key=selectedIcon('dialogIconPicker');
    if(!Object.hasOwn(ICONS,key))return false;
    if(!commit(s=>{const c=s.categories.find(c=>c.id===category.id);if(c)c.icon=key;}))return false;
    renderAll();showToast('已更換分類圖示');
  }});
  document.getElementById('dialogIconPicker').classList.remove('hidden');
  renderIconPickers();document.querySelector('#dialogIconPicker .icon-search').focus();
}

