import { changed, sensitivityLevels, stabilityDetector, visualSummary } from './detection.js';
import { scrollCoverage, sideMargins } from './capture-analysis.js';
import { startSampling } from './sampling.js';
import {
  openGallery, read, readAlbum, readAlbumState, selectAlbum, createAlbum, renameAlbum,
  deleteAlbum, moveImages, updateGallery, updateTrash
} from './storage.js';
import { moveToTrash, restoreOrder } from './trash.js';
import { makePdf, makeZip } from './exports.js';
import { attachMarquee } from './marquee.js';

const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
const { video, stage, surface, selection, gallery, viewer, large } = elements;
const trashDialog = elements['trash-dialog'];
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
const detector = stabilityDetector();
const coverage = scrollCoverage();
const duplicateSensitivity = [1, 2, 8];
const sampleMs = 250;
let db, stream, region, dragStart, draftRegion, dragId, viewerUrl;
let entries = [];
let trash = [];
let albums = [];
let albumId;
let changingAlbum = false;
let pendingMove;
let selectionMode = false;
let selectionAnchor;
const selectedIds = new Set();
let mode = 'idle';
let sharing = false;
let picking = false;
let busy = false;
let exporting = false;
let clearing = false;
let importing = false;
let managingTrash = false;
let undoIds = [];
let undoTimer;
let clearVersion = 0;
let viewerId;
let displayedId;
let viewerInTrash = false;
let viewerRequest = 0;
let generation = 0;
let stopSampling;

function notice(message) {
  elements.notice.textContent = message;
}

function report(error) {
  notice(error.name === 'QuotaExceededError'
    ? 'El almacenamiento está lleno. Exporta y elimina algunas capturas para continuar.'
    : error.message || 'Ocurrió un error inesperado.');
}

function galleryLocked() {
  return exporting || clearing || importing || managingTrash || changingAlbum;
}

function albumSwitchLocked() {
  return !db || mode === 'running' || busy || galleryLocked();
}

function refreshControls() {
  const active = !!stream;
  elements.share.disabled = active || sharing || !navigator.mediaDevices?.getDisplayMedia;
  elements.region.disabled = !active;
  elements.reset.disabled = !active || (!region && !picking);
  elements.toggle.disabled = !active || !db || picking || clearing || changingAlbum;
  elements.manual.disabled = !active || !db || picking || busy || clearing || changingAlbum;
  elements.finish.disabled = !active;
  elements.toggle.textContent = {
    idle: 'Iniciar captura', running: 'Pausar captura', paused: 'Reanudar captura'
  }[mode];
  elements.region.textContent = picking ? 'Cancelar selección' : 'Seleccionar región';
  elements.status.textContent = active ? {
    idle: 'Fuente compartida', running: 'Captura activa', paused: 'Captura pausada'
  }[mode] : 'Sin fuente';
  const locked = galleryLocked();
  const switchLocked = albumSwitchLocked();
  for (const id of ['album-select', 'album-add', 'album-rename', 'album-delete']) {
    elements[id].disabled = switchLocked;
  }
  elements['album-lock'].hidden = mode !== 'running';
  elements.pdf.disabled = elements.zip.disabled = elements.clear.disabled = !entries.length || locked;
  elements.attach.disabled = !db || locked;
  elements['trash-open'].disabled = !db || locked;
  elements['insert-mode'].disabled = !entries.length || locked;
  const position = elements['insert-position'];
  position.hidden = !entries.length || elements['insert-mode'].value === 'end';
  position.disabled = position.hidden || locked;
  position.max = entries.length;
}

function resetDetection() {
  generation++;
  detector.reset();
  coverage.reset();
}

function setMode(next) {
  mode = next;
  stopSampling?.();
  stopSampling = undefined;
  resetDetection();
  if (mode === 'running' && !picking && stream) {
    stopSampling = startSampling(stream.getVideoTracks()[0], sampleMs, tick);
  }
  refreshControls();
}

function fitPreview() {
  if (!video.videoWidth) return;
  const scale = Math.min((stage.clientWidth - 24) / video.videoWidth,
    (stage.clientHeight - 24) / video.videoHeight);
  surface.style.width = `${video.videoWidth * scale}px`;
  surface.style.height = `${video.videoHeight * scale}px`;
}

function drawSelection() {
  const box = draftRegion ?? region;
  selection.hidden = !box;
  if (!box) return;
  selection.style.left = `${box.x * 100}%`;
  selection.style.top = `${box.y * 100}%`;
  selection.style.width = `${box.w * 100}%`;
  selection.style.height = `${box.h * 100}%`;
}

function setPicking(enabled) {
  picking = enabled;
  dragStart = draftRegion = undefined;
  surface.classList.toggle('picking', picking);
  drawSelection();
  setMode(mode);
}

function point(event) {
  const bounds = surface.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
  };
}

