// 預算：每月總預算（所有支出合計）與各支出分類的每月預算，只計算支出。
// 金額存在偏好設定（monthlyBudget）與支出分類（budget），會跟著雲端同步與備份。
const BUDGET_NEAR = 0.8; // 用到八成就提醒「快用完」
const BUDGET_ICON =
  '<svg class="budget-flag-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.2 5h2.4v7h-2.4Zm0 9h2.4v2.4h-2.4Z"/></svg>';

const monthWord = month => (month === today().slice(0, 7) ? '本月' : `${Number(month.slice(5))} 月`);
// 某個月的預算使用情形：總預算排第一，接著依分類順序。
function budgetItems(month, s = state) {
  let total = 0;
  const spent = new Map();
  for (const r of s.records) {
    if (r.type !== 'expense' || !r.date.startsWith(month)) continue;
    total += r.amount;
    spent.set(r.categoryId, (spent.get(r.categoryId) || 0) + r.amount);
  }
  const items =
    s.preferences.monthlyBudget > 0
      ? [{ key: 'total', name: '總預算', limit: s.preferences.monthlyBudget, used: total }]
      : [];
  s.categories
    .filter(c => c.type === 'expense' && c.budget > 0)
    .sort((a, b) => a.order - b.order)
    .forEach(c => items.push({ key: c.id, name: c.name, icon: c.icon, limit: c.budget, used: spent.get(c.id) || 0 }));
  return items;
}
const budgetStatus = item => (item.used > item.limit ? 'over' : item.used >= item.limit * BUDGET_NEAR ? 'near' : 'ok');
// 「今天」在這個月的位置（例如 10/25 約 81%）；不是目前月份時沒有。
function monthPace(month) {
  const now = today();
  if (!now.startsWith(month)) return null;
  const [y, m] = month.split('-').map(Number);
  return Number(now.slice(8)) / new Date(y, m, 0).getDate();
}
// 進度條的顏色代表狀態（紫＝正常、黃＝快用完、紅＝超出），旁邊一定有文字，不只靠顏色。
function budgetMeter(item, pace = null) {
  const pct = Math.min(100, (item.used / item.limit) * 100).toFixed(1);
  const tick =
    pace === null
      ? ''
      : `<span class="budget-pace" style="left:${(pace * 100).toFixed(1)}%"></span><span class="budget-pace-label" style="left:${Math.min(92, Math.max(8, pace * 100)).toFixed(1)}%">今天</span>`;
  return `<div class="budget-meter${pace === null ? '' : ' has-pace'}" data-status="${budgetStatus(item)}" role="img" aria-label="已用 ${Math.round((item.used * 100) / item.limit)}%"><div class="budget-track"><div class="budget-fill" style="width:${pct}%"></div></div>${tick}</div>`;
}
function budgetNote(item) {
  const status = budgetStatus(item),
    left = item.limit - item.used;
  if (status === 'over')
    return `<span class="budget-flag" data-status="over">${BUDGET_ICON}超出 NT$ ${formatMoney(-left)}</span>`;
  return `${status === 'near' ? `<span class="budget-flag" data-status="near">${BUDGET_ICON}快用完</span>` : ''}<span>剩 NT$ ${formatMoney(left)}</span>`;
}
function budgetRow(item, pace = null, extra = '') {
  const icon = item.icon ? `<span class="text-accent">${ICONS[item.icon] || ICONS.other}</span>` : '';
  return `<div class="budget-row">
    <div class="budget-row-head"><span class="budget-name">${icon}<span class="truncate">${escapeHtml(item.name)}</span></span><span class="budget-amount">NT$ ${formatMoney(item.used)}<span class="text-textMuted"> / ${formatMoney(item.limit)}</span></span></div>
    ${budgetMeter(item, pace)}
    <div class="budget-note">${budgetNote(item)}${extra}</div>
  </div>`;
}
// 總預算還沒用完時：這個月還剩幾天（含今天）、平均每天還能花多少。
function dailyAllowance(item, month) {
  if (item.key !== 'total' || monthPace(month) === null || item.used >= item.limit) return '';
  const [y, m] = month.split('-').map(Number),
    daysLeft = new Date(y, m, 0).getDate() - Number(today().slice(8)) + 1;
  return `<span>還有 ${daysLeft} 天，每天約 NT$ ${formatMoney(Math.floor((item.limit - item.used) / daysLeft))}</span>`;
}
// 首頁：總預算一定顯示；分類只列快用完或超出的，其餘用一句話帶過。
function renderHomeBudget() {
  const month = state.currentMonth,
    items = budgetItems(month);
  $('homeBudgetCard').classList.toggle('hidden', !items.length);
  if (!items.length) return;
  $('homeBudgetTitle').textContent = `${monthWord(month)}預算`;
  const total = items.find(i => i.key === 'total'),
    cats = items.filter(i => i.key !== 'total'),
    pace = monthPace(month);
  let html = '';
  if (total) html += budgetRow(total, pace, dailyAllowance(total, month));
  const alerts = cats.filter(i => budgetStatus(i) !== 'ok');
  html += alerts
    .slice(0, 3)
    .map(i => budgetRow(i))
    .join('');
  if (alerts.length > 3) html += `<p class="budget-more">另有 ${alerts.length - 3} 個分類快用完或超出</p>`;
  else if (cats.length > alerts.length)
    html += `<p class="budget-more">${alerts.length ? '其他 ' : ''}${cats.length - alerts.length} 個分類預算都還在範圍內</p>`;
  $('homeBudgetBody').innerHTML = html;
}
// 統計頁（按月、支出）：列出全部預算。
function renderStatsBudget(yearMode) {
  const month = state.currentMonth,
    items = yearMode || state.statsType !== 'expense' ? [] : budgetItems(month);
  $('statsBudgetSection').classList.toggle('hidden', !items.length);
  if (!items.length) return;
  $('statsBudgetTitle').textContent = `${monthWord(month)}預算`;
  const pace = monthPace(month);
  $('statsBudgetList').innerHTML = items
    .map(i => (i.key === 'total' ? budgetRow(i, pace, dailyAllowance(i, month)) : budgetRow(i)))
    .join('');
}
function renderBudgetSettings() {
  const total = state.preferences.monthlyBudget || 0,
    cats = getCategoriesByType('expense');
  $('budgetTotalValue').textContent = total ? `NT$ ${formatMoney(total)}` : '未設定';
  $('budgetTotalValue').classList.toggle('text-textMuted', !total);
  $('btnEditTotalBudget').textContent = total ? '修改' : '設定';
  const list = $('budgetCategoryList');
  list.innerHTML = '';
  cats.forEach(c => {
    const row = document.createElement('div');
    row.className = 'budget-setting-row';
    row.innerHTML = `<span class="flex items-center gap-2 min-w-0">${ICONS[c.icon] || ICONS.other}<span class="truncate">${escapeHtml(c.name)}</span></span><span class="flex items-center gap-2 shrink-0"><span class="num-tabular ${c.budget ? 'text-textMain' : 'text-textMuted'}">${c.budget ? 'NT$ ' + formatMoney(c.budget) : '未設定'}</span><button type="button" class="px-2 text-accent">${c.budget ? '修改' : '設定'}</button></span>`;
    const b = row.querySelector('button');
    b.setAttribute('aria-label', `${c.name} 預算${b.textContent}`);
    b.onclick = () => editBudget(c.id);
    list.appendChild(row);
  });
  const sum = cats.reduce((n, c) => n + (c.budget || 0), 0);
  $('budgetCategorySum').textContent = sum
    ? `分類預算合計 NT$ ${formatMoney(sum)}${total && sum > total ? '，比總預算多 NT$ ' + formatMoney(sum - total) : ''}。`
    : '';
}
// 輸入框接受「12,000」「NT$ 12000」；留白或 0 代表不設定，格式錯誤回傳 null。
function parseBudget(value) {
  const t = String(value)
    .replace(/[,，\s]/g, '')
    .replace(/^NT\$?/i, '');
  if (t === '' || /^0+$/.test(t)) return 0;
  return /^\d+$/.test(t) && Number(t) <= MAX_AMOUNT ? Number(t) : null;
}
function editBudget(categoryId) {
  const cat = categoryId ? getCategoryById(categoryId) : null,
    current = cat ? cat.budget || 0 : state.preferences.monthlyBudget || 0;
  openDialog({
    title: cat ? `「${cat.name}」每月預算` : '每月總預算',
    message: cat
      ? '這個分類每個月最多想花多少。留白或 0 代表不設定。'
      : '所有支出加起來，每個月最多想花多少。留白或 0 代表不設定。',
    inputValue: current ? String(current) : '',
    inputMode: 'numeric',
    confirmText: '儲存',
    onConfirm: value => {
      const amount = parseBudget(value);
      if (amount === null) return showToast('請輸入 0～999,999,999 的整數金額。'), false;
      if (
        !commit(s => {
          if (!cat) {
            s.preferences.monthlyBudget = amount;
            return;
          }
          const c = s.categories.find(x => x.id === cat.id);
          if (!c) return;
          if (amount) c.budget = amount;
          else delete c.budget;
        })
      )
        return false;
      renderAll();
      showToast(amount ? '已設定預算' : '已取消預算');
    },
  });
}
// 記帳後的預算提醒：這筆讓分類或總預算超出、或第一次用到八成時提醒（超出優先）。
function budgetAlert(before, rec) {
  if (rec.type !== 'expense') return '';
  const month = rec.date.slice(0, 7),
    prev = new Map(budgetItems(month, before).map(i => [i.key, i]));
  let near = '';
  for (const item of budgetItems(month).filter(i => i.key === rec.categoryId || i.key === 'total')) {
    const was = prev.get(item.key),
      wasStatus = was ? budgetStatus(was) : 'ok',
      status = budgetStatus(item);
    const label = item.key === 'total' ? `${monthWord(month)}總預算` : `「${item.name}」${monthWord(month)}預算`;
    if (status === 'over' && wasStatus !== 'over') return `${label}已超出 NT$ ${formatMoney(item.used - item.limit)}`;
    if (status === 'near' && wasStatus === 'ok' && !near)
      near = `${label}已用 ${Math.floor((item.used * 100) / item.limit)}%`;
  }
  return near;
}
