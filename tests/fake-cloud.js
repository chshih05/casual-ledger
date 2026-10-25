// 模擬雲端：行為與 70-sync-firebase.js 的讀取／交易寫入規則相同，可模擬離線、
// 權限錯誤、額度用完、以及「已寫入但回應遺失」等情況。只用於自動測試。
function createFakeCloud() {
  const Core = LedgerSyncCore;
  const docs = new Map();
  let clock = 0;
  const err = code => Object.assign(new Error(code), { code });
  const order = (a, b) => Core.cmpTs(a.ts, b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const hashOf = (key, data) => Core.hashString(JSON.stringify(Core.canon[Core.splitKey(key)[0]](data)));

  const cloud = {
    docs, offline: false, failNext: null, dropAckNext: false,
    pullCalls: 0, pushCalls: 0, reads: 0, writes: 0,

    async pull({ cursor, after, limit }) {
      cloud.pullCalls++;
      if (cloud.offline) throw err('unavailable');
      if (cloud.failNext) { const code = cloud.failNext; cloud.failNext = null; throw err(code); }
      let list = [...docs.values()].sort(order);
      if (cursor) list = list.filter(d => Core.cmpTs(d.ts, cursor) > 0);
      if (after) list = list.filter(d => order(d, after) > 0);
      const page = list.slice(0, limit).map(d => structuredClone(d));
      cloud.reads += Math.max(1, page.length);
      const last = page[page.length - 1];
      return { docs: page, next: page.length === limit ? { ts: last.ts, id: last.id } : null, maxTs: last ? last.ts : null };
    },

    async push(changes, { deviceId }) {
      cloud.pushCalls++;
      if (cloud.offline) throw err('unavailable');
      if (cloud.failNext) { const code = cloud.failNext; cloud.failNext = null; throw err(code); }
      const ts = { s: ++clock, n: 0 };
      const results = [];
      for (const c of changes) {
        const remote = docs.get(c.key);
        cloud.reads++;
        const remoteH = remote ? (remote.del ? 'x' : remote.h) : 'x';
        if (remote && remoteH === c.h) { results.push({ key: c.key, status: 'same', rev: remote.rev, h: c.h }); continue; }
        if (!remote && c.del) { results.push({ key: c.key, status: 'same', rev: 0, h: 'x' }); continue; }
        if (remote && remote.rev !== c.baseRev) { results.push({ key: c.key, status: 'conflict', remote: structuredClone(remote) }); continue; }
        const rev = remote ? remote.rev + 1 : 1;
        docs.set(c.key, {
          id: c.key, k: c.key, kind: c.kind, rev, h: c.del ? '' : c.h, del: c.del,
          d: c.del ? (remote ? remote.d : {}) : structuredClone(c.data), t: c.t, dev: deviceId, ts,
        });
        cloud.writes++;
        results.push({ key: c.key, status: 'written', rev, h: c.h });
      }
      if (cloud.dropAckNext) { cloud.dropAckNext = false; throw err('deadline-exceeded'); }
      return results;
    },

    classify(e) {
      const code = e && e.code;
      if (code === 'unavailable' || code === 'deadline-exceeded') return 'offline';
      if (code === 'permission-denied') return 'permission';
      if (code === 'resource-exhausted') return 'quota';
      return 'unknown';
    },

    // 模擬「另一台裝置」直接寫入雲端。
    put(key, data, { t = Date.now(), del = false, dev = 'dev_other' } = {}) {
      const remote = docs.get(key);
      const ts = { s: ++clock, n: 0 };
      docs.set(key, {
        id: key, k: key, kind: Core.splitKey(key)[0], rev: remote ? remote.rev + 1 : 1,
        h: del ? '' : hashOf(key, data), del, d: del ? (remote ? remote.d : {}) : structuredClone(data), t, dev, ts,
      });
    },

    live(kind) {
      return [...docs.values()].filter(d => !d.del && (!kind || d.kind === kind));
    },
  };
  return cloud;
}

// 把模擬雲端包成網頁使用的連線物件（含模擬的 Google 登入）。
function fakeBackendFactory(cloud, { user = { uid: 'u1', email: 'me@example.com' }, signedIn = false } = {}) {
  return async ({ onAuth }) => {
    let current = signedIn ? user : null;
    onAuth(current);
    return {
      kind: 'fake',
      classify: cloud.classify,
      async signIn() { current = user; onAuth(current); },
      async signOut() { current = null; onAuth(null); },
      pull: options => cloud.pull(options),
      push: (changes, options) => cloud.push(changes, options),
    };
  };
}
