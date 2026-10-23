// 生成 vvn 启动器图标：深色极简几何 .ico（多尺寸）
// 输出：脚本所在目录的上一级 / vvn.ico
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "vvn.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  // 画布：深色圆角方块 + 白色几何符号（两条斜杠组成 V，右下角一个小方块）
  const px = Buffer.alloc(size * size * 4);
  const S = size;
  const r = S * 0.2;                    // 圆角半径
  const pad = S * 0.06;
  const put = (x, y, rr, gg, bb, aa) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const a = aa / 255;
    px[i] = Math.round(rr * a + px[i] * (1 - a));
    px[i + 1] = Math.round(gg * a + px[i + 1] * (1 - a));
    px[i + 2] = Math.round(bb * a + px[i + 2] * (1 - a));
    px[i + 3] = Math.max(px[i + 3], aa);
  };

  // 圆角矩形底色（近黑蓝），带极轻的垂直渐变
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cx = Math.min(Math.max(x, pad + r), S - pad - r);
      const cy = Math.min(Math.max(y, pad + r), S - pad - r);
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r + 0.5) continue;
      const edge = Math.min(1, Math.max(0, r + 0.5 - d)); // 抗锯齿
      const t = y / S;
      const rr = Math.round(18 + t * 8);
      const gg = Math.round(22 + t * 10);
      const bb = Math.round(28 + t * 14);
      put(x, y, rr, gg, bb, Math.round(255 * edge));
    }
  }

  // 符号：两条粗斜线组成 V，占画布中心
  const thick = Math.max(1.4, S * 0.105);
  const top = S * 0.26, bot = S * 0.74;
  const leftX = S * 0.255, rightX = S * 0.745;
  for (let y = Math.floor(top); y <= Math.ceil(bot); y++) {
    const t = (y - top) / (bot - top);
    const cxR = leftX + (S * 0.5 - leftX) * t;   // 左撇：从左上到中下
    const cxL = rightX + (S * 0.5 - rightX) * t; // 右撇：从右上到中下
    for (const cx of [cxR, cxL]) {
      const half = thick / 2;
      for (let x = Math.floor(cx - half - 1); x <= Math.ceil(cx + half + 1); x++) {
        const dist = Math.abs(x - cx);
        if (dist > half + 0.5) continue;
        const a = Math.min(1, Math.max(0, half + 0.5 - dist));
        put(x, y, 236, 240, 245, Math.round(255 * a));
      }
    }
  }

  // 右下角一个小方点，打破对称
  const dsz = Math.max(2, Math.round(S * 0.1));
  const dx0 = Math.round(S * 0.63), dy0 = Math.round(S * 0.635);
  for (let y = dy0; y < dy0 + dsz; y++) {
    for (let x = dx0; x < dx0 + dsz; x++) put(x, y, 47, 109, 246, 255);
  }

  // 打包 PNG
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const images = SIZES.map((s) => ({ size: s, data: png(s) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
const dir = [];
for (const im of images) {
  const e = Buffer.alloc(16);
  e[0] = im.size >= 256 ? 0 : im.size;
  e[1] = im.size >= 256 ? 0 : im.size;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(im.data.length, 8);
  e.writeUInt32LE(offset, 12);
  dir.push(e);
  offset += im.data.length;
}
fs.writeFileSync(OUT, Buffer.concat([header, ...dir, ...images.map((i) => i.data)]));
console.log(`已写入 ${OUT}`);
console.log(`尺寸: ${SIZES.join(", ")}  字节: ${fs.statSync(OUT).size}`);