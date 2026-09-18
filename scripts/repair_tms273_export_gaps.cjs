#!/usr/bin/env node
// 修复导出树里「**已被清单引用、却不在盘上**」的资产。
//
// 背景（2026-09-18）：`resources/tms273-export` 是 .gitignore 覆盖的本地导出树，
// 一次中途失败的导出在它里面留下成片空洞。`assemble_tms273.cjs` 在复制前逐条
// `statSync`，把缺口一次性列全并落成台账 `artifacts/tms273_assemble_missing.json`。
//
// **缺口不是「源 WZ 被裁剪」**。已实测：`Character/Weapon/_Canvas/01702211.img/49/
// swingO3/0/weapon` 源侧读得出来（68×110），只是那一帧的落盘产物被删了。真正的
// 裁剪（`Weapon_000.wz`、`Weapon/_Canvas/_Canvas_004.wz`、`Pants_000.wz` 等）影响的是
// **别的**部位，与本台账不相干。
//
// 修法按**证据强度**排序，逐条只用能自证的那条：
//   1) 先用真正的导出器重跑（`export_tms273_mage_effects.cjs`、`export_tms273.cjs
//      boss-effects|effects`、`export_tms273_levelup.cjs`）。`writePng` 是
//      `if (!fs.existsSync(target))` ⇒ 天生只补缺、不重写已存在的字节。跑完拿台账里
//      逐帧的 `sha256` 复核。这一路**优先做，但不在本脚本里做**——它是重活，且每个
//      导出器都有自己的前置条件（例如特效导出器依赖的 `WZ_JSON_TW` 缺 `Skill/220.json`，
//      会在写完 PNG 之后的后续步骤 assert 失败）。
//   2) 本脚本：对导出器没有定向入口的条目，按 `SOURCE_RENDERS` 的**显式声明**从源重渲。
//      声明不会说谎——`sourceName(逻辑路径)` 必须逐字符等于缺口文件名（sha1 自校验），
//      渲染后还要与该帧被引用处声明的 `width`/`height` 对齐。
//   3) 两条都不行 ⇒ 明确报缺，非零退出。
//
// 用法：
//   node scripts/repair_tms273_export_gaps.cjs            # 只演算
//   node scripts/repair_tms273_export_gaps.cjs --apply    # 落盘
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createReader, sourceName, pngSize } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXPORT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(EXPORT, 'assets/tms273');
// 与 export_tms273_avatar.cjs / export_tms273_avatar_parts.cjs 的 DATA 是同一处；
// 那两份模块在 require 时就会做重活，所以这里直接构造路径。
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const LEDGER = path.join(ROOT, 'artifacts/tms273_assemble_missing.json');
const JOURNAL = path.join(ROOT, 'artifacts/tms273_export_gap_repair.json');

// `appearance-cashshop/01702211.json` 的 `actionsByWeaponTypeByGender[1]['49']`
// `.skill2001008[1].parts[0]` 引用了它。
//
// 为什么只能显式声明、不能从层 JSON 反推：紧凑现金层丢掉了武器每帧**真正的**源动作
// （本帧是 `swingO3`，而 `layer.actionSources.skill2001008` 记的是基座的 `energyBolt`），
// 且 JSON 帧下标是**基座时间线**的下标（本帧 json#1 对应源帧 0）。两者都不足以还原路径。
// 但声明是可验证的：下面的哈希自校验一旦不符就会当场失败，不会静默产出错文件。
const SOURCE_RENDERS = {
  'Character_Weapon__Canvas_01702211.img_49_swingO3_0_weapon-55d3790a19.png':
    'Character/Weapon/_Canvas/01702211.img/49/swingO3/0/weapon',
};

function selfCheckDeclarations() {
  for (const [fileName, logicalPath] of Object.entries(SOURCE_RENDERS)) {
    assert.equal(sourceName(logicalPath), fileName,
      `SOURCE_RENDERS 声明与文件名不符：${logicalPath}\n  算出 ${sourceName(logicalPath)}\n  期望 ${fileName}`);
  }
}

