#!/usr/bin/env node
// 从 GMS083 客户端（参考/83 北斗端）的 UI.wz 映像里，逐节点提取登录 / 选角 /
// 创角相关的原始像素素材（PNG），并落一份可追溯的索引。
//
// 源：参考/83/083ASM-BOT/Beidou-asm-bot/BeiDou-Client-V15_fix/Data/UI/<name>.img
//     —— 这些是未解包的原始 WZ 映像，IV 为 GMS（WzMapleVersion.GMS = 0）。
//     同目录另有 BeiDou-Server/wz/UI.wz/*.img.xml，那是 HaRepacker 解包出的
//     结构 XML（不含像素），因此**不能**作为像素来源。
//
// 输出：<out>/*.png + <out>/index.json
//     PNG 名 = <img 名>__<WZ 路径，非法字符转 _>-<内容 sha256 前 10 位>.png
//     同内容只落一份（去重），index 里逐条记录 WZ 路径 → 文件 / 尺寸 / origin。
//
// 用法：
//   node scripts/export_gms83_login_ui.cjs --out DIR --img Login.img [--img Logo.img ...]
//                                             [--filter Title] [--filter CharSelect]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');

const UI_DIR = path.resolve(__dirname, '../参考/83/083ASM-BOT/Beidou-asm-bot/BeiDou-Client-V15_fix/Data/UI');
const CANVAS = 8;

function parseArgs(argv) {
  const out = { out: null, imgs: [], filters: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--out') { out.out = val; i += 1; }
    else if (key === '--img') { out.imgs.push(val); i += 1; }
    else if (key === '--filter') { out.filters.push(val); i += 1; }
    else throw new Error(`未知参数: ${key}`);
  }
  assert(out.out, '必须指定 --out DIR');
  assert(out.imgs.length, '至少要一个 --img NAME.img');
  return out;
}

// WZ 路径 → 安全文件名（与仓库既有导出命名风格一致）
const safe = (value) => value.replace(/[^\w.-]/g, '_').replace(/_{2,}/g, '__');

// canvas 节点上的 origin 可能挂在自己或父级 raw 节点
function readVec(prop, name) {
  for (const child of prop.wzProperties ?? []) {
    if (child.name !== name) continue;
    const v = child.value;
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x, y: v.y };
  }
  return null;
}

function readInt(prop, name) {
  for (const child of prop.wzProperties ?? []) {
    if (child.name !== name) continue;
    const v = Number(child.value);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });

  const index = [];
  const byHash = new Map();
  let total = 0;
  let skippedNoPixels = 0;

  for (const imgName of args.imgs) {
    const file = path.join(UI_DIR, imgName);
    assert(fs.existsSync(file), `缺少源映像: ${file}`);
    const img = wz.WzImage.createFromFile(file, wz.WzMapleVersion.GMS);
    await img.parseImage();
    const base = imgName; // 例如 Login.img
    const prefixRoot = base.replace(/\.img$/, '');

    const visit = async (prop, trail) => {
      if (prop.propertyType === CANVAS) {
        const here = `${prefixRoot}/${trail}`;
        if (args.filters.length && !args.filters.some((f) => here.startsWith(`${prefixRoot}/${f}`) || trail.startsWith(f))) return;
        total += 1;
        const origin = readVec(prop, 'origin') ?? { x: 0, y: 0 };
        let png = null;
        try { png = prop.pngProperty ?? null; } catch { png = null; }
        if (!png) { skippedNoPixels += 1; return; }
        const bitmap = await prop.getBitmap();
        if (!bitmap) { skippedNoPixels += 1; return; }
        const bytes = Buffer.from(await bitmap.getBufferAsync('image/png'));
        const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 10);
        const width = png.width;
        const height = png.height;
        let name = byHash.get(sha);
        if (!name) {
          name = `${safe(base)}__${safe(trail)}-${sha}.png`;
          fs.writeFileSync(path.join(out, name), bytes);
          byHash.set(sha, name);
        }
        index.push({ img: base, path: here, file: name, width, height, origin, sha256: sha });
        return;
      }
      for (const child of prop.wzProperties ?? []) {
        await visit(child, trail ? `${trail}/${child.name}` : child.name);
      }
    };

    for (const top of img.wzProperties ?? []) await visit(top, top.name);
    img.dispose?.();
  }

  index.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  fs.writeFileSync(path.join(out, 'index.json'), `${JSON.stringify({
    source: '参考/83/083ASM-BOT/.../BeiDou-Client-V15_fix/Data/UI',
    mapleVersion: 'GMS',
    images: args.imgs,
    filters: args.filters,
    canvasNodes: total,
    pngs: byHash.size,
    nodes: index,
  }, null, 2)}\n`);

  console.log(`扫描 canvas 节点 ${total} 个 → 唯一 PNG ${byHash.size} 张，索引 ${index.length} 条`);
  if (skippedNoPixels) console.log(`跳过无像素节点（UOL / 空 canvas）: ${skippedNoPixels}`);
  console.log(`输出目录: ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
