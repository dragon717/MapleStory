#!/usr/bin/env node
//
// 导出 TMS273 宠物（Item/Pet）为运行时资源。
//
// 输入（源，只读）：
//   参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/Item/Pet/Pet_*.wz   精灵画布（拆分档，ResourceReader 自动解析 _000 存根）
//   参考/273/TMS273少爷一键端/手工服务端/tms273/WZ_JSON_TW/String/Pet.json  繁中名称/描述
//
// 输出（写入 resources/tms273-export/）：
//   pets.json        运行时目录：id -> { itemId, name, life, hungry, actions:[...] }（同时拷贝到 shared/pets.json 供服务端 include_str）
//   pet-images.json  装配清单节点：id -> { icon, stand[], move[], jump[], hungry[] }（AssetFrame，url 已带 /assets/tms273/ 前缀）
//   assets/tms273/*.png   画布 PNG（由 ResourceReader.frame 落盘，装配脚本按 manifest url 拷贝进客户端 public）
//
// 用法：node scripts/export_tms273_pet.cjs

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const root = path.resolve(__dirname, '..');
const data = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const output = path.join(root, 'resources/tms273-export');
const assets = path.join(output, 'assets/tms273');
const stringPet = path.join(root, '参考/273/TMS273少爷一键端/手工服务端/tms273/WZ_JSON_TW/String/Pet.json');

const reader = createReader(data, path.join(output, 'ms'));

const exported = new Map();
async function frame(source) {
  if (!exported.has(source)) {
    const f = await reader.frame(source, assets);
    assert(f.width > 0 && f.height > 0 && Number.isFinite(f.delay) && f.delay > 0, source);
    exported.set(source, { ...f, url: '/assets/tms273/' + f.url });
  }
  return exported.get(source);
}

async function get(source) {
  const n = await reader.get(source);
  if (n instanceof wz.WzImage) assert(await n.parseImage(), source);
  return n;
}

function numeric(node) {
  return [...(node?.wzProperties ?? [])]
    .filter((child) => /^\d+$/.test(child.name))
    .sort((a, b) => Number(a.name) - Number(b.name));
}

async function frames(source) {
  const node = await get(source);
  if (node instanceof wz.WzCanvasProperty) return [await frame(source)];
  const nodes = numeric(node);
  if (!nodes.length) return [];
  const result = [];
  for (const child of nodes) result.push(await frame(`${source}/${child.name}`));
  return result;
}

async function main() {
  fs.mkdirSync(assets, { recursive: true });
  const names = JSON.parse(fs.readFileSync(stringPet, 'utf8'));
  const petName = (id) => {
    const entry = names[id];
    const name = entry?.name?._value;
    return typeof name === 'string' && name.length ? name : null;
  };

  // 枚举源宠物图像：以 WZ 侧为准（String 表可能有幽灵条目）。
  const ids = [];
  for (let id = 5000000; id <= 5019999; id += 1) {
    const image = await reader.get(`Item/Pet/${id}.img`).catch(() => null);
    if (image) ids.push(id);
  }
  assert(ids.length > 500, `TMS273 宠物图像枚举异常：仅 ${ids.length} 只`);

  const pets = {};
  const petImages = {};
  let missingName = 0;
  for (const id of ids) {
    const image = await get(`Item/Pet/${id}.img`);
    const info = image.at('info');
    if (!info) continue;
    const name = petName(id);
    if (!name) {
      missingName += 1;
      continue;
    }
    const icon = await frame(`Item/Pet/${id}.img/info/icon`).catch(() => null);
    if (!icon) continue;
    const stand = await frames(`Item/Pet/${id}.img/stand0`);
    const move = await frames(`Item/Pet/${id}.img/move`);
    const jump = await frames(`Item/Pet/${id}.img/jump`);
    // 源 hungry 节点是宠物饥饿状态的原版动画；饱满度过低时客户端切换到它。
    // 个别宠物可能缺该节点，按源边界留空数组而不是伪造。
    const hungry = await frames(`Item/Pet/${id}.img/hungry`).catch(() => []);
    if (!stand.length) continue; // 无站立帧的记录（例如纯图标宠物）不进运行时目录
    const numericInfo = (key) => {
      const value = info?.at?.(key)?.wzValue;
      return Number.isFinite(value) ? value : null;
    };
    pets[id] = {
      itemId: id,
      name,
      life: numericInfo('life'),
      hungry: numericInfo('hungry'),
    };
    petImages[id] = { name, icon, stand, move, jump, hungry };
  }

  fs.writeFileSync(path.join(output, 'pets.json'), JSON.stringify(pets, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(output, 'pet-images.json'), JSON.stringify(petImages, null, 2) + '\n', 'utf8');
  // 服务端运行时目录（include_str）：只保留名字与驯养度字段。
  const shared = {};
  for (const [id, pet] of Object.entries(pets)) {
    shared[id] = { name: pet.name, life: pet.life, hungry: pet.hungry };
  }
  fs.writeFileSync(path.join(root, 'shared/pets.json'), JSON.stringify(shared, null, 2) + '\n', 'utf8');
  console.log(`273 Pet: ${Object.keys(pets).length} pets exported (${ids.length} images, ${missingName} without source name)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
