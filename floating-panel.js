const markup = `
  <main class="float">
    <header>
      <div><h1 id="panel-album-title"></h1><p id="panel-count"></p></div>
      <output id="panel-state" aria-live="polite"></output>
    </header>
    <div class="float-row">
      <button id="panel-toggle" class="primary" type="button"></button>
      <button id="panel-manual" type="button">Captura manual</button>
    </div>
    <div class="float-row">
      <label for="panel-album">Álbum</label>
      <select id="panel-album"></select>
      <button id="panel-new" type="button">Nuevo álbum</button>
    </div>
    <form id="panel-create" class="float-row" hidden>
      <label for="panel-name">Nombre</label>
      <input id="panel-name" required autocomplete="off">
      <button type="submit">Crear</button>
      <button id="panel-cancel-create" type="button">Cancelar</button>
    </form>
    <label class="float-check"><input id="panel-show-preview" type="checkbox" checked> Mostrar vista previa</label>
    <section id="panel-preview" aria-label="Capturas guardadas">
      <label class="float-check"><input id="panel-follow" type="checkbox" checked> Seguir la última captura</label>
      <div id="panel-image-box">
        <img id="panel-image" alt="" hidden>
        <p id="panel-empty">Todavía no hay capturas.</p>
      </div>
      <div class="float-nav">
        <button id="panel-prev" type="button" aria-label="Captura anterior">‹</button>
        <output id="panel-position" aria-live="polite"></output>
        <button id="panel-next" type="button" aria-label="Captura siguiente">›</button>
      </div>
      <div class="float-row">
        <button id="panel-zoom" type="button" aria-pressed="false">Ampliar</button>
        <button id="panel-delete" class="danger" type="button">Enviar a papelera</button>
      </div>
    </section>
    <button id="panel-undo" type="button" hidden>Deshacer eliminación</button>
    <p id="panel-notice" role="status" hidden></p>
    <p id="panel-warning" class="float-hint" hidden>Al compartir toda la pantalla, esta ventana puede aparecer en las capturas. Comparte la pestaña de origen para excluirla.</p>
    <p id="panel-fallback" class="float-hint" hidden>Ventana emergente. El navegador o el sistema pueden cubrirla al cambiar de ventana.</p>
  </main>`;

