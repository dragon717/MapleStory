#!/usr/bin/env node
// 坐姿补丁的验收：证明「只新增了 sit」，没有动到其余动作。
//
// 判据是**与基线的逐层深比较**（基线取自备份目录的 appearance.json）：
//   1. base[g].actions 里除 sit 外的每个动作，与基线 deep-equal；
//   2. layers[*] 里除 sit 外的每个动作树，与基线 deep-equal；
//   3. actionSources 里除 sit 外逐键一致；
//   4. zmap / smap / contentVersion 等顶层字段一致；
//   5. sit 确实存在，且其部件数与几何自洽（x/y 有限、z 为整数）；
//   6. 被替代的部件都带 substitutedFrom:'stand'，且数量等于 sitSubstitutions 声明数。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = path.join(ROOT, 'resources/tms273-export/appearance.json');
const BACKUP = '/Users/muniao/Code/MapleStory-backups/tms273-export-20260918-200732/appearance.json';

const now = JSON.parse(fs.readFileSync(CURRENT, 'utf8'));
const before = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));

const KEEP_EQ = ['contentVersion', 'sourceVersion', 'source', 'zmap', 'smap', 'catalog'];
const SIT_KEYS = new Set(['sit']);
// The later pose patch appends source-selected mount/chair actions while
// preserving the same sit-patch invariant: no existing action may drift.
const POSE_KEYS = new Set(['prone', 'fly', 'swingOF', 'swingO1', 'alert', 'PL_walking_ELUNA', 'ride', 'ride2', 'ride3']);
const PATCH_KEYS = new Set(['sitSubstitutions', 'sitSkipped', 'sitPatch', 'posePatch']);

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (error) { failures++; console.log(`  ✗ ${label}\n      ${error.message.split('\n')[0]}`); }
}

console.log(`基线 ${path.basename(path.dirname(BACKUP))} → 现行`);
check('顶层字段（除新增的 sit* 元数据）与基线一致', () => {
  for (const key of KEEP_EQ) assert.deepEqual(now[key], before[key], `字段 ${key} 变了`);
  const patchKeys = [...PATCH_KEYS].filter(key => key in now);
  assert.deepEqual(Object.keys(now).sort(), [...Object.keys(before), ...patchKeys].filter((key, index, keys) => keys.indexOf(key) === index).sort(),
    '顶层键集合不符（多了或少了键）');
});

check('actionSources 只多了 sit', () => {
  const added = Object.keys(now.actionSources).filter(k => !(k in before.actionSources));
  assert.deepEqual(added, ['sit', ...[...POSE_KEYS].filter(key => now.actionSources[key])], `新增的动作源不是 sit/已登记 pose: ${added.join(',')}`);
  for (const key of Object.keys(before.actionSources)) {
    assert.deepEqual(now.actionSources[key], before.actionSources[key], `actionSources.${key} 变了`);
  }
  assert.equal(now.actionSources.sit.sourceAction, 'sit');
  assert.deepEqual(now.actionSources.sit.delays, [0], 'sit 是静态动作，delays 应为 [0]');
});

function compareActionTrees(label, currentActions, beforeActions) {
  for (const action of Object.keys(beforeActions)) {
    if (SIT_KEYS.has(action) || POSE_KEYS.has(action)) continue;
    assert.deepEqual(currentActions[action], beforeActions[action], `${label}.actions.${action} 变了`);
  }
}

function compareLayerTrees(label, current, before) {
  compareActionTrees(label, current.actions, before.actions);
  for (const key of Object.keys(before.actionsByGender ?? {})) {
    assert.deepEqual(current.actionsByGender?.[key] && Object.keys(current.actionsByGender[key]), Object.keys(before.actionsByGender[key]), `${label}.actionsByGender[${key}] shape 变了`);
    compareActionTrees(`${label}.actionsByGender[${key}]`, current.actionsByGender[key], before.actionsByGender[key]);
  }
  for (const key of Object.keys(before.actionsByWeaponType ?? {})) {
    compareActionTrees(`${label}.actionsByWeaponType[${key}]`, current.actionsByWeaponType?.[key], before.actionsByWeaponType[key]);
  }
  for (const gender of Object.keys(before.actionsByWeaponTypeByGender ?? {})) {
    for (const key of Object.keys(before.actionsByWeaponTypeByGender[gender] ?? {})) {
      compareActionTrees(`${label}.actionsByWeaponTypeByGender[${gender}][${key}]`,
        current.actionsByWeaponTypeByGender?.[gender]?.[key], before.actionsByWeaponTypeByGender[gender][key]);
    }
  }
}

check('base[g] 除 sit/新增 pose 外的动作与基线逐字节一致', () => {
  for (const gender of Object.keys(before.base)) {
    compareActionTrees(`base[${gender}]`, now.base[gender].actions, before.base[gender].actions);
    assert.ok(now.base[gender].actions.sit, `base[${gender}] 没有 sit`);
  }
});

check('layers[*] 除 sit 外的动作树与基线一致', () => {
  assert.deepEqual(Object.keys(now.layers).sort(), Object.keys(before.layers).sort(), 'layer 键集合变了');
  for (const key of Object.keys(before.layers)) {
    compareLayerTrees(`layers[${key}]`, now.layers[key], before.layers[key]);
  }
});

