import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankScroll, scrollCoverage, sideMargins, verticalShift } from '../capture-analysis.js';

function view(offset, end = 900) {
  const width = 144, height = 240;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = offset + y;
    for (let x = 0; x < width; x++) {
      const value = x < 24 || x >= width - 24 || row >= end
        ? 240 : (Math.imul(row + 19, 10940311) ^ Math.imul(x + row % 11, 31416979)) & 255;
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

test('conserva puntos intermedios en ambas direcciones con al menos 30 % de solapamiento', () => {
  const coverage = scrollCoverage();
  for (const offsets of [[0, 110, 142, 191], [410, 301, 268, 214]]) {
    const [initial, first, retained, jump] = offsets.map(offset => view(offset));
    coverage.reset(initial);
    assert.equal(coverage.observe(first), undefined);
    assert.equal(coverage.observe(retained), undefined);
    assert.equal(coverage.observe(jump), retained);
    assert.ok(Math.abs(verticalShift(retained, initial)) <= initial.height * 0.70);
    assert.equal(verticalShift(retained, initial), offsets[2] - offsets[0]);
  }
});

test('solo omite desplazamientos que revelan fondo vacío y conservan el solapamiento', () => {
  const original = view(0, 195);
  const shifted = view(38, 195);
  assert.equal(blankScroll(shifted, original), true);
  shifted.data[((shifted.height - 8) * shifted.width + 42) * 4] -= 8;
  assert.equal(blankScroll(shifted, original), false);
  assert.equal(blankScroll(view(38), view(0)), false);
});

test('recorta márgenes uniformes con reserva y conserva marcas en el borde', () => {
  const image = view(0);
  assert.deepEqual(sideMargins(image), { left: 16, right: 16 });
  image.data[(220 * image.width) * 4] -= 1;
  assert.deepEqual(sideMargins(image), { left: 0, right: 16 });
  assert.deepEqual(sideMargins(view(900)), { left: 0, right: 0 });
});
