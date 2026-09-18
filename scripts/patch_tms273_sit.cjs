#!/usr/bin/env node
// 增量坐姿（`sit`）补丁 —— 只往既有外观清单里**补一个动作**，不重算其余 27 个。
//
// ## 为什么不重跑整条导出
// 9-17 的 `appearance.json` / `appearance-cashshop/*.json` 是在源包**完整**时导出的，
// 里面 27 个动作的 z/origin 都来自当时的 WZ 结构分卷。之后源包被裁剪
// （见 `audit_tms273_source_volumes.cjs`：Character 子树缺 6 个分卷），
// 现在再整跑一遍，那些分卷缺席的部位只会读出 (0,0)——**把正确的旧值覆盖成错的**。
// 所以这里只算 `sit`，其余动作在字节层面保持与基线一致。
//
// ## 两个源事实决定了本补丁的形状
//  1. `_Canvas/` 并行树只有**像素**，节点属性为 0 个（无 `z`、无 `origin`、无 `map`）。
//     结构分卷一旦缺席（`Pants_000.wz`），该部位的几何就**读不出来**了。
//  2. 坐姿层帧要优先采用源里的 `sit`，以保留真实锚点和材质；客户端对 sit/ride
//     另有带锚点位移的 standing 兼容策略，用来覆盖源里没有该动作的层。补丁仍把
//     已声明的 sit 尽量写入清单，避免把可核实的源姿势降级成兼容帧。
//
// ## 缺料层怎么办（`--gaps` 策略）
//  · `substitute`（默认）：用该层**自己的 `stand` 帧**顶上，按基座（body）在 two pose
//    之间的锚点位移平移，并在每个部件上打 `substitutedFrom:'stand'`。
//    理由：几何与像素都来自同一件、同一份基线的**既有制品**，不是凭空造的；
//    平移量取自基座自己导出的锚点，可复核。代价是这一层画的是站姿图形。
//  · `omit`：该层在 sit 帧里不出现（会看见没穿裤子的坐姿）。
// 两种都会逐条写进产物里的 `sitSubstitutions`，不做静默降级。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const avatar = require('./export_tms273_avatar.cjs');
const parts = require('./export_tms273_avatar_parts.cjs');
const { partVolumeGap } = require('./audit_tms273_source_volumes.cjs');

const {
  OUTPUT, reader, loadSourceTables, actionSet, staticFace, leavesFor, compose,
  get, SUPPORT,
} = avatar;
const { NORMAL_SOURCES } = parts;

const APPEARANCE = path.join(OUTPUT, 'appearance.json');
const CASH_DIR = path.join(OUTPUT, 'assets/tms273/appearance-cashshop');
const BASE_PARTS = ['body', 'head', 'pants', 'shoes'];

function parseArgs() {
  const out = { gaps: 'substitute', apply: false };
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'gaps') out.gaps = value;
    else if (key === 'apply') out.apply = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  assert(['substitute', 'omit'].includes(out.gaps), `--gaps 只能是 substitute|omit，收到 ${out.gaps}`);
  return out;
}

const OPTIONS = parseArgs();
const substitutions = [];       // 逐条留档：哪一层因为什么走了替代
// 「源里本就没有 sit」在 1713 件现金层里会命中上千次。逐件写进清单只会把清单撑大，
// 却提供不了额外信息 —— 按 (部位, 原因) 归并计数。
const skipped = new Map();      // `${part}\0${note}` -> { part, note, count, sample }
function noteSkipped(part, image, note) {
  const key = `${part}\0${note}`;
  const entry = skipped.get(key) ?? { part, note, count: 0, sample: image };
  entry.count += 1;
  skipped.set(key, entry);
}

/** `Character/Pants/01060003.img` → `Pants` */
function partDirOf(image) {
  const segments = image.split('/');
  return segments[segments.length - 2];
}

