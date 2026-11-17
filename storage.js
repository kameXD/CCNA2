export function openGallery() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('smartcapture', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('gallery');
      request.result.createObjectStore('images');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Cierra otras pestañas de SmartCapture y vuelve a cargar.'));
    request.onsuccess = () => resolve(request.result);
  });
}

export function read(db, store, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Read and update the order inside the same transaction to preserve concurrent writes.
export function updateGallery(db, change, imageChange) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['gallery', 'images'], 'readwrite');
    const gallery = transaction.objectStore('gallery');
    const request = gallery.get('order');
    let updated;
    transaction.oncomplete = () => resolve(updated);
    transaction.onabort = () => reject(transaction.error ?? new Error('No se pudo guardar la galería.'));
    request.onsuccess = () => {
      updated = change(request.result ?? []);
      gallery.put(updated, 'order');
      imageChange?.(transaction.objectStore('images'));
    };
  });
}
