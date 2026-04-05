#!/usr/bin/env node
// generate-icon.js — Creates build/icon.ico using uncompressed BMP format (not PNG-in-ICO)
'use strict';

const fs   = require('fs');
const path = require('path');

// ── Pixel generator ───────────────────────────────────────────────────────────
// Returns RGBA pixel array (length = S*S*4), top-to-bottom, left-to-right

function makePixels(S) {
  const cx = S / 2, cy = S / 2, R = S / 2 - 1;
  const pixels = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const r  = Math.sqrt(dx * dx + dy * dy);
      const i  = (y * S + x) * 4;
      if (r >= R - Math.max(2, S * 0.08) && r <= R) {
        pixels[i]   = 0;   // R
        pixels[i+1] = 229; // G
        pixels[i+2] = 255; // B
        pixels[i+3] = 255; // A
      } else if (r < R - Math.max(2, S * 0.08)) {
        const angle = Math.atan2(dy, dx);
        const hourA = -Math.PI / 2 - Math.PI / 4;
        const minA  = -Math.PI / 2 + Math.PI / 3;
        const dH = Math.abs(Math.atan2(Math.sin(angle - hourA), Math.cos(angle - hourA)));
        const dM = Math.abs(Math.atan2(Math.sin(angle - minA),  Math.cos(angle - minA)));
        const thick = Math.max(0.15, 0.22 - S * 0.001);
        if ((dH < thick && r > 2 && r < R * 0.52) || (dM < thick * 0.75 && r > 2 && r < R * 0.72)) {
          pixels[i]   = 0;   pixels[i+1] = 229; pixels[i+2] = 255; pixels[i+3] = 230;
        } else {
          pixels[i]   = 8;   pixels[i+1] = 17;  pixels[i+2] = 32;  pixels[i+3] = 240;
        }
      } else {
        pixels[i] = pixels[i+1] = pixels[i+2] = pixels[i+3] = 0;
      }
    }
  }
  return pixels;
}

// ── BMP-in-ICO builder ────────────────────────────────────────────────────────
// Traditional uncompressed 32-bit BGRA BMP inside ICO — works with all tools

function makeBmpEntry(S) {
  const pixels = makePixels(S);

  // Pixel data: BGRA, bottom-to-top (ICO/BMP convention)
  const stride  = S * 4;
  const pixData = Buffer.alloc(S * stride);
  for (let y = 0; y < S; y++) {
    const srcRow = y * stride;           // top-to-bottom in our array
    const dstRow = (S - 1 - y) * stride; // bottom-to-top for BMP
    for (let x = 0; x < S; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * 4;
      pixData[di]   = pixels[si+2]; // B
      pixData[di+1] = pixels[si+1]; // G
      pixData[di+2] = pixels[si];   // R
      pixData[di+3] = pixels[si+3]; // A
    }
  }

  // AND mask (1-bit transparency, DWORD-aligned rows) — all zeros means "use alpha"
  const maskRowBytes = Math.ceil(S / 32) * 4;
  const andMask = Buffer.alloc(S * maskRowBytes, 0);

  // BITMAPINFOHEADER (40 bytes)
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40,          0);  // biSize
  hdr.writeInt32LE(S,            4);  // biWidth
  hdr.writeInt32LE(S * 2,        8);  // biHeight (×2 for XOR+AND)
  hdr.writeUInt16LE(1,          12);  // biPlanes
  hdr.writeUInt16LE(32,         14);  // biBitCount
  hdr.writeUInt32LE(0,          16);  // biCompression (BI_RGB)
  hdr.writeUInt32LE(pixData.length, 20); // biSizeImage
  hdr.writeInt32LE(0,           24);  // biXPelsPerMeter
  hdr.writeInt32LE(0,           28);  // biYPelsPerMeter
  hdr.writeUInt32LE(0,          32);  // biClrUsed
  hdr.writeUInt32LE(0,          36);  // biClrImportant

  return Buffer.concat([hdr, pixData, andMask]);
}

function makeIco(sizes) {
  const entries = sizes.map(makeBmpEntry);

  // ICO header (6 bytes)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(entries.length, 4);

  // Directory entries (16 bytes each)
  const dirOffset = 6 + entries.length * 16;
  let offset = dirOffset;
  const dirs = entries.map((entry, i) => {
    const S   = sizes[i];
    const dir = Buffer.alloc(16);
    dir.writeUInt8(S >= 256 ? 0 : S, 0); // width  (0 = 256)
    dir.writeUInt8(S >= 256 ? 0 : S, 1); // height (0 = 256)
    dir.writeUInt8(0,  2); // color count (0 = >8bpp)
    dir.writeUInt8(0,  3); // reserved
    dir.writeUInt16LE(1,  4); // color planes
    dir.writeUInt16LE(32, 6); // bits per pixel
    dir.writeUInt32LE(entry.length, 8);  // data size
    dir.writeUInt32LE(offset,       12); // data offset
    offset += entry.length;
    return dir;
  });

  return Buffer.concat([header, ...dirs, ...entries]);
}

// ── Write output ──────────────────────────────────────────────────────────────

const buildDir = path.join(__dirname, 'build');
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir);

const sizes = [16, 24, 32, 48, 64, 128, 256];
const ico   = makeIco(sizes);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
console.log(`✓ build/icon.ico created (${ico.length} bytes, ${sizes.length} sizes: ${sizes[0]}–${sizes[sizes.length-1]}px, BMP format)`);