/**
 * 这张图的几何/像素是否可信——判据是**清单声明**，不是试读。
 * 某个分卷被裁掉时，试读可能因为「这次用到的那张图恰好在别的分卷里」而假成功。
 */
function trust(image) {
  const part = partDirOf(image);
  const structure = partVolumeGap(part, true);
  const pixels = partVolumeGap(part, false);
  return {
    geometry: !(structure?.missing.length),
    pixels: !(pixels?.missing.length),
    part,
  };
}

async function sourceDeclares(image, action, actionPrefix = undefined) {
  try {
    const root = actionPrefix ? `${image}/${actionPrefix}` : image;
    await get(`${root}/${action}/0`);
    return true;
  } catch {
    return false;
  }
}

function filterParts(actions, predicate) {
  return Object.fromEntries(Object.entries(actions).map(([name, frames]) => [
    name,
    frames.map(frame => ({ ...frame, parts: frame.parts.filter(predicate) })),
  ]));
}

const ANCHOR_BY_PART = Object.freeze({
  head: 'neck', face: 'brow', hair: 'brow', cap: 'brow',
  faceAccessory: 'brow', accessory: 'brow', weapon: 'hand',
});
const anchorFor = part => ANCHOR_BY_PART[part] ?? 'navel';

/**
 * 取一个层树里的**性别键**。只认数字键：基线里 `hair:30020` 的
 * `actionsByGender` 带着一个 `'undefined'` 桶——那是 `addLayer` 被第三次调用时
 * `String(existing.gender)` 得到的键（既有缺陷，不是本补丁引入）。
 * 拿它去索引 `base[...]` 会得到 NaN，必须挡在门外。
 */
function genderKeysOf(actionsByGender) {
  const keys = Object.keys(actionsByGender ?? {});
  const numeric = keys.filter(key => /^\d+$/.test(key));
  return { numeric, ignored: keys.filter(key => !/^\d+$/.test(key)) };
}

/** Enumerate every authored action tree, including cash-weapon branches. */
function actionTreeDescriptors(layer) {
  const trees = [];
  const hasDirect = Boolean(layer.actions);
  if (hasDirect) trees.push({ actions: layer.actions, gender: layer.gender ?? 0 });
  for (const [gender, actions] of Object.entries(layer.actionsByGender ?? {})) {
    if (/^\d+$/.test(gender) && (!hasDirect || gender !== '0')) trees.push({ actions, gender: Number(gender) });
  }
  const hasDirectWeaponTypes = Object.keys(layer.actionsByWeaponType ?? {}).length > 0;
  for (const [weaponType, actions] of Object.entries(layer.actionsByWeaponType ?? {})) {
    trees.push({ actions, gender: layer.gender ?? 0, weaponType });
  }
  for (const [gender, byType] of Object.entries(layer.actionsByWeaponTypeByGender ?? {})) {
    if (!/^\d+$/.test(gender)) continue;
    if (hasDirectWeaponTypes && gender === '0') continue;
    for (const [weaponType, actions] of Object.entries(byType ?? {})) {
      trees.push({ actions, gender: Number(gender), weaponType });
    }
  }
  return trees;
}

/** 两个 pose 之间基座锚点的位移；任一侧没有锚点则返回 null（由调用方退到别处）。 */
function anchorDelta(fromFrame, toFrame, anchor) {
  const pick = frame => frame?.anchors?.[anchor] ?? frame?.anchors?.navel;
  const from = pick(fromFrame);
  const to = pick(toFrame);
  if (!from || !to) return null;
  return { x: to.x - from.x, y: to.y - from.y };
}

function compactPart(p) {
  return { key: p.key, url: p.url, x: p.x, y: p.y, origin: p.origin, z: p.z,
    width: p.width, height: p.height, part: p.part, zName: p.zName, itemId: p.itemId };
}

function compactFrames(frames) {
  return frames.map(frame => ({ delay: frame.delay, parts: frame.parts.map(compactPart) }));
}

