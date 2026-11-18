import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { inflateSync } from 'node:zlib';
import { seedLegacy, verifyAlbums } from './albums.mjs';

const profile = await mkdtemp(join(tmpdir(), 'smartcapture-test-'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const files = new Set(['index.html', 'style.css', 'app.js', 'detection.js',
  'storage.js', 'trash.js', 'exports.js', 'capture-analysis.js', 'sampling.js', 'sample-clock.js', 'tests/interactive.html']);
const server = createServer(async (req, res) => {
  const path = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!files.has(path)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(new URL('../' + path, import.meta.url));
    res.writeHead(200, { 'Content-Type': types[extname(path)] }).end(content);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const args = ['--headless=new', '--disable-dev-shm-usage',
  '--auto-select-tab-capture-source-by-title=Fuente SmartCapture',
  '--enable-usermedia-screen-capturing', '--remote-debugging-port=0',
  '--user-data-dir=' + profile, 'about:blank'];
if (process.getuid?.() === 0 || process.env.CHROMIUM_NO_SANDBOX === '1') args.unshift('--no-sandbox');
const browser = spawn(process.env.CHROMIUM || 'chromium', args, { stdio: 'ignore' });
const sockets = [];

async function until(get, description) {
  for (let i = 0; i < 120; i++) {
    const result = await get();
    if (result) return result;
    await wait(75);
  }
  throw new Error('Tiempo agotado: ' + description);
}

async function connect(url) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await once(socket, 'open');
  let seq = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const { id, result, error } = JSON.parse(data);
    const handler = pending.get(id);
    if (!handler) return;
    pending.delete(id);
    if (error) handler.reject(new Error(error.message));
    else handler.resolve(result);
  };
  function send(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evalPage(expression) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }
  function nextEvent(method) {
    return new Promise(resolve => {
      const listen = ({ data }) => {
        const response = JSON.parse(data);
        if (response.method !== method) return;
        socket.removeEventListener('message', listen);
        resolve(response.params);
      };
      socket.addEventListener('message', listen);
    });
  }
  return { send, evalPage, nextEvent };
}

try {
  const port = await until(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { return null; }
  }, 'Chromium');
  const list = async () => (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const [initialPage] = await list();
  const app = await connect(initialPage.webSocketDebuggerUrl);
  const { targetId } = await app.send('Target.createTarget', { url: origin + '/tests/interactive.html' });
  const sourcePage = (await list()).find(page => page.id === targetId);
  const source = await connect(sourcePage.webSocketDebuggerUrl);
  await until(() => source.evalPage('typeof window.movePointer === "function"'), 'fuente interactiva');
  const checkAlbums = process.argv.includes("--albums");
  if (checkAlbums) await seedLegacy(source);
  await app.send('Page.navigate', { url: origin });
  await until(() => app.evalPage('!!document.querySelector("#share")?.onclick'), 'inicio de SmartCapture');
  const preview = process.argv.includes('--preview');
  if (preview) {
    await app.evalPage('globalThis.MediaStreamTrackProcessor = undefined');
  } else {
    await app.evalPage(`(() => {
      const Processor = globalThis.MediaStreamTrackProcessor;
      if (!Processor) throw new Error('Usa --preview en Chromium sin MediaStreamTrackProcessor.');
      globalThis.rawFrames = 0;
      globalThis.MediaStreamTrackProcessor = class extends Processor {
        get readable() {
          const stream = super.readable;
          return stream.pipeThrough(new TransformStream({
            transform(frame, controller) { rawFrames++; controller.enqueue(frame); }
          }));
        }
      };
    })()`);
  }
  const click = (page, selector) => page.evalPage(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const count = () => app.evalPage('Number(document.querySelector("#count").textContent)');
  const expectCount = n => until(async () => await count() === n, `captura ${n}`);
  if (checkAlbums) await verifyAlbums({ app, click, expectCount, until });
  else await verifyExisting({ app, click, count, expectCount, source, targetId, preview });
} finally {
  for (const socket of sockets) socket.close();
  if (browser.exitCode === null && browser.signalCode === null) {
    const exited = once(browser, 'exit');
    browser.kill();
    await exited;
  }
  server.close();
  await rm(profile, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
}

async function verifyExisting({ app, click, count, expectCount, source, targetId, preview }) {
  await click(app, '#share');
  await until(() => app.evalPage('document.querySelector("#toggle")?.disabled === false'), 'permiso de captura');
  await click(app, '#toggle');
  await expectCount(1);

  await app.send('Target.activateTarget', { targetId });
  await until(() => app.evalPage('document.hidden'), 'SmartCapture oculto');
  await click(source, '#details');
  await expectCount(2);
  if (!preview) await until(() => app.evalPage('rawFrames > 0'), 'lectura directa después del primer cambio');
  await click(source, '#config');
  await expectCount(3);
  await source.evalPage('document.querySelector("#details").classList.add("hover")');
  await wait(2800);
  assert.equal(await count(), 3, 'un hover que conserva el texto debe ignorarse');
  await source.evalPage('document.querySelector("#details").classList.remove("hover")');
  await source.evalPage('movePointer(325,221)');
  await wait(2600);
  assert.equal(await count(), 3, 'un movimiento corto del cursor debe ignorarse');
  await source.evalPage('movePointer(470,240)');
  await wait(3200);
  assert.equal(await count(), 3, 'mover solo el cursor no debe guardar una captura');
  await app.evalPage(`(async () => {
    const {openGallery, updateGallery} = await import('./storage.js');
    const db = await openGallery();
    await updateGallery(db, 'general', entries => {
      delete entries[0].summary;
      return entries;
    });
    db.close();
  })()`);
  await click(source, '#topology');
  await wait(3200);
  assert.equal(await count(), 3, 'volver a la vista inicial con el cursor desplazado debe deduplicarse');
  await click(source, '#details');
  await wait(3200);
  assert.equal(await count(), 3, 'repetir el cambio localizado con otro cursor debe deduplicarse');
  await click(source, '#config');
  await click(source, '#details');
  await expectCount(4);
  assert.ok(await app.evalPage(`(async () => {
    const video = document.querySelector('video');
    const {openGallery, read, readAlbum} = await import('./storage.js');
    const db = await openGallery();
    const entries = (await readAlbum(db, 'general')).order;
    const {png} = await read(db, 'images', entries.at(-1).id);
    const bitmap = await createImageBitmap(png);
    const same = bitmap.width === video.videoWidth && bitmap.height === video.videoHeight;
    bitmap.close();
    db.close();
    return png.type === 'image/png' && same;
  })()`), 'PNG a la resolución de la fuente');
  console.log('Interacción, detección y deduplicación verificadas.');

  await source.evalPage('prepareScroll()');
  await expectCount(5);
  const height = await source.evalPage('innerHeight');
  const step = fraction => source.evalPage(`scrollTo(0,${Math.round(height * fraction / 2) * 2})`);
  for (const fraction of [0.22, 0.48, 0.68]) {
    await step(fraction);
    await wait(630);
  }
  await expectCount(6);
  await step(0.91);
  await expectCount(7);
  const shifts = await app.evalPage(`(async () => {
    const {openGallery,read,readAlbum}=await import('./storage.js');
    const {verticalShift}=await import('./capture-analysis.js');
    const db=await openGallery();
    const entries=((await readAlbum(db, 'general')).order).slice(-3);
    const frames=[];
    for (const entry of entries) {
      const {png}=await read(db,'images',entry.id);
      const bmp=await createImageBitmap(png);
      const canvas=new OffscreenCanvas(bmp.width,bmp.height);
      const ctx=canvas.getContext('2d');
      ctx.drawImage(bmp,0,0);
      bmp.close();
      frames.push(ctx.getImageData(0,0,canvas.width,canvas.height));
    }
    db.close();
    return [verticalShift(frames[1],frames[0]),verticalShift(frames[2],frames[1])];
  })()`);
  const firstScroll = Math.round(height * 0.68 / 2) * 2;
  const lastScroll = Math.round(height * 0.91 / 2) * 2;
  assert.ok(Math.abs(shifts[0] - firstScroll) <= 1 && Math.abs(shifts[1] - (lastScroll - firstScroll)) <= 1,
    'las capturas se solapan y siguen el orden real: ' + shifts.join(', '));
  console.log('Desplazamiento y solapamiento verificados.');

  await click(app, '#toggle');
  await click(app, '#auto-crop');
  await click(app, '#manual');
  await expectCount(8);
  const quality = await app.evalPage(`(async () => {
    const {openGallery,read,readAlbum}=await import('./storage.js');
    const db=await openGallery();
    const [full,cropped]=((await readAlbum(db, 'general')).order).slice(-2);
    const pngFor=async id=>(await read(db,'images',id)).png;
    const [fullBlob,cropBlob]=await Promise.all([pngFor(full.id),pngFor(cropped.id)]);
    async function raster(blob) {
      const bitmap=await createImageBitmap(blob);
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
      const ctx=canvas.getContext('2d');
      ctx.drawImage(bitmap,0,0);
      bitmap.close();
      return ctx.getImageData(0,0,canvas.width,canvas.height);
    }
    const fullFrame=await raster(fullBlob);
    const cropFrame=await raster(cropBlob);
    const {sideMargins}=await import('./capture-analysis.js');
    const {left,right}=sideMargins(fullFrame);
    const {width,height}=cropFrame;
    const nativePixels=width===fullFrame.width-left-right && height===fullFrame.height &&
      cropFrame.data.every((value,index)=>{
        const y=Math.floor(index/(width*4));
        return value===fullFrame.data[(y*fullFrame.width+left)*4+index%(width*4)];
      });
    const rgb=new Uint8Array(width*height*3);
    for(let i=0,j=0;i<cropFrame.data.length;i+=4,j+=3) rgb.set(cropFrame.data.subarray(i,i+3),j);
    globalThis.captureExports={};
    HTMLAnchorElement.prototype.click=function(){
      captureExports[this.download.split('.').at(-1)]=fetch(this.href).then(r=>r.blob()).then(blob=>encode(blob));
    };
    function encode(blob) {
      return new Promise(resolve=>{
        const reader=new FileReader();
        reader.onload=()=>resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      });
    }
    db.close();
    return {nativePixels,width,height,original:fullFrame.width,png:await encode(cropBlob),rgb:await encode(new Blob([rgb]))};
  })()`);
  assert.ok(quality.width < quality.original && quality.nativePixels, 'recorte sin remuestreo ni píxeles alterados');
  const download = async type => {
    await app.evalPage(`delete captureExports.${type}`);
    await click(app, '#' + type);
    await until(() => app.evalPage(`!!captureExports.${type}`), 'exportación ' + type);
    return Buffer.from(await app.evalPage(`captureExports.${type}`), 'base64');
  };
  const zip = await download('zip');
  let recordOffset = 0, last;
  while (zip.readUInt32LE(recordOffset) === 0x04034b50) {
    const begin = recordOffset + 30 + zip.readUInt16LE(recordOffset + 26) + zip.readUInt16LE(recordOffset + 28);
    recordOffset = begin + zip.readUInt32LE(recordOffset + 18);
    last = zip.subarray(begin, recordOffset);
  }
  assert.deepEqual(last, Buffer.from(quality.png, 'base64'), 'ZIP conserva el PNG original byte por byte');
  const pdf = await download('pdf');
  const pdfText = pdf.toString('latin1');
  const imageHeader = new RegExp('/Subtype /Image /Width '+quality.width+' /Height '+quality.height+
    ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length (\\d+) >>\\nstream\\n');
  const header = imageHeader.exec(pdfText);
  assert.ok(header, 'dimensiones nativas en PDF');
  const dataStart = header.index + header[0].length;
  assert.deepEqual(inflateSync(pdf.subarray(dataStart, dataStart + Number(header[1]))),
    Buffer.from(quality.rgb, 'base64'), 'PDF conserva el RGB píxel por píxel');
  console.log('Recorte y exportaciones verificados.');

  await app.send('Page.bringToFront');
  const first = await app.evalPage('document.querySelector(".card").dataset.id');
  await click(app, '.card:first-child [aria-label="Mover captura hacia el final"]');
  await until(async () => await app.evalPage('document.querySelectorAll(".card")[1].dataset.id') === first, 'reordenar');
  await click(app, '.card:first-child .thumb');
  const viewerAt = (n) => until(() => app.evalPage(
    `document.querySelector('#viewer').open && document.querySelector('#viewer-count').value === '${n} de 8' &&
      document.querySelector('#large').complete && document.querySelector('#large').naturalWidth > 0`), 'visor ' + n);
  await viewerAt(1);
  assert.ok(await app.evalPage(`(() => {
    const img=document.querySelector('#large');
    return Math.abs(img.clientWidth/img.clientHeight-img.naturalWidth/img.naturalHeight)<0.02;
  })()`), 'el visor mantiene la proporción original');
  const initialUrl = await app.evalPage('document.querySelector("#large").src');
  const rect = await app.evalPage('document.querySelector("#viewer-next").getBoundingClientRect().toJSON()');
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', {
      type, button: 'left', clickCount: 1, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2
    });
  }
  await viewerAt(2);
  await until(async () => await app.evalPage('document.querySelector("#large").src') !== initialUrl, 'imagen siguiente');
  const sendKey = async (key, windowsVirtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp']) await app.send('Input.dispatchKeyEvent', {type, key, windowsVirtualKeyCode});
  };
  await sendKey('ArrowLeft', 37);
  await viewerAt(1);
  await sendKey('ArrowRight', 39);
  await viewerAt(2);
  await sendKey('Escape', 27);
  await until(() => app.evalPage('!document.querySelector("#viewer").open'), 'cerrar con Escape');
  console.log('Visor verificado.');

  const galleryIds = () => app.evalPage('[...document.querySelectorAll(".card")].map(card => card.dataset.id)');
  const existing = await galleryIds();
  const fixtures = await app.evalPage(`(async () => {
    const formats = ['image/png', 'image/jpeg', 'image/webp'];
    return formats.map((type,index) => {
      const canvas = document.createElement('canvas');
      canvas.width = 71 + index;
      canvas.height = 55 + index;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = ['#e31206', '#164acc', '#17aa31'][index];
      ctx.fillRect(0,0,canvas.width,canvas.height);
      return canvas.toDataURL(type).split(',')[1];
    });
  })()`);
  const paths = ['adjunto.png', 'adjunto.jpeg', 'arrastrado.webp'].map(name => join(profile, name));
  await Promise.all(paths.map((path,index) => writeFile(path, Buffer.from(fixtures[index], 'base64'))));
  const invalid = join(profile, 'dañado.jpg');
  await writeFile(invalid, 'archivo de prueba sin imagen');
  const {root} = await app.send('DOM.getDocument');
  const {nodeId} = await app.send('DOM.querySelector', {nodeId:root.nodeId, selector:'#image-files'});
  await app.send('DOM.setFileInputFiles', {nodeId, files:[...paths.slice(0,2),invalid]});
  await expectCount(10);
  assert.match(await app.evalPage('document.querySelector("#notice").textContent'), /dañados: 1/);
  const attached = (await galleryIds()).slice(-2);
  assert.deepEqual((await galleryIds()).slice(0,8), existing);

  const insert = (mode, position) => app.evalPage(`(() => {
    const select=document.querySelector('#insert-mode');
    select.value='${mode}';
    select.dispatchEvent(new Event('change'));
    document.querySelector('#insert-position').value=${position};
  })()`);
  await insert('before', 1);
  await app.send('Browser.grantPermissions', {origin, permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  await app.evalPage(`(async()=>{
    const blob=await fetch('data:image/png;base64,${fixtures[0]}').then(r=>r.blob());
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
    document.querySelector('#insert-position').focus();
  })()`);
  for (const type of ['keyDown','keyUp']) {
    await app.send('Input.dispatchKeyEvent', {type,key:'v',code:'KeyV',modifiers:2,windowsVirtualKeyCode:86});
  }
  await expectCount(11);
  const pasted = (await galleryIds())[0];
  assert.equal((await galleryIds())[1], existing[0]);

  await insert('after', 2);
  const drop = await app.evalPage(`(() => {
    const panel = document.querySelector('#gallery-panel');
    panel.scrollIntoView({block:'start'});
    const {left,top}=panel.getBoundingClientRect();
    return {x:left+20,y:Math.max(1,top)+20};
  })()`);
  for (const type of ['dragEnter','dragOver','drop']) {
    await app.send('Input.dispatchDragEvent', {...drop,type,data:{items:[],files:[paths[2]],dragOperationsMask:1}});
  }
  await expectCount(12);
  const draggedFile = (await galleryIds())[2];
  await app.evalPage(`(() => {
    const cards = document.querySelectorAll('.card');
    const from = cards[cards.length-1], to = cards[0];
    const dataTransfer = new DataTransfer();
    for (const [node,type] of [[from,'dragstart'],[to,'dragover'],[to,'drop'],[from,'dragend']]) {
      node.dispatchEvent(new DragEvent(type,{dataTransfer,bubbles:true,cancelable:true}));
    }
  })()`);
  await until(async () => (await galleryIds())[0] === attached[1], 'reordenar con arrastre');
  await app.send('Page.enable');
  const prompt = app.nextEvent('Page.javascriptDialogOpening');
  const moveClick = click(app, '.card:first-child .card-footer button:nth-child(3)');
  assert.equal((await prompt).type, 'prompt');
  await app.send('Page.handleJavaScriptDialog', {accept:true,promptText:'4'});
  await moveClick;
  await until(async () => (await galleryIds())[3] === attached[1], 'mover a una posición');
  const ordered = [pasted,existing[0],draggedFile,attached[1],...existing.slice(1),attached[0]];
  assert.deepEqual(await galleryIds(), ordered);
  assert.deepEqual(await app.evalPage(`[...document.querySelectorAll('.card-footer span')].map(
    item => Number(item.textContent.split(' · ')[0]))`), ordered.map((_,i) => i+1));

  const mixedZip = await download('zip');
  const zipped = [];
  for (let offset = 0; mixedZip.readUInt32LE(offset) === 0x04034b50;) {
    const size = mixedZip.readUInt32LE(offset+18);
    const nameLength = mixedZip.readUInt16LE(offset+26);
    const name = mixedZip.toString('utf8',offset+30,offset+30+nameLength);
    const dataOffset = offset+30+nameLength+mixedZip.readUInt16LE(offset+28);
    zipped.push([name,mixedZip.subarray(dataOffset,dataOffset+size)]);
    offset = dataOffset+size;
  }
  assert.equal(zipped.length, ordered.length);
  for (const [id,index,extension] of [[draggedFile,2,'webp'],[attached[1],1,'jpg'],[attached[0],0,'png']]) {
    const at = ordered.indexOf(id);
    assert.equal(zipped[at][0], `captura-${String(at+1).padStart(4,'0')}.${extension}`);
    assert.deepEqual(zipped[at][1], Buffer.from(fixtures[index],'base64'));
  }
  const mixedPdf = await download('pdf');
  const pdfImages = [...mixedPdf.toString('latin1').matchAll(
    /\/Subtype \/Image \/Width (\d+) \/Height (\d+) \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g)];
  assert.equal(pdfImages.length, ordered.length);
  for (const [id,width] of [[pasted,71],[draggedFile,73],[attached[1],72],[attached[0],71]]) {
    const item = pdfImages[ordered.indexOf(id)];
    assert.equal(Number(item[1]), width);
    assert.equal(Number(item[2]), width-16);
  }
  for (const [id,index,type] of [[draggedFile,2,'webp'],[attached[1],1,'jpeg']]) {
    const item = pdfImages[ordered.indexOf(id)];
    const start = item.index + item[0].length;
    const rgb = await app.evalPage(`(async () => {
      const file = await fetch('data:image/${type};base64,${fixtures[index]}').then(r=>r.blob());
      const bmp = await createImageBitmap(file);
      const canvas = new OffscreenCanvas(bmp.width,bmp.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp,0,0);
      bmp.close();
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      return btoa(Array.from(pixels).filter((_,i)=>i%4!==3).map(channel=>String.fromCharCode(channel)).join(''));
    })()`);
    assert.deepEqual(inflateSync(mixedPdf.subarray(start,start+Number(item[3]))),Buffer.from(rgb,'base64'));
  }
  await app.send('Page.reload');
  await expectCount(12);
  assert.deepEqual(await galleryIds(), ordered, 'orden y capturas tras recargar');
  console.log('Adjuntos, Ctrl + V, soltar archivos, numeración y orden en IndexedDB, PDF y ZIP verificados.');

  const trashCount = n => until(() => app.evalPage(`document.querySelector('#trash-count').textContent === '${n}'`), 'papelera ' + n);
  const confirmAction = async (selector, accept) => {
    const opened = app.nextEvent('Page.javascriptDialogOpening');
    const clicked = click(app, selector);
    const dialog = await Promise.race([opened, wait(8000, {}, {ref: false})]);
    assert.equal(dialog.type, 'confirm');
    await app.send('Page.handleJavaScriptDialog', {accept});
    await clicked;
  };
  const viewerInfo = (position, width) => until(() => app.evalPage(`document.querySelector('#viewer').open &&
    document.querySelector('#viewer-count').value === '${position}' &&
    document.querySelector('#large').complete && document.querySelector('#large').naturalWidth === ${width} &&
    !!document.querySelector('#viewer-delete:not([hidden]):enabled, #viewer-restore:not([hidden]):enabled')`), 'imagen del visor ' + position);
  await click(app, '.card:nth-child(3) .thumb');
  await viewerInfo('3 de 12', 73);
  await click(app, '#viewer-delete');
  await viewerInfo('3 de 11', 72);
  await trashCount(1);
  assert.ok(await app.evalPage('document.querySelector("#viewer #undo-toast:not([hidden])") !== null'));
  await click(app, '#undo-delete');
  await viewerInfo('4 de 12', 72);
  assert.deepEqual(await galleryIds(), ordered);
  await sendKey('Escape',27);
  await click(app, '.card:last-child .thumb');
  await viewerInfo('12 de 12',71);
  await click(app, '#viewer-delete');
  await viewerInfo('11 de 11',quality.width);
  await sendKey('Escape',27);
  await click(app, '.card:nth-child(3) .card-footer button:last-child');
  await expectCount(10);
  await trashCount(2);

  await app.evalPage(`(() => {
    globalThis.captureExports={};
    HTMLAnchorElement.prototype.click=function(){
      captureExports[this.download.split('.').at(-1)]=fetch(this.href).then(r=>r.blob()).then(blob=>
        new Promise(resolve=>{
          const reader=new FileReader();
          reader.onload=()=>resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        }));
    };
  })()`);
  const activeZip = await download('zip');
  assert.equal(activeZip.readUInt16LE(activeZip.length-12), 10, 'ZIP excluye imágenes en la papelera');
  const activePdf = await download('pdf');
  assert.equal([...activePdf.toString('latin1').matchAll(/\/Subtype \/Image \/Width (\d+)/g)].length,10,
    'PDF excluye imágenes en la papelera');

  await app.send('Page.reload');
  await expectCount(10);
  await trashCount(2);
  await click(app, '#trash-open');
  await until(() => app.evalPage('document.querySelector("#trash-list .thumb img").naturalWidth > 0'), 'miniatura eliminada');
  await click(app, '#trash-list .card:first-child .thumb');
  await viewerInfo('1 de 2',73);
  const reviewed = await app.evalPage(`(async()=>{
    const bytes=await (await fetch(document.querySelector('#large').src)).arrayBuffer();
    return btoa(String.fromCharCode(...new Uint8Array(bytes)));
  })()`);
  assert.equal(reviewed, fixtures[2], 'la papelera conserva el archivo original importado');
  await click(app, '#viewer-restore');
  await viewerInfo('1 de 1',71);
  await sendKey('Escape',27);
  await click(app, '#restore-all');
  await expectCount(12);
  await trashCount(0);
  assert.deepEqual(await galleryIds(), ordered);
  await sendKey('Escape',27);

  await click(app, '#clear');
  await expectCount(0);
  await trashCount(12);
  await click(app, '#undo-delete');
  await expectCount(12);
  assert.deepEqual(await galleryIds(), ordered);
  await click(app, '#clear');
  await trashCount(12);
  await click(app, '#trash-open');
  await click(app, '#trash-list .card:first-child .card-footer button:first-child');
  await expectCount(1);
  await sendKey('Escape',27);
  await click(app, '#gallery .card .thumb');
  await viewerInfo('1 de 1',71);
  await click(app, '#viewer-delete');
  await until(() => app.evalPage('!document.querySelector("#viewer").open && !document.querySelector("#undo-toast").hidden'),
    'cerrar el visor al eliminar la única imagen');
  await trashCount(12);
  await click(app, '#undo-delete');
  await expectCount(1);
  assert.equal((await galleryIds())[0], ordered[0]);
  await click(app, '#gallery .card .card-footer button:last-child');
  await trashCount(12);
  await click(app, '#trash-open');
  const permanent = '#trash-list .card:first-child .card-footer button:last-child';
  await confirmAction(permanent, false);
  await trashCount(12);
  await confirmAction(permanent, true);
  await trashCount(11);
  await confirmAction('#empty-trash',false);
  await trashCount(11);
  await confirmAction('#empty-trash',true);
  await trashCount(0);
  await app.send('Page.reload');
  await until(() => app.evalPage('!document.querySelector("#empty")?.hidden'), 'galería vacía después de recargar');
  assert.equal(await count(),0);
  await trashCount(0);
  assert.equal(await app.evalPage(`(async()=>{
    const {openGallery}=await import('./storage.js');
    const db=await openGallery();
    return new Promise(resolve => {
      const read=db.transaction('images').objectStore('images').count();
      read.onsuccess=()=>{db.close();resolve(read.result);};
    });
  })()`),0,'vaciar la papelera elimina los originales de IndexedDB');
  console.log(`Chromium (${preview ? 'vista previa' : 'fotogramas directos'}): papelera, visor, deshacer, restauración, persistencia, exclusión de exportaciones y confirmación definitiva verificados.`);
}
