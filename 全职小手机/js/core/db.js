const DB_NAME = 'GloryPhoneDB';
const DB_VERSION = 2;

const STORES = {
  users: { keyPath: 'id', indices: ['name'] },
  characters: { keyPath: 'id', indices: ['name', 'team'] },
  chats: { keyPath: 'id', indices: ['userId', 'lastActivity', 'type'] },
  messages: { keyPath: 'id', indices: ['chatId', 'timestamp', 'senderId'] },
  worldBooks: { keyPath: 'id', indices: ['category', 'season', 'userId', 'isAU'] },
  memories: { keyPath: 'id', indices: ['chatId', 'characterId', 'timestamp'] },
  settings: { keyPath: 'key' },
  stickerPacks: { keyPath: 'id' },
  momentsPosts: { keyPath: 'id', indices: ['authorId', 'timestamp'] },
  weiboPosts: { keyPath: 'id', indices: ['authorId', 'timestamp'] },
  forumThreads: { keyPath: 'id', indices: ['timestamp', 'userId'] },
};

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      for (const [name, cfg] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
          if (cfg.indices) {
            for (const idx of cfg.indices) {
              store.createIndex(idx, idx, { unique: false });
            }
          }
        }
      }
      if (db.objectStoreNames.contains('forumThreads')) {
        const store = e.target.transaction.objectStore('forumThreads');
        if (!store.indexNames.contains('userId')) {
          store.createIndex('userId', 'userId', { unique: false });
        }
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
  });
}

async function tx(storeName, mode = 'readonly') {
  const db = await open();
  return db.transaction(storeName, mode).objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(storeName, key) {
  const store = await tx(storeName);
  return reqToPromise(store.get(key));
}

export async function getAll(storeName) {
  const store = await tx(storeName);
  return reqToPromise(store.getAll());
}

export async function getAllByIndex(storeName, indexName, value) {
  const store = await tx(storeName);
  const index = store.index(indexName);
  return reqToPromise(index.getAll(value));
}

export async function put(storeName, data) {
  const store = await tx(storeName, 'readwrite');
  return reqToPromise(store.put(data));
}

export async function putMany(storeName, items) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    for (const item of items) store.put(item);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function del(storeName, key) {
  const store = await tx(storeName, 'readwrite');
  return reqToPromise(store.delete(key));
}

export async function clear(storeName) {
  const store = await tx(storeName, 'readwrite');
  return reqToPromise(store.clear());
}

export async function count(storeName) {
  const store = await tx(storeName);
  return reqToPromise(store.count());
}

export async function exportAll() {
  const db = await open();
  const dump = {};
  const names = [...db.objectStoreNames];
  for (const name of names) {
    dump[name] = await getAll(name);
  }
  return dump;
}

export async function importAll(dump) {
  const db = await open();
  const names = [...db.objectStoreNames];
  for (const name of names) {
    if (dump[name]) {
      await clear(name);
      await putMany(name, dump[name]);
    }
  }
}

export { open, STORES };
