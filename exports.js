const encoder = new TextEncoder();

function record(length, write) {
  const bytes = new Uint8Array(length);
  write(new DataView(bytes.buffer));
  return bytes;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

export async function makeZip(entries, load) {
  if (entries.length > 65535) throw new Error('El ZIP admite hasta 65 535 capturas.');
  const files = [], directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const [index, entry] of entries.entries()) {
    const png = await load(entry.id);
    const name = encoder.encode(`captura-${String(index + 1).padStart(4, '0')}.png`);
    const date = new Date(entry.time);
    const dosTime = date.getHours() * 2048 + date.getMinutes() * 32 + (date.getSeconds() >> 1);
    const dosDate = (Math.max(1980, Math.min(2107, date.getFullYear())) - 1980) * 512 +
      (date.getMonth() + 1) * 32 + date.getDate();
    let crc = 0xffffffff;
    const reader = png.stream().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const byte of value) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    }
    crc ^= 0xffffffff;
    function fileInfo(view, pos) {
      view.setUint16(pos, 20, true);
      view.setUint16(pos + 6, dosTime, true);
      view.setUint16(pos + 8, dosDate, true);
      view.setUint32(pos + 10, crc, true);
      view.setUint32(pos + 14, png.size, true);
      view.setUint32(pos + 18, png.size, true);
      view.setUint16(pos + 22, name.length, true);
    }
    files.push(record(30, view => {
      view.setUint32(0, 0x04034b50, true);
      fileInfo(view, 4);
    }), name, png);
    directory.push(record(46, view => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      fileInfo(view, 6);
      view.setUint32(42, offset, true);
    }), name);
    offset += 30 + name.length + png.size;
    directorySize += 46 + name.length;
    if (offset + directorySize + 22 >= 0xffffffff) throw new Error('El ZIP supera el límite de 4 GiB.');
  }
  const end = record(22, view => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, entries.length, true);
    view.setUint16(10, entries.length, true);
    view.setUint32(12, directorySize, true);
    view.setUint32(16, offset, true);
  });
  return new Blob([...files, ...directory, end], { type: 'application/zip' });
}

async function pdfImage(png, canvas, context) {
  const bitmap = await createImageBitmap(png);
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  // Compress RGB rows incrementally without retaining a full second RGB buffer.
  let row = 0;
  const rows = new ReadableStream({
    pull(controller) {
      if (row === canvas.height) {
        controller.close();
        return;
      }
      const height = Math.min(32, canvas.height - row);
      const rgba = context.getImageData(0, row, canvas.width, height).data;
      const rgb = new Uint8Array(rgba.length / 4 * 3);
      for (let src = 0, dst = 0; src < rgba.length; src += 4, dst += 3) {
        rgb[dst] = rgba[src];
        rgb[dst + 1] = rgba[src + 1];
        rgb[dst + 2] = rgba[src + 2];
      }
      controller.enqueue(rgb);
      row += height;
    }
  });
  return new Response(rows.pipeThrough(new CompressionStream('deflate'))).blob();
}

export async function makePdf(entries, load) {
  const parts = [], offsets = [0], pages = [];
  let offset = 0;
  function append(value) {
    const part = typeof value === 'string' ? encoder.encode(value) : value;
    parts.push(part);
    offset += part.size ?? part.byteLength;
  }
  function object(id, ...values) {
    offsets[id] = offset;
    append(`${id} 0 obj\n`);
    for (const value of values) append(value);
    append('\nendobj\n');
  }

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  append('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  for (const [index, entry] of entries.entries()) {
    const imageId = 3 + index * 3;
    const contentId = imageId + 1;
    const pageId = imageId + 2;
    const image = await pdfImage(await load(entry.id), canvas, context);
    const { width, height } = canvas;
    // Limit the page dimensions in points while embedding every source pixel.
    const scale = Math.min(1, 14400 / Math.max(width, height));
    const w = (width * scale).toFixed(4);
    const h = (height * scale).toFixed(4);
    const drawing = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
    object(imageId, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.size} >>\nstream\n`, image, '\nendstream');
    object(contentId, `<< /Length ${drawing.length} >>\nstream\n${drawing}endstream`);
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pages.push(`${pageId} 0 R`);
  }
  canvas.width = canvas.height = 1;
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.join(' ')}] >>`);
  const xref = offset;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const position of offsets.slice(1)) {
    if (position >= 1e10) throw new Error('El PDF supera el tamaño admitido.');
    append(`${String(position).padStart(10, '0')} 00000 n \n`);
  }
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