/** 基座（纸娃娃底板）的 sit 帧；`substitutePants` 决定缺料的 pants 层怎么处理。 */
async function baseSitFrames(gender, standFrame) {
  const sources = { ...NORMAL_SOURCES[gender], face: undefined, hair: undefined };
  const set = await actionSet([], false, { sources, onlyActions: ['sit'] });
  const frames = filterParts(set.actions, p => BASE_PARTS.includes(p.part)).sit;
  assert(frames?.length === 1, `基座 sit 必须是单帧，实得 ${frames?.length}`);
  const frame = frames[0];
  // 静态动作没有源 delay；导出契约把它规范为 0，客户端 frameAt 固定取第 0 帧。
  frame.delay = 0;
  const pantsImage = sources.pants;
  const pantsTrust = trust(pantsImage);
  if (await sourceDeclares(pantsImage, 'sit')) {
    if (pantsTrust.geometry) {
      const broken = frame.parts.filter(p => p.part === 'pants'
        && p.origin.x === 0 && p.origin.y === 0 && p.x === 0 && p.y === 0);
      if (broken.length) {
        applyGapPolicy(frame, standFrame, 'pants', pantsImage, '结构分卷 Pants_000.wz 缺席，z/origin 读不出',
          { stand: standFrame, sit: frame }, false);
      }
    } else {
      applyGapPolicy(frame, standFrame, 'pants', pantsImage,
        `结构分卷缺席（${pantsTrust.part}），坐姿裤子的 z/origin 不在源里`,
        { stand: standFrame, sit: frame }, false);
    }
  }
  assert.equal(set.actionSources.sit.delays.length, 1, '基座 sit 应为单帧');
  set.actionSources.sit.delays = [0];
  return { frames, actionSource: set.actionSources.sit };
}

/**
 * 缺料策略落地：把 `part` 的 sit 部件换成 stand 帧里同名部件的副本并平移到 sit 基座。
 * 打 `substitutedFrom:'stand'` 让替代在产物里可查。
 *
 * 位移量取「stand → sit 的基座锚点位移」。现金层是**紧凑**格式，帧里不带 `anchors`，
 * 此时退到基座（`base[g]`）自己的两个帧——那也是同一次导出的既有数据。
 */
function applyGapPolicy(sitFrame, standFrame, part, image, reason, baseAnchors = {}, compact = false) {
  const standParts = standFrame.parts.filter(p => p.part === part);
  if (!standParts.length) {
    noteSkipped(part, image, 'stand 帧也没有这一层，无可替代');
    return;
  }
  const anchor = anchorFor(part);
  let delta = anchorDelta(standFrame, sitFrame, anchor);
  let deltaSource = 'layer';
  if (!delta) {
    delta = anchorDelta(baseAnchors.stand, baseAnchors.sit, anchor) ?? { x: 0, y: 0 };
    deltaSource = 'base';
  }
  const replacement = standParts.map(p => ({ ...p, x: p.x + delta.x, y: p.y + delta.y, substitutedFrom: 'stand' }));
  sitFrame.parts = [...sitFrame.parts.filter(p => p.part !== part), ...replacement];
  substitutions.push({ part, image, action: 'sit', policy: OPTIONS.gaps, reason,
    anchor, delta, deltaSource, parts: replacement.length, compact });
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => reader.close());

