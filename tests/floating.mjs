import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

export async function verifyFloating({ app, source, targetId, click, expectCount, until, popup }) {
  await app.send('Page.bringToFront');
  await app.evalPage(`(() => {
    if (${popup}) {
      Object.defineProperty(window, 'documentPictureInPicture', {value:undefined});
      const open = window.open;
      window.open = function (...args) { return window.testPanel = open.apply(window,args); };
    } else {
      const api = window.documentPictureInPicture;
      if (!api) throw new Error('Document Picture-in-Picture no está disponible en Chromium.');
      const request = api.requestWindow.bind(api);
      api.requestWindow = async options => window.testPanel = await request(options);
    }
  })()`);
  const panel = expression => app.evalPage(`(() => {
    const doc = window.testPanel?.document;
    return doc && (${expression});
  })()`);
  const control = name => `doc.querySelector('#panel-${name}')`;
  const press = name => panel(`${control(name)}.click()`);
  const value = name => panel(`${control(name)}?.value`);
  const state = text => until(async () => await value('state') === text, 'estado del panel: ' + text);
  const position = text => until(async () => await value('position') === text, text);
  const count = n => until(async () => await panel(`${control('count')}?.textContent`) ===
    `${n} ${n === 1 ? 'imagen' : 'imágenes'}`, 'contador del panel');
  const readyImage = () => until(() => panel(`!${control('image')}?.hidden && !${control('delete')}?.disabled`), 'vista de la imagen');

  async function openPanel() {
    await click(app, '#floating-panel');
    await until(() => panel(`!!${control('state')}`), 'apertura del panel');
    assert.equal(await panel(`${control('fallback')}.hidden`), !popup);
    await until(() => panel("doc.defaultView.getComputedStyle(doc.documentElement).colorScheme === 'dark'"), 'estilo oscuro');
  }

  async function activateSource() {
    await app.send('Target.activateTarget', { targetId });
    await until(() => source.evalPage('!document.hidden'), 'pestaña de origen visible');
    await source.evalPage('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    // Let Chromium resume the tab-capture compositor after focus changes.
    await wait(350);
  }

  await openPanel();
  await state('Desconectado');
  await count(0);
  await app.send('Page.bringToFront');
  await click(app, '#share');
  await until(() => app.evalPage('!document.querySelector("#toggle").disabled'), 'fuente de captura');
  await press('toggle');
  await state('Capturando');
  await expectCount(1);
  await position('Imagen 1 de 1');
  await readyImage();
  assert.ok(await panel(`${control('warning')}.hidden`), 'una pestaña compartida no es el monitor');
  await app.evalPage(`(() => {
    const track = document.querySelector('video').srcObject.getVideoTracks()[0];
    const settings = track.getSettings.bind(track);
    track.getSettings = () => ({...settings(), displaySurface:'monitor'});
    document.querySelector('#insert-mode').dispatchEvent(new Event('change'));
    track.getSettings = settings;
  })()`);
  assert.equal(await panel(`${control('warning')}.hidden`), false, 'aviso cuando la fuente informa que es el monitor');
  assert.ok(await panel(`${control('album')}.disabled && ${control('new')}.disabled`));
  await click(app, '#toggle');
  await state('Pausado');
  await click(app, '#toggle');
  await state('Capturando');
  await press('toggle');
  await state('Pausado');
  await press('toggle');
  await state('Capturando');
  await activateSource();
  await source.evalPage('document.querySelector("h1").textContent = "Verificación del panel · segunda captura"');
  await expectCount(2);
  await position('Imagen 2 de 2');
  await press('prev');
  await position('Imagen 1 de 2');
  assert.equal(await panel(`${control('follow')}.checked`), false);
  await source.evalPage('document.querySelector("h1").textContent = "Verificación del panel · tercera captura"');
  await expectCount(3);
  await position('Imagen 1 de 3');
  await press('zoom');
  const width = await app.evalPage('document.querySelector("video").videoWidth');
  await until(async () => await panel(`${control('image')}.naturalWidth`) === width, 'ampliación al tamaño original');
  await press('show-preview');
  assert.ok(await panel(`${control('preview')}.hidden && !${control('image')}.hasAttribute('src')`));
  await press('show-preview');
  await readyImage();
  await press('follow');
  await position('Imagen 3 de 3');
  await readyImage();

  await press('delete');
  await expectCount(2);
  await until(() => app.evalPage('document.querySelector("#trash-count").textContent === "1"'), 'papelera de la aplicación');
  await click(app, '#undo-delete');
  await expectCount(3);
  await position('Imagen 3 de 3');
  await click(app, '#gallery .card:first-child .card-footer button:last-child');
  await count(2);
  await until(() => panel(`!${control('undo')}.hidden`), 'deshacer sincronizado');
  await press('undo');
  await expectCount(3);

  await press('toggle');
  await state('Pausado');
  await press('new');
  await panel(`${control('name')}.value = 'Panel de prueba'`);
  await panel(`${control('create')}.requestSubmit()`);
  await until(() => app.evalPage('document.querySelector("#album-title").textContent === "Panel de prueba"'), 'álbum creado desde el panel');
  await count(0);
  await press('manual');
  await expectCount(1);
  await until(() => panel(`!${control('manual')}.disabled`), 'captura manual disponible');
  await press('manual');
  await until(() => panel(`${control('notice')}.textContent.includes('idéntica')`), 'captura manual duplicada detectada una vez');
  await expectCount(1);
  const newAlbum = await value('album');

  await app.evalPage(`(() => {
    const select=document.querySelector('#album-select');
    select.value='general';
    select.dispatchEvent(new Event('change'));
  })()`);
  await until(() => panel(`${control('album-title')}.textContent === 'General'`), 'álbum elegido desde la aplicación');
  await count(3);
  await panel(`(() => {
    const select=${control('album')};
    select.value=${JSON.stringify(newAlbum)};
    select.dispatchEvent(new doc.defaultView.Event('change'));
    return true;
  })()`);
  await expectCount(1);
  assert.equal(await app.evalPage('document.querySelector("#album-select").value'),newAlbum);

  await press('toggle');
  await state('Capturando');
  await app.evalPage('testPanel.close()');
  await until(() => app.evalPage('testPanel.closed'), 'panel cerrado');
  await activateSource();
  await source.evalPage('document.querySelector("h1").textContent = "La sesión continúa tras cerrar el panel"');
  await expectCount(2);
  await app.send('Page.bringToFront');
  await openPanel();
  await state('Capturando');
  await position('Imagen 2 de 2');
  await click(app, '#finish');
  await state('Desconectado');
  assert.ok(await panel(`${control('manual')}.disabled && ${control('toggle')}.disabled`));
  await count(2);

  const sizes = await app.evalPage(`(async()=>{
    const {openGallery,readAlbum,read}=await import('./storage.js');
    const {makeZip,makePdf}=await import('./exports.js');
    const db=await openGallery();
    const album=await readAlbum(db,${JSON.stringify(newAlbum)});
    const load=async id=>(await read(db,'images',id)).png;
    const zip=new DataView(await (await makeZip(album.order,load)).arrayBuffer());
    const pages=[...(await (await makePdf(album.order,load)).text()).matchAll(/\\/Subtype \\/Image \\/Width /g)].length;
    db.close();
    return [zip.getUint16(zip.byteLength-12,true),pages,album.trash.length];
  })()`);
  assert.deepEqual(sizes,[2,2,0]);
  console.log(`Panel ${popup?'emergente':'Document Picture-in-Picture'}: sincronización, revisión durante captura, papelera, álbumes, reapertura, desconexión y exportaciones verificadas.`);
}
