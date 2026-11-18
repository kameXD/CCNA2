import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

export async function verifyMarquee({ app, click, expectCount, until }) {
  await app.send("Page.bringToFront");
  await app.send('Emulation.setDeviceMetricsOverride', {width:820,height:680,deviceScaleFactor:1,mobile:false});
  await app.evalPage(`(async () => {
    const {openGallery,updateGallery}=await import('./storage.js');
    const db=await openGallery();
    const entries=Array.from({length:45},(_,i)=>({id:'img-'+(i+1),time:1,width:79,height:43}));
    const canvas=document.createElement('canvas');
    const png=await new Promise(resolve=>canvas.toBlob(resolve));
    await updateGallery(db,'general',()=>entries,images=>{
      for (const entry of entries) images.add({png,preview:png},entry.id);
    });
    db.close();
  })()`);
  await app.send('Page.reload');
  await expectCount(45);

  const toggle = () => click(app, '#selection-toggle');
  const clear = () => click(app, '#deselect-all');
  const viewTop = () => app.evalPage('window.scrollTo(0, document.querySelector("#gallery").offsetTop - 62)');
  const card = id => app.evalPage(`(() => {
    const r=document.querySelector('#gallery [data-id="img-${id}"] .thumb').getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};
  })()`);
  function mouse(type, point, modifiers = 0) {
    const buttons = type === 'mouseReleased' ? 0 : 1;
    return app.send('Input.dispatchMouseEvent',{
      type,...point,modifiers,buttons,
      button:type==='mouseMoved'?'none':'left',
      clickCount:type==='mouseMoved'?0:1
    });
  }
  async function selectCard(id, modifiers = 0) {
    const point = await card(id);
    await mouse('mousePressed',point,modifiers);
    await mouse('mouseReleased',point,modifiers);
  }
  const ranks = () => app.evalPage(`[...document.querySelectorAll('.selection-rank:not([hidden])')]
    .sort((a,b)=>Number(a.textContent)-Number(b.textContent))
    .map(badge=>Number(badge.closest('.card').dataset.id.slice(4)))`);
  const box = hidden => app.evalPage(`document.querySelector('#marquee-box').hidden === ${hidden}`);
  const scroll = () => app.evalPage('window.scrollY');
  function key(type,key,code,modifiers=0) {
    return app.send('Input.dispatchKeyEvent',{type,key,windowsVirtualKeyCode:code,modifiers});
  }

  await toggle();
  await viewTop();
  await selectCard(3);
  await selectCard(1);
  assert.deepEqual(await ranks(),[3,1],'los clics mantienen su orden');
  const first = await card(1), fifth = await card(5);
  await mouse('mousePressed',fifth);
  await mouse('mouseMoved',first);
  await until(() => box(false),'rectángulo visible');
  assert.ok(await app.evalPage(`parseFloat(getComputedStyle(document.querySelector('#marquee-box')).width)>0`));
  await mouse('mouseReleased',first);
  assert.deepEqual(await ranks(),[1,2,4,5],'arrastre inverso ordenado por filas');
  assert.ok(await box(true));
  await selectCard(3);
  assert.deepEqual(await ranks(),[1,2,4,5,3],'el clic siguiente funciona tras soltar el ratón');

  await clear();
  await selectCard(2);
  await selectCard(3);
  await mouse('mousePressed',first);
  await mouse('mouseMoved',fifth);
  await key('keyDown','Control',17,2);
  await until(async () => (await ranks()).join() === '1,3,4,5','Ctrl cambia el rectángulo sobre la marcha');
  await mouse('mouseReleased',fifth,2);
  await key('keyUp','Control',17);
  assert.deepEqual(await ranks(),[1,3,4,5],'Ctrl agrega y quita respecto a la selección inicial');

  await clear();
  await selectCard(2);
  await selectCard(8,8);
  assert.deepEqual(await ranks(),[2,3,4,5,6,7,8],'Shift + clic cubre el rango');
  await clear();
  await selectCard(2);
  const second = await card(2), eighth = await card(8);
  await mouse('mousePressed',second,8);
  await mouse('mouseMoved',eighth,8);
  await mouse('mouseReleased',eighth,8);
  assert.deepEqual(await ranks(),[2,3,4,5,6,7,8],'Shift + arrastre cubre el rango');

  await mouse('mousePressed',first);
  await mouse('mouseMoved',fifth);
  await key('keyDown','Escape',27);
  await key('keyUp','Escape',27);
  await mouse('mouseReleased',fifth);
  assert.ok(await box(true));
  assert.deepEqual(await ranks(),[2,3,4,5,6,7,8],'Escape conserva la selección previa');

  const initial = await scroll();
  const bottom = {x:second.x,y:673};
  await mouse('mousePressed',second);
  await mouse('mouseMoved',bottom);
  await until(async () => await scroll() > initial+300,'desplazamiento automático hacia abajo');
  await mouse('mouseReleased',bottom);
  assert.ok((await ranks()).some(id=>id>=11),'incluye imágenes que estaban fuera de pantalla');
  assert.ok(await box(true));
  const scrolled = await scroll();
  const inside = await app.evalPage(`(() => {
    const area = [...document.querySelectorAll('#gallery .thumb')].map(thumb=>thumb.getBoundingClientRect())
      .find(rect=>rect.top >= 160 && rect.bottom <= 570);
    return {x:area.left+area.width/2,y:area.top+area.height/2};
  })()`);
  const top = {x:inside.x,y:5};
  await mouse('mousePressed',inside);
  await mouse('mouseMoved',top);
  await until(async () => await scroll() < scrolled-170,'desplazamiento automático hacia arriba');
  await mouse('mouseReleased',top);

  const selected = await ranks();
  assert.ok(selected.length > 1);
  await app.send('Page.enable');
  const confirmation = app.nextEvent('Page.javascriptDialogOpening');
  const deleting = click(app,'#delete-selected');
  const dialog = await Promise.race([confirmation,wait(8000,{},{ref:false})]);
  assert.equal(dialog.type,'confirm');
  await app.send('Page.handleJavaScriptDialog',{accept:true});
  await deleting;
  await expectCount(45 - selected.length);
  await click(app,'#undo-delete');
  await expectCount(45);
  const restored = await app.evalPage('[...document.querySelectorAll("#gallery .card")].map(card=>Number(card.dataset.id.slice(4)))');
  assert.deepEqual(restored,Array.from({length:45},(_,i)=>i+1),'la papelera restaura el orden original');

  await toggle();
  await viewTop();
  assert.deepEqual(await ranks(),[]);
  assert.equal(await app.evalPage('document.querySelector("#gallery .card").draggable'),true);
  await app.evalPage(`(() => {
    const [target, source]=document.querySelectorAll('#gallery .card');
    const dataTransfer=new DataTransfer();
    for (const [node,type] of [[source,'dragstart'],[target,'dragover'],[target,'drop'],[source,'dragend']]) {
      node.dispatchEvent(new DragEvent(type,{dataTransfer,bubbles:true,cancelable:true}));
    }
  })()`);
  await until(() => app.evalPage('document.querySelector("#gallery .card").dataset.id === "img-2"'),
    'el arrastre vuelve a reordenar al salir del modo');
  console.log('Rectángulo, orden por filas, Ctrl, Shift, Escape, desplazamiento, papelera y reordenamiento verificados.');
}
