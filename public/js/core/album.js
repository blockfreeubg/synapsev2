// Screenshots, kept in this browser's IndexedDB.

const DB = 'synapse-album';
const STORE = 'shots';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export async function saveShot({ blob, title, pkg }) {
  const shot = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, blob, title, pkg, ts: Date.now() };
  await tx('readwrite', (s) => s.put(shot));
  return shot;
}

export async function listShots() {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    return all.sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

export async function deleteShot(id) {
  await tx('readwrite', (s) => s.delete(id));
}