// 缺口 URL 被**哪些**帧引用、那些帧声明了多大。渲染结果必须与声明对齐，
// 否则说明我们渲的不是那一张图。
function declaredSizes(fileName) {
  const found = [];
  const dir = path.join(ASSETS, 'appearance-cashshop');
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!text.includes(fileName)) continue;
    const layer = JSON.parse(text);
    (function walk(value, trail) {
      if (Array.isArray(value)) {
        for (const frame of value) {
          if (!frame || typeof frame !== 'object') continue;
          // 尺寸挂在 **part** 上（紧凑层的帧只是容器），不是挂在帧上。
          for (const part of frame.parts ?? []) {
            if (part.url === `/assets/tms273/${fileName}`) {
              found.push({ layer: name, width: part.width, height: part.height, trail });
            }
          }
          walk(frame, trail);
        }
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, trail.concat(key));
      }
    })(layer, [name]);
  }
  return found;
}

async function main() {
  const apply = process.argv.includes('--apply');
  selfCheckDeclarations();
  assert(fs.existsSync(LEDGER), `缺口台账不存在，先跑一次 scripts/assemble_tms273.cjs：${path.relative(ROOT, LEDGER)}`);
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));

  const entries = ledger.missing.map(url => {
    const fileName = path.basename(url);
    const target = path.join(EXPORT, url.slice(1));
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return { url, fileName, mode: 'present' };
    const logicalPath = SOURCE_RENDERS[fileName];
    return logicalPath ? { url, fileName, mode: 'render', logicalPath } : { url, fileName, mode: 'unresolved' };
  });

  const unresolved = entries.filter(entry => entry.mode === 'unresolved');
  const toRender = entries.filter(entry => entry.mode === 'render');
  console.log(JSON.stringify({
    checked: entries.length,
    present: entries.filter(entry => entry.mode === 'present').length,
    render: toRender.length,
    unresolved: unresolved.length,
    apply,
  }));

  let reader = null;
  if (toRender.length && apply) reader = createReader(DATA);
  try {
    for (const entry of toRender) {
      if (!apply) {
        console.log(`  演算 ${entry.fileName} ← ${entry.logicalPath}`);
        continue;
      }
      const node = await reader.get(entry.logicalPath);
      // frame() 按 `sourceName(resolvedSource)` 落盘 —— 名字与声明同源，不会写歪。
      await reader.frame(node, ASSETS);
      const target = path.join(EXPORT, entry.url.slice(1));
      assert(fs.existsSync(target), `渲染后仍不存在：${entry.url}`);
      const size = pngSize(fs.readFileSync(target));
      const declared = declaredSizes(entry.fileName);
      assert(declared.length, `没有任何帧引用 ${entry.fileName}，渲染无从核对`);
      for (const frame of declared) {
        assert.equal(size.width, frame.width, `渲染宽度与 ${frame.layer} 的声明不符：${entry.fileName}`);
        assert.equal(size.height, frame.height, `渲染高度与 ${frame.layer} 的声明不符：${entry.fileName}`);
      }
      entry.mode = 'rendered';
      entry.rendered = { ...size, referencedBy: declared.map(frame => frame.layer) };
      console.log(`  已渲染 ${entry.fileName} ${size.width}x${size.height} ← ${entry.logicalPath}`);
    }
  } finally {
    reader?.close();
  }

  // **追加式日志**，不是「最近一次」的覆盖写。覆盖写会让「修过什么」在下次空跑时
  // 悄悄消失——本仓对「留下可回溯的台账」有明确偏好（sitSubstitutions、缺口台账同）。
  // 空跑（没有任何缺口要处理）不留痕，免得把「什么都没发生」刷成一堆噪声。
  const worthRecording = apply || entries.some(entry => entry.mode !== 'present');
  if (worthRecording) {
    fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
    const journal = fs.existsSync(JOURNAL)
      ? JSON.parse(fs.readFileSync(JOURNAL, 'utf8'))
      : { exportTree: path.relative(ROOT, EXPORT), runs: [] };
    journal.runs.push({
      at: new Date().toISOString(),
      ledger: path.relative(ROOT, LEDGER),
      apply,
      checked: entries.length,
      present: entries.filter(entry => entry.mode === 'present').length,
      rendered: entries.filter(entry => entry.mode === 'rendered').length,
      unresolved: unresolved.length,
      entries,
    });
    fs.writeFileSync(JOURNAL, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    console.log(`台账：${path.relative(ROOT, JOURNAL)}（第 ${journal.runs.length} 次记录）`);
  } else {
    console.log('本轮无缺口，未改写台账');
  }

  if (unresolved.length) {
    // 这一路是「导出器没定向入口、又没有可自证的源路径声明」。列全，不猜。
    console.error(`仍有 ${unresolved.length} 条无解，需要先跑对应的导出器：`);
    for (const entry of unresolved) console.error(`  ${entry.url}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
