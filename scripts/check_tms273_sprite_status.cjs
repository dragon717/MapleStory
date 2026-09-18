#!/usr/bin/env node

// 骑宠 / 椅子图标状态台账对账（无 npm 依赖）。
//
// 为什么单开一张门禁而不是信生成器：
// `shared/mounts.json` / `shared/chairs.json` 的 `spriteSourceStatus` 曾经**全表**写着
// `wz-present-unextracted`（935 + 2797 件），而磁盘上 935 张骑宠图标、2681 张椅子图标
// 早就导出并在服务目录里躺着——写者没把状态写下去，读的人就只能当「没查过」。
// 这是一份**自述**，不是事实；自述要有人对着事实核，否则它永远停留在上一次运行。
//
// 判据（**独立重算**，不 import 生成器的任何函数，免得写者与判据一起错）：
//   1. 帧表里有这条 id，且 `url` 指向的 PNG 在 `client/public-tms273` 下真实存在且非空
//      ⇒ 应有状态 `wz-verified`；
//   2. 否则 ⇒ 应有状态 `wz-missing`；
//   3. 帧表里出现、目录表没有的 id ⇒ 多余产物（反向断言，逐条列全）；
//   4. `shared` 与浏览器侧镜像（`client/public-tms273/assets`）必须是同一份表。
// 差异**一次列全**：撞到第一条就 throw 只会让人一条一条重跑。
//
// 用法：node scripts/check_tms273_sprite_status.cjs

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'client/public-tms273');
const MIRROR = path.join(SITE, 'assets');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const TABLES = [
  { kind: 'mounts', frames: 'resources/tms273-export/mount-images.json' },
  { kind: 'chairs', frames: 'resources/tms273-export/chair-images.json' },
];

/** 独立重算：这一件在磁盘上到底有没有可画图的产物。 */
function actualStatus(frameFile, id) {
  const frames = read(frameFile);
  const frame = frames[id];
  if (!frame || typeof frame.url !== 'string') return 'wz-missing';
  const file = path.join(SITE, frame.url.replace(/^\//, ''));
  if (!fs.existsSync(file)) return 'wz-missing';
  if (fs.statSync(file).size === 0) return 'wz-missing';
  return 'wz-verified';
}

const problems = [];
const summary = [];

for (const { kind, frames: frameRel } of TABLES) {
  const frameFile = path.join(ROOT, frameRel);
  const catalogFile = path.join(ROOT, 'shared', `${kind}.json`);
  if (!fs.existsSync(frameFile)) {
    problems.push(`${kind}: 帧表缺席 ${frameRel} ⇒ 状态本该停在 wz-present-unextracted，请确认图标导出跑过。`);
    continue;
  }
  if (!fs.existsSync(catalogFile)) {
    problems.push(`${kind}: 目录表缺席 ${path.relative(ROOT, catalogFile)}。`);
    continue;
  }
  const items = read(catalogFile).items ?? {};
  const frames = read(frameFile);
  const declared = { 'wz-verified': 0, 'wz-missing': 0, 'wz-present-unextracted': 0, other: 0 };
  const wrong = [];
  for (const [id, entry] of Object.entries(items)) {
    const status = entry.spriteSourceStatus;
    if (status === 'wz-verified') declared['wz-verified']++;
    else if (status === 'wz-missing') declared['wz-missing']++;
    else if (status === 'wz-present-unextracted') declared['wz-present-unextracted']++;
    else declared.other++;
    const should = actualStatus(frameFile, id);
    if (status !== should) wrong.push(`${id}: 声明 ${status ?? '(无)'}，实况 ${should}`);
  }
  // 反向断言：帧表里的 id 必须在目录表里有对应条目，否则是没人认领的产物。
  const orphan = Object.keys(frames).filter(id => !(id in items));
  summary.push(
    `${kind}: 声明 verified ${declared['wz-verified']} / missing ${declared['wz-missing']}` +
      ` / 未查 ${declared['wz-present-unextracted']}；实况不符 ${wrong.length} 条，帧表孤儿 ${orphan.length} 条`,
  );
  if (wrong.length) {
    problems.push(
      `${kind}: ${wrong.length} 条 spriteSourceStatus 与磁盘实况不符（前 20 条）：\n  - ` +
        wrong.slice(0, 20).join('\n  - '),
    );
  }
  if (orphan.length) {
    problems.push(`${kind}: 帧表里有 ${orphan.length} 条目录表没有的 id：${orphan.slice(0, 20).join(', ')}`);
  }
  // 浏览器侧镜像必须与 shared 同一份，否则「服务端认得、客户端查不到」。
  const mirrorFile = path.join(MIRROR, `${kind}.json`);
  if (!fs.existsSync(mirrorFile)) {
    problems.push(`${kind}: 浏览器侧镜像缺席 ${path.relative(ROOT, mirrorFile)}。`);
  } else {
    const mirror = read(mirrorFile).items ?? {};
    const onlyShared = Object.keys(items).filter(id => !(id in mirror));
    const onlyMirror = Object.keys(mirror).filter(id => !(id in items));
    const drift = Object.keys(items).filter(
      id => id in mirror && mirror[id].spriteSourceStatus !== items[id].spriteSourceStatus,
    );
    if (onlyShared.length || onlyMirror.length || drift.length) {
      problems.push(
        `${kind}: 镜像不同步（仅 shared ${onlyShared.length} / 仅镜像 ${onlyMirror.length} / 状态漂移 ${drift.length}）`,
      );
    }
  }
}

for (const line of summary) console.log(line);
if (problems.length) {
  for (const line of problems) console.error(`\n[红] ${line}`);
  console.error(`\n共 ${problems.length} 类问题：spriteSourceStatus 是自述，必须与磁盘实况一致。`);
  process.exit(1);
}
console.log('骑宠/椅子图标状态台账与磁盘实况一致。');
