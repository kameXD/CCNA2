// Compare every pixel, including fine text. The threshold applies per RGB channel.
export function changed(a, b, threshold) {
  if (!b || a.length !== b.length) return true;
  const left = new Uint32Array(a.buffer, a.byteOffset, a.length / 4);
  const right = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
  for (let i = 0; i < left.length; i++) {
    const x = left[i];
    const y = right[i];
    if (x === y) continue;
    if (Math.abs((x & 255) - (y & 255)) > threshold ||
        Math.abs(((x >>> 8) & 255) - ((y >>> 8) & 255)) > threshold ||
        Math.abs(((x >>> 16) & 255) - ((y >>> 16) & 255)) > threshold) return true;
  }
  return false;
}

export function stabilityDetector() {
  let anchor, accepted, since, fresh;
  return {
    reset() {
      anchor = accepted = undefined;
      fresh = false;
    },
    observe(pixels, now, threshold, delay) {
      if (changed(pixels, anchor, threshold)) {
        anchor = pixels;
        since = now;
        fresh = true;
      }
      if (fresh && now - since >= delay) {
        fresh = false;
        if (changed(pixels, accepted, threshold)) return true;
        anchor = accepted;
      }
      return false;
    },
    accept(pixels) { anchor = accepted = pixels; }
  };
}
