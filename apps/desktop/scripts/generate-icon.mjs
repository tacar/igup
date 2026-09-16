// IGUP アプリアイコン生成(依存ゼロのPNGライター)。
// 一度だけ実行して build/icon.png を作り、成果物をコミットする。
//   node scripts/generate-icon.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const PAPER = [231, 232, 225, 255]; // #e7e8e1
const SIGNAL = [178, 61, 28, 255]; // #b23d1c
const SIGNAL_SOFT = [226, 101, 58, 255]; // #e2653a
const INK = [28, 27, 23, 255]; // #1c1b17

const px = Buffer.alloc(SIZE * SIZE * 4);

function setPx(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a === 0) return;
  const i = (y * SIZE + x) * 4;
  const inv = 255 - a;
  px[i] = (r * a + px[i] * inv) / 255;
  px[i + 1] = (g * a + px[i + 1] * inv) / 255;
  px[i + 2] = (b * a + px[i + 2] * inv) / 255;
  px[i + 3] = Math.max(px[i + 3], a);
}

function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return false;
  const cx = Math.max(x0 + r, Math.min(x, x0 + w - r));
  const cy = Math.max(y0 + r, Math.min(y, y0 + h - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function fillRoundRect(x0, y0, w, h, r, color) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (inRoundRect(x, y, x0, y0, w, h, r)) setPx(x, y, color);
}

function fillCircle(cx, cy, rad, color) {
  for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) setPx(x, y, color);
}

// 背景: 角丸のペーパー板(macOS/Windows でマスクされる前提のフルブリード)
fillRoundRect(0, 0, SIZE, SIZE, 224, PAPER);

// マーク: 上向きの棒グラフ(インサイト) + ストーリーズのドット
const baseline = 768;
const barW = 132;
const gap = 62;
const startX = (SIZE - (barW * 3 + gap * 2)) / 2;
const heights = [264, 424, 584];
heights.forEach((h, i) => {
  const x = startX + i * (barW + gap);
  fillRoundRect(x, baseline - h, barW, h, 28, i === 2 ? SIGNAL : SIGNAL_SOFT);
});
fillCircle(startX + 2 * (barW + gap) + barW / 2, baseline - heights[2] - 96, 52, SIGNAL);
fillRoundRect(startX, baseline, barW * 3 + gap * 2, 18, 9, INK);

// --- PNG エンコード ---
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0; // filter: none
  px.copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