async function main() {
  const appearance = JSON.parse(fs.readFileSync(APPEARANCE, 'utf8'));
  assert.equal(appearance.contentVersion, 'tms273-avatar-parts', '基线 contentVersion 不符，拒绝就地补丁');
  await loadSourceTables();

  // ---- 1) 基座：两个性别的纸娃娃底板 ----
  let sitActionSource = null;
  for (const gender of [0, 1]) {
    const base = appearance.base[String(gender)];
    const standFrame = base.actions.stand?.[0];
    assert(standFrame, `base[${gender}].actions.stand 缺席`);
    const { frames, actionSource } = await baseSitFrames(gender, standFrame);
    base.actions.sit = frames;
    base.actionSources = { ...base.actionSources, sit: actionSource };
    sitActionSource ??= actionSource;
  }
  appearance.actionSources.sit = sitActionSource;
  console.log(`基座 sit 已算：gender 0/1，每帧 ${appearance.base['0'].actions.sit[0].parts.length} 部件`);

  // ---- 2) 普通装备层（layers）----
  let layerCount = 0;
  const ignoredGenderBuckets = [];
  for (const [key, layer] of Object.entries(appearance.layers)) {
    const { ignored } = genderKeysOf(layer.actionsByGender);
    for (const bad of ignored) ignoredGenderBuckets.push(`${key}.actionsByGender['${bad}']`);
    for (const tree of actionTreeDescriptors(layer)) {
      layerCount += await injectLayer(key, layer, tree.actions, appearance, tree.gender, tree.weaponType);
    }
  }
  console.log(`普通装备层 sit 已算：${layerCount} 棵动作树`);
  if (ignoredGenderBuckets.length) {
    console.log(`跳过非数字性别桶 ${ignoredGenderBuckets.length} 个（基线既有缺陷）：${ignoredGenderBuckets.join(', ')}`);
  }

  // ---- 3) 现金层（逐件 JSON，紧凑格式）----
  let cashCount = 0;
  const cashFiles = fs.existsSync(CASH_DIR) ? fs.readdirSync(CASH_DIR).filter(f => f.endsWith('.json')) : [];
  for (const file of cashFiles) {
    const itemId = path.basename(file, '.json');
    const meta = appearance.cashAppearance.items[itemId];
    if (!meta) continue;
    const filePath = path.join(CASH_DIR, file);
    const layer = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let touched = 0;
    for (const tree of actionTreeDescriptors(layer)) {
      touched += await injectCompactLayer(itemId, meta, { actions: tree.actions }, appearance, tree.gender, tree.weaponType);
    }
    if (touched) {
      fs.writeFileSync(filePath, `${JSON.stringify(layer)}\n`, 'utf8');
      cashCount += 1;
    }
  }
  console.log(`现金层 sit 已算：${cashCount} 件`);

  // ---- 4) 缺口与替代留档 ----
  appearance.sitSubstitutions = substitutions;
  appearance.sitSkipped = [...skipped.values()].sort((a, b) => b.count - a.count);
  appearance.sitPatch = {
    patchedAt: new Date().toISOString(),
    gapsPolicy: OPTIONS.gaps,
    note: '只新增 sit；其余动作与 9-17 基线逐字节一致。substitutedFrom=stand 的部件是按基座锚点位移后的站姿图形。',
  };
  if (OPTIONS.apply) {
    fs.writeFileSync(APPEARANCE, `${JSON.stringify(appearance, null, 2)}\n`, 'utf8');
    console.log(`已写入 ${path.relative(process.cwd(), APPEARANCE)}`);
  } else {
    console.log('（未加 --apply，仅演算。加 --apply 才落盘。）');
  }
  console.log(JSON.stringify({
    substituted: substitutions.length,
    skippedGroups: skipped.size,
    substitutionReasons: [...new Set(substitutions.map(s => `${s.part}: ${s.reason}`))],
    skippedReasons: [...skipped.values()].map(s => `${s.part}: ${s.note} ×${s.count}`),
  }, null, 2));
}

/** 宽松版：layers / base 用完整帧对象。 */
async function injectLayer(key, layer, actions, appearance, genderOverride = undefined, weaponType = undefined) {
  const gender = genderOverride ?? layer.gender ?? 0;
  const result = await computeSit(layer.source, layer.part, layer.itemId ?? key, gender, actions, appearance, false, weaponType);
  if (!result) return 0;
  actions.sit = result;
  return 1;
}

