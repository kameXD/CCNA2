import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

export function seedLegacy(page) {
  return page.evalPage(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 61;
    canvas.height = 40;
    const png = await new Promise(resolve => canvas.toBlob(resolve));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('smartcapture', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const gallery = db.createObjectStore('gallery');
        const images = db.createObjectStore('images');
        const make = id => ({id,time:1,width:61,height:40});
        gallery.put([make('old-first'),make('old-last')], 'order');
        gallery.put([{entry:make('old-deleted'),index:1,previous:'old-first',next:'old-last'}], 'trash');
        for (const id of ['old-first','old-deleted','old-last']) images.put({png,preview:png},id);
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(true); };
    });
  })()`);
}

export async function verifyAlbums({ app, click, expectCount, until }) {
  const name = () => app.evalPage('document.querySelector("#album-title").textContent');
  const ids = () => app.evalPage('[...document.querySelectorAll("#gallery .card")].map(card=>card.dataset.id)');
  const trash = n => until(() => app.evalPage(`document.querySelector('#trash-count').textContent === '${n}'`), 'papelera ' + n);
  const active = value => until(async () => await name() === value, 'álbum ' + value);
  const select = value => app.evalPage(`(() => {
    const select = document.querySelector('#album-select');
    select.value = [...select.options].find(o=>o.textContent===${JSON.stringify(value)}).value;
    select.dispatchEvent(new Event('change'));
  })()`);
  await app.send('Page.enable');
  async function dialog(selector, type, options) {
    const pending = app.nextEvent('Page.javascriptDialogOpening');
    const clicking = click(app, selector);
    const opened = await Promise.race([pending, wait(8000, {}, {ref:false})]);
    assert.equal(opened.type, type);
    await app.send('Page.handleJavaScriptDialog', options);
    await clicking;
  }

  await active('General');
  await expectCount(2);
  await trash(1);
  assert.deepEqual(await ids(), ['old-first','old-last']);
  await dialog('#album-add','prompt',{accept:true,promptText:'Redes'});
  await active('Redes');
  await expectCount(0);
  await trash(0);
  await dialog('#album-rename','prompt',{accept:true,promptText:'Prácticas'});
  await active('Prácticas');
  await click(app, '#share');
  await until(() => app.evalPage('document.querySelector("#toggle").disabled === false'), 'fuente de captura');
  await click(app, '#toggle');
  await expectCount(1);
  assert.equal(await app.evalPage('document.querySelector("#album-select").disabled'), true);
  await select('General');
  assert.equal(await name(),'Prácticas');
  const captured = (await ids())[0];
  await click(app, '#toggle');
  await until(() => app.evalPage('!document.querySelector("#album-select").disabled'), 'selector tras pausar');
  await select('General');
  await active('General');
  await trash(1);
  assert.deepEqual(await ids(), ['old-first','old-last']);

  await click(app, '#trash-open');
  await click(app, '#restore-all');
  await expectCount(3);
  assert.deepEqual(await ids(), ['old-first','old-deleted','old-last']);
  await click(app, '#trash-dialog form button');
  await click(app, '#gallery .card:nth-child(2) .card-footer button:last-child');
  await trash(1);
  await click(app, '#gallery .card:first-child .card-footer button:nth-child(4)');
  await click(app, '#move-album-confirm');
  await expectCount(1);
  assert.deepEqual(await ids(), ['old-last']);

  await select('Prácticas');
  await active('Prácticas');
  await expectCount(2);
  await trash(0);
  assert.deepEqual(await ids(), [captured,'old-first']);
  await app.send('Page.reload');
  await until(() => app.evalPage('!document.querySelector("#album-select").disabled'), 'reinicio de álbum');
  await active('Prácticas');
  assert.deepEqual(await ids(), [captured,'old-first']);
  await app.send('Page.enable');

  await app.evalPage(`(() => {
    globalThis.filesExported = {};
    HTMLAnchorElement.prototype.click = function () {
      filesExported[this.download.split('.').at(-1)] = fetch(this.href).then(r=>r.arrayBuffer()).then(buffer=>{
        const data = new Uint8Array(buffer);
        let binary = '';
        for (let i=0;i<data.length;i+=4096) binary += String.fromCharCode(...data.subarray(i,i+4096));
        return btoa(binary);
      });
    };
  })()`);
  async function exportAlbum(count) {
    for (const type of ['pdf','zip']) {
      await app.evalPage(`delete filesExported.${type}`);
      await click(app, '#' + type);
      await until(() => app.evalPage(`!!filesExported.${type}`), 'exportación ' + type);
      const buffer = Buffer.from(await app.evalPage(`filesExported.${type}`), 'base64');
      if (type === 'zip') assert.equal(buffer.readUInt16LE(buffer.length-12),count);
      else assert.equal([...buffer.toString('latin1').matchAll(/\/Subtype \/Image \/Width /g)].length,count);
      await until(() => app.evalPage('!document.querySelector("#album-select").disabled'), 'fin de exportación');
    }
  }
  await exportAlbum(2);
  await select('General');
  await active('General');
  await exportAlbum(1);
  await trash(1);
  await dialog('#album-delete','confirm',{accept:false});
  await expectCount(1);
  await trash(1);
  await dialog('#album-delete','confirm',{accept:true});
  await active('Prácticas');
  await expectCount(2);
  assert.deepEqual(await ids(), [captured,'old-first']);
  assert.deepEqual(await app.evalPage(`(async()=>{
    const {read,openGallery}=await import('./storage.js');
    const db=await openGallery();
    const copies=await Promise.all(['old-first','old-last','old-deleted'].map(id=>read(db,'images',id)));
    db.close();
    return copies.map(Boolean);
  })()`), [true,false,false]);
  await dialog('#album-delete','confirm',{accept:true});
  await active('General');
  await expectCount(0);
  await trash(0);
  await app.send('Page.reload');
  await until(() => app.evalPage('!document.querySelector("#album-select").disabled'), 'último álbum persistente');
  assert.deepEqual(await ids(), []);
  assert.equal(await name(),'General');
  console.log('Migración v1, captura bloqueada, traslado, exportación, papeleras y persistencia de álbumes verificadas.');
}
