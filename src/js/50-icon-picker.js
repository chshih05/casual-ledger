const iconPickerStates=new Map();
const ICON_GROUPS=[...new Set(ICON_CATALOG.map(item=>item.group))];
function pickerState(id) {
  if(!iconPickerStates.has(id))iconPickerStates.set(id,{key:'other',group:'',reveal:false,onPick:null});
  return iconPickerStates.get(id);
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
// 圖示依大分類分組，點「全部」或某個大分類切換。不另外提供搜尋：打分類名稱就會自動選最接近的圖示；
// 選中的圖示顯示在分類編輯上方的預覽，這裡也不再重複列出。
function renderIconPicker(id) {
  const host=document.getElementById(id),picker=pickerState(id);
  if(!host.dataset.ready){
    host.dataset.ready='true';
    host.innerHTML=`<div class="icon-group-chips" role="group" aria-label="圖示大分類">${['',...ICON_GROUPS].map(group=>`<button type="button" class="icon-chip" data-group="${escapeHtml(group)}">${group?escapeHtml(group):'全部'}</button>`).join('')}</div>
      <div class="icon-results"></div>`;
    host.querySelectorAll('.icon-chip').forEach(chip=>chip.onclick=()=>{picker.group=chip.dataset.group;renderPickerResults(id);});
  }
  renderPickerResults(id);
}
// 改變選取的圖示（點選或依名稱建議）：只更新選取狀態，不改變顯示的大分類與捲動位置。
function selectPickerIcon(id,key) {
  pickerState(id).key=key;
  document.getElementById(id).querySelectorAll('.icon-option').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.icon===key)));
}
function renderPickerResults(id) {
  const host=document.getElementById(id),picker=pickerState(id),chips=host.querySelector('.icon-group-chips');
  chips.querySelectorAll('.icon-chip').forEach(chip=>chip.setAttribute('aria-pressed',String(chip.dataset.group===picker.group)));
  // 預設跳到「收入」這類排在後面的大分類時，把按鈕捲到看得見的位置；畫面還沒顯示時等下次再捲。
  if(picker.reveal&&chips.clientWidth){
    const chip=chips.querySelector('.icon-chip[aria-pressed="true"]');
    chips.scrollLeft+=chip.getBoundingClientRect().left-chips.getBoundingClientRect().left-8;
    picker.reveal=false;
  }
  const results=host.querySelector('.icon-results');results.innerHTML='';results.scrollTop=0;
  for(const group of picker.group?[picker.group]:ICON_GROUPS){
    const groupItems=ICON_CATALOG.filter(item=>item.group===group);
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
