import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const profile = await mkdtemp(join(tmpdir(), 'smartcapture-test-'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const files = new Set(['index.html', 'style.css', 'app.js', 'detection.js',
  'storage.js', 'exports.js', 'sampling.js', 'sample-clock.js', 'tests/interactive.html']);
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
  return { send, evalPage };
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
  await click(app, '#share');
  await until(() => app.evalPage('document.querySelector("#toggle")?.disabled === false'), 'permiso de captura');
  await click(app, '#toggle');
  await expectCount(1);
  if (!preview) assert.ok(await app.evalPage('rawFrames > 0'), 'lectura directa de fotogramas');

  await app.send('Target.activateTarget', { targetId });
  await until(() => app.evalPage('document.hidden'), 'SmartCapture oculto');
  await click(source, '#details');
  await expectCount(2);
  await click(source, '#config');
  await expectCount(3);
  await source.evalPage('movePointer(325,221)');
  await wait(2600);
  assert.equal(await count(), 3, 'un movimiento corto del cursor debe ignorarse');
  await source.evalPage('movePointer(470,240)');
  await wait(3200);
  assert.equal(await count(), 3, 'mover solo el cursor no debe guardar una captura');
  await app.evalPage(`(async () => {
    const {openGallery, updateGallery} = await import('./storage.js');
    const db = await openGallery();
    await updateGallery(db, entries => {
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
    const {openGallery, read} = await import('./storage.js');
    const db = await openGallery();
    const entries = await read(db, 'gallery', 'order');
    const {png} = await read(db, 'images', entries.at(-1).id);
    const bitmap = await createImageBitmap(png);
    const same = bitmap.width === video.videoWidth && bitmap.height === video.videoHeight;
    bitmap.close();
    db.close();
    return png.type === 'image/png' && same;
  })()`), 'PNG a la resolución de la fuente');
  console.log(`Chromium (${preview ? 'vista previa' : 'fotogramas directos'}): botones, pestañas, cursor, duplicados visuales, segundo plano y resolución del PNG.`);
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