surface.addEventListener('pointerdown', event => {
  if (!picking || event.button !== 0 || dragStart) return;
  dragStart = { ...point(event), id: event.pointerId };
  surface.setPointerCapture(event.pointerId);
});
surface.addEventListener('pointermove', event => {
  if (event.pointerId !== dragStart?.id) return;
  const { x, y } = point(event);
  draftRegion = {
    x: Math.min(x, dragStart.x), y: Math.min(y, dragStart.y),
    w: Math.abs(x - dragStart.x), h: Math.abs(y - dragStart.y)
  };
  drawSelection();
});
surface.addEventListener('pointerup', event => {
  if (event.pointerId !== dragStart?.id) return;
  if (!draftRegion || draftRegion.w * video.videoWidth < 2 || draftRegion.h * video.videoHeight < 2) {
    dragStart = draftRegion = undefined;
    drawSelection();
    notice('Arrastra sobre la vista previa para marcar una región.');
    return;
  }
  region = draftRegion;
  setPicking(false);
  notice('Región seleccionada.');
});
surface.addEventListener('pointercancel', event => {
  if (event.pointerId === dragStart?.id) setPicking(false);
});

new ResizeObserver(fitPreview).observe(stage);
video.addEventListener('resize', () => {
  fitPreview();
  resetDetection();
});

function finish() {
  const previous = stream;
  stream = undefined;
  previous?.getTracks().forEach(track => track.stop());
  video.srcObject = null;
  surface.hidden = true;
  elements.placeholder.hidden = false;
  region = undefined;
  mode = 'idle';
  setPicking(false);
  if (!busy) canvas.width = canvas.height = 1;
}

elements.share.onclick = async () => {
  sharing = true;
  refreshControls();
  try {
    const incoming = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 7680 }, height: { ideal: 4320 }, frameRate: { ideal: 15 }, cursor: 'never' },
      audio: false
    });
    stream = incoming;
    const track = incoming.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      if (stream !== incoming) return;
      finish();
      notice('El navegador dejó de compartir la fuente.');
    }, { once: true });
    track.addEventListener('mute', resetDetection);
    track.addEventListener('unmute', resetDetection);
    video.srcObject = incoming;
    await video.play();
    if (stream !== incoming) return;
    surface.hidden = false;
    elements.placeholder.hidden = true;
    fitPreview();
    notice('Puedes seleccionar una región o iniciar la captura.');
  } catch (error) {
    finish();
    if (error.name === 'NotAllowedError') notice('Se canceló la selección o el navegador denegó el permiso.');
    else report(error);
  } finally {
    sharing = false;
    refreshControls();
  }
};

elements.region.onclick = () => {
  setPicking(!picking);
  notice(picking ? 'Arrastra sobre la vista previa para marcar una región.' : 'Selección cancelada.');
};
elements.reset.onclick = () => {
  region = undefined;
  setPicking(false);
  notice('Se usará la imagen completa.');
};
elements.toggle.onclick = () => {
  setMode(mode === 'running' ? 'paused' : 'running');
  notice(mode === 'running' ? 'Esperando contenido estable…' : 'Captura automática pausada.');
};
elements.finish.onclick = () => {
  finish();
  notice('Captura finalizada. Las imágenes siguen disponibles en la galería.');
};
elements.manual.onclick = async () => {
  try {
    const pixels = frame();
    if (!pixels) { notice('La fuente todavía no entrega una imagen.'); return; }
    await save(pixels, generation, true);
  } catch (error) { report(error); }
};

elements.sensitivity.oninput = () => {
  elements['sensitivity-value'].value = ['Mínima', 'Baja', 'Media', 'Alta', 'Máxima'][elements.sensitivity.value - 1];
  resetDetection();
};
function delay() {
  return Math.max(0.25, Math.min(30, elements.delay.valueAsNumber || 1));
}
elements.delay.onchange = () => {
  elements.delay.value = delay();
  resetDetection();
};

function frame(raw) {
  const track = stream?.getVideoTracks()[0];
  const width = raw?.displayWidth ?? video.videoWidth;
  const height = raw?.displayHeight ?? video.videoHeight;
  if (!track || track.muted || track.readyState !== 'live' ||
      (!raw && video.readyState < 2) || !width || !height) return;
  const box = region ?? { x: 0, y: 0, w: 1, h: 1 };
  const x = Math.min(width - 1, Math.floor(box.x * width));
  const y = Math.min(height - 1, Math.floor(box.y * height));
  const w = Math.max(1, Math.min(width, Math.ceil((box.x + box.w) * width)) - x);
  const h = Math.max(1, Math.min(height, Math.ceil((box.y + box.h) * height)) - y);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    detector.reset();
    coverage.reset();
  }
  context.drawImage(raw ?? video, x, y, w, h, 0, 0, w, h);
  return context.getImageData(0, 0, w, h);
}

async function tick(raw) {
  if (busy || clearing) return;
  try {
    const pixels = frame(raw);
    const sensitivity = sensitivityLevels[elements.sensitivity.value - 1];
    if (!pixels) {
      detector.reset();
      coverage.reset();
      return;
    }
    const stable = detector.observe(pixels, performance.now(), sensitivity, delay() * 1000);
    const checkpoint = detector.moved() ? coverage.observe(pixels) : undefined;
    if (checkpoint) await save(checkpoint, generation, false, checkpoint !== pixels);
    else if (stable && !coverage.redundant(pixels)) await save(pixels, generation);
  } catch (error) {
    if (mode === 'running') setMode('paused');
    report(error);
  }
}

