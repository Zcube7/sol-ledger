// 扩展自己的 IndexedDB（只在这台电脑、这个浏览器里）。后台写，汇总页读。
//   matches：每局一条（自己那一行），键 roomId，按 day 建索引
//   details：每局的小队（3 人），键 roomId；玩家 ID 只存带本机密钥的代号
//   meta   ：本机密钥、每天的同步状态
const DB_NAME = 'sol-ledger';
const DB_VERSION = 1;

let dbP = null;
export function openDb() {
  return dbP || (dbP = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const m = db.createObjectStore('matches', { keyPath: 'roomId' });
      m.createIndex('day', 'day');
      db.createObjectStore('details', { keyPath: 'roomId' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const req2p = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export const putAll = (store, items) => tx(store, 'readwrite', s => { for (const it of items) s.put(it); return items.length; });
export const get = (store, key) => tx(store, 'readonly', s => req2p(s.get(key)));
export const getMany = (store, keys) => tx(store, 'readonly', s => Promise.all(keys.map(k => req2p(s.get(k)))));
export const matchesOfDay = day => tx('matches', 'readonly', s => req2p(s.index('day').getAll(day)));
/** 清空战绩和同步状态；keepKey=true 时留着本机密钥（同一个人以后还是同一个代号） */
export async function clearAll({ keepKey = true } = {}) {
  await tx('matches', 'readwrite', s => s.clear());
  await tx('details', 'readwrite', s => s.clear());
  const key = keepKey ? await get('meta', 'localKey') : null;
  await tx('meta', 'readwrite', s => { s.clear(); if (key) s.put(key); });
}

/** 本机随机密钥：把玩家 ID 换成代号用，从不离开这个扩展 */
export async function localKey() {
  const hit = await get('meta', 'localKey');
  if (hit) return hit.value;
  const value = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  await putAll('meta', [{ key: 'localKey', value }]);
  return value;
}

/** 玩家 ID → 代号（带本机密钥的 SHA-256 前 16 位十六进制）：同一个人永远是同一个代号，但没有密钥推不回 ID */
export async function aliasOf(id, key) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key + '|' + id));
  return Array.from(new Uint8Array(buf).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}
