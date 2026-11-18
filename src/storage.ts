const database = new Promise<IDBDatabase>((resolve,reject) => {
  const request = indexedDB.open('daybreak-factory',1);
  request.onupgradeneeded = () => request.result.createObjectStore('campaign');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function resumeSave():Promise<unknown> {
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