function encode(target, type, quality) {
  return new Promise((resolve, reject) => target.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error('No se pudo codificar la captura.'));
  }, type, quality));
}

async function findVisualDuplicate(pixels, summary, token, galleryOrder) {
  const { width, height } = pixels;
  let examined = 0;
  let ctx;
  for (const entry of galleryOrder.sort((a, b) => b.time - a.time)) {
    if (token !== generation) break;
    if (entry.width !== width || entry.height !== height ||
        entry.summary?.some((value, index) => Math.abs(value - summary[index]) > 12)) continue;
    if (++examined > 16) break;
    const image = await read(db, 'images', entry.id);
    if (!image) continue;
    if (!ctx) {
      const comparison = document.createElement('canvas');
      comparison.width = width;
      comparison.height = height;
      ctx = comparison.getContext('2d', { alpha: false, willReadFrequently: true });
    }
    const bitmap = await createImageBitmap(image.png);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    if (!changed(pixels, ctx.getImageData(0, 0, width, height), duplicateSensitivity)) return entry.id;
  }
}

async function save(pixels, token, manual = false, retained = false) {
  const time = Date.now();
  const targetAlbum = albumId;
  const version = clearVersion;
  const cancelled = () => version !== clearVersion || (!manual && token !== generation);
  busy = true;
  refreshControls();
  try {
    const { left, right } = elements['auto-crop'].checked ? sideMargins(pixels) : { left: 0, right: 0 };
    const cropped = left || right;
    const width = pixels.width - left - right;
    const { height } = pixels;
    // A retained scroll checkpoint may differ from the sample currently on the canvas.
    if (retained) context.putImageData(pixels, 0, 0);
    let output = canvas;
    if (cropped) {
      output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      output.getContext('2d', { alpha: false }).drawImage(canvas, left, 0, width, height, 0, 0, width, height);
    }
    const croppedPixels = cropped ? output.getContext('2d').getImageData(0, 0, width, height) : pixels;
    const { data } = croppedPixels;
    const digest = await crypto.subtle.digest('SHA-256', data);
    const hash = `${width}x${height}:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
    if (cancelled()) return;
    const current = (await readAlbum(db, targetAlbum)).order.filter(entry => !entry.imported);
    let duplicate = current.some(entry => entry.hash === hash);
    let summary;
    if (!duplicate) {
      summary = visualSummary(croppedPixels);
      if (!manual && current.length) {
        const match = await findVisualDuplicate(croppedPixels, summary, token, current);
        if (match) {
          const updated = (await readAlbum(db, targetAlbum)).order;
          duplicate = updated.some(entry => entry.id === match);
        }
      }
    }
    if (cancelled()) return;
    if (!duplicate) {
      const thumb = document.createElement('canvas');
      const scale = Math.min(1, 320 / width, 200 / height);
      thumb.width = Math.max(1, Math.round(width * scale));
      thumb.height = Math.max(1, Math.round(height * scale));
      thumb.getContext('2d', { alpha: false }).drawImage(output, 0, 0, thumb.width, thumb.height);
      const [png, preview] = await Promise.all([encode(output, 'image/png'), encode(thumb, 'image/jpeg', 0.8)]);
      if (cancelled()) return;
      const entry = { id: crypto.randomUUID(), time, width, height, hash, summary };
      entries = await updateGallery(db, targetAlbum, list => {
        duplicate = list.some(item => item.hash === hash);
        return duplicate ? list : [...list, entry];
      }, store => { if (!duplicate) store.add({ png, preview }, entry.id); });
      render();
    }
    if (token === generation) {
      coverage.reset(pixels);
      if (!manual) detector.accept(pixels);
      else detector.reset();
    }
    if (!duplicate) notice(manual ? 'Captura manual guardada.' : 'Captura automática guardada.');
    else if (manual) notice('La imagen es idéntica a una captura de la galería.');
  } finally {
    busy = false;
    if (!stream) canvas.width = canvas.height = 1;
    refreshControls();
  }
}

const cards = new Map();
const trashCards = new Map();
const thumbnailObserver = new IntersectionObserver(items => {
  for (const item of items) {
    const card = (item.target.parentElement === elements['trash-list'] ? trashCards : cards).get(item.target.dataset.id);
    if (card?.node !== item.target) continue;
    card.visible = item.isIntersecting;
    if (card.visible) loadThumbnail(card).catch(report);
    else releaseThumbnail(card);
  }
}, { rootMargin: '160px' });

function releaseThumbnail(card) {
  if (!card.url) return;
  card.img.removeAttribute('src');
  URL.revokeObjectURL(card.url);
  card.url = undefined;
}

async function loadThumbnail(card) {
  if (card.url || card.loading) return;
  card.loading = true;
  try {
    const image = await read(db, 'images', card.node.dataset.id);
    if (image && card.visible) {
      card.url = URL.createObjectURL(image.preview);
      card.img.src = card.url;
    }
  } finally {
    card.loading = false;
  }
}

function button(label, click) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.onclick = click;
  return node;
}

function makeCard(entry) {
  const node = document.createElement('li');
  node.className = 'card';
  node.dataset.id = entry.id;
  node.draggable = true;
  const img = document.createElement('img');
  img.alt = '';
  const preview = button('', event => {
    if (!selectionMode) {
      enlarge(entry).catch(report);
    } else if (!galleryLocked()) {
      if (event.shiftKey) {
        const range = selectionRange(entry.id);
        replaceSelection(event.ctrlKey ? new Set([...selectedIds, ...range]) : range);
        selectionAnchor ??= entry.id;
      } else {
        if (!selectedIds.delete(entry.id)) selectedIds.add(entry.id);
        selectionAnchor = entry.id;
        renderSelection();
      }
    }
  });
  preview.className = 'thumb';
  preview.setAttribute('aria-label', 'Ampliar captura');
  const rank = document.createElement('span');
  rank.className = 'selection-rank';
  rank.hidden = true;
  rank.setAttribute('aria-hidden', 'true');
  preview.append(img, rank);
  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const caption = document.createElement('span');
  const controls = document.createElement('div');
  const earlier = button('←', () => moveRelative(entry.id, -1));
  earlier.setAttribute('aria-label', 'Mover captura hacia el inicio');
  const later = button('→', () => moveRelative(entry.id, 1));
  later.setAttribute('aria-label', 'Mover captura hacia el final');
  const move = button('Mover a…', () => moveToPosition(entry.id));
  const remove = button('Eliminar', () => discard([entry.id]));
  const transfer = button('Mover a álbum…', () => openMoveAlbum([entry.id]));
  controls.append(earlier, later, move, transfer, remove);
  footer.append(caption, controls);
  node.append(preview, footer);
  node.ondragstart = event => {
    if (galleryLocked() || selectionMode) { event.preventDefault(); return; }
    dragId = entry.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragId);
  };
  img.draggable = false;
  node.ondragover = event => {
    if (!hasFiles(event) && dragId && dragId !== entry.id) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      node.classList.add('drop');
    }
  };
  node.ondragleave = event => {
    if (!node.contains(event.relatedTarget)) node.classList.remove('drop');
  };
  node.ondragend = () => {
    dragId = undefined;
    gallery.querySelectorAll('.drop').forEach(element => element.classList.remove('drop'));
  };
  node.ondrop = event => {
    if (hasFiles(event) || !dragId || dragId === entry.id) return;
    event.preventDefault();
    node.classList.remove('drop');
    const moved = dragId;
    dragId = undefined;
    edit(list => reorder(list, moved, list.findIndex(item => item.id === entry.id)));
  };
  const card = { node, img, caption, earlier, later, move, remove, transfer, preview, rank };
  thumbnailObserver.observe(node);
  return card;
}

const dateFormat = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'medium' });

function removeStaleCards(collection, ids) {
  for (const [id, card] of collection) {
    if (ids.has(id)) continue;
    card.visible = false;
    releaseThumbnail(card);
    thumbnailObserver.unobserve(card.node);
    card.node.remove();
    collection.delete(id);
  }
}

function render() {
  removeStaleCards(cards, new Set(entries.map(entry => entry.id)));
  const locked = galleryLocked();
  entries.forEach((entry, index) => {
    if (!cards.has(entry.id)) cards.set(entry.id, makeCard(entry));
    const card = cards.get(entry.id);
    card.caption.textContent = `${index + 1} · ${dateFormat.format(entry.time)}`;
    card.caption.title = `${entry.width} × ${entry.height} px`;
    card.earlier.disabled = locked || index === 0;
    card.later.disabled = locked || index === entries.length - 1;
    card.move.disabled = locked || entries.length < 2;
    card.remove.disabled = locked;
    card.transfer.hidden = albums.length < 2;
    card.transfer.disabled = locked;
    if (gallery.children[index] !== card.node) gallery.insertBefore(card.node, gallery.children[index] ?? null);
  });
  elements.count.textContent = entries.length;
  elements.empty.hidden = entries.length > 0;
  renderSelection();
  renderTrash();
  updateViewerPosition();
  refreshControls();
}

function renderSelection() {
  if (!cards.has(selectionAnchor)) selectionAnchor = undefined;
  for (const id of selectedIds) {
    if (!cards.has(id)) selectedIds.delete(id);
  }
  const ranks = new Map([...selectedIds].map((id, index) => [id, index + 1]));
  const locked = galleryLocked();
  for (const [id, card] of cards) {
    const rank = ranks.get(id);
    card.node.classList.toggle('selected', !!rank);
    card.node.draggable = !selectionMode;
    card.rank.hidden = !rank;
    card.rank.textContent = rank ?? '';
    if (selectionMode) {
      card.preview.setAttribute('aria-pressed', String(!!rank));
      card.preview.setAttribute('aria-label', rank
        ? `Deseleccionar imagen · selección ${rank}` : 'Seleccionar imagen');
    } else {
      card.preview.removeAttribute('aria-pressed');
      card.preview.setAttribute('aria-label', 'Ampliar captura');
    }
  }
  elements['selection-toggle'].setAttribute('aria-pressed', String(selectionMode));
  elements['selection-toggle'].disabled = !db || locked;
  elements['selection-actions'].hidden = !selectionMode;
  elements['selection-count'].value = `${selectedIds.size} seleccionadas`;
  elements['select-all'].disabled = locked || selectedIds.size === entries.length;
  elements['deselect-all'].disabled = elements['delete-selected'].disabled = locked || !selectedIds.size;
  elements['move-selected'].disabled = elements['delete-selected'].disabled || albums.length < 2;
}

function replaceSelection(ids) {
  const previous = [...selectedIds];
  const next = [...ids];
  if (previous.length === next.length && next.every((id, index) => id === previous[index])) return;
  selectedIds.clear();
  for (const id of next) selectedIds.add(id);
  renderSelection();
}

function selectionRange(id, fallback) {
  const ordered = entries.map(entry => entry.id);
  const end = ordered.indexOf(id);
  const start = ordered.indexOf(selectionAnchor ?? fallback);
  if (end < 0) return [];
  if (start < 0) return [id];
  return ordered.slice(Math.min(start, end), Math.max(start, end) + 1);
}

attachMarquee(gallery, elements['marquee-box'], {
  enabled: () => selectionMode && !galleryLocked(),
  getSelected: () => selectedIds,
  replace: replaceSelection,
  rangeTo: selectionRange,
  setAnchor: id => { selectionAnchor = id; }
});

elements['selection-toggle'].onclick = () => {
  if (galleryLocked()) return;
  selectionMode = !selectionMode;
  if (!selectionMode) {
    selectedIds.clear();
    selectionAnchor = undefined;
  }
  renderSelection();
};
elements['select-all'].onclick = () => {
  if (galleryLocked()) return;
  for (const entry of entries) selectedIds.add(entry.id);
  renderSelection();
};
elements['deselect-all'].onclick = () => {
  if (galleryLocked()) return;
  selectedIds.clear();
  selectionAnchor = undefined;
  renderSelection();
};
elements['move-selected'].onclick = () => openMoveAlbum([...selectedIds], true);
elements['delete-selected'].onclick = () => {
  const ids = [...selectedIds];
  if (!galleryLocked() && ids.length && confirm(`¿Enviar ${ids.length} imágenes seleccionadas a la papelera?`)) {
    discard(ids, true);
  }
};

function reorder(list, id, target) {
  const from = list.findIndex(entry => entry.id === id);
  if (from < 0 || target < 0 || target >= list.length || from === target) return list;
  const [item] = list.splice(from, 1);
  list.splice(target, 0, item);
  return list;
}

function moveRelative(id, offset) {
  edit(list => {
    const index = list.findIndex(entry => entry.id === id);
    return index < 0 ? list : reorder(list, id, index + offset);
  });
}

function moveToPosition(id) {
  const value = prompt(`Indica la posición de destino (1–${entries.length}).`,
    entries.findIndex(entry => entry.id === id) + 1);
  if (value === null) return;
  const target = Number(value);
  if (!Number.isInteger(target) || target < 1 || target > entries.length) {
    notice('Introduce un número de posición válido.');
    return;
  }
  edit(list => reorder(list, id, target - 1));
}

async function edit(change) {
  if (galleryLocked()) return;
  const source = albumId;
  try {
    const order = await updateGallery(db, source, change);
    if (albumId === source) {
      entries = order;
      render();
    }
  } catch (error) { report(error); }
}

async function imageType(file) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
  const header = String.fromCharCode(...bytes);
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'image/webp';
  throw new Error('Formato de imagen incompatible.');
}

async function prepareImport(file) {
  const type = await imageType(file);
  const original = file.type === type ? file : file.slice(0, file.size, type);
  const bitmap = await createImageBitmap(original);
  const { width, height } = bitmap;
  const thumb = document.createElement('canvas');
  const scale = Math.min(1, 320 / width, 200 / height);
  thumb.width = Math.max(1, Math.round(width * scale));
  thumb.height = Math.max(1, Math.round(height * scale));
  try {
    thumb.getContext('2d').drawImage(bitmap, 0, 0, thumb.width, thumb.height);
  } finally { bitmap.close(); }
  const preview = await encode(thumb, 'image/png');
  return { entry: { id: crypto.randomUUID(), time: Date.now(), width, height, imported: true },
    image: { original, preview } };
}

async function importImages(files) {
  if (!files.length || !db || galleryLocked()) return;
  const position = elements['insert-position'];
  const mode = position.hidden ? 'end' : elements['insert-mode'].value;
  if (mode !== 'end' && !position.checkValidity()) {
    notice('Introduce un número de imagen válido para la inserción.');
    position.focus();
    return;
  }
  const anchor = entries[position.valueAsNumber - 1]?.id;
  importing = true;
  render();
  try {
    const prepared = [];
    for (const file of files) {
      try { prepared.push(await prepareImport(file)); }
      catch { /* An incompatible file does not prevent importing the rest. */ }
    }
    if (!prepared.length) {
      notice('No se pudieron abrir las imágenes. Usa PNG, JPG, JPEG o WEBP válidos.');
      return;
    }
    let missingAnchor = false;
    entries = await updateGallery(db, albumId, list => {
      const index = mode === 'end' ? -1 : list.findIndex(entry => entry.id === anchor);
      missingAnchor = mode !== 'end' && index < 0;
      const at = index < 0 ? list.length : index + (mode === 'after' ? 1 : 0);
      return [...list.slice(0, at), ...prepared.map(item => item.entry), ...list.slice(at)];
    }, store => {
      for (const item of prepared) store.add(item.image, item.entry.id);
    });
    const rejected = files.length - prepared.length;
    notice(`Imágenes importadas: ${prepared.length}.` +
      (rejected ? ` Archivos incompatibles o dañados: ${rejected}.` : '') +
      (missingAnchor ? ' La imagen de referencia ya no existe. Se añadieron al final.' : ''));
  } catch (error) { report(error); }
  finally { importing = false; render(); }
}

elements['insert-mode'].onchange = refreshControls;
elements.attach.onclick = () => elements['image-files'].click();
elements['image-files'].onchange = () => {
  const input = elements['image-files'];
  const files = [...input.files];
  input.value = '';
  importImages(files);
};

function hasFiles(event) {
  return event.dataTransfer?.types.includes('Files');
}

const galleryPanel = elements['gallery-panel'];
galleryPanel.ondragover = event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = elements.attach.disabled ? 'none' : 'copy';
  galleryPanel.classList.toggle('file-drop', !elements.attach.disabled);
};
galleryPanel.ondragleave = event => {
  if (!(event.relatedTarget instanceof Node) || !galleryPanel.contains(event.relatedTarget)) {
    galleryPanel.classList.remove('file-drop');
  }
};
galleryPanel.ondrop = event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  galleryPanel.classList.remove('file-drop');
  importImages([...event.dataTransfer.files]);
};
document.addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  importImages(files);
});

async function changeTrash(change) {
  managingTrash = true;
  refreshControls();
  updateViewerPosition();
  renderTrash();
  try {
    const result = await updateTrash(db, albumId, change);
    entries = result.order;
    trash = result.trash;
    if (undoIds.length && !trash.some(record => undoIds.includes(record.entry.id))) hideUndo();
    return result;
  } catch (error) { report(error); }
  finally { managingTrash = false; render(); }
}

function placeUndo() {
  const toast = elements['undo-toast'];
  const parent = viewer.open ? viewer : trashDialog.open ? trashDialog : document.body;
  if (toast.parentElement !== parent) parent.append(toast);
}

function hideUndo() {
  clearTimeout(undoTimer);
  undoIds = [];
  elements['undo-toast'].hidden = true;
}

function showUndo(ids) {
  if (!ids.length) return;
  hideUndo();
  undoIds = ids;
  placeUndo();
  elements['undo-message'].textContent = ids.length === 1
    ? 'Imagen enviada a la papelera.' : `${ids.length} imágenes enviadas a la papelera.`;
  elements['undo-toast'].hidden = false;
  undoTimer = setTimeout(hideUndo, 10000);
}

function followViewer(id, index, fromTrash) {
  if (!viewer.open || viewerId !== id || viewerInTrash !== fromTrash) return;
  const current = viewerEntries();
  if (current.some(entry => entry.id === id)) return;
  const next = current[Math.min(index, current.length - 1)];
  if (next) enlarge(next, fromTrash).catch(report);
  else viewer.close();
}

async function discard(ids, requireAll = false) {
  if (!db || galleryLocked()) return;
  const id = viewerId;
  const index = entries.findIndex(entry => entry.id === id);
  const all = ids === undefined;
  if (all) {
    clearing = true;
    clearVersion++;
    if (mode === 'running') setMode('paused');
  }
  try {
    const result = await changeTrash((order, deleted) => {
      const updated = moveToTrash(order, deleted, ids ?? order.map(entry => entry.id));
      if (requireAll && updated.moved.length !== ids.length) {
        throw new Error('El borrado no se realizó. Alguna imagen ya no está disponible.');
      }
      return updated;
    });
    if (!result?.moved.length) return;
    followViewer(id, index, false);
    showUndo(result.moved);
  } finally {
    if (all) {
      clearing = false;
      render();
    }
  }
}

async function recover(ids) {
  if (!db || galleryLocked()) return;
  const id = viewerId;
  const index = trash.findIndex(record => record.entry.id === id);
  const result = await changeTrash((order, deleted) => {
    const selected = new Set(ids ?? deleted.map(record => record.entry.id));
    return {
      order: restoreOrder(order, deleted, selected),
      trash: deleted.filter(record => !selected.has(record.entry.id))
    };
  });
  if (result) followViewer(id, index, true);
}

async function purge(ids) {
  if (!db || galleryLocked() || !trash.length) return;
  const message = ids ? '¿Eliminar esta imagen definitivamente?' : '¿Vaciar la papelera definitivamente?';
  if (!confirm(message)) return;
  const selected = ids && new Set(ids);
  await changeTrash((order, deleted) => ({
    order,
    trash: selected ? deleted.filter(record => !selected.has(record.entry.id)) : [],
    purge: deleted.map(record => record.entry.id).filter(id => !selected || selected.has(id))
  }));
}

function renderTrash() {
  elements['trash-count'].textContent = trash.length;
  const locked = galleryLocked();
  elements['undo-delete'].disabled = locked;
  if (!trashDialog.open) return;
  elements['trash-empty'].hidden = trash.length > 0;
  elements['restore-all'].disabled = elements['empty-trash'].disabled = locked || !trash.length;
  removeStaleCards(trashCards, new Set(trash.map(record => record.entry.id)));
  const list = elements['trash-list'];
  trash.forEach(({ entry }, index) => {
    if (!trashCards.has(entry.id)) {
      const node = document.createElement('li');
      node.className = 'card';
      node.dataset.id = entry.id;
      const preview = button('', () => enlarge(entry, true).catch(report));
      preview.className = 'thumb';
      preview.setAttribute('aria-label', 'Ampliar imagen eliminada');
      const img = document.createElement('img');
      img.alt = '';
      preview.append(img);
      const footer = document.createElement('div');
      footer.className = 'card-footer';
      const restore = button('Restaurar', () => recover([entry.id]));
      const remove = button('Eliminar definitivamente', () => purge([entry.id]));
      remove.className = 'danger';
      footer.append(restore, remove);
      node.append(preview, footer);
      thumbnailObserver.observe(node);
      trashCards.set(entry.id, { node, img, restore, remove });
    }
    const card = trashCards.get(entry.id);
    card.restore.disabled = card.remove.disabled = locked;
    if (list.children[index] !== card.node) list.insertBefore(card.node, list.children[index] ?? null);
  });
}

elements.clear.onclick = () => discard();
elements['undo-delete'].onclick = () => recover(undoIds);
elements['trash-open'].onclick = () => {
  trashDialog.showModal();
  placeUndo();
  renderTrash();
};
trashDialog.addEventListener('close', () => {
  if (trashDialog.open) return;
  removeStaleCards(trashCards, new Set());
  placeUndo();
});
elements['restore-all'].onclick = () => recover();
elements['empty-trash'].onclick = () => purge();

function viewerEntries() {
  return viewerInTrash ? trash.map(record => record.entry) : entries;
}

async function loadImage(id) {
  const image = await read(db, 'images', id);
  if (!image) throw new Error('Una captura ya no está disponible.');
  return image.original ?? image.png;
}

function updateViewerPosition() {
  const list = viewerEntries();
  const index = list.findIndex(entry => entry.id === viewerId);
  elements['viewer-count'].value = index < 0 ? '' : `${index + 1} de ${list.length}`;
  elements['viewer-prev'].disabled = managingTrash || index <= 0;
  elements['viewer-next'].disabled = managingTrash || index < 0 || index === list.length - 1;
  elements['viewer-delete'].hidden = viewerInTrash;
  elements['viewer-restore'].hidden = !viewerInTrash;
  elements['viewer-delete'].disabled = elements['viewer-restore'].disabled =
    galleryLocked() || index < 0 || displayedId !== viewerId;
  return index;
}

async function enlarge(entry, fromTrash = false) {
  if (!viewer.open) viewer.showModal();
  placeUndo();
  const request = ++viewerRequest;
  viewerId = entry.id;
  displayedId = undefined;
  viewerInTrash = fromTrash;
  updateViewerPosition();
  const image = await loadImage(entry.id);
  if (!viewer.open || request !== viewerRequest) return;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(image);
  large.src = viewerUrl;
  large.alt = `Captura del ${dateFormat.format(entry.time)}`;
  elements['viewer-title'].textContent = `Captura · ${entry.width} × ${entry.height} px`;
  large.parentElement.scrollTo(0, 0);
  try {
    await large.decode();
  } catch (error) {
    if (!viewer.open || request !== viewerRequest) return;
    throw error;
  }
  if (viewer.open && request === viewerRequest) {
    displayedId = entry.id;
    updateViewerPosition();
  }
}

function navigateViewer(direction) {
  if (managingTrash) return;
  const index = updateViewerPosition();
  const entry = index < 0 ? undefined : viewerEntries()[index + direction];
  if (entry) enlarge(entry, viewerInTrash).catch(report);
}

elements['viewer-delete'].onclick = () => discard([viewerId]);
elements['viewer-restore'].onclick = () => recover([viewerId]);
elements['viewer-prev'].onclick = () => navigateViewer(-1);
elements['viewer-next'].onclick = () => navigateViewer(1);
viewer.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  navigateViewer(event.key === 'ArrowLeft' ? -1 : 1);
});

elements.zoom.onclick = () => {
  const original = viewer.classList.toggle('original');
  elements.zoom.setAttribute('aria-pressed', String(original));
  elements.zoom.textContent = original ? 'Ajustar a la ventana' : 'Tamaño original';
};

viewer.addEventListener('close', () => {
  if (viewer.open) return;
  viewerRequest++;
  viewerId = undefined;
  displayedId = undefined;
  viewerInTrash = false;
  placeUndo();
  if (viewer.classList.contains('original')) elements.zoom.click();
  large.removeAttribute('src');
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = undefined;
});

async function download(type, build) {
  exporting = true;
  render();
  notice(`Preparando ${type.toUpperCase()}…`);
  try {
    const selected = (await readAlbum(db, albumId)).order;
    if (!selected?.length) throw new Error('La galería está vacía.');
    const file = await build(selected, loadImage);
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `smartcapture-${new Date().toISOString().slice(0, 10)}.${type}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    notice(`Descarga de ${type.toUpperCase()} solicitada.`);
  } catch (error) { report(error); }
  finally { exporting = false; render(); }
}

