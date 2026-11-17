import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changed, sensitivityLevels, stabilityDetector, visualSummary } from '../detection.js';

const high = sensitivityLevels[3];
function frame() {
  const width = 144, height = 96;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([70, 75, 80, 255], i);
  return { width, height, data };
}
function paint(image, x, y, rgb) {
  image.data.set(rgb, (y * image.width + x) * 4);
}
function cursor(image, left, top) {
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x <= Math.floor(y * 0.72); x++) {
      const edge = x === 0 || x >= Math.floor(y * 0.72) - 1 || y === 23;
      const color = edge ? 255 : 0;
      paint(image, left + x, top + y, [color, color, color]);
    }
  }
  return image;
}

test('texto localizado de bajo contraste en el límite entre regiones', () => {
  const original = frame(), edited = frame();
  for (const y of [15, 16]) {
    for (const x of [14, 15, 16, 17]) paint(edited, x, y, [75, 80, 85]);
  }
  assert.equal(changed(edited, original, high), true);
  assert.equal(changed(edited, original, sensitivityLevels[0]), false);
});

test('detecta cambios globales y tolera ruido mínimo', () => {
  const original = frame(), edited = frame();
  for (let i = 0; i < edited.data.length; i += 4) edited.data[i]++;
  assert.equal(changed(edited, original, high), false);
  for (let i = 0; i < edited.data.length; i += 4) edited.data[i] += 20;
  assert.equal(changed(edited, original, high), true);
  assert.equal(visualSummary(edited).length, 48);
});

test('filtra movimientos cortos y largos del cursor sin perder otra edición', () => {
  const original = cursor(frame(), 12, 14);
  const nearby = cursor(frame(), 17, 15);
  const distant = cursor(frame(), 90, 45);
  assert.equal(changed(nearby, original, high), false);
  assert.equal(changed(distant, original, high), false);
  assert.equal(changed(original, distant, high), false);
  for (let x = 11; x < 20; x++) paint(distant, x, 77, [75, 80, 85]);
  assert.equal(changed(distant, original, high), true);
});

test('el cursor no reinicia la espera de una vista estable', () => {
  const detector = stabilityDetector();
  const initial = cursor(frame(), 12, 14);
  const next = cursor(frame(), 90, 45);
  assert.equal(detector.observe(initial, 0, high, 1000), false);
  assert.equal(detector.observe(next, 400, high, 1000), false);
  assert.equal(detector.observe(initial, 990, high, 1000), false);
  assert.equal(detector.observe(next, 1000, high, 1000), true);
  detector.accept(next);
  assert.equal(detector.observe(initial, 2000, high, 1000), false);
});
