const tileSize = 16;
const pointerSize = 64;
const pointerBudget = pointerSize * pointerSize;
const decorationBudget = 12000;

// [RGB noise floor, minimum regional pixels, minimum regional contrast].
export const sensitivityLevels = [
  [18, 12, 180], [12, 8, 120], [7, 5, 65], [2, 3, 22], [0, 2, 8]
];

function contrast(a, b) {
  return Math.max(Math.abs((a & 255) - (b & 255)),
    Math.abs(((a >>> 8) & 255) - ((b >>> 8) & 255)),
    Math.abs(((a >>> 16) & 255) - ((b >>> 16) & 255)));
}

function bounds(points, width) {
  let left = Infinity, top = Infinity, right = -1, bottom = -1;
  for (const point of points) {
    const x = point % width;
    const y = Math.floor(point / width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function separatedClusters(points, width, axis) {
  const get = axis === 'x' ? point => point % width : point => Math.floor(point / width);
  const positions = [...new Set(points.map(get))].sort((a, b) => a - b);
  let split = -1;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] - positions[i - 1] < 3) continue;
    if (split !== -1) return;
    split = positions[i];
  }
  if (split === -1) return;
  return [points.filter(point => get(point) < split), points.filter(point => get(point) >= split)];
}

function pointerTone(pixel) {
  if (pixel === undefined) return 0;
  const luminance = ((pixel & 255) + ((pixel >>> 8) & 255) + ((pixel >>> 16) & 255)) / 3;
  return luminance < 32 ? 1 : luminance > 200 ? 2 : 0;
}

function overlappingPointer(points, width, before, after) {
  const area = bounds(points, width);
  if (area.width > pointerSize || area.height > pointerSize) return false;
  const oldShape = [], newShape = [];
  for (let y = area.top; y < area.top + area.height; y++) {
    for (let x = area.left; x < area.left + area.width; x++) {
      const point = y * width + x;
      if (pointerTone(before[point])) oldShape.push(point);
      if (pointerTone(after[point])) newShape.push(point);
    }
  }
  if (Math.min(oldShape.length, newShape.length) < 24) return false;
  const a = bounds(oldShape, width);
  const b = bounds(newShape, width);
  const dx = b.left - a.left;
  const dy = b.top - a.top;
  if ((!dx && !dy) || Math.abs(dx) > 16 || Math.abs(dy) > 16 ||
      Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2) return false;
  const shift = dx + dy * width;
  const targets = new Set(newShape);
  let dark = 0, light = 0;
  for (const point of oldShape) {
    const target = point + shift;
    if (!targets.has(target) || contrast(before[point], after[target]) > 18) continue;
    if (pointerTone(before[point]) === 1) dark++;
    else light++;
  }
  if (dark < 4 || light < 4 || dark + light < Math.max(oldShape.length, newShape.length) * 0.92) return false;
  // Video encoding and antialiasing can change pixels just outside the outline.
  return points.every(point => {
    const x = point % width;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = Math.max(-4, -x); dx <= Math.min(4, width - 1 - x); dx++) {
        const neighbor = point + dy * width + dx;
        if (pointerTone(before[neighbor]) || pointerTone(after[neighbor])) return true;
      }
    }
    return false;
  });
}

// Require two translated, compact patches with a matching dark/light foreground.
// A small monochrome glyph or an isolated change never qualifies as a pointer move.
function pointerMoved(points, width, before, after) {
  if (points.length < 24) return false;
  for (const axis of ['x', 'y']) {
    const clusters = separatedClusters(points, width, axis);
    if (!clusters) continue;
    const [first, second] = clusters;
    if (Math.min(first.length, second.length) < Math.max(first.length, second.length) * 0.8) continue;
    const a = bounds(first, width);
    const b = bounds(second, width);
    if (a.width > pointerSize || a.height > pointerSize ||
        Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2) continue;
    const shift = b.left - a.left + (b.top - a.top) * width;
    const targets = new Set(second);
    let matched = 0, dark = 0, light = 0, reverse = 0, reverseDark = 0, reverseLight = 0;
    for (const point of first) {
      const target = point + shift;
      if (!targets.has(target)) continue;
      // One frame contains the pointer in the first patch and the other in the second.
      const departing = contrast(before[point], after[target]);
      const arriving = contrast(after[point], before[target]);
      if (departing <= 18 && arriving <= 35) {
        const tone = pointerTone(before[point]);
        dark += Number(tone === 1);
        light += Number(tone === 2);
        matched++;
      }
      if (arriving <= 18 && departing <= 35) {
        const tone = pointerTone(after[point]);
        reverseDark += Number(tone === 1);
        reverseLight += Number(tone === 2);
        reverse++;
      }
    }
    const minimum = Math.max(first.length, second.length) * 0.84;
    if ((matched >= minimum && dark >= 4 && light >= 4) ||
        (reverse >= minimum && reverseDark >= 4 && reverseLight >= 4)) return true;
  }
  return overlappingPointer(points, width, before, after);
}