/** 现金层用紧凑帧对象。 */
async function injectCompactLayer(itemId, meta, layer, appearance, genderOverride = undefined, weaponType = undefined) {
  const result = await computeSit(meta.source, meta.part, itemId, genderOverride ?? 0, layer.actions, appearance, true, weaponType);
  if (!result) return 0;
  layer.actions.sit = compactFrames(result);
  return 1;
}

/**
 * 算一个层的 sit 帧。返回 null 表示「源里本就没有这个动作」——那是作者的缺席，
 * 不是缺口，不补也不记。
 */
async function computeSit(image, part, itemId, gender, existingActions, appearance, compact = false, weaponType = undefined) {
  const standFrames = existingActions?.stand;
  const declared = part === 'face' ? true : await sourceDeclares(image, 'sit', weaponType);
  if (!declared) {
    noteSkipped(part, image, '源 WZ 里没有 sit 节点（作者未编写）');
    return null;
  }
  const standFrame = standFrames?.[0];
  const baseSitFrame = appearance.base[String(gender)].actions.sit[0];
  if (!standFrame) return null;

  let frame;
  if (part === 'face') {
    // 脸是静态层：源里没有 sit，用它的 `default/face` 画布，与其他动作同策。
    frame = { delay: 0, parts: [compose(await staticFace(image), baseSitFrame.anchors)] };
  } else if (part === 'hair') {
    const leaves = await leavesFor(image, 'hair', 'sit', 0, 'hair');
    frame = { delay: 0, parts: leaves.map(c => compose(c, baseSitFrame.anchors)) };
  } else {
    const sources = { ...NORMAL_SOURCES[gender], face: undefined, hair: undefined };
    SUPPORT.set(itemId, { part, image, itemId, actionPrefix: weaponType });
    SUPPORT.set(String(Number(itemId)), { part, image, itemId, actionPrefix: weaponType });
    const set = await actionSet([itemId], false, { sources, onlyActions: ['sit'] });
    const frames = filterParts(set.actions, p => p.itemId === itemId && p.part === part).sit;
    assert(frames?.length === 1, `${itemId} 的 sit 必须是单帧，实得 ${frames?.length}`);
    frame = frames[0];
  }

  // 静态动作契约见 `export_tms273_avatar.cjs` 的 ACTIONS 注释：源里没有 delay，
  // 产物写 0，客户端 frameAt 固定取第 0 帧。
  frame.delay = 0;

  // 判据作用在**观察到的几何**上，而不是「这个部位的分卷集合完不完整」。
  // 后者会把「映像其实住在健全的那一卷里」误判成缺料（`Weapon` 缺 `_000`，
  // 但大量武器映像住在 `_001`，它们的 z/origin 是读得出来的）。
  const degenerate = frame.parts.length > 0 && frame.parts.every(p =>
    p.origin?.x === 0 && p.origin?.y === 0 && p.x === 0 && p.y === 0);
  if (frame.parts.length === 0 || degenerate) {
    // 分卷审计只用来**写清原因**，不用来做判定。
    const info = trust(image);
    const reason = frame.parts.length === 0
      ? (info.pixels ? '源声明了 sit 但没有任何可用部件' : `像素分卷缺席（${info.part}/_Canvas），sit 的贴图不在源里`)
      : (info.geometry ? '读出的几何退化为 (0,0)' : `结构分卷缺席（${info.part}），sit 的 z/origin 不在源里`);
    if (OPTIONS.gaps === 'omit') {
      frame.parts = [];
      substitutions.push({ part, image, action: 'sit', policy: 'omit', reason, parts: 0, compact });
    } else {
      applyGapPolicy(frame, standFrame, part, image, reason,
        { stand: appearance.base[String(gender)].actions.stand?.[0], sit: baseSitFrame }, compact);
    }
  }
  return [frame];
}
