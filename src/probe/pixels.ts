import { PNG } from 'pngjs';

export interface Gray {
  w: number;
  h: number;
  /** Luminance 0..255, row-major. */
  data: Uint8Array;
}

/** Decode a PNG buffer to a luminance plane. */
export function decodeGray(buf: Buffer): Gray {
  const png = PNG.sync.read(buf);
  const { width: w, height: h } = png;
  const data = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    // Rec. 601 luma, integer-weighted to avoid float noise in the hash.
    data[i] = (png.data[p]! * 77 + png.data[p + 1]! * 150 + png.data[p + 2]! * 29) >> 8;
  }
  return { w, h, data };
}

/** Box-filter downscale. Averaging (not sampling) keeps thin text visible. */
export function downscale(src: Gray, w: number, h: number): Gray {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.h) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.h) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.w) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.w) / w));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += src.data[yy * src.w + xx]!;
          n++;
        }
      }
      out[y * w + x] = n ? Math.round(sum / n) : 0;
    }
  }
  return { w, h, data: out };
}

/**
 * 64-bit difference hash: downscale to 9x8, then compare each pixel to its
 * right-hand neighbour. Insensitive to uniform brightness shifts, sensitive to
 * layout change, which is exactly the tradeoff we want for dedupe.
 */
export function dhash(gray: Gray): string {
  const small = downscale(gray, 9, 8);
  const bits: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits.push(small.data[y * 9 + x]! > small.data[y * 9 + x + 1]! ? 1 : 0);
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += ((bits[i]! << 3) | (bits[i + 1]! << 2) | (bits[i + 2]! << 1) | bits[i + 3]!).toString(16);
  }
  return hex;
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/**
 * Fraction of pixels that are not the dominant tone.
 *
 * A blank white page scores ~0. A page with a paragraph of text scores a few
 * percent -- text is genuinely sparse in pixel terms -- so the blankness test
 * must pair this with a text-length check rather than thresholding it alone.
 */
export function inkRatio(gray: Gray): number {
  const hist = new Uint32Array(32);
  for (let i = 0; i < gray.data.length; i++) hist[gray.data[i]! >> 3]!++;
  let mode = 0;
  for (let i = 1; i < 32; i++) if (hist[i]! > hist[mode]!) mode = i;
  // Neighbouring buckets count as background too: anti-aliasing and subtle
  // gradients are not ink.
  const bg = hist[mode]! + (hist[mode - 1] ?? 0) + (hist[mode + 1] ?? 0);
  return Math.max(0, 1 - bg / gray.data.length);
}

/**
 * Box-filter downscale of a colour PNG, re-encoded as PNG.
 *
 * Judged frames are sent to a vision model, where cost scales with pixel count.
 * Full-resolution frames stay on disk for the report filmstrip; only the copy
 * handed to the judge is shrunk.
 */
export function downscalePngColor(buf: Buffer, maxW: number): Buffer {
  const src = PNG.sync.read(buf);
  if (src.width <= maxW) return buf;
  const w = maxW;
  const h = Math.max(1, Math.round((src.height * maxW) / src.width));
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * src.width + xx) << 2;
          r += src.data[p]!; g += src.data[p + 1]!; b += src.data[p + 2]!; a += src.data[p + 3]!;
          n++;
        }
      }
      const q = (y * w + x) << 2;
      out.data[q] = Math.round(r / n);
      out.data[q + 1] = Math.round(g / n);
      out.data[q + 2] = Math.round(b / n);
      out.data[q + 3] = Math.round(a / n);
    }
  }
  return PNG.sync.write(out);
}

/**
 * Coarse colour signature: an 8x8 grid of mean RGB, base64 encoded.
 *
 * The difference hash above is computed on luminance, which makes it blind to
 * the single most common small edit anyone asks for -- "make the header blue".
 * Recolouring text or a banner can leave luminance almost untouched, so dhash
 * reports no change while the page visibly changed. This signature catches hue
 * movement that dhash structurally cannot see.
 */
export function colorSignature(buf: Buffer, grid = 16): string {
  const src = PNG.sync.read(buf);
  const out = Buffer.alloc(grid * grid * 3);
  for (let gy = 0; gy < grid; gy++) {
    const y0 = Math.floor((gy * src.height) / grid);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * src.height) / grid));
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * src.width) / grid);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * src.width) / grid));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * src.width + x) << 2;
          r += src.data[p]!; g += src.data[p + 1]!; b += src.data[p + 2]!;
          n++;
        }
      }
      const q = (gy * grid + gx) * 3;
      out[q] = Math.round(r / n);
      out[q + 1] = Math.round(g / n);
      out[q + 2] = Math.round(b / n);
    }
  }
  return out.toString('base64');
}

export interface ColorDelta {
  /** Mean cell difference: whole-page change, e.g. a theme switch. */
  mean: number;
  /** Largest single-cell difference: a localised change, e.g. one recoloured heading. */
  max: number;
}

/**
 * Compare two colour signatures, per cell.
 *
 * `max` is the number that matters for edits. Measured on a real recolour of a
 * single heading: dhash moved 0 bits, the mean cell difference was 0.19 -- a
 * local change averaged across the whole frame vanishes -- while the worst cell
 * moved 18.7. Thresholding the mean would miss every small edit; thresholding
 * the max catches them.
 */
export function colorDelta(a: string | null, b: string | null): ColorDelta {
  if (!a || !b) return { mean: 0, max: 0 };
  const x = Buffer.from(a, 'base64');
  const y = Buffer.from(b, 'base64');
  if (x.length !== y.length || x.length === 0) return { mean: 0, max: 0 };
  const cells = x.length / 3;
  let sum = 0;
  let max = 0;
  for (let c = 0; c < cells; c++) {
    const i = c * 3;
    const d = (Math.abs(x[i]! - y[i]!) + Math.abs(x[i + 1]! - y[i + 1]!) + Math.abs(x[i + 2]! - y[i + 2]!)) / 3;
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / cells, max };
}