function scrollbarMoved(area, width, height, before, after) {
  if (area.width > 18 || area.height < 20 ||
      (area.left >= 18 && area.left + area.width <= width - 18)) return false;
  // A track must have the same background at both ends, and exactly one
  // contiguous thumb of the same color and length in each image.
  function thumb(pixels, x, track) {
    let start = -1, end = -1, color;
    if (contrast(pixels[(height - 1) * width + x], track) > 3) return;
    for (let y = 1; y < height - 1; y++) {
      const pixel = pixels[y * width + x];
      if (contrast(pixel, track) <= 3) continue;
      if (start < 0) {
        start = y;
        color = pixel;
      } else if (y !== end + 1 || contrast(pixel, color) > 4) return;
      end = y;
    }
    if (end - start >= 11 && contrast(color, track) >= 8) return { start, end, color };
  }
  let shift;
  for (let x = area.left; x < area.left + area.width; x++) {
    const track = before[x];
    if (contrast(track, after[x]) > 3) return false;
    const old = thumb(before, x, track);
    const next = thumb(after, x, track);
    if (!old || !next || contrast(old.color, next.color) > 3 ||
        Math.abs((old.end - old.start) - (next.end - next.start)) > 1) return false;
    const offset = next.start - old.start;
    if (!offset || (shift !== undefined && Math.abs(shift - offset) > 1)) return false;
    shift = offset;
  }
  return true;
}

function flatHover(points, area, width, before, after) {
  if (area.width < 24 || area.width > 180 || area.height < 14 || area.height > 56 ||
      points.length < area.width * area.height * 0.50) return false;
  const colors = new Map();
  let base, fill, most = 0;
  for (const point of points) {
    const key = (before[point] & 0xffffff) * 0x1000000 + (after[point] & 0xffffff);
    const frequency = (colors.get(key) ?? 0) + 1;
    colors.set(key, frequency);
    if (frequency > most) {
      most = frequency;
      base = before[point];
      fill = after[point];
    }
  }
  const channels = [0, 8, 16];
  const deltas = channels.map(shift => ((fill >>> shift) & 255) - ((base >>> shift) & 255));
  const prominent = deltas.reduce((a, b) => Math.abs(a) > Math.abs(b) ? a : b);
  if (Math.abs(prominent) < 5 || Math.abs(prominent) > 30 ||
      Math.max(...deltas) - Math.min(...deltas) > 5) return false;

  let filled = 0;
  for (const point of points) {
    if (contrast(before[point], base) <= 3 && contrast(after[point], fill) <= 3) {
      filled++;
      continue;
    }
    const x = point % width, y = Math.floor(point / width);
    if (x >= area.left + 4 && x < area.left + area.width - 4 &&
        y >= area.top + 4 && y < area.top + area.height - 4) {
      const oldDetail = contrast(before[point], base);
      const newDetail = contrast(after[point], fill);
      if (Math.min(oldDetail, newDetail) <= 6 && Math.max(oldDetail, newDetail) >= 18) return false;
    }
    // Unchanged antialiased glyphs can inherit a fraction of the fill delta.
    const actual = channels.map(shift => ((after[point] >>> shift) & 255) - ((before[point] >>> shift) & 255));
    const fraction = Math.max(0, Math.min(1, (actual[0] + actual[1] + actual[2]) / (deltas[0] + deltas[1] + deltas[2])));
    if (!actual.every((value, index) => Math.abs(value - deltas[index] * fraction) <= 4)) return false;
  }
  if (filled < points.length * 0.75) return false;
  let foreground = 0;
  for (let y = area.top + 4; y < area.top + area.height - 4; y++) {
    for (let x = area.left + 4; x < area.left + area.width - 4; x++) {
      const i = y * width + x;
      if (contrast(before[i], after[i]) <= 2 && contrast(before[i], base) >= 45) foreground++;
    }
  }
  return foreground >= 8;
}

