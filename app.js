import { changed, sensitivityLevels, stabilityDetector, visualSummary } from './detection.js';
import { startSampling } from './sampling.js';
import { openGallery, read, updateGallery } from './storage.js';
import { makePdf, makeZip } from './exports.js';

const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
const { video, stage, surface, selection, gallery, viewer, large } = elements;
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
const detector = stabilityDetector();
const duplicateSensitivity = [2, 2, 10];
const sampleMs = 250;
let db, stream, region, dragStart, draftRegion, dragId, viewerUrl;
let entries = [];
let mode = 'idle';
let sharing = false;
let picking = false;
let busy = false;
let exporting = false;
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

function refreshControls() {
  const active = !!stream;
  elements.share.disabled = active || sharing || !navigator.mediaDevices?.getDisplayMedia;
  elements.region.disabled = !active;
  elements.reset.disabled = !active || (!region && !picking);
  elements.toggle.disabled = !active || !db || picking;
  elements.manual.disabled = !active || !db || picking || busy;
  elements.finish.disabled = !active;
  elements.toggle.textContent = {
    idle: 'Iniciar captura', running: 'Pausar captura', paused: 'Reanudar captura'
  }[mode];
  elements.region.textContent = picking ? 'Cancelar selección' : 'Seleccionar región';
  elements.status.textContent = active ? {
    idle: 'Fuente compartida', running: 'Captura activa', paused: 'Captura pausada'
  }[mode] : 'Sin fuente';
  elements.pdf.disabled = elements.zip.disabled = !entries.length || exporting;
}

function resetDetection() {
  generation++;
  detector.reset();
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
  }
  context.drawImage(raw ?? video, x, y, w, h, 0, 0, w, h);
  return context.getImageData(0, 0, w, h);
}