elements.pdf.onclick = () => download('pdf', makePdf);
elements.zip.onclick = () => download('zip', makeZip);

function albumOptions(select, choices) {
  select.replaceChildren(...choices.map(album => new Option(album.name, album.id)));
}

function applyAlbumState({ active, albums: known }) {
  if (active.id !== albumId) {
    hideUndo();
    selectedIds.clear();
    selectionAnchor = undefined;
    selectionMode = false;
    resetDetection();
  }
  albums = known;
  albumId = active.id;
  entries = active.order;
  trash = active.trash;
  albumOptions(elements['album-select'], albums);
  elements['album-select'].value = albumId;
  elements['album-title'].textContent = active.name;
  render();
}

async function manageAlbum(action) {
  if (albumSwitchLocked()) return;
  changingAlbum = true;
  refreshControls();
  try {
    applyAlbumState(await action());
  } catch (error) {
    elements['album-select'].value = albumId;
    report(error);
  } finally {
    changingAlbum = false;
    render();
  }
}

elements['album-select'].onchange = event => {
  const destination = event.target.value;
  event.target.value = albumId;
  if (destination !== albumId) manageAlbum(() => selectAlbum(db, destination));
};
elements['album-add'].onclick = () => {
  const name = prompt('Nombre del nuevo álbum')?.trim();
  if (name) manageAlbum(() => createAlbum(db, name));
};
elements['album-rename'].onclick = () => {
  const id = albumId;
  const previous = albums.find(album => album.id === id).name;
  const name = prompt('Nuevo nombre del álbum', previous)?.trim();
  if (name && name !== previous) manageAlbum(() => renameAlbum(db, id, name));
};
elements['album-delete'].onclick = () => {
  if (albumSwitchLocked()) return;
  const id = albumId;
  const name = albums.find(album => album.id === id).name;
  if (confirm(`¿Eliminar el álbum «${name}» y todas sus imágenes, incluidas las de su papelera? Esta acción no se puede deshacer.`)) {
    manageAlbum(() => deleteAlbum(db, id));
  }
};

