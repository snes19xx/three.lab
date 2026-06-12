// Cross-app GLB handoff via IndexedDB.
// Lab and Editor both import this to send / receive a model.
//
//   await putHandoff('toEditor', file)   // sender
//   const f  = await takeHandoff('toEditor')  // receiver (and clears the slot)
//
// `file` can be a real File, or a plain { name, buffer } object (an ArrayBuffer).

const DB_NAME = "model-tools-handoff";
const STORE = "files";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// `extra` rides along in the stored record (e.g. { wireframe: true }) and is
// returned by takeHandoff, so the receiver can react to how the model was sent.
export async function putHandoff(key, fileOrPayload, extra = {}) {
  let name, buffer;
  if (fileOrPayload instanceof Blob) {
    name = fileOrPayload.name || "model.glb";
    buffer = await fileOrPayload.arrayBuffer();
  } else {
    name = fileOrPayload.name || "model.glb";
    buffer = fileOrPayload.buffer;
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ name, buffer, ts: Date.now(), ...extra }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Reads and clears the slot. Returns null if empty.
// Result: { name, buffer (ArrayBuffer), ts }
export async function takeHandoff(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const get = store.get(key);
    get.onsuccess = () => {
      const val = get.result || null;
      if (val) store.delete(key);
      tx.oncomplete = () => resolve(val);
    };
    get.onerror = () => reject(get.error);
    tx.onerror = () => reject(tx.error);
  });
}

// Helper: convert a payload from the handoff into a File object that can be loaded by Three.js
export function payloadToFile(payload) {
  if (!payload) return null;
  return new File([payload.buffer], payload.name, {
    type: "model/gltf-binary",
  });
}
