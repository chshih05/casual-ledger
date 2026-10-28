// 統計比較：按月時和上個月比、整年時和去年比，並畫出近 12 個月的走勢。
// 這個月（或今年）還沒過完時，只比到今天為止的同一段日子，不拿半個月去比整個月。
let compareShowAll = false;
const COMPARE_TOP = 5;

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// 回傳兩段日期範圍（含頭尾，用字串比較，所以月底寫 31 也適用 30 天的月份）與顯示用的文字。
// live：期間還沒過完，range 是兩邊都只算的那一段日子。
function comparePeriods(yearMode) {
  const now = today(),
    [y, m] = state.currentMonth.split('-').map(Number),
    [mm, dd] = now.slice(5).split('-').map(Number);
  if (yearMode) {
    const live = now.startsWith(`${y}-`),
      end = live ? now.slice(4) : '-12-31';
    return {
      live,
      range: `1/1～${mm}/${dd}`,
      cur: [`${y}-01-01`, `${y}${end}`],
      prev: [`${y - 1}-01-01`, `${y - 1}${end}`],
      title: '和去年比較',
      name: live ? '去年同期' : '去年',
      curLabel: `${y} 年`,
      prevLabel: `${y - 1} 年${live ? '同期' : ''}`,
      avgWord: '月均',
      units: live ? mm - 1 + dd / new Date(y, mm, 0).getDate() : 12,
    };
  }
  const cur = state.currentMonth,
    p = new Date(y, m - 2, 1),
    live = now.startsWith(cur + '-'),
    end = live ? now.slice(7) : '-31';
  return {
    live,
    range: `1～${dd} 日`,
    cur: [`${cur}-01`, `${cur}${end}`],
    prev: [`${monthKey(p)}-01`, `${monthKey(p)}${end}`],
    title: '和上月比較',
    name: live ? '上月同期' : '上月',
    curLabel: `${m} 月`,
    prevLabel: `${p.getMonth() + 1} 月${live ? '同期' : ''}`,
    avgWord: '日均',
    units: live ? dd : new Date(y, m, 0).getDate(),
  };
}
function sumByCategory(type, [start, end]) {
  const map = new Map();
  let total = 0;
  for (const r of state.records) {
    if (r.type !== type || r.date < start || r.date > end) continue;
    total += r.amount;
    map.set(r.categoryId, (map.get(r.categoryId) || 0) + r.amount);
  }
  return { total, map };
}
// 支出變多是壞消息（紅），收入變多是好消息（綠）；一定搭配 ▲▼ 與文字，不只靠顏色。
const deltaTone = (delta, type) => (!delta ? 'flat' : delta > 0 === (type === 'expense') ? 'bad' : 'good');
function deltaChip(cur, prev, type) {
  const d = cur - prev;
  if (!(prev > 0) || !d) return '';
  return `<span class="stats-delta" data-tone="${deltaTone(d, type)}">${d > 0 ? '▲' : '▼'} ${percentText((Math.abs(d) * 100) / prev)}</span>`;
}
function renderStatsCompare(yearMode) {
  const type = state.statsType,
    word = type === 'income' ? '收入' : '支出',
    p = comparePeriods(yearMode);
  const cur = sumByCategory(type, p.cur),
    prev = sumByCategory(type, p.prev),
    d = cur.total - prev.total;
  $('statsCompareLine').classList.toggle('hidden', !cur.total && !prev.total);
  const name = p.live ? `${p.name}（${p.range}）` : p.name;
  const text = !prev.total
    ? `${name}沒有${word}`
    : !d
      ? `和${name}一樣`
      : `比${name}${d > 0 ? '多' : '少'} NT$ ${formatMoney(Math.abs(d))}`;
  $('statsCompareText').innerHTML = `${deltaChip(cur.total, prev.total, type)}<span>${text}</span>`;
  $('statsAverage').textContent = `${p.avgWord} ${moneyText(cur.total / p.units)}`;

  const rows = getCategoriesByType(type)
    .map(c => ({ c, cur: cur.map.get(c.id) || 0, prev: prev.map.get(c.id) || 0 }))
    .filter(x => x.cur || x.prev)
    .sort((a, b) => Math.abs(b.cur - b.prev) - Math.abs(a.cur - a.prev) || b.cur - a.cur);
  $('statsCompareSection').classList.toggle('hidden', !rows.length);
  $('statsCompareTitle').textContent = p.title;
  $('statsCompareHint').textContent = p.live ? `兩邊都只算 ${p.range}` : '依差額大小排列';
  const list = $('statsCompareList');
  list.innerHTML = '';
  rows.slice(0, compareShowAll ? rows.length : COMPARE_TOP).forEach(({ c, cur: a, prev: b }) => {
    const diff = a - b,
      btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'compare-row';
    btn.innerHTML = `<span class="compare-name"><span class="text-accent">${ICONS[c.icon] || ICONS.other}</span><span class="truncate">${escapeHtml(c.name)}</span></span>
      <span class="compare-delta" data-tone="${deltaTone(diff, type)}">${diff ? `${diff > 0 ? '▲' : '▼'} NT$ ${formatMoney(Math.abs(diff))}` : '持平'}</span>
      <span class="compare-detail">${p.curLabel} ${moneyText(a)}・${p.prevLabel} ${moneyText(b)}</span>`;
    btn.addEventListener('click', () => openDrilldownModal('category', c.id, c.name));
    list.appendChild(btn);
  });
  const more = $('btnCompareMore');
  more.classList.toggle('hidden', rows.length <= COMPARE_TOP);
  more.textContent = compareShowAll ? `只顯示變化最大的 ${COMPARE_TOP} 個` : `顯示全部 ${rows.length} 個分類`;
}
// 長條：以最高的為滿格；扣掉退款後是 0 或負數時不畫。
function trendBar(v, max) {
  return `<span class="trend-bar" style="height:${max > 0 && v > 0 ? ((v / max) * 100).toFixed(1) : 0}%${v > 0 ? ';min-height:2px' : ''}"></span>`;
}
// 近 12 個月的走勢：目前月份用主色，其他月份用灰色；點長條切換到那個月。
// 近 12 個月可以只看一個分類（例如「飲料」每個月花多少）；換支出／收入時，分類不在清單裡就回到全部分類。
let trendCategory = '';
function renderTrendCategories(type) {
  const select = $('statsTrendCategory'),
    cats = getCategoriesByType(type);
  if (!cats.some(c => c.id === trendCategory)) trendCategory = '';
  select.innerHTML = '';
  select.append(new Option('全部分類', ''), ...cats.map(c => new Option(c.name, c.id)));
  select.value = trendCategory;
}
function renderStatsTrend(yearMode) {
  $('statsTrendSection').classList.toggle('hidden', yearMode);
  $('statsTrendTip').classList.add('hidden');
  if (yearMode) return;
  const type = state.statsType,
    [y, m] = state.currentMonth.split('-').map(Number),
    now = today().slice(0, 7);
  renderTrendCategories(type);
  const months = Array.from({ length: 12 }, (_, i) => monthKey(new Date(y, m - 12 + i, 1))),
    sums = new Map(months.map(k => [k, 0]));
  for (const r of state.records) {
    if (r.type !== type || (trendCategory && r.categoryId !== trendCategory)) continue;
    const k = r.date.slice(0, 7);
    if (sums.has(k)) sums.set(k, sums.get(k) + r.amount);
  }
  const values = months.map(k => sums.get(k)),
    max = Math.max(...values);
  // 平均只算有紀錄、而且已經過完的月份，才不會被還沒開始記帳的月份或這個月的半個月拉低。
  const done = months.filter((k, i) => values[i] > 0 && k < now);
  $('statsTrendTitle').textContent = `近 12 個月${type === 'income' ? '收入' : '支出'}`;
  $('statsTrendRange').textContent =
    `${months[0].replace('-', '/')}～${months[11].replace('-', '/')}・點長條切換到那個月`;
  $('statsTrendAvg').textContent = done.length
    ? `月平均 NT$ ${formatMoney(done.reduce((s, k) => s + sums.get(k), 0) / done.length)}`
    : '';
  const chart = $('statsTrendChart');
  chart.innerHTML = '';
  months.forEach((k, i) => {
    const [ky, km] = k.split('-').map(Number),
      v = values[i],
      btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trend-col';
    btn.dataset.month = k;
    btn.dataset.value = v;
    btn.setAttribute('aria-label', `${ky} 年 ${km} 月 ${moneyText(v)}`);
    btn.setAttribute('aria-current', String(k === state.currentMonth));
    btn.innerHTML = `<span class="trend-plot">${trendBar(v, max)}</span><span class="trend-label">${km}</span>`;
    btn.addEventListener('click', () => {
      state.currentMonth = k;
      renderAll();
    });
    chart.appendChild(btn);
  });
}
// 這個月每天的支出：一天一根長條，今天用主色，還沒到的日子留空。
function renderStatsDaily(yearMode) {
  const show = !yearMode && state.statsType === 'expense';
  $('statsDailySection').classList.toggle('hidden', !show);
  $('statsDailyTip').classList.add('hidden');
  if (!show) return;
  const month = state.currentMonth,
    [y, m] = month.split('-').map(Number),
    days = new Date(y, m, 0).getDate(),
    now = today();
  // 每天的支出扣掉當天的退款；counts 是當天有幾筆，有紀錄的日子才能點開。
  const sums = new Array(days).fill(0),
    counts = new Array(days).fill(0);
  for (const r of state.records)
    if (r.type === 'expense' && r.date.startsWith(month + '-')) {
      sums[Number(r.date.slice(8)) - 1] += r.amount;
      counts[Number(r.date.slice(8)) - 1]++;
    }
  const max = Math.max(...sums);
  $('statsDailyTitle').textContent = `${m} 月每日支出`;
  $('statsDailyMax').textContent = max > 0 ? `最多 ${m}/${sums.indexOf(max) + 1} NT$ ${formatMoney(max)}` : '';
  const chart = $('statsDailyChart');
  chart.innerHTML = '';
  chart.style.gridTemplateColumns = `repeat(${days},minmax(0,1fr))`;
  sums.forEach((v, i) => {
    const d = i + 1,
      date = `${month}-${String(d).padStart(2, '0')}`,
      btn = document.createElement('button');
    // 日期只標 1、5、10…和月底，太擠時略過月底前的那一個（例如 31 天的月份不標 30）。
    const label = d === 1 || d === days || (d % 5 === 0 && days - d >= 3) ? d : '';
    btn.type = 'button';
    btn.className = 'trend-col';
    btn.dataset.date = date;
    btn.dataset.value = v;
    btn.setAttribute('aria-label', `${m} 月 ${d} 日 ${moneyText(v)}`);
    btn.setAttribute('aria-current', String(date === now));
    btn.innerHTML = `<span class="trend-plot">${trendBar(v, max)}</span><span class="trend-label">${label}</span>`;
    // 有紀錄的日子：點長條列出那天的紀錄（沒有紀錄的日子只顯示 NT$ 0）。
    if (counts[i])
      btn.addEventListener('click', e => {
        e.stopPropagation();
        $('statsDailyTip').classList.add('hidden');
        btn.classList.remove('is-active');
        openDrilldownModal('date', date, `${m} 月 ${d} 日`, { type: 'expense', switchable: false });
      });
    chart.appendChild(btn);
  });
}
const SCRUB_SLOP = 8; // 手指左右移動超過這麼多（px）才算滑動；點一下時的小晃動不算
// 滑鼠移到長條、用鍵盤選到時，在長條上方顯示金額（顯示中的那一欄標成 is-active）。
// tapToShow（每日支出）：點一下也顯示（近 12 個月點一下是切換月份，不用）。
// scrub：手指按住圖表左右滑，金額跟著手指下面的那一欄，放開後留著；上下滑照常捲動頁面
// （.trend-chart 的 touch-action）。滑過之後放開不算點那一欄，點一下才打開那天的紀錄或切換月份。
function setupChartTooltip(chart, tip, label, { tapToShow = false, scrub = false } = {}) {
  const showCol = col => {
    if (!col || !col.isConnected) return; // 點長條切換月份後圖表已經重畫，舊的那一欄不在畫面上
    chart.querySelectorAll('.trend-col.is-active').forEach(c => c !== col && c.classList.remove('is-active'));
    col.classList.add('is-active');
    tip.innerHTML = `<strong>${moneyText(Number(col.dataset.value))}</strong><span>${label(col)}</span>`;
    tip.classList.remove('hidden');
    const half = tip.offsetWidth / 2,
      x = col.offsetLeft + col.offsetWidth / 2;
    tip.style.left = `${Math.min(chart.offsetWidth - half, Math.max(half, x))}px`;
    // 最高的長條上方沒有空間：提示最高只到圖表頂端（蓋住長條頂端），不蓋到上面的標題。
    tip.style.top = `${Math.max(col.querySelector('.trend-bar').offsetTop - 6, tip.offsetHeight)}px`;
  };
  const show = e => showCol(e.target.closest('.trend-col'));
  const hide = () => {
    tip.classList.add('hidden');
    chart.querySelectorAll('.trend-col.is-active').forEach(c => c.classList.remove('is-active'));
  };
  chart.addEventListener('pointerover', show);
  chart.addEventListener('focusin', show);
  // 手指離開螢幕也會觸發 pointerleave：可以滑的圖表讓金額留著，看得到最後停在哪一欄。
  chart.addEventListener('pointerleave', e => {
    if (!(scrub && e.pointerType === 'touch')) hide();
  });
  chart.addEventListener('focusout', hide);
  if (tapToShow) chart.addEventListener('click', show);
  if (!scrub) return;
  // 每一欄一樣寬：用手指的左右位置算出是第幾欄；滑出圖表時停在第一欄或最後一欄。
  // 手機上手指一直算在第一個按到的長條（瀏覽器的預設），所以不能看事件發生在哪個長條上。
  const columnAt = x => {
    const r = chart.getBoundingClientRect(),
      cols = chart.children;
    return cols[Math.min(cols.length - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * cols.length)))];
  };
  let press = null,
    slid = false;
  chart.addEventListener('pointerdown', e => {
    slid = false;
    press = e.button > 0 ? null : { id: e.pointerId, x: e.clientX, moved: false };
  });
  chart.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id) return;
    if (!press.moved && Math.abs(e.clientX - press.x) < SCRUB_SLOP) return;
    press.moved = true;
    showCol(columnAt(e.clientX));
  });
  chart.addEventListener('pointerup', e => {
    if (press && e.pointerId === press.id) slid = press.moved;
    press = null;
  });
  // 往上下滑、頁面開始捲動時，瀏覽器會取消這次按住：收起金額。
  chart.addEventListener('pointercancel', () => {
    press = null;
    hide();
  });
  // 滑過之後放開：攔下接著來的 click（在長條自己的 click 之前），不打開那天的紀錄、不切換月份。
  chart.addEventListener(
    'click',
    e => {
      if (!slid) return;
      slid = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );
}
function setupTrendTooltip() {
  $('statsTrendCategory').addEventListener('change', e => {
    trendCategory = e.target.value;
    renderStatsTrend(false);
  });
  setupChartTooltip(
    $('statsTrendChart'),
    $('statsTrendTip'),
    col => {
      const [y, m] = col.dataset.month.split('-').map(Number);
      return `${y} 年 ${m} 月`;
    },
    { scrub: true }
  );
  setupChartTooltip(
    $('statsDailyChart'),
    $('statsDailyTip'),
    col => {
      const [, m, d] = col.dataset.date.split('-').map(Number);
      return `${m} 月 ${d} 日`;
    },
    { tapToShow: true, scrub: true }
  );
}
