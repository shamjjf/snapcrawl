// Generates the SnapCrawl toolbar icons (PNG) at 16/32/48/128 with ZERO
// dependencies — pure Node (zlib + fs). Renders an azure rounded-square badge
// with a white "crawl path" node-graph mark (matches the in-app Logo).
//
//   node apps/extension/scripts/gen-icons.mjs
//
// Output → apps/extension/assets/icon-<size>.png (referenced by the manifest as
// "assets/icon-<size>.png"; the build emits them verbatim into dist/assets).

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../assets");
const SIZES = [16, 32, 48, 128];

// ── brand + geometry (normalized 0..1 space) ──────────────────────────────
const AZURE = [0x0b, 0x6b, 0xcb];
const WHITE = [0xff, 0xff, 0xff];
const BADGE_HALF = 0.46; // half-size of the rounded square (0.04 margin)
const BADGE_R = 0.15; // corner radius
const NODES = [
  [0.29, 0.65],
  [0.5, 0.35],
  [0.71, 0.63],
];
const NODE_R = 0.095;
const LINE_T = 0.082;
const SS = 4; // supersampling factor for anti-aliasing

function sdRoundRect(px, py, half, r) {
  const qx = Math.abs(px) - (half - r);
  const qy = Math.abs(py) - (half - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  );
}
function distSeg(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function subpixel(u, v) {
  let inWhite = false;
  for (const n of NODES) {
    if (Math.hypot(u - n[0], v - n[1]) <= NODE_R) {
      inWhite = true;
      break;
    }
  }
  if (!inWhite) {
    inWhite =
      distSeg(u, v, NODES[0], NODES[1]) <= LINE_T / 2 ||
      distSeg(u, v, NODES[1], NODES[2]) <= LINE_T / 2;
  }
  const inBadge = sdRoundRect(u - 0.5, v - 0.5, BADGE_HALF, BADGE_R) <= 0;
  if (inWhite && inBadge) return WHITE;
  if (inBadge) return AZURE;
  return null; // transparent
}

function render(size) {
  const rgba = new Uint8Array(size * size * 4);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x * SS + sx + 0.5) / (size * SS);
          const v = (y * SS + sy + 0.5) / (size * SS);
          const p = subpixel(u, v);
          if (p) {
            r += p[0];
            g += p[1];
            b += p[2];
            a += 255;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        const cov = a / 255; // number of covered samples
        rgba[i] = Math.round(r / cov);
        rgba[i + 1] = Math.round(g / cov);
        rgba[i + 2] = Math.round(b / cov);
        rgba[i + 3] = Math.round(a / n);
      }
    }
  }
  return rgba;
}

// ── minimal PNG encoder (RGBA, 8-bit) ─────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePNG(size, render(size));
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file}  (${png.length} bytes)`);
}
console.log("done.");
