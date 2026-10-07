#!/usr/bin/env node
// Generates build/icon.png (512x512) without external dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const px = Buffer.alloc(S * S * 4);

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inRoundRect(x, y, r0, r1, rad) {
  if (x < r0 || y < r0 || x > r1 || y > r1) return false;
  const cx = Math.min(Math.max(x, r0 + rad), r1 - rad);
  const cy = Math.min(Math.max(y, r0 + rad), r1 - rad);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
}
const c = S / 2;
const R = 170;
const hex = [...Array(6)].map((_, i) => [c + R * Math.cos(Math.PI / 6 + (i * Math.PI) / 3), c + R * Math.sin(Math.PI / 6 + (i * Math.PI) / 3)]);
const top = [[c, c - R], [hex[5][0], hex[5][1]], [c, c], [hex[3][0], hex[3][1]]];
const cursor = [[c - 20, c - 70], [c - 20, c + 95], [c + 22, c + 52], [c + 50, c + 115], [c + 78, c + 102], [c + 50, c + 40], [c + 105, c + 40]];

const SS = 4;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const X = x + (sx + 0.5) / SS, Y = y + (sy + 0.5) / SS;
      let col = null;
      if (inRoundRect(X, Y, 16, S - 16, 96)) col = [24, 24, 32];
      if (col && inPoly(X, Y, hex)) {
        const t = (X + Y) / (2 * S);
        col = [Math.round(60 + 40 * t), Math.round(110 + 60 * t), 255];
        if (inPoly(X, Y, top)) col = [Math.round(120 + 40 * t), Math.round(170 + 40 * t), 255];
      }
      if (col && inPoly(X, Y, cursor)) col = [255, 255, 255];
      if (col) { r += col[0]; g += col[1]; b += col[2]; a += 255; }
    }
    const n = SS * SS;
    const i = (y * S + x) * 4;
    const cov = a / n;
    px[i] = cov ? Math.round(r / (a / 255)) : 0;
    px[i + 1] = cov ? Math.round(g / (a / 255)) : 0;
    px[i + 2] = cov ? Math.round(b / (a / 255)) : 0;
    px[i + 3] = Math.round(cov);
  }
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), png);
console.log('wrote build/icon.png');
