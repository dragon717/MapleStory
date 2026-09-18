#!/usr/bin/env node
// 坐姿补丁的**精确影响面**探针。
//
// 客户端 `composeAppearance` 对每个动作走 `layerFrames(layer, action, ...)`；
// 该层没有该动作 ⇒ 返回 [] ⇒ **这一层在该动作里整层消失**（不是回落到自己的 stand）。
// 所以「哪些可装备层需要 sit」= 「哪些层的源映像里**真的有** sit 帧」。
//
// 本探针把 `appearance.json` 的 `layers`（普通装备）按 item 逐个核对：
//   · 该层现有 actions 键（9-17 基线的实测动作面）
//   · 源映像里 sit 是否存在
//   · sit 那一帧的每个子层能不能同时拿到**像素 + z/origin**（结构被裁的部位会缺）
const fs = require('node:fs');
const path = require('node:path');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = '/Users/muniao/Code/MapleStory';
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const EXPORT = path.join(ROOT, 'resources/tms273-export');

const appearance = JSON.parse(fs.readFileSync(path.join(EXPORT, 'appearance.json'), 'utf8'));

function children(node) { return [...(node?.wzProperties || [])]; }

(async () => {
  const reader = createReader(DATA);
  const byPart = new Map();
  try {
    // 1) 普通装备：按 part 归组，列出 9-17 基线里的动作键
    for (const [itemId, layer] of Object.entries(appearance.layers)) {
      const entry = byPart.get(layer.part) ?? { items: [], actionKeys: new Set(), samples: [] };
      entry.items.push(itemId);
      for (const k of Object.keys(layer.actions)) entry.actionKeys.add(k);
      if (entry.samples.length < 2) entry.samples.push({ itemId, source: layer.source });
      byPart.set(layer.part, entry);
    }

    console.log('=== 普通装备按部位（9-17 基线） ===');
    for (const [part, entry] of [...byPart].sort()) {
      const keys = [...entry.actionKeys].sort();
      console.log(`${part.padEnd(14)} 件数=${String(entry.items.length).padEnd(4)} 动作=${keys.join(',')}`);
    }

    // 2) 对每个部位的样本映像实测 sit
    console.log('\n=== 逐部位 sit 实测（源映像级） ===');
    for (const [part, entry] of [...byPart].sort()) {
      for (const { itemId, source } of entry.samples) {
        let acts = [];
        try {
          const img = await reader.get(source);
          if (typeof img.parseImage === 'function' && !img.parsed) await img.parseImage();
          acts = children(img).map(c => c.name);
        } catch (e) {
          console.log(`${part.padEnd(14)} ${itemId} ${source}  ✗ ${e.message}`);
          continue;
        }
        const hasSit = acts.includes('sit');
        let detail = '';
        if (hasSit) {
          const frame = await reader.get(`${source}/sit/0`).catch(() => null);
          const names = frame ? children(frame).map(c => c.name) : [];
          const bits = [];
          for (const n of names) {
            const node = await reader.get(`${source}/sit/0/${n}`).catch(() => null);
            const f = node ? await reader.frame(node, null).catch(() => null) : null;
            bits.push(`${n}[z=${node?.at?.('z')?.wzValue ?? '无'} og=${node?.at?.('origin') ? 'y' : '无'} px=${f ? f.width + 'x' + f.height : '✗'}]`);
          }
          detail = ' sit层: ' + bits.join(' ');
        }
        console.log(`${part.padEnd(14)} ${itemId} sit=${hasSit ? 'YES' : 'no '}${detail}`);
      }
    }
  } finally {
    reader.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
