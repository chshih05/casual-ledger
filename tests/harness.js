// 極簡測試工具：在瀏覽器中執行，結果顯示在頁面上，也放在 window.__testResults。
const T = (() => {
  const tests = [];
  const results = [];

  function test(name, fn) {
    tests.push({ name, fn });
  }

  function assert(cond, message) {
    if (!cond) throw new Error(message || '條件不成立');
  }

  function eq(actual, expected, message) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message || '數值不同'}\n  實際：${a}\n  預期：${b}`);
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function waitFor(fn, { timeout = 4000, interval = 30, message } = {}) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeout) {
      try {
        last = await fn();
        if (last) return last;
      } catch (e) {
        last = e;
      }
      await sleep(interval);
    }
    throw new Error(message || `等待逾時：${last instanceof Error ? last.message : String(last)}`);
  }

  async function run(filter = '') {
    const out = document.getElementById('results');
    const summary = document.getElementById('summary');
    window.__testResults = { done: false, passed: 0, failed: 0, results };
    for (const t of tests) {
      if (filter && !t.name.includes(filter)) continue;
      const started = performance.now();
      let error = null;
      try {
        await t.fn();
      } catch (e) {
        error = e;
      }
      const ms = Math.round(performance.now() - started);
      results.push({ name: t.name, ok: !error, ms, error: error ? String(error.message || error) : '' });
      if (error) window.__testResults.failed++; else window.__testResults.passed++;
      const row = document.createElement('li');
      row.className = error ? 'fail' : 'pass';
      row.textContent = `${error ? '✗' : '✓'} ${t.name}（${ms} ms）${error ? '\n' + (error.message || error) : ''}`;
      out.appendChild(row);
      summary.textContent = `通過 ${window.__testResults.passed}・失敗 ${window.__testResults.failed}`;
    }
    window.__testResults.done = true;
    summary.textContent = `完成：通過 ${window.__testResults.passed}・失敗 ${window.__testResults.failed}`;
    return window.__testResults;
  }

  return { test, assert, eq, sleep, waitFor, run };
})();
