/* Generates assets/app-icon.png (1024x1024) with no dependencies, using zlib.
   Run:  node scripts/make-icon.mjs   then   npm run icons */
import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const S = 1024;
const bg = [26, 26, 31];      // #1a1a1f
const amber = [201, 169, 110]; // #c9a96e
const cream = [232, 224, 213]; // #e8e0d5

const buf = Buffer.alloc(S * S * 4);
const px = (x, y, [r, g, b], a = 255) => {
  const i = (y * S + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
};

// background
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(x, y, bg);

// rounded amber panel (a "book")
const pad = 190, rad = 90;
const inRounded = (x, y) => {
  if (x < pad || x > S - pad || y < pad || y > S - pad) return false;
  const cx = Math.min(Math.max(x, pad + rad), S - pad - rad);
  const cy = Math.min(Math.max(y, pad + rad), S - pad - rad);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad ** 2 || (x >= pad + rad && x <= S - pad - rad) || (y >= pad + rad && y <= S - pad - rad);
};
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (inRounded(x, y)) px(x, y, amber);

// dark page lines (a stylised "N" made of 3 strokes on the amber)
const stroke = (x0, y0, x1, y1, w) => {
  const steps = Math.hypot(x1 - x0, y1 - y0);
  for (let t = 0; t <= steps; t++) {
    const x = Math.round(x0 + (x1 - x0) * (t / steps));
    const y = Math.round(y0 + (y1 - y0) * (t / steps));
    for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) {
      if (dx * dx + dy * dy <= w * w) px(x + dx, y + dy, bg);
    }
  }
};
stroke(360, 700, 360, 340, 34);           // left vertical
stroke(360, 340, 664, 700, 34);           // diagonal
stroke(664, 700, 664, 340, 34);           // right vertical

// PNG encode
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
]);

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'app-icon.png'), png);
console.log('wrote assets/app-icon.png', png.length, 'bytes');
