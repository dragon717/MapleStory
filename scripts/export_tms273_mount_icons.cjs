#!/usr/bin/env node

// 骑宠图标导出：把 `Character/TamingMob/<8位>.img/info/icon` 抽成 PNG + 帧表。
//
// 为什么单开一张帧表而不是塞进 `shared/mounts.json`：
// 与 `pets.json` / `pet-images.json` 的分工一致——目录表回答「这件东西是什么」
// （名字、槽位、骑行数值），帧表回答「怎么画」。装配器把它们分别挂到
// `manifest.mounts`（帧）与客户端侧表（目录），互不污染。
//
// 源事实：
//   图标节点 `Character/TamingMob/01902000.img/info/icon` 是**外链 Canvas**
//   （子项只有 `origin` + `_outlink`），真正的像素在并行树
//   `Character/TamingMob/_Canvas/_Canvas_00N.wz`；`reader.frame()` 会顺着外链解析，
//   并落到确定性命名的 PNG（`Character_TamingMob__Canvas_01902000.img_info_icon-<hash>.png`）。
//   实测 32×32、origin (0,32)。
//
// 幂等：`writePng` 命中已存在的确定性命名文件即跳过，重复运行不产生新文件。
//
// 用法（顺序有意义：`export_tms273_mounts_chairs.cjs` 读本脚本的产物来决定
// `spriteSourceStatus`，所以先跑本脚本）：
//   node scripts/export_tms273_mount_icons.cjs
//   node scripts/export_tms273_mounts_chairs.cjs

const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const CATALOG = path.join(ROOT, 'shared/mounts.json');
const TARGET = path.join(OUTPUT, 'mount-images.json');

/** 8 位补零镜像名（源目录用 8 位，运行时 id 不带前导零）。 */
const mirrorOf = id => String(id).padStart(8, '0');

async function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const ids = Object.keys(catalog.items ?? {});
  if (!ids.length) throw new Error(`坐骑目录为空: ${CATALOG}`);

  const reader = createReader(DATA);
  const images = {};
  const missing = [];
  try {
    for (const id of ids) {
      const source = `Character/TamingMob/${mirrorOf(id)}.img/info/icon`;
      try {
        const frame = await reader.frame(source, ASSETS);
        images[id] = frame;
      } catch (error) {
        // 源里就是没有这一件（例如目录登记了 id 但 WZ 无对应映像）。逐条记录，
        // 不补图、不猜图；缺口由调用方写进表里。
        missing.push({ id, reason: error.message.slice(0, 160) });
      }
    }
  } finally {
    reader.close?.();
  }

  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(TARGET, `${JSON.stringify(images, null, 2)}\n`, 'utf8');
  console.log(`骑宠图标：目录 ${ids.length} 件，导出 ${Object.keys(images).length} 件，源内无图标 ${missing.length} 件。`);
  if (missing.length) {
    console.log(`无图标样例（全部 ${missing.length} 条已随表记录在案）：`);
    for (const row of missing.slice(0, 5)) console.log(`  ${row.id} :: ${row.reason}`);
  }
  console.log(`帧表：${path.relative(ROOT, TARGET)}；PNG 落盘于 ${path.relative(ROOT, ASSETS)}`);
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
