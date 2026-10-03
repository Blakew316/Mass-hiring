/* Enough PNG to read one in, scale it down well, and write it back out.
 *
 * 8-bit RGBA only, which is what every file in this repo is. No dependency:
 * Node's zlib does the compression and everything else is a few loops. Shared
 * by build-dark-logo.mjs and build-icons.mjs.
 */
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function readChunks(buf) {
  const out = [];
  let i = 8;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    out.push({ type: buf.toString('latin1', i + 4, i + 8), data: buf.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
  }
  return out;
}

export function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, crc]);
}

/** PNG bytes -> { width, height, data } with data as straight (not
 *  premultiplied) RGBA. 8-bit RGB (colour type 2) is accepted and given an
 *  opaque alpha channel — that is what a screenshot of an opaque page is. */
export function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const depth = ihdr[8], colour = ihdr[9];
  if (depth !== 8 || (colour !== 6 && colour !== 2)) {
    throw new Error(`expected 8-bit RGB or RGBA; got depth ${depth} colour type ${colour}`);
  }
  if (ihdr[12] !== 0) throw new Error('interlaced PNGs are not supported');

  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const bpp = colour === 6 ? 4 : 3;
  const stride = width * bpp;
  const lines = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[pos++];
    const line = lines.subarray(y * stride, (y + 1) * stride);
    raw.copy(line, 0, pos, pos + stride);
    pos += stride;
    const prev = y ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) line[x] = (line[x] + paeth(a, b, c)) & 255;
    }
  }
  if (bpp === 4) return { width, height, data: lines };

  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, o = 0; i < lines.length; i += 3, o += 4) {
    data[o] = lines[i]; data[o + 1] = lines[i + 1]; data[o + 2] = lines[i + 2]; data[o + 3] = 255;
  }
  return { width, height, data };
}

/** { width, height, data } -> PNG bytes.
 *
 *  Each row is filtered the way the PNG spec suggests: try all five, keep the
 *  one whose bytes sum smallest read as signed, because that is the one deflate
 *  will find most repetitive. It matters a lot here — a launch screen is
 *  mostly one flat colour, and writing those rows unfiltered instead of as
 *  "same as the row above" was the difference between 3.5 MB and 100 KB. */
export function encode({ width, height, data }) {
  const stride = width * 4, bpp = 4;
  const body = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y ? data.subarray((y - 1) * stride, y * stride) : null;
    let bestFilter = 0, bestScore = Infinity;
    for (let f = 0; f <= 4; f++) {
      if (f > 1 && !prev) continue;                 // nothing above row 0 to lean on
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= bpp ? prev[x - bpp] : 0;
        let v;
        if (f === 0) v = row[x];
        else if (f === 1) v = row[x] - a;
        else if (f === 2) v = row[x] - b;
        else if (f === 3) v = row[x] - ((a + b) >> 1);
        else v = row[x] - paeth(a, b, c);
        v &= 255;
        candidate[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestFilter = f; candidate.copy(best); }
    }
    body[y * (stride + 1)] = bestFilter;
    best.copy(body, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(body, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* Area-average resampling: every destination pixel is the mean of exactly the
 * source rectangle it covers, edge pixels counted by the fraction they
 * contribute. For the large reductions an icon set needs (1024 down to 180, or
 * to 16) this is what you want — picking nearest neighbours would drop whole
 * letters out of the label, and a bilinear pair would alias them into fuzz.
 *
 * Alpha is premultiplied first. Without that, the fully transparent pixels
 * around the mark contribute their (arbitrary) colour to the average and leave
 * a dark rim on everything.
 */
export function resize(img, width, height) {
  const { width: sw, height: sh, data: src } = img;
  if (sw === width && sh === height) return { width, height, data: Buffer.from(src) };
  const out = Buffer.alloc(width * height * 4);
  const xScale = sw / width, yScale = sh / height;

  for (let dy = 0; dy < height; dy++) {
    const y0 = dy * yScale, y1 = (dy + 1) * yScale;
    const yStart = Math.floor(y0), yEnd = Math.min(sh - 1, Math.ceil(y1) - 1);
    for (let dx = 0; dx < width; dx++) {
      const x0 = dx * xScale, x1 = (dx + 1) * xScale;
      const xStart = Math.floor(x0), xEnd = Math.min(sw - 1, Math.ceil(x1) - 1);
      let r = 0, g = 0, b = 0, a = 0, weight = 0;
      for (let sy = yStart; sy <= yEnd; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = xStart; sx <= xEnd; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (sy * sw + sx) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha * w;
          g += src[i + 1] * alpha * w;
          b += src[i + 2] * alpha * w;
          a += src[i + 3] * w;
          weight += w;
        }
      }
      const o = (dy * width + dx) * 4;
      if (!weight) continue;
      const alpha = a / weight;
      out[o + 3] = Math.round(alpha);
      if (alpha <= 0) continue;                       // fully clear: leave RGB at 0
      const un = weight * (alpha / 255);
      out[o] = Math.min(255, Math.round(r / un));
      out[o + 1] = Math.min(255, Math.round(g / un));
      out[o + 2] = Math.min(255, Math.round(b / un));
    }
  }
  return { width, height, data: out };
}

/** The tight bounding box of everything that is not fully transparent. */
export function inkBounds({ width, height, data }, { x0 = 0, x1 = width - 1 } = {}) {
  let top = height, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = x0; x <= x1; x++) {
      if (data[(y * width + x) * 4 + 3] <= 8) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0) throw new Error('image is entirely transparent');
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

export function crop(img, { left, top, width, height }) {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y + top) * img.width + left) * 4;
    img.data.copy(out, y * width * 4, from, from + width * 4);
  }
  return { width, height, data: out };
}

/** A new opaque canvas of one colour. `hex` is #rgb or #rrggbb. */
export function solid(width, height, hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { width, height, data };
}

/** Recolour every pixel, keeping its alpha. For artwork drawn in one flat
 *  colour that each theme then tints its own way. */
export function tint(img, hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  const data = Buffer.from(img.data);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; }
  return { width: img.width, height: img.height, data };
}

/** Draw `src` over `dst` at (x, y), source-over, in place. */
export function blend(dst, src, x, y) {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (sy * src.width + sx) * 4;
      const a = src.data[s + 3] / 255;
      if (a <= 0) continue;
      const d = (dy * dst.width + dx) * 4;
      if (a >= 1) {
        dst.data[d] = src.data[s]; dst.data[d + 1] = src.data[s + 1];
        dst.data[d + 2] = src.data[s + 2]; dst.data[d + 3] = 255;
        continue;
      }
      const da = dst.data[d + 3] / 255;
      const out = a + da * (1 - a);
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] = Math.round((src.data[s + c] * a + dst.data[d + c] * da * (1 - a)) / out);
      }
      dst.data[d + 3] = Math.round(out * 255);
    }
  }
  return dst;
}

/** Crop away the fully transparent border, leaving the artwork tight. */
export function trim(img) {
  return crop(img, inkBounds(img));
}
