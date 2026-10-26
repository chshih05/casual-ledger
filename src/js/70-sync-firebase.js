// Firebase 連線：Google 登入（Firebase Authentication）與雲端資料庫（Cloud Firestore Lite）。
// 只有在同步設定完成、且使用者開啟同步時才會從 Google 官方網址載入元件；
// 未設定或離線時，帳本仍完全在本機運作。
// 資料位置：users/{登入帳號 uid}/entities/{項目}，安全規則限制只有帳號本人能讀寫。
const LedgerFirebase = (() => {
  'use strict';
  const SDK_VERSION = '12.19.0';
  const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;
  const NETWORK_TIMEOUT_MS = 25000;
  const BACKUP_TIMEOUT_MS = 60000; // 雲端備份一次上傳或下載整本帳，手機網路慢時需要久一點
  let sdkPromise = null;

  function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = Promise.all([
        import(SDK_BASE + 'firebase-app.js'),
        import(SDK_BASE + 'firebase-auth.js'),
        import(SDK_BASE + 'firebase-firestore-lite.js'),
      ]).then(([app, auth, fs]) => ({ app, auth, fs }));
      sdkPromise.catch(() => { sdkPromise = null; });
    }
    return sdkPromise;
  }

  function base64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // 店家名稱可能含有雲端文件代碼不允許的字元，因此轉成 base64url。
  function docIdForKey(key) {
    const i = key.indexOf(':');
    const kind = key.slice(0, i), id = key.slice(i + 1);
    return kind === 'mer' ? 'mer_' + base64Url(id) : `${kind}_${id}`;
  }

  function withTimeout(promise, ms = NETWORK_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('network timeout'), { code: 'deadline-exceeded' })), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function classify(err) {
    const code = String((err && err.code) || '');
    const message = String((err && err.message) || '');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    if (['unavailable', 'deadline-exceeded', 'auth/network-request-failed', 'auth/timeout'].includes(code)) return 'offline';
    if (!code && /fetch|network|load failed|import/i.test(message)) return 'offline';
    if (code === 'permission-denied') return 'permission';
    if (['unauthenticated', 'auth/user-token-expired', 'auth/invalid-user-token', 'auth/user-disabled', 'auth/requires-recent-login'].includes(code)) return 'unauthenticated';
    if (code === 'resource-exhausted' || code === 'auth/quota-exceeded') return 'quota';
    if (code === 'not-found') return 'no-database';
    if (code === 'failed-precondition') return 'needs-setup';
    if (code === 'auth/unauthorized-domain') return 'unauthorized-domain';
    if (code === 'auth/operation-not-allowed' || code === 'auth/configuration-not-found') return 'provider-disabled';
    if (code === 'auth/popup-blocked') return 'popup-blocked';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' || code === 'auth/user-cancelled') return 'popup-closed';
    if (code === 'auth/invalid-api-key' || code.startsWith('auth/api-key') || code === 'invalid-argument' || code === 'auth/invalid-app-id') return 'invalid-config';
    return 'unknown';
  }

  function fromSnapshot(snap) {
    const d = snap.data();
    const ts = d.serverTs;
    return {
      id: snap.id, k: d.k, kind: d.kind, rev: d.rev, h: d.h, del: d.del === true, d: d.d || {},
      t: d.t, dev: d.dev, ts: ts ? { s: ts.seconds, n: ts.nanoseconds } : null,
    };
  }

  async function create(config, { onAuth }) {
    const { app: A, auth: Au, fs: F } = await withTimeout(loadSdk());
    const app = A.getApps().length ? A.getApp() : A.initializeApp(config);
    const auth = Au.getAuth(app);
    const db = F.getFirestore(app);
    let user = null;

    await new Promise(resolve => {
      let first = true;
      Au.onAuthStateChanged(auth, u => {
        user = u;
        onAuth(u ? { uid: u.uid, email: u.email || '' } : null);
        if (first) { first = false; resolve(); }
      });
    });

    const signedInUid = () => {
      if (!user) throw Object.assign(new Error('not signed in'), { code: 'unauthenticated' });
      return user.uid;
    };
    const entities = () => F.collection(db, 'users', signedInUid(), 'entities');
    // 雲端自動備份（見 85-backup.js）：users/{uid}/backups/{週代號}，內容分段存在底下的 parts。
    const backups = () => F.collection(db, 'users', signedInUid(), 'backups');
    const backupMeta = snap => {
      const d = snap.data();
      return { id: snap.id, at: d.at ? d.at.toMillis() : d.t, t: d.t, records: d.records, size: d.size, parts: d.parts, enc: d.enc };
    };

    return {
      kind: 'firebase',
      classify,

      async signIn() {
        const provider = new Au.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        await Au.signInWithPopup(auth, provider);
      },

      async signOut() {
        await Au.signOut(auth);
      },

      // 依雲端寫入時間（伺服器時間）依序讀取 cursor 之後的變更。
      async pull({ cursor, after, limit }) {
        const parts = [];
        if (cursor) parts.push(F.where('serverTs', '>', new F.Timestamp(cursor.s, cursor.n)));
        parts.push(F.orderBy('serverTs'));
        if (after) parts.push(F.startAfter(after.snapshot));
        parts.push(F.limit(limit));
        const snap = await withTimeout(F.getDocs(F.query(entities(), ...parts)));
        const docs = snap.docs.map(fromSnapshot);
        const last = snap.docs[snap.docs.length - 1];
        const lastTs = last ? fromSnapshot(last).ts : null;
        return { docs, next: snap.docs.length === limit ? { snapshot: last } : null, maxTs: lastTs };
      },

      // 以交易一次檢查並寫入：雲端版本仍是本機上次看到的版本才覆寫，否則回報衝突。
      // 內容已相同（例如上次已寫入但回應遺失）就不重寫，避免重複。
      async push(changes, { deviceId }) {
        const col = entities();
        const refs = changes.map(c => F.doc(col, docIdForKey(c.key)));
        return withTimeout(F.runTransaction(db, async tx => {
          const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
          const results = [];
          changes.forEach((c, i) => {
            const remote = snaps[i].exists() ? fromSnapshot(snaps[i]) : null;
            const remoteH = remote ? (remote.del ? 'x' : remote.h) : 'x';
            if (remote && remoteH === c.h) {
              results.push({ key: c.key, status: 'same', rev: remote.rev, h: c.h });
              return;
            }
            if (!remote && c.del) {
              results.push({ key: c.key, status: 'same', rev: 0, h: 'x' });
              return;
            }
            if (remote && remote.rev !== c.baseRev) {
              results.push({ key: c.key, status: 'conflict', remote });
              return;
            }
            const rev = remote ? remote.rev + 1 : 1;
            tx.set(refs[i], {
              k: c.key, kind: c.kind, rev, h: c.del ? '' : c.h, del: c.del,
              // 刪除時保留雲端最後的內容，日後可以查證或還原。
              d: c.del ? (remote ? remote.d : {}) : c.data,
              t: c.t, dev: deviceId, serverTs: F.serverTimestamp(), v: 1,
            });
            results.push({ key: c.key, status: 'written', rev, h: c.h });
          });
          return results;
        }));
      },

      async getBackup(id) {
        const snap = await withTimeout(F.getDoc(F.doc(backups(), id)));
        return snap.exists() ? backupMeta(snap) : null;
      },

      // 內容與說明一次寫入（全部成功或全部失敗），不會留下只寫了一半的備份。
      // 安全規則只允許新增：同一週已經有備份時會被拒絕，不會蓋掉。
      async saveBackup(id, meta, parts) {
        const ref = F.doc(backups(), id), batch = F.writeBatch(db);
        parts.forEach((bytes, i) => batch.set(F.doc(ref, 'parts', String(i)), { i, data: F.Bytes.fromUint8Array(bytes) }));
        batch.set(ref, {
          v: 1, at: F.serverTimestamp(), t: meta.t, records: meta.records, size: meta.size,
          parts: parts.length, enc: meta.enc, dev: meta.dev, app: meta.app,
        });
        await withTimeout(batch.commit(), BACKUP_TIMEOUT_MS);
      },

      async listBackups(limit) {
        const snap = await withTimeout(F.getDocs(F.query(backups(), F.orderBy('at', 'desc'), F.limit(limit))));
        return snap.docs.map(backupMeta);
      },

      async loadBackup(id) {
        const snap = await withTimeout(F.getDocs(F.collection(F.doc(backups(), id), 'parts')), BACKUP_TIMEOUT_MS);
        return snap.docs.map(d => d.data()).sort((a, b) => a.i - b.i).map(p => p.data.toUint8Array());
      },
    };
  }

  return { create, docIdForKey, classify, SDK_VERSION };
})();
