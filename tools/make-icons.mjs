// Generates the PWA icons (two stacked study cards on a sage background) as PNGs,
// with no dependencies: signed-distance shapes, 4x4 supersampling, zlib-compressed PNG.
// Run: node tools/make-icons.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const BG_TOP = hex('#3E9A86'), BG_BOT = hex('#2A6F61');
const SUN = hex('#F2B544'), CARD = hex('#FBF7EE'), INK = hex('#2F7D6D'), INK2 = hex('#B9D6CD');

function roundRect(px, py, cx, cy, w, h, r, rot) {
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const x = (px - cx) * c - (py - cy) * s, y = (px - cx) * s + (py - cy) * c;
  const qx = Math.abs(x) - w / 2 + r, qy = Math.abs(y) - h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Scene in 512-unit space; `inset` shrinks artwork for maskable safe zone.
function sample(x, y, { rounded, inset }) {
  const k = 1 / inset, X = 256 + (x - 256) * k, Y = 256 + (y - 256) * k;
  if (rounded && roundRect(x, y, 256, 256, 512, 512, 112, 0) > 0) return null;
  const t = y / 512;
  let col = BG_TOP.map((v, i) => v + (BG_BOT[i] - v) * t);
  const layers = [
    [roundRect(X, Y, 286, 232, 232, 292, 36, 0.17), SUN],
    [roundRect(X, Y, 236, 272, 232, 292, 36, -0.09), CARD],
    [roundRect(X, Y, 228, 214, 136, 30, 15, -0.09), INK],
    [roundRect(X, Y, 236, 270, 156, 20, 10, -0.09), INK2],
    [roundRect(X, Y, 228, 312, 120, 20, 10, -0.09), INK2],
    [Math.hypot(X - 300, Y - 372) - 26, SUN],
  ];
  for (const [d, c] of layers) if (d <= 0) col = c;
  return col;
}

function render(size, opts) {
  const ss = 4, px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = sample(((x + (sx + 0.5) / ss) * 512) / size, ((y + (sy + 0.5) / ss) * 512) / size, opts);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const i = (y * size + x) * 4, n = ss * ss;
    if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; }
    px[i + 3] = Math.round((255 * a) / n);
  }
  return png(size, size, px);
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = new URL('../app/icons/', import.meta.url);
fs.mkdirSync(out, { recursive: true });
const jobs = [
  ['icon-192.png', 192, { rounded: true, inset: 1 }],
  ['icon-512.png', 512, { rounded: true, inset: 1 }],
  ['maskable-512.png', 512, { rounded: false, inset: 0.82 }],
  ['apple-touch-icon.png', 180, { rounded: false, inset: 1 }], // iOS applies its own mask; must be opaque
];
for (const [name, size, opts] of jobs) {
  fs.writeFileSync(new URL(name, out), render(size, opts));
  console.log('wrote', name);
}
