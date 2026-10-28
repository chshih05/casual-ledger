// 固定收支：房租、訂閱、薪水這類固定的收支，到了那天自動記一筆。
// 自動記的紀錄代碼由規則與日期決定（rec_規則代碼_年月日），兩台裝置各自產生也只會有一筆；
// 刪掉的那一天不會再補回來。規則同步時存成 pref:rule_…（見 55-sync-core.js）。
const RULE_CATCH_UP_LIMIT = 120; // 一次最多補記幾筆（每月一筆是 10 年）
const RULE_SYNC_WAIT_MS = 6000;
let recurringTimer = null,
  editingRuleId = null,
  ruleFormType = 'expense';

const pad2 = n => String(n).padStart(2, '0');
// 31 號遇到小月記在月底；2/29 遇到平年記在 2/28。
function dueDate(y, m, day) {
  return `${y}-${pad2(m)}-${pad2(Math.min(day, new Date(y, m, 0).getDate()))}`;
}
function nextDue(rule, date) {
  const [y, m] = date.split('-').map(Number);
  return rule.freq === 'year'
    ? dueDate(y + 1, m, rule.day)
    : dueDate(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, rule.day);
}
const ruleRecordId = (rule, date) => `rec_${rule.id}_${date.replace(/-/g, '')}`;
const isRuleRecord = id => String(id).startsWith('rec_' + LedgerSyncCore.RULE_PREFIX);
function ruleUsable(rule) {
  const c = state.categories.find(c => c.id === rule.categoryId);
  return Boolean(c && c.type === rule.type);
}
// 從 next 開始到 until（含）為止要記的日期，以及之後的下一次。
function dueDates(rule, until) {
  const dates = [];
  let date = rule.next;
  while (date <= until && (!rule.end || date <= rule.end) && dates.length < RULE_CATCH_UP_LIMIT) {
    dates.push(date);
    date = nextDue(rule, date);
  }
  return { dates, next: date };
}
function runRecurring() {
  clearTimeout(recurringTimer);
  if (storageBlocked) return 0;
  const now = today(),
    plans = [];
  for (const rule of state.recurring || []) {
    if (rule.paused || !ruleUsable(rule)) continue;
    const plan = dueDates(rule, now);
    if (plan.dates.length) plans.push({ rule, ...plan });
  }
  if (!plans.length) return 0;
  let added = 0;
  const ok = commit(s => {
    s.entityTimes = { ...s.entityTimes };
    const setTime = (key, value) =>
      Object.defineProperty(s.entityTimes, key, { value, enumerable: true, writable: true, configurable: true });
    const ids = new Set(s.records.map(r => r.id));
    for (const { rule, dates, next } of plans) {
      for (const date of dates) {
        const id = ruleRecordId(rule, date),
          key = 'rec:' + id;
        // 已經有了（另一台裝置記過），或曾經被刪掉的日期，都不再記。
        if (ids.has(id) || Object.hasOwn(s.entityTimes, key)) continue;
        s.records.push({
          id,
          seq: 0,
          type: rule.type,
          date,
          categoryId: rule.categoryId,
          amount: rule.amount,
          merchant: rule.merchant,
          note: rule.note,
        });
        ids.add(id);
        added++;
        // 修改時間固定為到期日：兩台裝置各自記下的內容與時間都一樣，不會變成衝突。
        setTime(key, new Date(date + 'T00:00:00').getTime());
        if (rule.merchant && !s.merchants.includes(rule.merchant)) {
          s.merchants.push(rule.merchant);
          Object.defineProperty(s.merchantTypes, rule.merchant, {
            value: rule.type,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      const r = s.recurring.find(x => x.id === rule.id);
      if (!r) continue;
      r.next = next;
      // 自動往後推只比原本的時間多 1 毫秒：另一台裝置同時修改這條規則時，以使用者的修改為準。
      setTime('pref:' + r.id, (Number(s.entityTimes['pref:' + r.id]) || 0) + 1);
    }
  });
  if (!ok) return 0;
  renderAll();
  if (added) showToast(`已自動記下 ${added} 筆固定收支`);
  return added;
}
// 開啟網頁、從其他 App 切回來時檢查。有連結雲端時，先等同步把其他裝置的變更
// （例如暫停或刪除規則）帶進來再記；離線或沒登入時最多等幾秒。
function scheduleRecurring() {
  if (!(state.recurring || []).length) return;
  if (!LedgerSync.isLinked()) return runRecurring();
  clearTimeout(recurringTimer);
  recurringTimer = setTimeout(runRecurring, RULE_SYNC_WAIT_MS);
}
// 每次同步結束（成功或失敗）都檢查一次。
function afterLedgerSync() {
  if ((state.recurring || []).length) runRecurring();
}

// ---------- 設定頁：固定收支 ----------
function formatDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}/${m}/${d}`;
}
function ruleSchedule(rule) {
  const month = Number(rule.next.slice(5, 7));
  return rule.freq === 'year'
    ? `每年 ${month} 月 ${rule.day} 日`
    : `每月 ${rule.day} 日${rule.day > 28 ? '（沒有這天的月份記在月底）' : ''}`;
}
function ruleStatus(rule) {
  if (!ruleUsable(rule)) return { text: '分類已刪除，請修改', warn: true };
  if (rule.paused) return { text: '已暫停' };
  if (rule.end && rule.next > rule.end) return { text: `已結束（${formatDay(rule.end)}）` };
  return { text: `下次 ${formatDay(rule.next)}${rule.end ? `・到 ${formatDay(rule.end)}` : ''}` };
}
function renderRecurringSettings() {
  const list = $('ruleList'),
    rules = (state.recurring || [])
      .slice()
      .sort((a, b) => a.type.localeCompare(b.type) || a.next.localeCompare(b.next));
  list.innerHTML = rules.length
    ? ''
    : '<p class="text-xs text-textMuted">還沒有固定收支。按「新增」設定房租、訂閱或薪水。</p>';
  for (const rule of rules) {
    const cat = getCategoryById(rule.categoryId),
      status = ruleStatus(rule),
      ended = rule.end && rule.next > rule.end;
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.dataset.id = rule.id;
    row.innerHTML = `<div class="rule-row-main">
        <span class="text-accent shrink-0">${ICONS[cat.icon] || ICONS.other}</span>
        <div class="min-w-0">
          <div class="rule-title"><span class="truncate">${escapeHtml(rule.merchant || cat.name)}</span>${rule.merchant ? `<span class="rule-badge">${escapeHtml(cat.name)}</span>` : ''}</div>
          ${rule.note ? `<div class="rule-sub truncate">${escapeHtml(rule.note)}</div>` : ''}
          <div class="rule-sub">${ruleSchedule(rule)}</div>
          <div class="rule-sub${status.warn ? ' rule-warn' : ''}">${escapeHtml(status.text)}</div>
        </div>
        <span class="rule-amount${rule.type === 'income' ? ' text-incomeGreen' : ''}">${rule.type === 'income' ? '+' : ''}$${formatMoney(rule.amount)}</span>
      </div>
      <div class="rule-actions"></div>`;
    const actions = row.querySelector('.rule-actions');
    [['edit', '修改'], ended ? null : ['pause', rule.paused ? '繼續' : '暫停'], ['delete', '刪除']]
      .filter(Boolean)
      .forEach(([action, text]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'px-2 text-accent';
        b.textContent = text;
        b.setAttribute('aria-label', `${rule.merchant || cat.name} ${text}`);
        b.onclick = () => handleRuleAction(action, rule.id);
        actions.appendChild(b);
      });
    list.appendChild(row);
  }
  if (!$('ruleEditor').classList.contains('hidden')) updateRulePreview();
}
function fillRuleCategories(selected) {
  const cats = getCategoriesByType(ruleFormType),
    fallback = cats.find(c => c.id === (ruleFormType === 'income' ? 'cat_salary' : 'cat_bills')) || cats[0];
  $('ruleCategory').innerHTML = cats
    .map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
    .join('');
  $('ruleCategory').value = cats.some(c => c.id === selected) ? selected : fallback?.id || '';
  ['expense', 'income'].forEach(t => {
    const b = $(t === 'expense' ? 'ruleTypeExpense' : 'ruleTypeIncome'),
      on = t === ruleFormType;
    b.classList.toggle('bg-accent', on);
    b.classList.toggle('text-bgMain', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('ruleMerchantLabel').textContent = ruleFormType === 'income' ? '收入來源' : '店家';
  $('ruleMerchantOptions').innerHTML = state.merchants
    .filter(m => (state.merchantTypes[m] || 'expense') === ruleFormType && !state.archivedMerchants.includes(m))
    .map(m => `<option value="${escapeHtml(m)}"></option>`)
    .join('');
}
function openRuleEditor(rule = null) {
  editingRuleId = rule ? rule.id : null;
  ruleFormType = rule ? rule.type : 'expense';
  $('ruleEditorTitle').textContent = rule ? '修改固定收支' : '新增固定收支';
  $('ruleStartLabel').textContent = rule ? '下次日期' : '第一次';
  fillRuleCategories(rule?.categoryId);
  $('ruleAmount').value = rule ? String(rule.amount) : '';
  $('ruleMerchant').value = rule?.merchant || '';
  $('ruleNote').value = rule?.note || '';
  $('ruleFreq').value = rule?.freq || 'month';
  $('ruleStart').value = rule?.next || today();
  $('ruleEnd').value = rule?.end || '';
  $('ruleError').classList.add('hidden');
  $('ruleEditor').classList.remove('hidden');
  updateRulePreview();
  $('ruleEditor').scrollIntoView({ block: 'start', behavior: 'smooth' });
  $('ruleAmount').focus({ preventScroll: true });
}
function closeRuleEditor() {
  editingRuleId = null;
  $('ruleEditor').classList.add('hidden');
}
// 依表單內容組出規則；格式錯誤時回傳錯誤訊息。
function readRuleForm() {
  const categoryId = $('ruleCategory').value,
    amount = evaluateSimpleMath($('ruleAmount').value.trim()),
    start = $('ruleStart').value,
    end = $('ruleEnd').value;
  if (!state.categories.some(c => c.id === categoryId && c.type === ruleFormType)) return { error: '請選擇分類。' };
  if (!amount.valid || amount.value <= 0) return { error: '金額須為 1～999,999,999 的整數。' };
  if (!validDate(start)) return { error: editingRuleId ? '請選擇下次日期。' : '請選擇第一次的日期。' };
  if (end && !validDate(end)) return { error: '結束日期無效。' };
  if (end && end < start) return { error: '結束日期不能早於第一次的日期。' };
  const rule = {
    id: editingRuleId || uid('rule'),
    type: ruleFormType,
    categoryId,
    amount: amount.value,
    merchant: $('ruleMerchant').value.trim().slice(0, 100),
    note: $('ruleNote').value.trim().slice(0, 1000),
    freq: $('ruleFreq').value === 'year' ? 'year' : 'month',
    day: Number(start.slice(8)),
    next: start,
  };
  if (end) rule.end = end;
  const old = editingRuleId && state.recurring.find(r => r.id === editingRuleId);
  if (old?.paused) rule.paused = true;
  return { rule };
}
function updateRulePreview() {
  const start = $('ruleStart').value,
    freq = $('ruleFreq').value === 'year' ? 'year' : 'month';
  if (!validDate(start)) {
    $('rulePreview').textContent = '';
    return;
  }
  const rule = {
    freq,
    day: Number(start.slice(8)),
    next: start,
    end: validDate($('ruleEnd').value) ? $('ruleEnd').value : '',
  };
  const { dates } = dueDates(rule, today());
  let text = `${ruleSchedule(rule)}記一筆。`;
  if (dates.length > 1)
    text += `儲存後會先補記 ${dates.length} 筆（${formatDay(dates[0])}～${formatDay(dates.at(-1))}），已經記過或刪掉的日期會略過。`;
  else if (dates.length === 1) text += `儲存後會記下 ${formatDay(dates[0])} 這一筆。`;
  else text += `第一次會在 ${formatDay(start)} 記下。`;
  if (editingRuleId) text += '修改只影響之後的紀錄，已經記下的不會改變。';
  $('rulePreview').textContent = text;
}
function saveRuleForm() {
  const { rule, error } = readRuleForm();
  if (error) {
    $('ruleError').textContent = error;
    $('ruleError').classList.remove('hidden');
    return;
  }
  if (
    !commit(s => {
      s.recurring = s.recurring || [];
      const i = s.recurring.findIndex(r => r.id === rule.id);
      if (i >= 0) s.recurring[i] = rule;
      else s.recurring.push(rule);
      if (rule.merchant && !s.merchants.includes(rule.merchant)) {
        s.merchants.push(rule.merchant);
        Object.defineProperty(s.merchantTypes, rule.merchant, {
          value: rule.type,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    })
  )
    return;
  closeRuleEditor();
  if (!runRecurring()) {
    renderAll();
    showToast('已儲存固定收支');
  }
}
function handleRuleAction(action, id) {
  const rule = (state.recurring || []).find(r => r.id === id);
  if (!rule) return;
  const name = rule.merchant || getCategoryById(rule.categoryId).name;
  if (action === 'edit') return openRuleEditor(rule);
  if (action === 'pause') {
    // 繼續時從今天之後的日期開始，暫停期間的不補記。
    const resume = rule.paused,
      now = today();
    if (
      !commit(s => {
        const r = s.recurring.find(x => x.id === id);
        if (!r) return;
        if (resume) {
          delete r.paused;
          while (r.next < now) r.next = nextDue(r, r.next);
        } else r.paused = true;
      })
    )
      return;
    if (!resume || !runRecurring()) {
      renderAll();
      showToast(resume ? '已繼續' : '已暫停，暫停期間不會自動記帳');
    }
    return;
  }
  openDialog({
    title: '刪除固定收支？',
    message: `「${name}」之後不會再自動記帳，已經記下的紀錄會保留。`,
    confirmText: '刪除',
    onConfirm: () => {
      if (
        !commit(s => {
          s.recurring = s.recurring.filter(r => r.id !== id);
        })
      )
        return false;
      if (editingRuleId === id) closeRuleEditor();
      renderAll();
      showToast('已刪除固定收支');
    },
  });
}
function setupRecurringForm() {
  $('btnAddRule').onclick = () => openRuleEditor();
  $('btnRuleCancel').onclick = closeRuleEditor;
  $('btnRuleSave').onclick = saveRuleForm;
  ['expense', 'income'].forEach(t => {
    $(t === 'expense' ? 'ruleTypeExpense' : 'ruleTypeIncome').onclick = () => {
      if (ruleFormType === t) return;
      ruleFormType = t;
      fillRuleCategories($('ruleCategory').value);
    };
  });
  ['ruleStart', 'ruleEnd', 'ruleFreq'].forEach(id => $(id).addEventListener('input', updateRulePreview));
  $('ruleFreq').addEventListener('change', updateRulePreview);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRecurring();
  });
}