function decorative(points, width, height, before, after) {
  if (points.length <= pointerBudget && pointerMoved(points, width, before, after)) return true;
  const area = bounds(points, width);
  return scrollbarMoved(area, width, height, before, after) || flatHover(points, area, width, before, after);
}

export function changed(current, previous, [floor, minPixels, minContrast]) {
  if (!previous || current.width !== previous.width || current.height !== previous.height) return true;
  const { width, height } = current;
  const after = new Uint32Array(current.data.buffer, current.data.byteOffset, width * height);
  const before = new Uint32Array(previous.data.buffer, previous.data.byteOffset, width * height);
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const counts = new Uint32Array(columns * rows);
  const energy = new Uint32Array(counts.length);
  const points = [];
  const globalMinimum = Math.max(32, width * height * 0.004);
  let total = 0, totalEnergy = 0;
  for (let y = 0, i = 0; y < height; y++) {
    const tileRow = (y >> 4) * columns;
    for (let x = 0; x < width; x++, i++) {
      if (after[i] === before[i]) continue;
      const delta = contrast(after[i], before[i]) - floor;
      if (delta <= 0) continue;
      const tile = tileRow + (x >> 4);
      counts[tile]++;
      energy[tile] += delta;
      total++;
      totalEnergy += delta;
      if (points.length < decorationBudget) points.push(i);
      if (total > decorationBudget && total >= globalMinimum && totalEnergy >= minContrast * 4) return true;
    }
  }
  if (total < minPixels || totalEnergy < minContrast) return false;

  const global = total >= globalMinimum && totalEnergy >= minContrast * 4;
  let regional = false;
  // Check adjacent tiles together so text crossing a tile boundary is still detected.
  for (let y = 0; y < rows && !global && !regional; y++) {
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x;
      let count = counts[i], sum = energy[i];
      if (x + 1 < columns) {
        count += counts[i + 1];
        sum += energy[i + 1];
      }
      if (y + 1 < rows) {
        count += counts[i + columns];
        sum += energy[i + columns];
        if (x + 1 < columns) {
          count += counts[i + columns + 1];
          sum += energy[i + columns + 1];
        }
      }
      if (count >= minPixels && sum >= minContrast) {
        regional = true;
        break;
      }
    }
  }
  return (global || regional) &&
    (total > decorationBudget || !decorative(points, width, height, before, after));
}

// A negative filter only. Original-size pixels decide whether a candidate is a duplicate.
export function visualSummary({ data, width, height }) {
  const size = 4;
  const summary = [];
  for (let row = 0; row < size; row++) {
    const top = Math.floor(row * height / size);
    const bottom = Math.max(top + 1, Math.floor((row + 1) * height / size));
    for (let column = 0; column < size; column++) {
      const left = Math.floor(column * width / size);
      const right = Math.max(left + 1, Math.floor((column + 1) * width / size));
      let r = 0, g = 0, b = 0, count = 0;
      for (let y = top; y < bottom; y += 2) {
        for (let x = left; x < right; x += 2) {
          const index = (y * width + x) * 4;
          r += data[index];
          g += data[index + 1];
          b += data[index + 2];
          count++;
        }
      }
      summary.push(Math.round(r / count), Math.round(g / count), Math.round(b / count));
    }
  }
  return summary;
}

export function stabilityDetector() {
  let anchor, accepted, since, fresh, moving;
  return {
    reset() {
      anchor = accepted = undefined;
      fresh = moving = false;
    },
    observe(frame, now, sensitivity, delay) {
      moving = changed(frame, anchor, sensitivity);
      if (moving) {
        anchor = frame;
        since = now;
        fresh = true;
      }
      if (fresh && now - since >= delay) {
        fresh = false;
        if (changed(frame, accepted, sensitivity)) return true;
        anchor = accepted;
      }
      return false;
    },
    moved() { return moving; },
    accept(frame) { anchor = accepted = frame; }
  };
}