const moveDialog = elements['move-album-dialog'];
function openMoveAlbum(ids, batch = false) {
  if (galleryLocked() || albums.length < 2 || !ids.length) return;
  pendingMove = { ids, batch };
  albumOptions(elements['move-album-target'], albums.filter(album => album.id !== albumId));
  elements['move-placement'].hidden = !batch;
  elements['move-place'].value = 'end';
  elements['move-position'].value = 1;
  elements['move-album-title'].textContent = batch ? `Mover ${ids.length} imágenes a otro álbum` : 'Mover imagen a otro álbum';
  elements['move-album-confirm'].textContent = batch ? 'Mover seleccionadas' : 'Mover imagen';
  elements['move-error'].textContent = '';
  updateMovePlacement();
  moveDialog.showModal();
}
function updateMovePlacement() {
  const input = elements['move-position'];
  input.hidden = input.disabled = elements['move-place'].value !== 'position';
}
elements['move-place'].onchange = updateMovePlacement;
elements['move-album-cancel'].onclick = () => moveDialog.close();
moveDialog.addEventListener('close', () => {
  if (!moveDialog.open) pendingMove = undefined;
});
elements['move-album-form'].onsubmit = async event => {
  event.preventDefault();
  if (galleryLocked() || !pendingMove) return;
  const destination = elements['move-album-target'].value;
  const { ids, batch } = pendingMove;
  const where = elements['move-place'].value;
  const placement = where === 'start' ? 1 : where === 'position' ? elements['move-position'].valueAsNumber : 'end';
  const name = elements['move-album-target'].selectedOptions[0].textContent;
  if (batch && !confirm(`¿Mover ${ids.length} imágenes seleccionadas a «${name}»?`)) return;
  changingAlbum = true;
  elements['move-album-confirm'].disabled = true;
  render();
  try {
    entries = await moveImages(db, albumId, destination, ids, placement);
    moveDialog.close();
    notice(batch ? `${ids.length} imágenes movidas al álbum de destino.` : 'Imagen movida al álbum de destino.');
  } catch (error) {
    elements['move-error'].textContent = error.message;
  } finally {
    changingAlbum = false;
    elements['move-album-confirm'].disabled = false;
    render();
  }
};

refreshControls();
try {
  db = await openGallery();
  applyAlbumState(await readAlbumState(db));
  if (!navigator.mediaDevices?.getDisplayMedia) {
    notice('Abre SmartCapture en Chrome o Brave desde HTTPS o localhost para compartir pantalla.');
  }
} catch (error) { db = undefined; report(error); }
