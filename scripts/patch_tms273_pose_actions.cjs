#!/usr/bin/env node
// Incrementally add the source character poses selected by mount/chair scenes.
// This patch only appends missing base actions to an existing appearance
// catalogue.  It deliberately leaves the already-correct layer/cash files
// untouched; composeAppearance supplies the documented standing fallback for
// layers that do not author the selected source action.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const avatar = require('./export_tms273_avatar.cjs');
const parts = require('./export_tms273_avatar_parts.cjs');

const { OUTPUT, reader, loadSourceTables, actionSet } = avatar;
const { NORMAL_SOURCES } = parts;
const APPEARANCE = path.join(OUTPUT, 'appearance.json');
const BASE_PARTS = new Set(['body', 'head', 'pants', 'shoes']);
const POSE_ACTIONS = Object.freeze([
  'prone', 'fly', 'swingOF', 'swingO1', 'alert', 'PL_walking_ELUNA',
  'ride', 'ride2', 'ride3',
]);

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) assert(arg === '--apply', `未知参数: ${arg}`);
  return { apply: args.has('--apply') };
}

function baseFrames(frames) {
  return frames.map(frame => ({
    ...frame,
    parts: frame.parts.filter(part => BASE_PARTS.has(part.part)),
  }));
}

async function main() {
  const { apply } = parseArgs();
  const appearance = JSON.parse(fs.readFileSync(APPEARANCE, 'utf8'));
  assert.equal(appearance.contentVersion, 'tms273-avatar-parts', '外观清单 contentVersion 不符');
  await loadSourceTables();

  const added = [];
  const existing = [];
  const sourceActions = {};
  for (const gender of [0, 1]) {
    const key = String(gender);
    const base = appearance.base[key];
    assert(base?.actions?.stand?.length, `base[${gender}] 缺少 stand`);
    const sources = { ...NORMAL_SOURCES[gender], face: undefined, hair: undefined };
    const result = await actionSet([], false, {
      sources,
      appearanceVariants: true,
      onlyActions: POSE_ACTIONS,
    });
    sourceActions[key] = result.actionSources;
    base.actionSources = {
      ...base.actionSources,
      ...(appearance.actionSources?.sit ? { sit: appearance.actionSources.sit } : {}),
      ...result.actionSources,
    };
    for (const action of POSE_ACTIONS) {
      if (base.actions[action]) {
        existing.push(`${key}:${action}`);
        continue;
      }
      const frames = baseFrames(result.actions[action]);
      assert(frames.length, `base[${gender}].${action} 无帧`);
      base.actions[action] = frames;
      added.push(`${key}:${action}`);
    }
  }

  appearance.actionSources = { ...appearance.actionSources };
  for (const action of POSE_ACTIONS) {
    // Gender 0/1 share the same source timing contract. Keep the per-gender
    // source details in posePatch, while actionSources remains compatible with
    // the existing catalogue shape consumed by the client.
    appearance.actionSources[action] ??= sourceActions['0'][action];
  }
  appearance.posePatch = {
    patchedAt: new Date().toISOString(),
    actions: POSE_ACTIONS,
    sourceActions: sourceActions['0'],
    sourceActionsByGender: sourceActions,
    layerPolicy: 'appearance-compose-standing-fallback',
    layerNote: '既有 layer/cash JSON 不重算；没有源动作的部件由 appearance.ts 保留 stand 并按 base anchor 位移。未来完整导出会写入源动作层帧。',
  };
  if (apply) {
    fs.writeFileSync(APPEARANCE, `${JSON.stringify(appearance, null, 2)}\n`, 'utf8');
    console.log(`已写入 ${path.relative(process.cwd(), APPEARANCE)}`);
  } else {
    console.log('（未加 --apply，仅演算；加 --apply 才落盘。）');
  }
  console.log(JSON.stringify({ added, existing, actions: POSE_ACTIONS,
    sourceFrames: Object.fromEntries(POSE_ACTIONS.map(action => [action, sourceActions['0'][action].frameCount])),
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => reader.close());
