#!/usr/bin/env node
/**
 * 生成桌面安装包图标源图（1024×1024 RGBA PNG）。
 *
 * 为什么要自己画：Tauri 的 `tauri icon` 要求**正方形**源图，而 TMS273 导出的美术
 * 全是非正方形（登录背景 1366×768 等），仓库里没有任何 ≥256 的正方形素材可裁。
 * 与其塞一个来路不明的二进制进版本库，不如用可复算的脚本画一张：颜色、几何、
 * 采样方式都在这里，任何人 `node scripts/make_desktop_icon.cjs` 都能得到同一张图。
 *
 * 只依赖 node 内置 zlib：PNG 编码（IHDR/IDAT/IEND + CRC32）与 2×2 超采样都在本文件内，
 * 不引入图像库。
 *
 * 用法： node scripts/make_desktop_icon.cjs [输出路径]
 *        默认输出 client/src-tauri/icon-source.png
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 1024;
/** 2×2 超采样：枫叶边缘锯齿在 1024 尺度下很明显，纯点采样会显得很脏。 */
const SAMPLES = 2;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // 过滤器：None
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // 位深
  header[9] = 6;   // 颜色类型：RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 经典 22 点枫叶轮廓，坐标在 [-1,1] 区间、y 轴向上。 */
const LEAF = [
  [0.00, 1.00], [0.12, 0.62], [0.38, 0.72], [0.30, 0.48], [0.78, 0.55], [0.60, 0.28],
  [0.95, 0.18], [0.52, 0.02], [0.62, -0.18], [0.20, -0.16], [0.16, -0.62], [0.00, -0.45],
  [-0.16, -0.62], [-0.20, -0.16], [-0.62, -0.18], [-0.52, 0.02], [-0.95, 0.18], [-0.60, 0.28],
  [-0.78, 0.55], [-0.30, 0.48], [-0.38, 0.72], [-0.12, 0.62],
];

/** 偶奇规则射线法；点在多边形内返回 true。 */
function insideLeaf(x, y) {
  let inside = false;
  for (let i = 0, j = LEAF.length - 1; i < LEAF.length; j = i, i += 1) {
    const [xi, yi] = LEAF[i];
    const [xj, yj] = LEAF[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 圆角方形覆盖率：把点变换到「中心 + 半径」坐标下按半径判定。 */
function roundedSquareCoverage(x, y, half, radius) {
  const dx = Math.max(Math.abs(x) - (half - radius), 0);
  const dy = Math.max(Math.abs(y) - (half - radius), 0);
  return dx * dx + dy * dy <= radius * radius ? 1 : 0;
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const center = SIZE / 2;
  const half = SIZE * 0.44;         // 圆角方形半边长，四周留出安全边距
  const radius = SIZE * 0.22;
  const leafScale = SIZE * 0.30;

  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      let background = 0;
      let leaf = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = px + (sx + 0.5) / SAMPLES - center;
          const y = py + (sy + 0.5) / SAMPLES - center;
          background += roundedSquareCoverage(x, y, half, radius);
          // 屏幕 y 向下，叶子轮廓 y 向上，取负还原。
          if (insideLeaf(x / leafScale, -y / leafScale)) leaf += 1;
        }
      }
      const total = SAMPLES * SAMPLES;
      const backgroundAlpha = background / total;
      const leafAlpha = (leaf / total) * backgroundAlpha;
      const offset = (py * SIZE + px) * 4;
      // 底色用游戏主视觉的草绿→深绿纵向渐变，叶子压成米白。
      const ratio = py / SIZE;
      const base = [
        Math.round(0x5c + (0x1f - 0x5c) * ratio),
        Math.round(0xb0 + (0x5e - 0xb0) * ratio),
        Math.round(0x3a + (0x24 - 0x3a) * ratio),
      ];
      rgba[offset] = Math.round(base[0] * (1 - leafAlpha) + 0xf4 * leafAlpha);
      rgba[offset + 1] = Math.round(base[1] * (1 - leafAlpha) + 0xf7 * leafAlpha);
      rgba[offset + 2] = Math.round(base[2] * (1 - leafAlpha) + 0xe8 * leafAlpha);
      rgba[offset + 3] = Math.round(255 * backgroundAlpha);
    }
  }
  return encodePng(SIZE, SIZE, rgba);
}

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'client/src-tauri/icon-source.png');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, render());
console.log(`已写出 ${target}（${SIZE}×${SIZE} RGBA，${(fs.statSync(target).size / 1024).toFixed(1)}KB）`);
