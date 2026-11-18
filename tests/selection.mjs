import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

export async function verifySelection({ app, click, expectCount, until }) {
  const fixture = await app.evalPage(`(async () => {
    const {openGallery, createAlbum, selectAlbum, updateGallery}=await import('./storage.js');
    const db=await openGallery();
    const destination=(await createAlbum(db,'Destino')).active.id;
    const canvas = document.createElement('canvas');
    canvas.width=79;
    canvas.height=43;
    const png=await new Promise(resolve=>canvas.toBlob(resolve));
    for (const [album, ids] of [['general','ABCDEFGH'],[destination,'XYZ']]) {
      const entries=[...ids].map(id=>({id,time:1,width:79,height:43}));
      await updateGallery(db,album,()=>entries,images=>{
        for (const entry of entries) images.add({png,preview:png},entry.id);
      });
    }
    await selectAlbum(db,'general');
    db.close();
    return {destination,original:[...new Uint8Array(await png.arrayBuffer())]};
  })()`);
  await app.send('Page.reload');
  await expectCount(8);
  await app.send('Page.enable');
  const pressed = selector => click(app, selector);
  const card = id => pressed(`#gallery [data-id="${id}"] .thumb`);
  const order = () => app.evalPage('[...document.querySelectorAll("#gallery .card")].map(card=>card.dataset.id).join("")');
  const ranks = () => app.evalPage(`Object.fromEntries([...document.querySelectorAll('#gallery .selection-rank:not([hidden])')]
    .map(rank=>[rank.closest('.card').dataset.id,Number(rank.textContent)]))`);
  const checkCount = n => app.evalPage(`document.querySelector('#selection-count').value === '${n} seleccionadas'`);
  const trash = n => until(() => app.evalPage(`document.querySelector('#trash-count').textContent === '${n}'`), 'papelera ' + n);
  async function confirm(selector, accept) {
    const pending = app.nextEvent('Page.javascriptDialogOpening');
    const clicking = pressed(selector);
    const opened = await Promise.race([pending, wait(8000, {}, {ref:false})]);
    assert.equal(opened.type, 'confirm');
    await app.send('Page.handleJavaScriptDialog',{accept});
    await clicking;
  }
  async function selectAlbum(id, title) {
    await app.evalPage(`(() => {
      const select=document.querySelector('#album-select');
      select.value=${JSON.stringify(id)};
      select.dispatchEvent(new Event('change'));
    })()`);
    await until(() => app.evalPage(`document.querySelector('#album-title').textContent === '${title}'`), title);
  }
  function placement(where, at = 1) {
    return app.evalPage(`(() => {
      const select=document.querySelector('#move-place');
      select.value='${where}';
      select.dispatchEvent(new Event('change'));
      document.querySelector('#move-position').value=${at};
    })()`);
  }
  async function persisted(expected) {
    assert.deepEqual(await app.evalPage(`(async()=>{
      const {openGallery,readAlbum}=await import('./storage.js');
      const db=await openGallery();
      const album=await readAlbum(db,${JSON.stringify(fixture.destination)});
      db.close();
      return album.order.map(item=>item.id);
    })()`), [...expected]);
  }

  await pressed('#selection-toggle');
  await card('C');
  await card('A');
  await card('E');
  assert.deepEqual(await ranks(), {C:1,A:2,E:3});
  await card('A');
  await card('B');
  assert.deepEqual(await ranks(), {C:1,E:2,B:3});
  assert.ok(await checkCount(3));
  await pressed('#select-all');
  assert.deepEqual(await ranks(), {C:1,E:2,B:3,A:4,D:5,F:6,G:7,H:8});
  await pressed('#deselect-all');
  assert.deepEqual(await ranks(), {});
  assert.ok(await checkCount(0));
  for (const id of 'CEB') await card(id);
  await pressed('#move-selected');
  await placement('position',2);
  await confirm('#move-album-confirm',false);
  assert.equal(await order(),'ABCDEFGH');
  await persisted('XYZ');
  await placement('position',99);
  await confirm('#move-album-confirm',true);
  await until(() => app.evalPage('document.querySelector("#move-error").textContent.includes("entre 1 y 4")'), 'posición inválida');
  assert.equal(await order(),'ABCDEFGH');
  await persisted('XYZ');
  await placement('position',2);
  await confirm('#move-album-confirm',true);
  await expectCount(5);
  assert.equal(await order(),'ADFGH');
  assert.ok(await checkCount(0));
  await persisted('XCEBYZ');

  for (const id of 'GD') await card(id);
  await pressed('#move-selected');
  await placement('start');
  await confirm('#move-album-confirm',true);
  await expectCount(3);
  await persisted('GDXCEBYZ');

  for (const id of 'HF') await card(id);
  await pressed('#move-selected');
  await confirm('#move-album-confirm',true);
  await expectCount(1);
  await persisted('GDXCEBYZHF');
  assert.equal(await order(),'A');
  const rejected = await app.evalPage(`(async()=>{
    const {openGallery,moveImages}=await import('./storage.js');
    const db=await openGallery();
    try {
      await moveImages(db,'general',${JSON.stringify(fixture.destination)},['A','desaparecida']);
      return false;
    } catch {
      return true;
    } finally { db.close(); }
  })()`);
  assert.ok(rejected, 'un lote con una imagen ausente se rechaza por completo');
  await persisted('GDXCEBYZHF');

  await selectAlbum(fixture.destination,'Destino');
  await expectCount(10);
  assert.equal(await order(),'GDXCEBYZHF');
  assert.equal(await app.evalPage('document.querySelector("#selection-toggle").getAttribute("aria-pressed")'),'false');
  await pressed('#selection-toggle');
  for (const id of 'HCG') await card(id);
  await confirm('#delete-selected',false);
  await expectCount(10);
  await confirm('#delete-selected',true);
  await expectCount(7);
  await trash(3);
  assert.equal(await order(),'DXEBYZF');
  await app.send('Page.reload');
  await expectCount(7);
  await trash(3);
  await pressed('#trash-open');
  await pressed('#restore-all');
  await expectCount(10);
  await trash(0);
  assert.equal(await order(),'GDXCEBYZHF');

  const audit = await app.evalPage(`(async()=>{
    const {openGallery,readAlbum,read}=await import('./storage.js');
    const db=await openGallery();
    const [a,b]=await Promise.all([readAlbum(db,'general'),readAlbum(db,${JSON.stringify(fixture.destination)})]);
    const ids=[...a.order,...b.order].map(item=>item.id);
    const binaries=await Promise.all(ids.map(async id=>[...new Uint8Array(await (await read(db,'images',id)).png.arrayBuffer())]));
    const count=await new Promise(resolve=>{
      const request=db.transaction('images').objectStore('images').count();
      request.onsuccess=()=>resolve(request.result);
    });
    db.close();
    return {ids,binaries,count};
  })()`);
  assert.deepEqual(audit.ids, [...'AGDXCEBYZHF']);
  assert.equal(new Set(audit.ids).size,11);
  assert.equal(audit.count,11);
  for (const bytes of audit.binaries) assert.deepEqual(bytes,fixture.original);
  console.log('Selección numerada, traslados en las tres posiciones, cancelaciones, papelera, restauración y 11 originales únicos verificados.');
}
