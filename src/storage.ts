const reviewScenes = ['opening', 'miner', 'first-light', 'three-cities'];
const reviewParam = import.meta.env.DEV && import.meta.env.MODE === 'visual-review'
  ? new URLSearchParams(location.search).get('review')
  : null;
export const reviewScene = reviewParam && reviewScenes.includes(reviewParam) ? reviewParam : null;
const legacyBlueprintKey = reviewScene ? 'daybreak-review-blueprint' : 'daybreak-blueprint';

export function legacyBlueprint():number[] | undefined {
  try {
    const value:unknown=JSON.parse(localStorage.getItem(legacyBlueprintKey) ?? 'null');
    if (Array.isArray(value) && value.length>0 && value.length<=250 && value.every(part=>
      Array.isArray(part) && part.length===6 && part.every(word=>Number.isInteger(word) && word>=-2147483648 && word<=2147483647))) {
      return value.flat();
    }
  } catch { /* A damaged optional layout does not prevent loading the campaign. */ }
  return undefined;
}

export function clearLegacyBlueprint() {
  // Reloading a review scene intentionally starts from its original sample.
  if (!reviewScene) localStorage.removeItem(legacyBlueprintKey);
}

const database = new Promise<IDBDatabase>((resolve,reject) => {
  const request = indexedDB.open(reviewScene ? 'daybreak-factory-review' : 'daybreak-factory',1);
  request.onupgradeneeded = () => request.result.createObjectStore('campaign');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function resumeSave():Promise<unknown> {
  if (reviewScene === 'opening') return undefined;
  if (reviewScene) {
    const response = await fetch(`/docs/visual-review.local/${reviewScene}.dawn`);
    if (!response.ok) throw new Error('未找到视觉评审场景，请通过 npm run review:visual 启动。');
    return response.arrayBuffer();
  }
  const db = await database;
  return new Promise((resolve,reject) => {
    const request = db.transaction('campaign').objectStore('campaign').get('current');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function persistSave(buffer:ArrayBuffer) {
  const db = await database;
  return new Promise<void>((resolve,reject) => {
    const transaction = db.transaction('campaign','readwrite');
    transaction.objectStore('campaign').put(buffer,'current');
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

export function downloadSave(buffer:ArrayBuffer) {
  const url = URL.createObjectURL(new Blob([buffer],{type:'application/octet-stream'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'daybreak-factory.dawn';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),3000);
}
