// 同步核心：比對本機與雲端的差異、處理衝突、決定要上傳或套用哪些資料。
// 不碰畫面、不直接讀寫 localStorage，也不綁定特定雲端服務；
// 帳本、同步狀態的保存與雲端連線都由呼叫端提供，因此可以用模擬雲端測試。
const LedgerSyncCore = (() => {
  'use strict';

  const TOMBSTONE = 'x'; // 「已刪除／不存在」的雜湊代號；一般雜湊一律以 h 開頭，不會撞到
  const KINDS = ['rec', 'cat', 'mer', 'pref'];
  const PREF_KEY = 'pref:main';
  const DEMO_SEED_IDS = new Set(Array.from({ length: 12 }, (_, i) => `rec_${i + 1}`));
  const HEADER_MODES = ['expense_only', 'expense_and_income', 'full_net'];
  const MAX_AMOUNT = 999999999;
  const MAX_CONFLICTS = 30;
  // 同步格式版本：2 起有預算欄位與固定收支規則。舊版程式會略過或去掉這些資料，
  // 所以換到新版後第一次同步要從頭讀一次雲端並重新比對（見 pullAll）。
  const FORMAT = 2;
  // 固定收支規則沿用偏好設定的類別（pref:rule_…），雲端安全規則不需要修改。
  const RULE_PREFIX = 'rule_';

  class SyncError extends Error {
    constructor(code, message, detail = {}) {
      super(message || code);
      this.code = code;
      this.detail = detail;
    }
  }

  // ---------- 雜湊與資料正規化 ----------
  const hashCache = new Map();
  function hashString(str) {
    const cached = hashCache.get(str);
    if (cached) return cached;
    // cyrb53：快速、分布均勻的 53 位元雜湊，只用來判斷內容是否改變（不是加密）。
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const hash = 'h' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    if (hashCache.size > 50000) hashCache.clear();
    hashCache.set(str, hash);
    return hash;
  }

  // 每月預算：1～999,999,999 的整數；沒有設定時不寫入欄位，舊資料的雜湊因此不會改變。
  const validBudget = v => Number.isSafeInteger(v) && v > 0 && v <= MAX_AMOUNT;

  const canon = {
    rec: r => ({ id: String(r.id), seq: Number(r.seq) || 0, type: r.type, date: r.date, categoryId: r.categoryId, amount: r.amount, merchant: r.merchant || '', note: r.note || '' }),
    cat: c => {
      const out = { id: String(c.id), type: c.type, name: c.name, icon: c.icon, order: c.order };
      if (c.type === 'expense' && validBudget(c.budget)) out.budget = c.budget;
      return out;
    },
    mer: m => ({ name: m.name, type: m.type === 'income' ? 'income' : 'expense', archived: Boolean(m.archived) }),
    pref: p => {
      const out = { homeHeaderMode: HEADER_MODES.includes(p.homeHeaderMode) ? p.homeHeaderMode : 'expense_only', enableSaveAndNext: p.enableSaveAndNext === true };
      if (validBudget(p.monthlyBudget)) out.monthlyBudget = p.monthlyBudget;
      return out;
    },
    // 固定收支規則：next 是下一次要記的日期；day 是每月幾號（31 號遇到小月記在月底）。
    rule: r => {
      const out = { id: String(r.id), type: r.type, categoryId: r.categoryId, amount: r.amount, merchant: r.merchant || '', note: r.note || '',
        freq: r.freq === 'year' ? 'year' : 'month', day: r.day, next: r.next };
      if (r.end) out.end = r.end;
      if (r.paused) out.paused = true;
      return out;
    },
  };
  const isRuleKey = key => key.startsWith('pref:' + RULE_PREFIX);
  const canonFor = key => isRuleKey(key) ? canon.rule : canon[splitKey(key)[0]];

  function splitKey(key) {
    const i = key.indexOf(':');
    return [key.slice(0, i), key.slice(i + 1)];
  }

  function ownValue(obj, name) {
    return obj && Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : undefined;
  }

  function setOwn(obj, name, value) {
    Object.defineProperty(obj, name, { value, enumerable: true, writable: true, configurable: true });
  }

  function isDemoSeedRecord(record) {
    return DEMO_SEED_IDS.has(String(record && record.id));
  }

  // 把帳本拆成可個別同步的項目：紀錄、分類、店家／收入來源、偏好設定。
  function entityMap(s) {
    const map = new Map();
    const put = (key, kind, data) => map.set(key, { kind, data, json: JSON.stringify(data) });
    for (const r of s.records || []) put('rec:' + r.id, 'rec', canon.rec(r));
    for (const c of s.categories || []) put('cat:' + c.id, 'cat', canon.cat(c));
    const archived = new Set(s.archivedMerchants || []);
    for (const name of s.merchants || []) {
      put('mer:' + name, 'mer', canon.mer({ name, type: ownValue(s.merchantTypes, name), archived: archived.has(name) }));
    }
    put(PREF_KEY, 'pref', canon.pref(s.preferences || {}));
    for (const r of s.recurring || []) put('pref:' + r.id, 'pref', canon.rule(r));
    return map;
  }

  const mapCache = new WeakMap();
  function cachedEntityMap(s) {
    let map = mapCache.get(s);
    if (!map) {
      map = entityMap(s);
      mapCache.set(s, map);
    }
    return map;
  }

  // 每次儲存後記錄「哪個項目在何時改變」，跨裝置衝突時用來判斷誰比較新。
  // 若變更程式已明確指定時間（例如匯入備份沿用原時間），就保留指定值。
  function stampTimes(prev, next, now) {
    const before = cachedEntityMap(prev);
    const after = entityMap(next);
    const prevTimes = prev.entityTimes || {};
    const times = Object.assign({}, next.entityTimes || {});
    const keys = new Set([...before.keys(), ...after.keys()]);
    for (const key of keys) {
      const a = before.get(key), b = after.get(key);
      if ((a && a.json) === (b && b.json)) continue;
      const explicit = ownValue(times, key);
      if (typeof explicit === 'number' && explicit !== ownValue(prevTimes, key)) continue;
      setOwn(times, key, now);
    }
    next.entityTimes = times;
    mapCache.set(next, after);
    return next;
  }

  // 修改帳本前先記下目前每個項目的內容，之後比對才不會受到修改途中共用物件的影響。
  function snapshot(s) { cachedEntityMap(s); }

  // 兩個版本的帳本之間改了哪些項目（內容或修改時間），給儲存層只寫入變更的部分。
  // 回傳 [項目代號, 內容（已刪除為 null）, 修改時間（沒有則為 undefined）]。
  function diffEntities(prev, next) {
    const before = cachedEntityMap(prev), after = cachedEntityMap(next);
    const ta = prev.entityTimes || {}, tb = next.entityTimes || {};
    const out = [];
    for (const [key, e] of after) {
      const old = before.get(key);
      if (!old || old.json !== e.json || ownValue(ta, key) !== ownValue(tb, key)) out.push([key, e.data, ownValue(tb, key)]);
    }
    for (const key of before.keys()) if (!after.has(key)) out.push([key, null, ownValue(tb, key)]);
    // 已刪除項目只剩修改時間；時間變了也要記下來（衝突判斷與「刪掉的日期不再補記」會用到）。
    for (const key of Object.keys(tb)) {
      if (!after.has(key) && !before.has(key) && ownValue(ta, key) !== ownValue(tb, key)) out.push([key, null, ownValue(tb, key)]);
    }
    return out;
  }

  // ---------- 套用單一項目到帳本 ----------
  function upsertById(list, id, data) {
    const index = list.findIndex(x => String(x.id) === id);
    if (!data) {
      if (index >= 0) list.splice(index, 1);
    } else if (index >= 0) {
      list[index] = data;
    } else {
      list.push(data);
    }
  }

  function applyEntity(s, key, data) {
    const [kind, id] = splitKey(key);
    if (kind === 'rec') upsertById(s.records, id, data && canon.rec(data));
    else if (kind === 'cat') upsertById(s.categories, id, data && canon.cat(data));
    else if (kind === 'mer') {
      s.merchants = s.merchants || [];
      s.archivedMerchants = s.archivedMerchants || [];
      if (!s.merchantTypes || typeof s.merchantTypes !== 'object') s.merchantTypes = {};
      if (!data) {
        s.merchants = s.merchants.filter(m => m !== id);
        s.archivedMerchants = s.archivedMerchants.filter(m => m !== id);
        if (Object.prototype.hasOwnProperty.call(s.merchantTypes, id)) delete s.merchantTypes[id];
      } else {
        const m = canon.mer(data);
        if (!s.merchants.includes(id)) s.merchants.push(id);
        setOwn(s.merchantTypes, id, m.type);
        const at = s.archivedMerchants.indexOf(id);
        if (m.archived && at < 0) s.archivedMerchants.push(id);
        if (!m.archived && at >= 0) s.archivedMerchants.splice(at, 1);
      }
    } else if (kind === 'pref' && id.startsWith(RULE_PREFIX)) {
      s.recurring = s.recurring || [];
      upsertById(s.recurring, id, data && canon.rule(data));
    } else if (kind === 'pref' && data) {
      s.preferences = Object.assign({}, s.preferences, { monthlyBudget: 0 }, canon.pref(data));
    }
  }

  // 套用雲端變更後，確保帳本仍能正常開啟：每筆紀錄都有對應分類、店家清單完整、
  // 支出與收入至少各有一個分類。修補的項目時間記為 0，之後有正式資料時以正式資料為準。
  function repairInvariants(s, categoryHints = {}) {
    const repaired = new Set();
    const nextOrder = type => Math.max(0, ...s.categories.filter(c => c.type === type).map(c => Number(c.order) || 0)) + 1;
    const fallback = type => {
      const id = type === 'income' ? 'cat_sync_income' : 'cat_sync_expense';
      let c = s.categories.find(x => x.id === id);
      if (!c) {
        c = { id, type, name: '未分類（同步）', icon: 'other', order: nextOrder(type) };
        s.categories.push(c);
        repaired.add('cat:' + id);
      }
      return c;
    };
    const byId = new Map(s.categories.map(c => [String(c.id), c]));
    s.records.forEach((r, i) => {
      const c = byId.get(String(r.categoryId));
      if (c && c.type === r.type) return;
      if (!c) {
        const hint = categoryHints['cat:' + r.categoryId];
        const restored = hint && hint.type === r.type
          ? canon.cat(hint)
          : { id: String(r.categoryId), type: r.type, name: '未分類（同步）', icon: 'other', order: nextOrder(r.type) };
        s.categories.push(restored);
        byId.set(restored.id, restored);
        repaired.add('cat:' + restored.id);
      } else {
        // 換成新物件，不改到上一版帳本共用的紀錄（見 60-app.js 的 cloneForCommit）。
        s.records[i] = Object.assign({}, r, { categoryId: fallback(r.type).id });
        repaired.add('rec:' + r.id);
      }
    });
    for (const type of ['expense', 'income']) {
      if (!s.categories.some(c => c.type === type)) fallback(type);
    }
    const names = new Set(s.merchants);
    if (!s.merchantTypes || typeof s.merchantTypes !== 'object') s.merchantTypes = {};
    for (const r of s.records) {
      if (r.merchant && !names.has(r.merchant)) {
        s.merchants.push(r.merchant);
        names.add(r.merchant);
        setOwn(s.merchantTypes, r.merchant, r.type);
        repaired.add('mer:' + r.merchant);
      }
    }
    return [...repaired];
  }

  // ---------- 雲端資料檢查（與匯入備份的規則一致） ----------
  function validDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    if (y < 1900 || y > 2199) return false;
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  }
  const isStr = (v, max) => typeof v === 'string' && v.length <= max;
  const isType = v => v === 'expense' || v === 'income';
  const isId = v => isStr(v, 100) && /^[\w-]+$/.test(v);

  function validEntityData(kind, id, d) {
    if (!d || typeof d !== 'object') return false;
    if (kind === 'rec') {
      return d.id === id && isId(d.id) && isType(d.type) && validDate(d.date) && isId(d.categoryId)
        && Number.isSafeInteger(d.amount) && d.amount > 0 && d.amount <= MAX_AMOUNT
        && isStr(d.merchant, 100) && isStr(d.note, 1000) && Number.isFinite(d.seq);
    }
    if (kind === 'cat') {
      return d.id === id && isId(d.id) && isType(d.type) && isStr(d.name, 40) && d.name.trim() !== ''
        && isStr(d.icon, 80) && Number.isFinite(d.order) && (d.budget === undefined || validBudget(d.budget));
    }
    if (kind === 'mer') {
      return d.name === id && isStr(d.name, 100) && d.name.trim() !== '' && isType(d.type) && typeof d.archived === 'boolean';
    }
    if (kind === 'pref' && typeof id === 'string' && id.startsWith(RULE_PREFIX)) {
      return d.id === id && isId(d.id) && isType(d.type) && isId(d.categoryId)
        && Number.isSafeInteger(d.amount) && d.amount > 0 && d.amount <= MAX_AMOUNT
        && isStr(d.merchant, 100) && isStr(d.note, 1000) && (d.freq === 'month' || d.freq === 'year')
        && Number.isInteger(d.day) && d.day >= 1 && d.day <= 31 && validDate(d.next)
        && (d.end === undefined || validDate(d.end)) && (d.paused === undefined || d.paused === true);
    }
    if (kind === 'pref') {
      return id === 'main' && HEADER_MODES.includes(d.homeHeaderMode) && typeof d.enableSaveAndNext === 'boolean'
        && (d.monthlyBudget === undefined || validBudget(d.monthlyBudget));
    }
    return false;
  }

  function validRemoteDoc(doc) {
    if (!doc || typeof doc.k !== 'string' || !Number.isSafeInteger(doc.rev) || doc.rev < 1) return false;
    if (typeof doc.t !== 'number' || !Number.isFinite(doc.t) || doc.t < 0) return false;
    const [kind, id] = splitKey(doc.k);
    if (!KINDS.includes(kind) || doc.kind !== kind || !id) return false;
    return doc.del === true || validEntityData(kind, id, doc.d);
  }

  function remoteHash(doc) {
    if (doc.del) return TOMBSTONE;
    return hashString(JSON.stringify(canonFor(doc.k)(doc.d)));
  }

  // ---------- 同步狀態（每台裝置各自保存） ----------
  function packShadow(h, rev) { return `${h}|${rev}`; }
  function unpackShadow(v) {
    if (typeof v !== 'string') return null;
    const i = v.lastIndexOf('|');
    return { h: v.slice(0, i), r: Number(v.slice(i + 1)) || 0 };
  }

  function freshMeta(deviceId) {
    return {
      v: 1, format: FORMAT, deviceId, uid: null, email: '', cursor: null, shadow: {}, conflicts: [],
      lastSyncAt: 0, lastPullAt: 0, skipped: 0, bulkAck: null,
    };
  }

  function normalizeMeta(raw, deviceId) {
    const m = Object.assign(freshMeta(deviceId), raw && typeof raw === 'object' ? raw : {});
    if (raw && typeof raw === 'object' && raw.format === undefined) m.format = 1; // 舊版程式留下的同步狀態
    if (!m.deviceId) m.deviceId = deviceId;
    if (!m.shadow || typeof m.shadow !== 'object') m.shadow = {};
    if (!Array.isArray(m.conflicts)) m.conflicts = [];
    return m;
  }

  function cmpTs(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    return (a.s - b.s) || (a.n - b.n);
  }

  // 找出「本機內容」與「上次同步時的雲端內容」不同的項目，就是待上傳的變更（含刪除）。
  function computePending(s, meta, now = Date.now()) {
    const map = cachedEntityMap(s);
    const times = s.entityTimes || {};
    const keys = new Set([...map.keys(), ...Object.keys(meta.shadow || {})]);
    const out = [];
    for (const key of keys) {
      const [kind, id] = splitKey(key);
      if (kind === 'rec' && DEMO_SEED_IDS.has(id)) continue; // 示例資料永遠不上傳
      const loc = map.get(key);
      const sh = unpackShadow(meta.shadow[key]);
      const localH = loc ? hashString(loc.json) : TOMBSTONE;
      const baseH = sh ? sh.h : TOMBSTONE;
      if (localH === baseH) continue;
      const t = ownValue(times, key);
      out.push({ key, kind, baseRev: sh ? sh.r : 0, h: localH, del: !loc, data: loc ? loc.data : null, t: typeof t === 'number' ? t : now });
    }
    return out;
  }

  // ---------- 同步引擎 ----------
  // backend：pull({cursor, after, limit}) → {docs, next, maxTs}；push(changes, {deviceId}) → results
  // ledger：get() 取得目前帳本；apply(mutator) 寫入帳本（成功回傳 true，或確實存好後才完成的 Promise）；
  //         flush()（可省略）等本機帳本確實寫入。同步狀態一定在帳本存好之後才保存，
  //         否則網頁中途關掉時，下次會把沒存到的紀錄誤當成「在這台刪掉了」。
  // metaStore：load() / save(meta) 保存此裝置的同步狀態
  // bulkAck()：使用者剛確認過的大量刪除 {count, until}；由畫面層保存，避免同步途中被覆蓋。
  function createEngine({ backend, ledger, metaStore, now = () => Date.now(), pageSize = 300, chunkSize = 100,
    bulkDelete = { min: 20, ratio: 0.3 }, bulkAck = () => null }) {
    let running = null;
    let again = false;

    function localState() {
      const s = ledger.get();
      return { s, map: entityMap(s), times: s.entityTimes || {} };
    }

    function pendingChanges(meta) {
      return computePending(ledger.get(), meta, now());
    }

    // 套用雲端資料。兩邊都改過同一項目時，以「最後修改時間」較新的版本為準，
    // 另一個版本存入衝突紀錄，使用者可以改用。
    // recheck：換到新版程式後第一次同步，連已經讀過的版本也重新比對一次。
    async function applyRemote(docs, meta, recheck = false) {
      const { map, times } = localState();
      const changes = [];
      const conflicts = [];
      const categoryHints = {};
      let skipped = 0;
      // 同一項目在分頁讀取期間又被修改時會出現兩次，只處理最新版本。
      const latest = new Map();
      for (const doc of docs) {
        if (!validRemoteDoc(doc)) { skipped++; continue; }
        const seen = latest.get(doc.k);
        if (!seen || doc.rev > seen.rev) latest.set(doc.k, doc);
      }
      for (const doc of latest.values()) {
        const sh = unpackShadow(meta.shadow[doc.k]);
        const seen = sh && sh.r >= doc.rev;
        if (seen && !recheck) continue;
        const loc = map.get(doc.k);
        const localH = loc ? hashString(loc.json) : TOMBSTONE;
        const rH = remoteHash(doc);
        // 已經讀過這個版本：重新比對時，只有「雲端在新格式下不同、本機從上次同步後沒改過」
        // 才採用雲端（例如舊版程式讀到時去掉的預算欄位）。
        if (seen && (localH !== sh.h || rH === sh.h)) continue;
        const baseH = sh ? sh.h : TOMBSTONE;
        const [kind] = splitKey(doc.k);
        const remoteData = doc.del ? null : canonFor(doc.k)(doc.d);
        if (kind === 'cat') categoryHints[doc.k] = doc.del ? (doc.d && validEntityData('cat', splitKey(doc.k)[1], doc.d) ? doc.d : loc && loc.data) : remoteData;
        meta.shadow[doc.k] = packShadow(rH, doc.rev);
        if (rH === localH) continue;
        const localT = Number(ownValue(times, doc.k)) || 0;
        // 本機沒有改過（或只是預設值、自動修補、無時間的舊資料）就直接採用雲端版本，不算衝突。
        if (localH === baseH || localT === 0) {
          changes.push({ key: doc.k, data: remoteData, t: doc.t });
          continue;
        }
        const remoteWins = doc.t > localT || (doc.t === localT && rH > localH);
        conflicts.push({
          at: now(), key: doc.k, kept: remoteWins ? 'remote' : 'local',
          other: remoteWins ? { del: !loc, data: loc ? loc.data : null, t: localT } : { del: Boolean(doc.del), data: remoteData, t: doc.t },
          keptData: remoteWins ? remoteData : (loc ? loc.data : null),
        });
        if (remoteWins) changes.push({ key: doc.k, data: remoteData, t: doc.t });
      }
      let repaired = [];
      if (changes.length) {
        const ok = await ledger.apply(next => {
          next.entityTimes = Object.assign({}, next.entityTimes || {});
          for (const c of changes) {
            applyEntity(next, c.key, c.data);
            setOwn(next.entityTimes, c.key, c.t);
          }
          repaired = repairInvariants(next, categoryHints);
          for (const key of repaired) setOwn(next.entityTimes, key, 0);
        });
        if (!ok) throw new SyncError('local-save', '此裝置無法寫入帳本，已暫停同步以保護資料。');
      }
      if (conflicts.length) meta.conflicts = conflicts.concat(meta.conflicts).slice(0, MAX_CONFLICTS);
      meta.skipped = (meta.skipped || 0) + skipped;
      return { applied: changes.length, conflicts: conflicts.length, skipped, repaired: repaired.length };
    }

    async function pullAll(meta) {
      const recheck = meta.format !== FORMAT;
      if (recheck) { meta.cursor = null; meta.skipped = 0; }
      const docs = [];
      let after = null, maxTs = meta.cursor, pages = 0;
      do {
        const page = await backend.pull({ cursor: meta.cursor, after, limit: pageSize });
        docs.push(...page.docs);
        if (page.maxTs && cmpTs(page.maxTs, maxTs) > 0) maxTs = page.maxTs;
        after = page.next;
        pages++;
      } while (after && pages < 1000);
      // 整批下載完成才套用並前進讀取位置；中途斷線就下次從原位置重新讀。
      const result = await applyRemote(docs, meta, recheck);
      meta.cursor = maxTs;
      meta.lastPullAt = now();
      meta.format = FORMAT;
      return Object.assign({ pulled: docs.length }, result);
    }

    function holdBulkDeletes(pending, meta) {
      const deletes = pending.filter(p => p.kind === 'rec' && p.del);
      if (deletes.length < bulkDelete.min) return { allowed: pending, held: 0 };
      const synced = Object.entries(meta.shadow).filter(([k, v]) => k.startsWith('rec:') && !String(v).startsWith(TOMBSTONE + '|')).length;
      if (deletes.length <= synced * bulkDelete.ratio) return { allowed: pending, held: 0 };
      const ack = bulkAck() || meta.bulkAck;
      if (ack && ack.until > now() && deletes.length <= ack.count) return { allowed: pending, held: 0 };
      return { allowed: pending.filter(p => !(p.kind === 'rec' && p.del)), held: deletes.length };
    }

    async function pushAll(meta) {
      let pushed = 0, held = 0, conflicts = 0;
      if (ledger.flush) await ledger.flush(); // 先確定本機帳本已經存好，再上傳
      for (let round = 0; round < 4; round++) {
        const gate = holdBulkDeletes(pendingChanges(meta), meta);
        held = gate.held;
        if (!gate.allowed.length) break;
        let conflictDocs = [];
        for (let i = 0; i < gate.allowed.length; i += chunkSize) {
          const chunk = gate.allowed.slice(i, i + chunkSize);
          const results = await backend.push(chunk, { deviceId: meta.deviceId });
          for (const r of results) {
            if (r.status === 'written' || r.status === 'same') {
              meta.shadow[r.key] = packShadow(r.h, r.rev);
              if (r.status === 'written') pushed++;
            } else if (r.status === 'conflict' && r.remote) {
              conflictDocs.push(r.remote);
            }
          }
          metaStore.save(meta);
        }
        if (!conflictDocs.length) break;
        conflicts += (await applyRemote(conflictDocs, meta)).conflicts;
        metaStore.save(meta);
      }
      return { pushed, held, conflicts };
    }

    async function runOnce() {
      const meta = normalizeMeta(metaStore.load(), null);
      if (!meta.uid) throw new SyncError('not-linked', '尚未連結雲端帳號。');
      const pull = await pullAll(meta);
      if (!metaStore.save(meta)) throw new SyncError('local-save', '此裝置無法保存同步狀態。');
      const push = await pushAll(meta);
      meta.lastSyncAt = now();
      if (!metaStore.save(meta)) throw new SyncError('local-save', '此裝置無法保存同步狀態。');
      const pending = pendingChanges(meta).length;
      return {
        pulled: pull.pulled, applied: pull.applied, skipped: pull.skipped, repaired: pull.repaired,
        conflicts: pull.conflicts + push.conflicts, pushed: push.pushed, heldDeletes: push.held, pending,
      };
    }

    // 同一時間只跑一輪；執行中又有新變更時，結束後自動再跑一次。
    function sync() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          let result;
          do {
            again = false;
            result = await runOnce();
          } while (again);
          return result;
        } finally {
          running = null;
        }
      })();
      return running;
    }

    return {
      sync,
      isRunning: () => Boolean(running),
      pending: () => pendingChanges(normalizeMeta(metaStore.load(), null)),
    };
  }

  return {
    TOMBSTONE, PREF_KEY, DEMO_SEED_IDS, SyncError, FORMAT, RULE_PREFIX, isRuleKey, canonFor,
    hashString, entityMap, snapshot, stampTimes, diffEntities, applyEntity, repairInvariants, validRemoteDoc, validEntityData,
    isDemoSeedRecord, packShadow, unpackShadow, freshMeta, normalizeMeta, splitKey, canon, cmpTs, validBudget,
    computePending, createEngine,
  };
})();