async function tick(raw) {
  if (busy) return;
  try {
    const pixels = frame(raw);
    const sensitivity = sensitivityLevels[elements.sensitivity.value - 1];
    if (pixels && detector.observe(pixels, performance.now(), sensitivity, delay() * 1000)) {
      await save(pixels, generation);
    } else if (!pixels) detector.reset();
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

async function findVisualDuplicate(pixels, summary, token) {
  const { width, height } = pixels;
  const galleryOrder = await read(db, 'gallery', 'order') ?? [];
  let ctx;
  for (let index = galleryOrder.length - 1; index >= 0; index--) {
    const entry = galleryOrder[index];
    if (token !== generation) break;
    if (entry.width !== width || entry.height !== height ||
        entry.summary?.some((value, index) => Math.abs(value - summary[index]) > 12)) continue;
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

async function save(pixels, token, manual = false) {
  const time = Date.now();
  busy = true;
  refreshControls();
  try {
    const { width, height, data } = pixels;
    const digest = await crypto.subtle.digest('SHA-256', data);
    const hash = `${width}x${height}:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
    if (!manual && token !== generation) return;
    const summary = visualSummary(pixels);
    const visualMatch = !manual && !entries.some(entry => entry.hash === hash)
      ? await findVisualDuplicate(pixels, summary, token) : undefined;
    if (!manual && token !== generation) return;
    let duplicate = entries.some(entry => entry.hash === hash);
    if (visualMatch) {
      const current = await read(db, 'gallery', 'order') ?? [];
      duplicate ||= current.some(entry => entry.id === visualMatch);
    }
    if (!manual && token !== generation) return;
    if (!duplicate) {
      const thumb = document.createElement('canvas');
      const scale = Math.min(1, 320 / width, 200 / height);
      thumb.width = Math.max(1, Math.round(width * scale));
      thumb.height = Math.max(1, Math.round(height * scale));
      thumb.getContext('2d', { alpha: false }).drawImage(canvas, 0, 0, thumb.width, thumb.height);
      const [png, preview] = await Promise.all([encode(canvas, 'image/png'), encode(thumb, 'image/jpeg', 0.8)]);
      if (!manual && token !== generation) return;
      const entry = { id: crypto.randomUUID(), time, width, height, hash, summary };
      entries = await updateGallery(db, list => {
        duplicate = list.some(item => item.hash === hash);
        return duplicate ? list : [...list, entry];
      }, store => { if (!duplicate) store.add({ png, preview }, entry.id); });
      render();
    }
    if (token === generation) {
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
const thumbnailObserver = new IntersectionObserver(items => {
  for (const item of items) {
    const card = cards.get(item.target.dataset.id);
    if (!card) continue;
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
  const preview = button('', () => enlarge(entry).catch(report));
  preview.className = 'thumb';
  preview.setAttribute('aria-label', 'Ampliar captura');
  preview.append(img);
  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const caption = document.createElement('span');
  const controls = document.createElement('div');
  const earlier = button('←', () => moveRelative(entry.id, -1));
  earlier.setAttribute('aria-label', 'Mover captura hacia el inicio');
  const later = button('→', () => moveRelative(entry.id, 1));
  later.setAttribute('aria-label', 'Mover captura hacia el final');
  const remove = button('Eliminar', () => edit(list => list.filter(item => item.id !== entry.id),
    store => store.delete(entry.id)));
  controls.append(earlier, later, remove);
  footer.append(caption, controls);
  node.append(preview, footer);
  node.ondragstart = event => {
    if (exporting) { event.preventDefault(); return; }
    dragId = entry.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragId);
  };
  img.draggable = false;
  node.ondragover = event => {
    if (dragId && dragId !== entry.id) {
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
    if (!dragId || dragId === entry.id) return;
    event.preventDefault();
    node.classList.remove('drop');
    const moved = dragId;
    dragId = undefined;
    edit(list => reorder(list, moved, list.findIndex(item => item.id === entry.id)));
  };
  const card = { node, img, caption, earlier, later, remove };
  thumbnailObserver.observe(node);
  return card;
}

const dateFormat = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'medium' });

function render() {
  const ids = new Set(entries.map(entry => entry.id));
  for (const [id, card] of cards) {
    if (ids.has(id)) continue;
    card.visible = false;
    releaseThumbnail(card);
    thumbnailObserver.unobserve(card.node);
    card.node.remove();
    cards.delete(id);
  }
  entries.forEach((entry, index) => {
    if (!cards.has(entry.id)) cards.set(entry.id, makeCard(entry));
    const card = cards.get(entry.id);
    card.caption.textContent = `${index + 1} · ${dateFormat.format(entry.time)}`;
    card.caption.title = `${entry.width} × ${entry.height} px`;
    card.earlier.disabled = exporting || index === 0;
    card.later.disabled = exporting || index === entries.length - 1;
    card.remove.disabled = exporting;
    if (gallery.children[index] !== card.node) gallery.insertBefore(card.node, gallery.children[index] ?? null);
  });
  elements.count.textContent = entries.length;
  elements.empty.hidden = entries.length > 0;
  refreshControls();
}

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

async function edit(change, imageChange) {
  if (exporting) return;
  try {
    entries = await updateGallery(db, change, imageChange);
    render();
  } catch (error) { report(error); }
}

async function loadPng(id) {
  const image = await read(db, 'images', id);
  if (!image) throw new Error('Una captura ya no está disponible.');
  return image.png;
}

async function enlarge(entry) {
  const png = await loadPng(entry.id);
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(png);
  large.src = viewerUrl;
  large.alt = `Captura del ${dateFormat.format(entry.time)}`;
  elements['viewer-title'].textContent = `Captura · ${entry.width} × ${entry.height} px`;
  if (!viewer.open) viewer.showModal();
}

elements.zoom.onclick = () => {
  const original = viewer.classList.toggle('original');
  elements.zoom.setAttribute('aria-pressed', String(original));
  elements.zoom.textContent = original ? 'Ajustar a la ventana' : 'Tamaño original';
};

viewer.addEventListener('close', () => {
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
    const selected = await read(db, 'gallery', 'order');
    if (!selected?.length) throw new Error('La galería está vacía.');
    const file = await build(selected, loadPng);
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

refreshControls();
try {
  db = await openGallery();
  entries = await read(db, 'gallery', 'order') ?? [];
  render();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    notice('Abre SmartCapture en Chrome o Brave desde HTTPS o localhost para compartir pantalla.');
  }
} catch (error) { db = undefined; report(error); }