function mount(child, popup, actions, stateOf) {
  const doc = child.document;
  doc.title = 'SmartCapture · Panel flotante';
  doc.documentElement.lang = 'es';
  const viewport = doc.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  const css = doc.createElement('link');
  css.rel = 'stylesheet';
  css.href = new URL('./floating-panel.css', import.meta.url).href;
  doc.head.append(viewport, css);
  doc.body.innerHTML = markup;
  const elements = Object.fromEntries([...doc.querySelectorAll('[id]')].map(node => [node.id.slice(6), node]));
  elements.fallback.hidden = !popup;

  let album, id, index = -1, latest, records, choices;
  let url, imageKey, displayed;
  let frameRequest = 0;
  let zoom = false;
  let disposed = false;

  function releaseImage() {
    frameRequest++;
    imageKey = displayed = undefined;
    elements.image.removeAttribute('src');
    elements.image.hidden = true;
    if (url) URL.revokeObjectURL(url);
    url = undefined;
  }

  function preview(entry) {
    const key = entry && elements['show-preview'].checked ? `${entry.id}:${zoom}` : undefined;
    if (key === imageKey && (key || !url)) return;
    releaseImage();
    if (!key) {
      elements.empty.hidden = false;
      elements.empty.textContent = 'Todavía no hay capturas.';
      return;
    }
    imageKey = key;
    const request = frameRequest;
    elements.empty.hidden = false;
    elements.empty.textContent = 'Cargando captura…';
    actions.load(entry.id, zoom).then(blob => {
      if (disposed || request !== frameRequest) return;
      url = URL.createObjectURL(blob);
      elements.image.src = url;
      return elements.image.decode().then(() => {
        if (disposed || request !== frameRequest) return;
        displayed = entry.id;
        elements.image.hidden = false;
        elements.empty.hidden = true;
        update();
      });
    }).catch(() => {
      if (disposed || request !== frameRequest) return;
      elements.empty.textContent = 'No se pudo abrir la captura.';
    });
  }

  function update() {
    if (disposed || child.closed) return;
    const state = stateOf();
    if (records !== state.entries) {
      records = state.entries;
      latest = records.reduce((newest, entry) => !newest || entry.time >= newest.time ? entry : newest, undefined);
    }
    if (choices !== state.albums) {
      choices = state.albums;
      elements.album.replaceChildren(...choices.map(({ id, name }) => {
        const option = doc.createElement('option');
        option.value = id;
        option.textContent = name;
        return option;
      }));
    }
    if (album !== state.albumId) {
      album = state.albumId;
      id = latest?.id;
      index = -1;
      zoom = false;
    }
    if (elements.follow.checked) id = latest?.id;
    const found = records.findIndex(entry => entry.id === id);
    index = found >= 0 ? found : Math.min(Math.max(0, index), records.length - 1);
    const entry = records[index];
    id = entry?.id;
    const visible = elements['show-preview'].checked;

    elements['album-title'].textContent = state.albumName;
    elements.count.textContent = `${records.length} ${records.length === 1 ? 'imagen' : 'imágenes'}`;
    elements.state.value = state.running ? 'Capturando' : state.connected ? 'Pausado' : 'Desconectado';
    elements.toggle.textContent = state.toggleText;
    elements.toggle.disabled = state.toggleDisabled;
    elements.manual.disabled = state.manualDisabled;
    elements.album.value = album ?? '';
    elements.album.disabled = elements.new.disabled = state.albumLocked;
    elements.create.querySelector('button[type=submit]').disabled = state.albumLocked;
    elements.preview.hidden = !visible;
    elements.position.value = entry ? `Imagen ${index + 1} de ${records.length}` : '0 imágenes';
    elements.prev.disabled = index <= 0;
    elements.next.disabled = index < 0 || index >= records.length - 1;
    elements.zoom.disabled = !entry;
    elements.zoom.textContent = zoom ? 'Ajustar imagen' : 'Ampliar';
    elements.zoom.setAttribute('aria-pressed', String(zoom));
    elements['image-box'].classList.toggle('original', zoom);
    elements.image.alt = entry ? `Captura ${index + 1} · ${entry.width} × ${entry.height} px` : '';
    elements.delete.disabled = !entry || displayed !== id || state.galleryLocked;
    elements.undo.hidden = !state.canUndo;
    elements.undo.disabled = state.galleryLocked;
    elements.warning.hidden = !state.monitor;
    elements.notice.textContent = state.notice;
    elements.notice.hidden = !state.notice;
    preview(entry);
  }

  function navigate(offset) {
    const entry = records[index + offset];
    if (!entry) return;
    elements.follow.checked = false;
    id = entry.id;
    elements['image-box'].scrollTo(0, 0);
    update();
  }

  elements.toggle.onclick = actions.toggle;
  elements.manual.onclick = actions.manual;
  elements.prev.onclick = () => navigate(-1);
  elements.next.onclick = () => navigate(1);
  elements.follow.onchange = update;
  elements['show-preview'].onchange = update;
  elements.zoom.onclick = () => {
    zoom = !zoom;
    if (zoom) elements.follow.checked = false;
    elements['image-box'].scrollTo(0, 0);
    update();
  };
  elements.delete.onclick = () => actions.discard(id);
  elements.undo.onclick = actions.undo;
  elements.album.onchange = async () => {
    const next = elements.album.value;
    elements.album.value = album;
    if (next !== album) await actions.selectAlbum(next);
  };
  elements.new.onclick = () => {
    elements.create.hidden = false;
    elements.name.focus();
  };
  elements['cancel-create'].onclick = () => { elements.create.hidden = true; };
  elements.create.onsubmit = async event => {
    event.preventDefault();
    if (await actions.createAlbum(elements.name.value)) {
      elements.name.value = '';
      elements.create.hidden = true;
    }
  };

  update();
  return {
    update,
    dispose() {
      disposed = true;
      releaseImage();
    }
  };
}

export function createFloatingPanel(stateOf, actions) {
  let child, view;
  let opening = false;
  let usePopup = false;
  let leaving = false;

  window.addEventListener('pagehide', () => {
    leaving = true;
    child?.close();
  });
  window.addEventListener('pageshow', () => { leaving = false; });

  async function open() {
    if (child && !child.closed) {
      child.focus();
      return;
    }
    if (opening || leaving) return;
    view?.dispose();
    child = view = undefined;
    opening = true;
    try {
      const api = window.documentPictureInPicture;
      if (!usePopup && typeof api?.requestWindow === 'function') {
        try {
          child = await api.requestWindow({ width: 360, height: 500 });
        } catch {
          usePopup = true;
        }
      } else usePopup = true;
      if (!child && usePopup) {
        child = window.open('about:blank', 'smartcapture-panel', 'popup,width=360,height=500');
      }
      if (!child) {
        actions.notice('El panel no pudo abrirse. Permite las ventanas emergentes y pulsa «Abrir panel flotante» de nuevo.');
        return;
      }
      if (leaving) {
        child.close();
        child = undefined;
        return;
      }
      const opened = child;
      const panel = mount(opened, usePopup, actions, stateOf);
      view = panel;
      opened.addEventListener('pagehide', () => {
        panel.dispose();
        if (child === opened) {
          child = view = undefined;
        }
      }, { once: true });
      opened.focus();
    } catch (error) {
      child?.close();
      child = view = undefined;
      actions.report(error);
    } finally {
      opening = false;
    }
  }

  return { open, update: () => view?.update() };
}
