const iconPickerStates=new Map();
const ICON_GROUPS=[...new Set(ICON_CATALOG.map(item=>item.group))];
function pickerState(id) {
  if(!iconPickerStates.has(id))iconPickerStates.set(id,{key:'other',query:'',group:'',reveal:false,onPick:null});
  return iconPickerStates.get(id);
}
// 有輸入搜尋字時找全部大分類；沒有時只顯示選中的大分類。
function filteredIcons(picker) {
  const words=picker.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return ICON_CATALOG.filter(item=>(words.length||!picker.group||item.group===picker.group)&&words.every(word=>`${item.label} ${item.group} ${item.key} ${item.keywords}`.toLocaleLowerCase().includes(word)));
}
function selectedIcon(id) { return pickerState(id).key; }
// 依分類名稱建議圖示：和圖示名稱相同最優先，其次是和關鍵字相同、互相包含（取最長的相符字）。
// 收入分類優先用「收入」大分類的圖示，支出分類則避開它們（例如「利息」）。找不到時回傳 null。
function suggestIcon(name,type='expense') {
  const text=name.trim().toLocaleLowerCase();
  if(!text)return null;
  let best=null,bestScore=0;
  for(const item of ICON_CATALOG){
    const label=item.label.toLocaleLowerCase(),words=item.keywords.toLocaleLowerCase().split(/\s+/).filter(w=>w.length>=2);
    let score=0;
    if(label===text)score=100;
    else if(words.includes(text))score=90;
    else if(label.length>=2&&text.includes(label))score=70+label.length;
    else if(text.length>=2&&label.includes(text))score=60+text.length;
    else{const w=words.filter(w=>text.includes(w)||(text.length>=2&&w.includes(text))).sort((a,b)=>b.length-a.length)[0];if(w)score=50+Math.min(w.length,text.length);}
    if(!score)continue;
    score+=(item.group==='收入')===(type==='income')?5:-5;
    if(score>bestScore){best=item.key;bestScore=score;}
  }
  return best;
}
function renderIconPicker(id) {
  const host=document.getElementById(id),picker=pickerState(id);
  if(!host.dataset.ready){
    host.dataset.ready='true';
    host.innerHTML=`<input type="search" class="icon-search" aria-label="搜尋分類圖示" placeholder="搜尋：咖啡、停車、保險…" autocomplete="off" />
      <div class="icon-group-chips" role="group" aria-label="圖示大分類">${['',...ICON_GROUPS].map(group=>`<button type="button" class="icon-chip" data-group="${escapeHtml(group)}">${group?escapeHtml(group):'全部'}</button>`).join('')}</div>
      <div class="icon-selected" aria-live="polite"></div><div class="icon-results-count" aria-live="polite"></div><div class="icon-results"></div>`;
    host.querySelector('.icon-search').oninput=e=>{picker.query=e.target.value;renderPickerResults(id);};
    host.querySelectorAll('.icon-chip').forEach(chip=>chip.onclick=()=>{picker.group=chip.dataset.group;picker.query='';host.querySelector('.icon-search').value='';renderPickerResults(id);});
  }
  host.querySelector('.icon-search').value=picker.query;
  renderPickerResults(id);
}
// 改變選取的圖示（點選或依名稱建議）：只更新選取狀態，不改變顯示的大分類與捲動位置。
function selectPickerIcon(id,key) {
  const host=document.getElementById(id);
  pickerState(id).key=key;
  host.querySelectorAll('.icon-option').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.icon===key)));
  host.querySelector('.icon-selected').innerHTML=`${ICONS[key]||ICONS.other}<span>已選：${escapeHtml(ICON_LABELS[key]||'其他')}</span>`;
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
  host.querySelector('.icon-selected').innerHTML=`${ICONS[picker.key]||ICONS.other}<span>已選：${escapeHtml(ICON_LABELS[picker.key]||'其他')}</span>`;
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
      button.onclick=()=>{selectPickerIcon(id,item.key);picker.onPick?.(item.key);};
      grid.appendChild(button);
    });
    section.appendChild(grid);results.appendChild(section);
  }
}
