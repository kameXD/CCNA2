export const GENERAL_ALBUM = 'general';

export function openGallery() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('smartcapture', 2);
    request.onupgradeneeded = ({ oldVersion }) => {
      const db = request.result;
      const transaction = request.transaction;
      if (!oldVersion) {
        db.createObjectStore('gallery');
        db.createObjectStore('images');
      }
      const albums = db.createObjectStore('albums', { keyPath: 'id' });
      const gallery = transaction.objectStore('gallery');
      const order = gallery.get('order');
      const trash = gallery.get('trash');
      trash.onsuccess = () => {
        albums.add({ id: GENERAL_ALBUM, name: 'General', order: order.result ?? [], trash: trash.result ?? [] });
        gallery.put(GENERAL_ALBUM, 'activeAlbum');
        gallery.delete('order');
        gallery.delete('trash');
      };
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Cierra otras pestañas de SmartCapture y vuelve a cargar.'));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function read(db, store, key) {
  return result(db.transaction(store).objectStore(store).get(key));
}

async function write(db, stores, change) {
  const transaction = db.transaction(stores, 'readwrite');
  const completed = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error ?? new Error('No se pudo guardar el cambio.'));
  });
  // Individual request errors propagate through change. Also observe early aborts.
  completed.catch(() => {});
  try {
    const value = await change(transaction);
    await completed;
    return value;
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction already ended. */ }
    await completed.catch(() => {});
    throw error;
  }
}

export async function readAlbum(db, id) {
  return requireAlbum(db.transaction('albums').objectStore('albums'), id);
}

async function requireAlbum(store, id) {
  const album = await result(store.get(id));
  if (!album) throw new Error('El álbum ya no existe.');
  return album;
}

async function albumState(transaction, preferred) {
  const store = transaction.objectStore('albums');
  const gallery = transaction.objectStore('gallery');
  const all = await result(store.getAll());
  const remembered = preferred ?? await result(gallery.get('activeAlbum'));
  const active = all.find(album => album.id === remembered) ?? all[0];
  return { active, albums: all.map(({ id, name }) => ({ id, name })) };
}

export function readAlbumState(db) {
  return albumState(db.transaction(['albums', 'gallery']));
}

export function selectAlbum(db, id) {
  return write(db, ['albums', 'gallery'], async transaction => {
    const state = await albumState(transaction, id);
    if (state.active.id !== id) throw new Error('El álbum ya no existe.');
    transaction.objectStore('gallery').put(id, 'activeAlbum');
    return state;
  });
}

export function createAlbum(db, name) {
  return write(db, ['albums', 'gallery'], async transaction => {
    const id = crypto.randomUUID();
    transaction.objectStore('albums').add({ id, name, order: [], trash: [] });
    transaction.objectStore('gallery').put(id, 'activeAlbum');
    return albumState(transaction, id);
  });
}

export function renameAlbum(db, id, name) {
  return write(db, ['albums', 'gallery'], async transaction => {
    const store = transaction.objectStore('albums');
    const album = await requireAlbum(store, id);
    store.put({ ...album, name });
    return albumState(transaction, id);
  });
}

export function deleteAlbum(db, id) {
  return write(db, ['albums', 'gallery', 'images'], async transaction => {
    const store = transaction.objectStore('albums');
    const album = await requireAlbum(store, id);
    const images = transaction.objectStore('images');
    for (const entry of album.order) images.delete(entry.id);
    for (const { entry } of album.trash) images.delete(entry.id);
    store.delete(id);
    if (!await result(store.count())) {
      store.add({ id: GENERAL_ALBUM, name: 'General', order: [], trash: [] });
    }
    const state = await albumState(transaction, GENERAL_ALBUM);
    transaction.objectStore('gallery').put(state.active.id, 'activeAlbum');
    return state;
  });
}

export function moveImages(db, source, destination, ids, placement = 'end') {
  return write(db, ['albums'], async transaction => {
    const store = transaction.objectStore('albums');
    const [from, to] = await Promise.all([requireAlbum(store, source), requireAlbum(store, destination)]);
    const available = new Map(from.order.map(entry => [entry.id, entry]));
    const selected = new Set(ids);
    const present = new Set([...to.order.map(entry => entry.id), ...to.trash.map(({ entry }) => entry.id)]);
    if (source === destination || !ids.length || selected.size !== ids.length ||
        ids.some(id => !available.has(id) || present.has(id))) {
      throw new Error('El traslado no se realizó. Comprueba que las imágenes sigan en el álbum de origen.');
    }
    const index = placement === 'end' ? to.order.length : placement - 1;
    if (!Number.isInteger(index) || index < 0 || index > to.order.length) {
      throw new Error(`Indica una posición entre 1 y ${to.order.length + 1} para ese álbum.`);
    }
    from.order = from.order.filter(entry => !selected.has(entry.id));
    to.order = [...to.order.slice(0, index), ...ids.map(id => available.get(id)), ...to.order.slice(index)];
    store.put(from);
    store.put(to);
    return from.order;
  });
}

export function updateGallery(db, id, change, imageChange) {
  return write(db, ['albums', 'images'], async transaction => {
    const store = transaction.objectStore('albums');
    const album = await requireAlbum(store, id);
    album.order = change(album.order);
    store.put(album);
    imageChange?.(transaction.objectStore('images'));
    return album.order;
  });
}

// Both lists and any permanent image deletions commit together.
export function updateTrash(db, id, change) {
  return write(db, ['albums', 'images'], async transaction => {
    const store = transaction.objectStore('albums');
    const album = await requireAlbum(store, id);
    const updated = change(album.order, album.trash);
    store.put({ ...album, order: updated.order, trash: updated.trash });
    const images = transaction.objectStore('images');
    for (const id of updated.purge ?? []) images.delete(id);
    return updated;
  });
}