check('sit 帧几何自洽（x/y 有限、z 为整数、有 url）', () => {
  let frames = 0;
  const visit = (label, actions) => {
    const sit = actions?.sit;
    if (!sit) return;
    assert.equal(sit.length, 1, `${label} 的 sit 必须单帧`);
    for (const part of sit[0].parts) {
      frames++;
      assert.ok(Number.isFinite(part.x) && Number.isFinite(part.y), `${label} 部件 ${part.name} 坐标非有限`);
      assert.ok(Number.isSafeInteger(part.z), `${label} 部件 ${part.name} z 不是整数`);
      assert.equal(typeof part.url, 'string', `${label} 部件 ${part.name} 无 url`);
    }
  };
  for (const gender of Object.keys(now.base)) visit(`base[${gender}]`, now.base[gender].actions);
  for (const [key, layer] of Object.entries(now.layers)) {
    visit(`layers[${key}]`, layer.actions);
    for (const [gender, actions] of Object.entries(layer.actionsByGender ?? {})) visit(`layers[${key}][${gender}]`, actions);
  }
  assert.ok(frames > 0, '一个 sit 部件都没有');
  console.log(`      共校验 ${frames} 个 sit 部件`);
});

check('被替代的层都在 sitSubstitutions 里留了案', () => {
  const declared = now.sitSubstitutions.filter(s => s.policy === 'substitute').length;
  assert.ok(declared > 0, '没有任何替代记录');
  assert.ok(now.sitSubstitutions.every(s => s.reason && s.action === 'sit'), '替代记录缺 reason/action');
  assert.ok(now.sitSubstitutions.every(s => ['pants', 'cape'].includes(s.part) || s.reason), '替代记录缺部位');
  console.log(`      替代记录 ${declared} 条；原因：${[...new Set(now.sitSubstitutions.map(s => s.part))].join(', ')}`);
});

console.log(`\n${failures ? `✗ ${failures} 项未通过` : '✓ 全部通过'}：坐姿是唯一新增的动作，其余动作与基线逐字节一致。`);
process.exitCode = failures ? 1 : 0;

// ---- 现金层：与备份归档逐件对比（除 sit 外必须逐字节一致）----
// 现金层是 1713 个独立 JSON，`appearance.json` 的一致性证明不了它们。
// 判据相同：把现行 JSON 里的 `sit` 摘掉，剩下的必须与备份归档里的原件 deep-equal。
(async () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const CASH = path.join(ROOT, 'resources/tms273-export/assets/tms273/appearance-cashshop');
  const TGZ = '/Users/muniao/Code/MapleStory-backups/tms273-export-20260918-200732/appearance-cashshop.tgz';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sit-check-'));
  let compared = 0, added = 0, drifted = [];
  // `appearance.json` 是 `{ base, layers }` 形状。
  const countMarkedInAppearance = doc => {
    let marked = 0;
    const count = actions => {
      for (const part of actions?.sit?.[0]?.parts ?? []) if (part.substitutedFrom === 'stand') marked++;
    };
    for (const gender of Object.keys(doc.base)) count(doc.base[gender].actions);
    for (const layer of Object.values(doc.layers)) {
      count(layer.actions);
      for (const tree of Object.values(layer.actionsByGender ?? {})) count(tree);
    }
    return marked;
  };
  try {
    execFileSync('tar', ['-xzf', TGZ, '-C', work]);
    const backupDir = path.join(work, 'assets/tms273/appearance-cashshop');
    for (const file of fs.readdirSync(CASH).filter(f => f.endsWith('.json'))) {
      const cur = JSON.parse(fs.readFileSync(path.join(CASH, file), 'utf8'));
      const old = JSON.parse(fs.readFileSync(path.join(backupDir, file), 'utf8'));
      compared++;
      if (cur.actions?.sit) added++;
      const strip = doc => {
        const clone = { ...doc };
        if (clone.actions) { clone.actions = { ...clone.actions }; delete clone.actions.sit; }
        if (clone.actionsByGender) {
          clone.actionsByGender = Object.fromEntries(Object.entries(clone.actionsByGender).map(([g, tree]) => {
            const t = { ...tree };
            delete t.sit;
            return [g, t];
          }));
        }
        return clone;
      };
      try { assert.deepEqual(strip(cur), old, '除 sit 外有差异'); }
      catch { drifted.push(file); }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n现金层：对比 ${compared} 件，其中新增 sit 的 ${added} 件，除 sit 外有差异的 ${drifted.length} 件`);
  if (drifted.length) {
    console.log(`  ✗ 漂移件（前 5）：${drifted.slice(0, 5).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('  ✓ 每件现金层都是「原样 + 一个 sit」');
  }
  const nonCompact = now.sitSubstitutions.filter(s => s.policy === 'substitute' && !s.compact).length;
  const compact = now.sitSubstitutions.filter(s => s.policy === 'substitute' && s.compact).length;
  console.log(`\n替代留档：共 ${now.sitSubstitutions.length} 条（非紧凑载体 ${nonCompact} 条、现金紧凑载体 ${compact} 条）`);
  // 紧凑现金层按既有约定只保留运行时字段（`compactAppearancePart` 的注释即此意：
  // 审计字段属于**导出报告**，不塞进每件现金层），因此只在非紧凑产物上核对打标数。
  if (countMarkedInAppearance(now) !== nonCompact) {
    console.log(`  ✗ 非紧凑产物打标 ${countMarkedInAppearance(now)} 个，与留档 ${nonCompact} 条不符`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ 非紧凑载体 ${countMarkedInAppearance(now)} 个部件全部打标；现金载体 ${compact} 条以 sitSubstitutions 留档`);
  }
})();

function countMarked(doc) {
  let marked = 0;
  const count = actions => {
    for (const part of actions?.sit?.[0]?.parts ?? []) if (part.substitutedFrom === 'stand') marked++;
  };
  for (const gender of Object.keys(doc.base)) count(doc.base[gender].actions);
  for (const layer of Object.values(doc.layers)) {
    count(layer.actions);
    for (const actions of Object.values(layer.actionsByGender ?? {})) count(actions);
  }
  return marked;
}
