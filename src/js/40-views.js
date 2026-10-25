    function getInitialState() {
      return {
        currentMonth: today().slice(0,7),
        activeView: 'home', // 'home' | 'stats' | 'settings' | 'record'
        previousView: 'home',
        statsType: 'expense',
        catMgrType: 'expense',
        isOfflineSim: false,
        pendingSyncIds: [],
        preferences: {
          homeHeaderMode: 'expense_only',
          enableSaveAndNext: false
        },
        categories: [
          { id: 'cat_breakfast', type: 'expense', name: '早餐', icon: 'breakfast', order: 1 },
          { id: 'cat_lunch', type: 'expense', name: '午餐', icon: 'lunch', order: 2 },
          { id: 'cat_dinner', type: 'expense', name: '晚餐', icon: 'dinner', order: 3 },
          { id: 'cat_drink', type: 'expense', name: '飲料點心', icon: 'drink', order: 4 },
          { id: 'cat_daily', type: 'expense', name: '日用品', icon: 'daily', order: 5 },
          { id: 'cat_transport', type: 'expense', name: '交通', icon: 'transport', order: 6 },
          { id: 'cat_bills', type: 'expense', name: '帳單固定', icon: 'bills', order: 7 },
          { id: 'cat_medical', type: 'expense', name: '醫療保健', icon: 'medical', order: 8 },
          { id: 'cat_entertainment', type: 'expense', name: '娛樂休閒', icon: 'entertainment', order: 9 },
          { id: 'cat_other_exp', type: 'expense', name: '其他支出', icon: 'other', order: 10 },
          { id: 'cat_salary', type: 'income', name: '薪資', icon: 'salary', order: 1 },
          { id: 'cat_bonus', type: 'income', name: '獎金補助', icon: 'bonus', order: 2 },
          { id: 'cat_other_inc', type: 'income', name: '其他收入', icon: 'other', order: 3 }
        ],
        merchants: [
          '麥當勞', '全聯', '7-11', '全家', '八方雲集', '星巴克', '50嵐',
          '爭鮮', '台灣中油', '台鐵', '屈臣氏', '路易莎', '中華電信', '公司薪轉'
        ],
        records: [
          // 10/24：依當天記帳先後順序 (早 -> 午 -> 飲料 -> 晚)，新增的會排在 10/24 最下方
          { id: 'rec_1', seq: 101, type: 'expense', date: '2026-10-24', categoryId: 'cat_lunch', amount: 110, merchant: '', note: '便當（店家留白直接顯示分類名）' },
          { id: 'rec_2', seq: 102, type: 'expense', date: '2026-10-24', categoryId: 'cat_drink', amount: 65, merchant: '50嵐', note: '四季春珍波椰' },
          { id: 'rec_3', seq: 103, type: 'expense', date: '2026-10-24', categoryId: 'cat_dinner', amount: 185, merchant: '麥當勞', note: '大麥克套餐' },
          // 10/23：早 -> 晚 -> 日用品
          { id: 'rec_4', seq: 91, type: 'expense', date: '2026-10-23', categoryId: 'cat_breakfast', amount: 75, merchant: '7-11', note: '三明治+拿鐵' },
          { id: 'rec_5', seq: 92, type: 'expense', date: '2026-10-23', categoryId: 'cat_dinner', amount: 105, merchant: '八方雲集', note: '鍋貼10顆+酸辣湯' },
          { id: 'rec_6', seq: 93, type: 'expense', date: '2026-10-23', categoryId: 'cat_daily', amount: 320, merchant: '全聯', note: '衛生紙與鮮奶' },
          // 10/22
          { id: 'rec_7', seq: 81, type: 'expense', date: '2026-10-22', categoryId: 'cat_transport', amount: 115, merchant: '台灣中油', note: '機車加油' },
          { id: 'rec_8', seq: 82, type: 'expense', date: '2026-10-22', categoryId: 'cat_dinner', amount: 190, merchant: '麥當勞', note: '雙層牛肉吉事堡餐' },
          // 10/21
          { id: 'rec_9', seq: 71, type: 'expense', date: '2026-10-21', categoryId: 'cat_lunch', amount: 98, merchant: '八方雲集', note: '水餃+豆漿' },
          // 10/20
          { id: 'rec_10', seq: 61, type: 'expense', date: '2026-10-20', categoryId: 'cat_dinner', amount: 240, merchant: '全聯', note: '火鍋肉片與青菜（全聯跨分類示例）' },
          // 10/18
          { id: 'rec_11', seq: 51, type: 'expense', date: '2026-10-18', categoryId: 'cat_bills', amount: 499, merchant: '中華電信', note: '手機月租費' },
          // 10/05
          { id: 'rec_12', seq: 11, type: 'income', date: '2026-10-05', categoryId: 'cat_salary', amount: 52000, merchant: '公司薪轉', note: '10月份薪資' }
        ]
      };
    }
    function formatMoney(n) {
      const num = Math.round(Number(n) || 0);
      return num.toLocaleString('zh-TW');
    }
    function getCategoryById(id) {
      return state.categories.find(c => c.id === id) || { id: 'unknown', name: '未分類', icon: 'other', type: 'expense' };
    }
    function getCategoriesByType(type) {
      return state.categories
        .filter(c => c.type === type)
        .sort((a, b) => a.order - b.order);
    }
    function getNextSeq() {
      const maxSeq = state.records.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 100);
      return maxSeq + 1;
    }
    function renderHeader() {
      const [y, m] = state.currentMonth.split('-');
      document.getElementById('currentMonthLabel').textContent = `${y} 年 ${parseInt(m, 10)} 月`;
      const monthWrap = document.getElementById('monthSelectorWrap');
      const titleOnly = document.getElementById('headerTitleOnly');
      const recHeader = document.getElementById('recordPageHeader');

      monthWrap.classList.add('hidden');
      titleOnly.classList.add('hidden');
      recHeader.classList.add('hidden');

      if (state.activeView === 'settings') {
        titleOnly.classList.remove('hidden');
      } else if (state.activeView === 'record') {
        recHeader.classList.remove('hidden');
      } else {
        monthWrap.classList.remove('hidden');
      }
    }
    function getMonthRecords() {
      return state.records
        .filter(r => r.date.startsWith(state.currentMonth))
        .sort((a, b) => {
          const dateDiff = b.date.localeCompare(a.date);
          if (dateDiff !== 0) return dateDiff;
          return (Number(a.seq) || 0) - (Number(b.seq) || 0);
        });
    }
    function renderHome() {
      const monthRecords = filteredHomeRecords();
      const totalExp = getMonthRecords().filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
      const totalInc = getMonthRecords().filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
      const net = totalInc - totalExp;

      document.getElementById('homeTotalExpense').textContent = formatMoney(totalExp);
      document.getElementById('homeTotalIncome').textContent = `+NT$ ${formatMoney(totalInc)}`;
      const netEl = document.getElementById('homeNetAmount');
      netEl.textContent = `${net >= 0 ? '+' : '-'}NT$ ${formatMoney(Math.abs(net))}`;
      netEl.className = `font-semibold num-tabular text-sm mt-0.5 block ${net >= 0 ? 'text-textMain' : 'text-dangerRed'}`;

      const mode = state.preferences.homeHeaderMode || 'expense_only';
      const extraBox = document.getElementById('homeExtraSummary');
      const netWrap = document.getElementById('homeNetWrap');
      const modeLabel = document.getElementById('headerModeLabel');

      if (mode === 'expense_only') {
        extraBox.classList.add('hidden');
        modeLabel.textContent = '僅顯示支出';
      } else if (mode === 'expense_and_income') {
        extraBox.classList.remove('hidden');
        netWrap.classList.add('hidden');
        modeLabel.textContent = '顯示支出+收入';
      } else {
        extraBox.classList.remove('hidden');
        netWrap.classList.remove('hidden');
        modeLabel.textContent = '顯示收支與結餘';
      }

      document.getElementById('homeRecordCount').textContent = `共 ${monthRecords.length} 筆`;
      const listEl = document.getElementById('homeRecordList');
      listEl.innerHTML = '';

      if (monthRecords.length === 0) {
        listEl.innerHTML = `
          <div class="bg-bgCard border border-borderSubtle rounded-2xl p-8 text-center space-y-2">
            <div class="text-sm font-medium text-textMuted">目前沒有符合的紀錄</div>
            <div class="text-xs text-textDim">可調整搜尋條件，或點「＋記一筆」新增</div>
          </div>
        `;
        return;
      }

      const groups = {};
      for (const r of monthRecords) {
        if (!groups[r.date]) groups[r.date] = [];
        groups[r.date].push(r);
      }

      const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
      Object.keys(groups).sort((a, b) => b.localeCompare(a)).forEach(dateStr => {
        // 確保同一天內依 seq 由小到大（舊 -> 新），新加入的在當天最後面
        const items = groups[dateStr].slice().sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
        const dObj = new Date(dateStr + 'T00:00:00');
        const mm = parseInt(dateStr.slice(5, 7), 10);
        const dd = parseInt(dateStr.slice(8, 10), 10);
        const wk = weekNames[dObj.getDay()];

        const groupCard = document.createElement('div');
        groupCard.className = 'bg-bgCard border border-borderSubtle rounded-2xl overflow-hidden';

        const headerHtml = `
          <div class="px-4 py-2 bg-bgElevated/50 border-b border-borderSubtle/70 flex items-center justify-between text-xs text-textMuted">
            <span class="font-medium">${mm} 月 ${dd} 日（週${wk}）</span>
            <span class="text-[11px] text-textDim">${items.length} 筆</span>
          </div>
        `;

        const rowsHtml = items.map(rec => {
          const cat = getCategoryById(rec.categoryId);
          const hasMerchant = rec.merchant && rec.merchant.trim() !== '';
          const primaryTitle = hasMerchant ? rec.merchant.trim() : cat.name;
          const categoryBadge = hasMerchant ? `<span class="text-[11px] px-1.5 py-0.5 rounded bg-bgElevated text-textMuted font-normal">${escapeHtml(cat.name)}</span>` : '';
          const isPendingSync = LedgerSync.isPending('rec:' + rec.id);
          const pendingBadge = isPendingSync ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-warnAmber/20 text-warnAmber font-medium">待同步</span>` : '';
          const amountPrefix = rec.type === 'income' ? '+' : '';
          const amountColor = rec.type === 'income' ? 'text-incomeGreen' : 'text-textMain';

          return `
            <button type="button" data-record-id="${escapeHtml(rec.id)}" class="record-item-btn w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-bgElevated/40 active:bg-bgElevated transition text-left border-b border-borderSubtle/40 last:border-b-0">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-9 h-9 rounded-xl bg-bgInput border border-borderSubtle flex items-center justify-center text-accent shrink-0">
                  ${ICONS[cat.icon] || ICONS.other}
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold text-textMain truncate">${escapeHtml(primaryTitle)}</span>
                    ${categoryBadge}
                    ${pendingBadge}
                  </div>
                  ${rec.note ? `<div class="text-xs text-textMuted truncate mt-0.5">${escapeHtml(rec.note)}</div>` : ''}
                </div>
              </div>
              <div class="text-right shrink-0">
                <span class="text-base font-bold num-tabular ${amountColor}">${amountPrefix}$${formatMoney(rec.amount)}</span>
              </div>
            </button>
          `;
        }).join('');

        groupCard.innerHTML = headerHtml + `<div>${rowsHtml}</div>`;
        listEl.appendChild(groupCard);
      });

      listEl.querySelectorAll('.record-item-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          openEditRecordModal(btn.getAttribute('data-record-id'));
        });
      });
    }
    function renderStats() {
      const monthRecords = getMonthRecords().filter(r => r.type === state.statsType);
      const total = monthRecords.reduce((s, r) => s + r.amount, 0);

      const tabExp = document.getElementById('statsTabExpense');
      const tabInc = document.getElementById('statsTabIncome');
      if (state.statsType === 'expense') {
        tabExp.className = 'px-3.5 py-1.5 rounded-lg text-xs font-medium bg-accent text-bgMain transition';
        tabInc.className = 'px-3.5 py-1.5 rounded-lg text-xs font-medium text-textMuted hover:text-textMain transition';
        document.getElementById('statsTotalTitle').textContent = '當月總支出';
      } else {
        tabInc.className = 'px-3.5 py-1.5 rounded-lg text-xs font-medium bg-accent text-bgMain transition';
        tabExp.className = 'px-3.5 py-1.5 rounded-lg text-xs font-medium text-textMuted hover:text-textMain transition';
        document.getElementById('statsTotalTitle').textContent = '當月總收入';
      }
      document.getElementById('statsTotalValue').textContent = `NT$ ${formatMoney(total)}`;

      const catMap = {};
      for (const r of monthRecords) {
        if (!catMap[r.categoryId]) catMap[r.categoryId] = { categoryId: r.categoryId, amount: 0, count: 0 };
        catMap[r.categoryId].amount += r.amount;
        catMap[r.categoryId].count += 1;
      }
      const catList = Object.values(catMap).sort((a, b) => b.amount - a.amount);
      const catContainer = document.getElementById('statsCategoryList');
      catContainer.innerHTML = '';

      if (catList.length === 0) {
        catContainer.innerHTML = `<div class="text-xs text-textDim py-4 text-center">本月尚無此類別資料</div>`;
      } else {
        catList.forEach(item => {
          const cat = getCategoryById(item.categoryId);
          const pct = total > 0 ? Math.round((item.amount / total) * 100) : 0;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'w-full text-left p-2.5 rounded-xl bg-bgInput hover:bg-bgElevated border border-borderSubtle/60 transition space-y-1.5';
          btn.innerHTML = `
            <div class="flex items-center justify-between text-xs">
              <div class="flex items-center gap-2">
                <span class="text-accent">${ICONS[cat.icon] || ICONS.other}</span>
                <span class="font-semibold text-textMain text-sm">${escapeHtml(cat.name)}</span>
                <span class="text-textDim">(${item.count} 筆)</span>
              </div>
              <div class="flex items-center gap-2 num-tabular">
                <span class="text-textMuted">${pct}%</span>
                <span class="font-bold text-sm text-textMain">NT$ ${formatMoney(item.amount)}</span>
              </div>
            </div>
            <div class="w-full h-1.5 bg-bgCard rounded-full overflow-hidden">
              <div class="h-full bg-accent rounded-full" style="width: ${Math.max(pct, 3)}%"></div>
            </div>
          `;
          btn.addEventListener('click', () => openDrilldownModal('category', item.categoryId, cat.name));
          catContainer.appendChild(btn);
        });
      }

      const merMap = {};
      for (const r of monthRecords) {
        const key = (r.merchant && r.merchant.trim() !== '') ? r.merchant.trim() : '__BLANK__';
        if (!merMap[key]) merMap[key] = { key, amount: 0, count: 0 };
        merMap[key].amount += r.amount;
        merMap[key].count += 1;
      }
      const merList = Object.values(merMap).sort((a, b) => b.amount - a.amount);
      const merContainer = document.getElementById('statsMerchantList');
      merContainer.innerHTML = '';

      if (merList.length === 0) {
        merContainer.innerHTML = `<div class="text-xs text-textDim py-4 text-center">本月尚無店家統計資料</div>`;
      } else {
        merList.forEach(item => {
          const displayName = item.key === '__BLANK__' ? (state.statsType === 'income' ? '未指定來源' : '未指定店家') : item.key;
          const pct = total > 0 ? Math.round((item.amount / total) * 100) : 0;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'w-full flex items-center justify-between p-2.5 rounded-xl bg-bgInput hover:bg-bgElevated border border-borderSubtle/60 text-xs transition';
          btn.innerHTML = `
            <div class="flex items-center gap-2 truncate">
              <span class="font-semibold text-sm text-textMain truncate">${escapeHtml(displayName)}</span>
              <span class="text-textDim shrink-0">${item.count} 筆</span>
            </div>
            <div class="flex items-center gap-2 shrink-0 num-tabular">
              <span class="text-textMuted">${pct}%</span>
              <span class="font-bold text-sm text-textMain">NT$ ${formatMoney(item.amount)}</span>
            </div>
          `;
          btn.addEventListener('click', () => openDrilldownModal('merchant', item.key, displayName));
          merContainer.appendChild(btn);
        });
      }
    }
    function openDrilldownModal(filterType, filterValue, titleName) {
      const records = getMonthRecords().filter(r => {
        if (r.type !== state.statsType) return false;
        if (filterType === 'category') return r.categoryId === filterValue;
        const mKey = (r.merchant && r.merchant.trim() !== '') ? r.merchant.trim() : '__BLANK__';
        return mKey === filterValue;
      });
      const sum = records.reduce((s, r) => s + r.amount, 0);

      document.getElementById('drilldownTitle').textContent = `${titleName} — 明細紀錄`;
      document.getElementById('drilldownSubtitle').textContent = `${state.currentMonth}・共 ${records.length} 筆・合計 NT$ ${formatMoney(sum)}`;

      const listEl = document.getElementById('drilldownList');
      listEl.innerHTML = '';

      records.forEach(rec => {
        const cat = getCategoryById(rec.categoryId);
        const hasMerchant = rec.merchant && rec.merchant.trim() !== '';
        const title = hasMerchant ? rec.merchant.trim() : cat.name;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'w-full p-3 rounded-xl bg-bgInput hover:bg-bgElevated border border-borderSubtle flex items-center justify-between text-left transition';
        row.innerHTML = `
          <div>
            <div class="flex items-center gap-2">
              <span class="text-xs font-mono text-textMuted">${rec.date}</span>
              <span class="text-sm font-semibold text-textMain">${escapeHtml(title)}</span>
              <span class="text-[11px] px-1.5 py-0.5 rounded bg-bgCard text-textMuted">${escapeHtml(cat.name)}</span>
            </div>
            ${rec.note ? `<div class="text-xs text-textMuted mt-1">${escapeHtml(rec.note)}</div>` : ''}
          </div>
          <div class="text-sm font-bold num-tabular text-textMain">NT$ ${formatMoney(rec.amount)}</div>
        `;
        row.addEventListener('click', () => {
          document.getElementById('modalDrilldown').classList.add('hidden');
          openEditRecordModal(rec.id);
        });
        listEl.appendChild(row);
      });

      document.getElementById('modalDrilldown').classList.remove('hidden');
    }
    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function updateBottomNav() {
      const v = state.activeView;
      document.getElementById('viewHome').classList.toggle('hidden', v !== 'home');
      document.getElementById('viewStats').classList.toggle('hidden', v !== 'stats');
      document.getElementById('viewSettings').classList.toggle('hidden', v !== 'settings');
      document.getElementById('modalRecord').classList.toggle('hidden', v !== 'record');

      // 在獨立記帳頁面時隱藏底部導覽列，讓畫面更專注乾淨
      document.getElementById('bottomNavBar').classList.toggle('hidden', v === 'record');

      document.getElementById('navBtnHome').className = `flex flex-col items-center justify-center gap-1 w-16 py-1 transition ${v === 'home' ? 'text-accent' : 'text-textMuted hover:text-textMain'}`;
      document.getElementById('navBtnStats').className = `flex flex-col items-center justify-center gap-1 w-12 py-1 transition ${v === 'stats' ? 'text-accent' : 'text-textMuted hover:text-textMain'}`;
      document.getElementById('navBtnSettings').className = `flex flex-col items-center justify-center gap-1 w-12 py-1 transition ${v === 'settings' ? 'text-accent' : 'text-textMuted hover:text-textMain'}`;
    }
