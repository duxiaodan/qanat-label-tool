// Project pools are expendable IndexedDB caches. Recovery records stay synchronous
// in localStorage so a save can verify durability before sending its RPC.
const POOL_PREFIX = 'qanat-labels:';
const DB_NAME = 'qanat-label-cache-v1';
const MAX_CACHE_CHARS = 8 * 1024 * 1024;

export class RecoveryStorageError extends Error {
  constructor(cause, operation = 'write') {
    super(`Browser storage could not ${operation === 'write' ? 'save' : 'remove'} the recovery record. Keep this page open and download the current draft.`);
    this.name = 'RecoveryStorageError';
    this.cause = cause;
  }
}

function quotaError(error) {
  return error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
function parse(raw, fallback = null) {
  try { return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
}
function poolShape(value) {
  return value && Array.isArray(value.shaftMarks) && Array.isArray(value.lineMarks);
}
function expendable(value) {
  return poolShape(value) && value.unsynced === false &&
    [...value.shaftMarks, ...value.lineMarks].every(mark => mark && Number.isFinite(mark.dbId) && mark.dbId > 0);
}

export function createLabelStorage({local, indexedDB: factory, maxCacheChars = MAX_CACHE_CHARS,
  openTimeoutMs = 1500, now = () => Date.now()} = {}) {
  const localStore = () => local === undefined ? globalThis.localStorage : local;
  let opening, migration;

  function readRecovery(key, fallback = null) {
    try { return parse(localStore().getItem(key), fallback); } catch { return fallback; }
  }
  function writeRecovery(key, value) {
    try {
      const raw = JSON.stringify(value), store = localStore();
      try { store.setItem(key, raw); return; }
      catch (error) { if (!quotaError(error)) throw error; }
      // Reclaim only reconstructible, server-confirmed legacy pool caches.
      // Drafts, archives, pending commands and unconfirmed pools are never removed.
      const candidates = Object.keys(store).filter(k => k !== key && k.startsWith(POOL_PREFIX))
        .map(k => ({key: k, raw: store.getItem(k)}))
        .filter(entry => expendable(parse(entry.raw))).sort((a,b) => b.raw.length - a.raw.length);
      for (const entry of candidates) {
        if (store.getItem(entry.key) !== entry.raw) continue;
        store.removeItem(entry.key);
        try { store.setItem(key, raw); return; }
        catch (error) { if (!quotaError(error)) throw error; }
      }
      store.setItem(key, raw); // Preserve the native failure as the cause.
    } catch (error) { throw new RecoveryStorageError(error); }
  }
  function removeRecovery(key) {
    try { localStore().removeItem(key); } catch (error) { throw new RecoveryStorageError(error, 'remove'); }
  }

  function database() {
    if (opening) return opening;
    opening = new Promise(resolve => {
      let request, settled = false;
      const finish = db => { if (settled) { db?.close(); return; } settled = true; clearTimeout(timer); resolve(db); };
      const timer = setTimeout(() => finish(null), openTimeoutMs);
      try {
        const idb = factory === undefined ? globalThis.indexedDB : factory;
        if (!idb) { finish(null); return; }
        request = idb.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (settled) { request.transaction.abort(); return; }
          const db = request.result;
          db.createObjectStore('pools', {keyPath: 'key'});
          const legacy = db.createObjectStore('legacy', {keyPath: 'id', autoIncrement: true});
          legacy.createIndex('scope', 'scope');
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opening = null; };
          finish(db);
        };
        request.onerror = () => finish(null);
        request.onblocked = () => finish(null);
      } catch { finish(null); }
    });
    return opening;
  }
  function transaction(db, names, mode, run) {
    return new Promise((resolve, reject) => {
      let result, tx;
      try {
        tx = db.transaction(names, mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || new Error('Cache transaction aborted'));
        tx.onerror = () => {}; // onabort reports the final outcome.
        run(tx, value => { result = value; });
      } catch (error) { try { tx?.abort(); } catch {} reject(error); }
    });
  }
  async function evictOptional(db) {
    await transaction(db, ['pools'], 'readwrite', tx => {
      const store = tx.objectStore('pools'), request = store.getAll();
      request.onsuccess = () => { for (const row of request.result) if (row.expendable) store.delete(row.key); };
    });
  }
  async function storePool(db, key, raw, value) {
    const optional = expendable(value);
    if (optional && raw.length > maxCacheChars) return false;
    const put = () => transaction(db, ['pools'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('pools'), request = store.getAll();
      request.onsuccess = () => {
        const others = request.result.filter(row => row.key !== key);
        let total = raw.length + others.reduce((n,row) => n + row.raw.length, 0);
        for (const row of others.filter(row => row.expendable).sort((a,b) => a.touched - b.touched)) {
          if (total <= maxCacheChars) break;
          store.delete(row.key); total -= row.raw.length;
        }
        if (optional && total > maxCacheChars) { done(false); return; }
        store.put({key, raw, expendable: optional, touched: now()}); done(true);
      };
    });
    try { return await put(); }
    catch (error) { if (!quotaError(error)) throw error; await evictOptional(db); return put(); }
  }
  async function storeLegacy(db, scope, raw) {
    const put = () => transaction(db, ['legacy'], 'readwrite', tx => {
      const store = tx.objectStore('legacy'), request = store.index('scope').getAll(scope);
      request.onsuccess = () => {
        if (!request.result.some(row => row.raw === raw)) store.add({scope, raw, touched: now()});
      };
    });
    try { await put(); }
    catch (error) { if (!quotaError(error)) throw error; await evictOptional(db); await put(); }
  }
  async function migrateLegacyPools(db) {
    if (migration) return migration;
    migration = (async () => {
      let entries;
      try {
        const store = localStore();
        entries = Object.keys(store).filter(key => key.startsWith(POOL_PREFIX))
          .map(key => ({key, raw: store.getItem(key)}));
      } catch { return; }
      for (const {key, raw} of entries) {
        const value = parse(raw);
        if (!poolShape(value)) continue;
        try {
          // Unconfirmed historical snapshots get their own non-evictable store.
          // Future ordinary cache writes cannot overwrite those snapshots.
          const stored = expendable(value) ? await storePool(db, key, raw, value)
            : (await storeLegacy(db, key, raw), true);
          if (stored && localStore().getItem(key) === raw) localStore().removeItem(key);
        } catch { /* Leave the original untouched unless its copy committed. */ }
      }
    })();
    return migration;
  }
  async function loadPool(key) {
    const localValue = readRecovery(key);
    const db = await database();
    if (!db) return poolShape(localValue) ? localValue : null;
    try {
      await migrateLegacyPools(db);
      const records = await transaction(db, ['pools', 'legacy'], 'readonly', (tx, done) => {
        const result = {};
        const pool = tx.objectStore('pools').get(key);
        pool.onsuccess = () => { result.pool = pool.result; };
        const legacy = tx.objectStore('legacy').index('scope').getAll(key);
        legacy.onsuccess = () => { result.legacy = legacy.result; };
        done(result);
      });
      const recovered = records.legacy.map(row => parse(row.raw)).filter(poolShape);
      if (poolShape(localValue)) recovered.push(localValue);
      const base = parse(records.pool?.raw) || recovered.at(-1);
      if (!poolShape(base)) return null;
      const result = {...base, shaftMarks: [...base.shaftMarks], lineMarks: [...base.lineMarks]};
      // Preserve unuploaded marks from old snapshots even if a newer shared
      // server cache was written by a different account on the same browser.
      for (const field of ['shaftMarks', 'lineMarks']) {
        const fingerprint = mark => JSON.stringify([mark.labeler, mark.cropId, mark.world]);
        const present = new Set(result[field].map(fingerprint));
        for (const old of recovered) for (const mark of old[field]) {
          if (mark.dbId != null || present.has(fingerprint(mark))) continue;
          result[field].push(mark); present.add(fingerprint(mark)); result.unsynced = true;
        }
      }
      return result;
    } catch { return poolShape(localValue) ? localValue : null; }
  }
  async function savePool(key, value) {
    try {
      // Serialize before awaiting: this is a snapshot of the caller's state.
      const raw = JSON.stringify(value), snapshot = JSON.parse(raw), db = await database();
      return db ? await storePool(db, key, raw, snapshot) : false;
    } catch { return false; } // Optional caches never veto a confirmed cloud save.
  }
  async function confirmCrop(key, actor, cellId) {
    // Retire only this actor/crop's historical recovery after the server has
    // confirmed it. Otherwise a moved/deleted old unsaved mark could reappear.
    try {
      const db = await database();
      if (!db) return;
      await transaction(db, ['legacy'], 'readwrite', tx => {
        const store = tx.objectStore('legacy'), request = store.index('scope').getAll(key);
        request.onsuccess = () => {
          for (const row of request.result) {
            const pool = parse(row.raw);
            if (!poolShape(pool)) continue;
            const mine = mark => mark.cropId === cellId && mark.labeler === actor;
            pool.shaftMarks = pool.shaftMarks.filter(mark => !mine(mark));
            pool.lineMarks = pool.lineMarks.filter(mark => !mine(mark));
            if (!pool.shaftMarks.length && !pool.lineMarks.length) store.delete(row.id);
            else store.put({...row, raw: JSON.stringify(pool)});
          }
        };
      });
    } catch { /* Keep historical recovery if its retirement cannot commit. */ }
  }
  return {readRecovery, writeRecovery, removeRecovery, loadPool, savePool, confirmCrop};
}
