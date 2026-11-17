const channelMask = 0xffffff;
const rowsCache = new WeakMap();

// Every removed pixel must match its neutral edge color, including at the
// top and bottom. Preserve a gutter even when only one side qualifies.
export function sideMargins({ data, width, height }) {
  const pixels = new Uint32Array(data.buffer, data.byteOffset, width * height);
  function margin(start, direction) {
    const color = pixels[start] & channelMask;
    const channels = [color & 255, (color >>> 8) & 255, color >>> 16];
    if (Math.max(...channels) - Math.min(...channels) > 8) return 0;
    const limit = Math.floor(width / 3);
    let length = 0;
    while (length < limit) {
      const x = start + direction * length;
      let y = 0;
      while (y < height && (pixels[y * width + x] & channelMask) === color) y++;
      if (y < height) break;
      length++;
    }
    return length >= 16 ? length - 8 : 0;
  }
  const left = margin(0, 1);
  const right = margin(width - 1, -1);
  if ((left || right) && pixels.some(pixel => (pixel & channelMask) !== (pixels[0] & channelMask))) {
    return { left, right };
  }
  return { left: 0, right: 0 };
}

function rowSignatures(frame) {
  if (rowsCache.has(frame)) return rowsCache.get(frame);
  const { data, width, height } = frame;
  const signatures = new Uint32Array(height);
  const unique = new Map();
  const start = Math.floor(width * 0.08);
  const end = width - start;
  const step = Math.max(1, Math.floor((end - start) / 64));
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let hash = 2166136261;
    let detail = 0;
    let previous;
    for (let x = start; x < end; x += step) {
      const i = row + x * 4;
      const tone = (data[i] + data[i + 1] + data[i + 2]) >> 5;
      if (previous !== undefined && Math.abs(tone - previous) >= 2) detail++;
      previous = tone;
      hash = Math.imul(hash ^ tone, 16777619);
    }
    signatures[y] = hash >>> 0;
    if (detail >= 2) unique.set(signatures[y], unique.has(signatures[y]) ? -1 : y);
  }
  const result = { signatures, unique };
  rowsCache.set(frame, result);
  return result;
}

function rowMatches(current, previous, y, oldY) {
  const { width, data } = current;
  const old = previous.data;
  const step = Math.max(1, Math.floor(width / 56));
  let close = 0, samples = 0;
  for (let x = step; x < width - step; x += step) {
    const i = (y * width + x) * 4;
    const j = (oldY * width + x) * 4;
    if (Math.abs(data[i] - old[j]) <= 9 &&
        Math.abs(data[i + 1] - old[j + 1]) <= 9 &&
        Math.abs(data[i + 2] - old[j + 2]) <= 9) close++;
    samples++;
  }
  return samples > 0 && close >= samples * 0.87;
}

export function verticalShift(current, previous) {
  if (!previous || current.width !== previous.width || current.height !== previous.height) return 0;
  const { height } = current;
  const next = rowSignatures(current);
  const old = rowSignatures(previous);
  const votes = new Map();
  for (const [signature, y] of next.unique) {
    const oldY = old.unique.get(signature);
    if (y < 0 || oldY === undefined || oldY < 0 || oldY === y) continue;
    const shift = oldY - y;
    const vote = votes.get(shift);
    if (vote) {
      vote.count++;
      vote.last = y;
    } else votes.set(shift, { count: 1, first: y, last: y });
  }
  const ranked = [...votes].sort((a, b) => b[1].count - a[1].count);
  if (!ranked.length) return 0;
  const [shift, evidence] = ranked[0];
  const overlap = height - Math.abs(shift);
  if (Math.abs(shift) < 4 || overlap < height * 0.25 ||
      evidence.count < Math.max(6, (ranked[1]?.[1].count ?? 0) * 1.6) ||
      evidence.last - evidence.first < overlap * 0.32) return 0;
  let matches = 0, fixed = 0;
  const top = Math.max(0, -shift);
  for (let y = top; y < top + overlap; y++) {
    const oldY = y + shift;
    // A captured scroll can land between rows during compositor sampling.
    if (next.signatures[y] === old.signatures[oldY] || rowMatches(current, previous, y, oldY) ||
        (oldY > 0 && rowMatches(current, previous, y, oldY - 1)) ||
        (oldY + 1 < height && rowMatches(current, previous, y, oldY + 1))) matches++;
    else if (next.signatures[y] === old.signatures[y]) fixed++;
  }
  return matches >= overlap * 0.55 && matches >= (overlap - fixed) * 0.70 ? shift : 0;
}

// Suppress a shifted viewport only if the aligned pixels and revealed blank
// strip agree at native resolution. A new mark of sufficient contrast survives.
export function blankScroll(current, previous) {
  const shift = verticalShift(current, previous);
  if (!shift) return false;
  const { width, height, data } = current;
  const revealed = shift > 0 ? height - shift : 0;
  const sample = revealed * width * 4;
  for (let y = 0; y < height; y++) {
    const oldY = y + shift;
    const overlap = oldY >= 0 && oldY < height;
    const reference = overlap ? previous.data : data;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const j = overlap ? (oldY * width + x) * 4 : sample;
      if (Math.abs(data[i] - reference[j]) > 2 || Math.abs(data[i + 1] - reference[j + 1]) > 2 ||
          Math.abs(data[i + 2] - reference[j + 2]) > 2) return false;
    }
  }
  return true;
}

export function scrollCoverage() {
  let baseline, checkpoint, lastShift = 0;
  const redundant = frame => !!baseline && blankScroll(frame, baseline);
  return {
    redundant,
    reset(frame) {
      baseline = frame;
      checkpoint = undefined;
      lastShift = 0;
    },
    observe(frame) {
      const shift = verticalShift(frame, baseline);
      const distance = Math.abs(shift) / frame.height;
      if (shift && lastShift && Math.sign(shift) !== Math.sign(lastShift)) {
        checkpoint = undefined;
        lastShift = 0;
      }
      if (distance >= 0.48 && distance <= 0.70 && Math.abs(shift) > Math.abs(lastShift)) {
        checkpoint = frame;
        lastShift = shift;
      }
      if (distance >= 0.64 && distance <= 0.70 && !redundant(frame)) return frame;
      if (checkpoint && (!shift || distance > 0.70) && !redundant(checkpoint)) return checkpoint;
      if (distance < 0.48 && shift) {
        checkpoint = undefined;
        lastShift = 0;
      }
    }
  };
}
