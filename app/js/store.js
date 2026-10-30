// IndexedDB persistence. One database per data mode (live / demo / file) so demo data can
// never mix with real data, plus a small global database for the active-mode pointer.
const DB_VERSION = 1;

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function open(name, upgrade) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, DB_VERSION);
    r.onupgradeneeded = () => upgrade(r.result);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('IndexedDB blocked (close other tabs of the app)'));
  });
}

export async function openModeDb(mode) {
  const db = await open('ielts-vocab-' + mode, (d) => {
    if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('events')) d.createObjectStore('events', { keyPath: 'eventId' });
    if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
  });
  return wrap(db);
}

export async function openGlobalDb() {
  return wrap(await open('ielts-vocab-global', (d) => {
    if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
  }));
}

function wrap(db) {
  const tx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);
  const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); });
  return {
    db,
    getAll: (store) => req(tx(store).getAll()),
    get: (store, key) => req(tx(store).get(key)),
    async putMany(store, values) {
      const t = db.transaction(store, 'readwrite');
      const os = t.objectStore(store);
      for (const v of values) os.put(v);
      await done(t);
    },
    put(store, value) { return this.putMany(store, [value]); },
    async getKv(k, dflt = null) { const r = await req(tx('kv').get(k)); return r ? r.v : dflt; },
    async setKv(k, v) { await this.put('kv', { k, v }); },
    close: () => db.close(),
  };
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch (e) { /* ignore */ }
  return false;
}
