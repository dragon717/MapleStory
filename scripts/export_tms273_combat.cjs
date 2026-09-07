#!/usr/bin/env node

// Export the ordinary starter-weapon attack from the TMS273 client data.
// Timing, hit bounds, afterimage and sound all come from the 273 WZ files;
// no v83 values are used here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');

const WEAPON = 'Character/Weapon/01302000.img';
const BODY_ATTACK = 'Character/00002000.img/swingO1';
const SOUND = 'Sound/Weapon.img';
const BINARY = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/bin/game');

const reader = createReader(DATA);
const frameCache = new Map();

function children(node) {
  return [...(node?.wzProperties || [])];
}

function numericChildren(node) {
  return children(node)
    .filter(child => /^\d+$/.test(child.name))
    .sort((a, b) => Number(a.name) - Number(b.name));
}

function value(node, name) {
  return node?.at?.(name)?.wzValue;
}

function scalar(node, name) {
  const result = value(node, name);
  return ['string', 'number', 'boolean'].includes(typeof result) || typeof result === 'bigint'
    ? result
    : undefined;
}

function numberValue(node, name, label) {
  const result = Number(value(node, name));
  assert(Number.isFinite(result), `${label || name} is not numeric`);
  return result;
}

function vector(node, name, label) {
  const result = value(node, name);
  const x = Number(result?.x);
  const y = Number(result?.y);
  assert(Number.isFinite(x) && Number.isFinite(y), `${label || name} is not a finite vector`);
  return { x, y };
}

async function get(source) {
  try {
    const node = await reader.get(source);
    if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
    return node;
  } catch (error) {
    throw new Error(`${source}: ${error.message}`, { cause: error });
  }
}

function assetName(source, extension) {
  const safe = source.replace(/[^A-Za-z0-9_.-]/g, '_');
  const hash = crypto.createHash('sha1').update(source, 'utf8').digest('hex').slice(0, 10);
  return `${safe}-${hash}.${extension}`;
}

async function exportFrame(source, extra = {}) {
  if (!frameCache.has(source)) {
    const frame = await reader.frame(source, ASSETS);
    assert(frame.url && frame.width > 0 && frame.height > 0, `invalid afterimage Canvas: ${source}`);
    assert(frame.delay > 0, `invalid afterimage delay: ${source}`);
    frameCache.set(source, {
      ...frame,
      url: `/assets/tms273/${frame.url}`,
    });
  }
  return { ...frameCache.get(source), ...extra };
}

async function exportSound(source) {
  const result = { source, status: 'missing', url: undefined, format: undefined, bytes: undefined, reason: undefined };
  let node;
  try {
    node = await get(source);
  } catch (error) {
    result.reason = `273 WZ 节点不存在: ${error.message}`;
    return result;
  }

  if (!(node instanceof wz.WzBinaryProperty) || typeof node.getBytes !== 'function') {
    result.status = 'undecodable';
    result.reason = `节点类型 ${node?.constructor?.name || '<unknown>'} 不是声音属性`;
    return result;
  }

  let bytes;
  try {
    bytes = Buffer.from(await node.getBytes());
  } catch (error) {
    result.status = 'undecodable';
    result.reason = `读取声音字节失败: ${error.message}`;
    return result;
  }

  // WzBinaryProperty exposes the embedded MP3 payload without the WZ sound
  // header.  Refuse to write an unrecognised payload rather than fabricating a
  // playable asset for a missing/unsupported source.
  const isMp3 = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (!isMp3) {
    result.status = 'undecodable';
    result.reason = `声音字节不是可识别的 MP3 帧 (length=${bytes.length})`;
    return result;
  }

  fs.mkdirSync(ASSETS, { recursive: true });
  const filename = assetName(source, 'mp3');
  fs.writeFileSync(path.join(ASSETS, filename), bytes);
  return {
    source,
    status: 'exported',
    url: `/assets/tms273/${filename}`,
    format: 'mp3',
    bytes: bytes.length,
  };
}

async function optionalSource(source) {
  try {
    const node = await get(source);
    return { source, available: true, type: node.constructor.name };
  } catch (error) {
    return { source, available: false, reason: error.message };
  }
}

async function initialPlayerEvidence() {
  const creationSource = 'Etc/MakeCharInfo.img/000';
  let creation;
  try {
    const node = await get(creationSource);
    creation = {
      source: creationSource,
      available: true,
      children: children(node).map(child => child.name),
      semantic: '角色创建外观/装备候选；不包含服务器初始等级、属性或等级经验表',
    };
  } catch (error) {
    creation = { source: creationSource, available: false, reason: error.message };
  }

  let eventExp;
  try {
    const node = await get('Etc/AutoIncFieldExp.img/1/exp');
    const entries = numericChildren(node);
    const field = await get('Etc/AutoIncFieldExp.img/1/fieldID/0');
    const dateStart = await get('Etc/AutoIncFieldExp.img/1/dateStart');
    const dateEnd = await get('Etc/AutoIncFieldExp.img/1/dateEnd');
    eventExp = {
      source: 'Etc/AutoIncFieldExp.img/1/exp',
      available: true,
      semantic: '限时地图事件 EXP；不是玩家等级 EXP 曲线',
      entryCount: entries.length,
      firstEntry: entries[0] ? { level: Number(entries[0].name), exp: Number(entries[0].wzValue) } : undefined,
      lastEntry: entries.at(-1) ? { level: Number(entries.at(-1).name), exp: Number(entries.at(-1).wzValue) } : undefined,
      fieldId: Number(field.wzValue),
      dateStart: dateStart.wzValue,
      dateEnd: dateEnd.wzValue,
    };
  } catch (error) {
    eventExp = { source: 'Etc/AutoIncFieldExp.img/1/exp', available: false, reason: error.message };
  }

  const levelTable = await optionalSource('Etc/ExpTable.img');
  const binary = {
    source: 'TMS273/bin/game',
    pathExists: fs.existsSync(BINARY),
    format: 'ELF 64-bit LSB PIE x86-64, unstripped',
    inspectedWith: ['file', 'nm -a', 'strings'],
    authoritativeExpSymbols: [],
    authoritativeExpStrings: [],
    conclusion: '未发现可用的客户端 EXP_TABLE/等级经验符号或游戏经验表；不能从该 ELF 推导初始数据',
  };

  return {
    status: 'unavailable',
    level: null,
    exp: null,
    stats: null,
    checkedSources: [creation, eventExp, levelTable, binary],
    excludedSources: [
      {
        source: 'TMS273/data/Etc/MakeCharacterSetting.json',
        semantic: '私服角色初始化覆盖',
        reason: '不是 273 客户端权威数据；其中的 level/EXP 参数不能用于复刻',
      },
    ],
    reason: '273 客户端 WZ 仅提供创建候选和事件 EXP；服务器初始属性及等级 EXP 需另有权威服务端来源，当前不伪造。',
  };
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  try {
    const weapon = await get(`${WEAPON}/info`);
    const afterImage = scalar(weapon, 'afterImage');
    const sfx = scalar(weapon, 'sfx');
    assert(afterImage === 'swordOL', `01302000 afterImage changed: ${afterImage}`);
    assert(sfx === 'swordL', `01302000 sfx changed: ${sfx}`);

    const body = await get(BODY_ATTACK);
    const bodyFrames = numericChildren(body);
    assert(bodyFrames.length > 0, '273 body swingO1 has no frames');
    const bodyDelaysMs = bodyFrames.map((frame, index) => numberValue(frame, 'delay', `${BODY_ATTACK}/${index}/delay`));
    assert(bodyDelaysMs.every(delay => delay > 0), '273 body attack contains a non-positive delay');
    const attackDurationMs = bodyDelaysMs.reduce((sum, delay) => sum + delay, 0);
    const hitAtMs = bodyDelaysMs.slice(0, -1).reduce((sum, delay) => sum + delay, 0);

    const actionSource = `Character/Afterimage/${afterImage}.img/0/swingO1`;
    const action = await get(actionSource);
    const groups = numericChildren(action);
    assert(groups.length > 0, `273 afterimage action has no numeric group: ${actionSource}`);
    const firstFrame = Number(groups[0].name);
    const lt = vector(action, 'lt', `${actionSource}/lt`);
    const rb = vector(action, 'rb', `${actionSource}/rb`);
    const group = groups[0];
    const canvases = numericChildren(group);
    assert(canvases.length > 0, `273 afterimage group ${group.name} has no Canvas frames`);
    const frames = [];
    for (const canvas of canvases) {
      const frameSource = `${actionSource}/${group.name}/${canvas.name}`;
      frames.push(await exportFrame(frameSource, {
        index: Number(canvas.name),
        afterimageFrame: firstFrame,
        lt,
        rb,
      }));
    }

    const soundSource = `${SOUND}/${sfx}/Attack`;
    const sound = await exportSound(soundSource);
    const attack = {
      weaponSource: WEAPON,
      weaponInfoSource: `${WEAPON}/info`,
      afterImage,
      afterimageSource: actionSource,
      bodyActionSource: BODY_ATTACK,
      bodyFrameDelaysMs: bodyDelaysMs,
      durationMs: attackDurationMs,
      hitAtMs,
      hitbox: {
        source: { lt: `${actionSource}/lt`, rb: `${actionSource}/rb` },
        lt,
        rb,
      },
      afterimage: {
        source: actionSource,
        firstFrame,
        startMs: hitAtMs,
        frames,
      },
      sound,
    };

    const output = {
      contentVersion: 'tms273-combat',
      source: 'TMS273.7 client WZ / Character + Sound',
      attack,
      // This alias is ready to copy into manifest.avatar.attackSound.
      avatarAttackSound: sound,
      combat: {
        attack: {
          afterimage: attack.afterimage,
          hitAtMs: attack.hitAtMs,
          durationMs: attack.durationMs,
          hitbox: attack.hitbox,
          sound: attack.sound,
        },
      },
      initialPlayer: await initialPlayerEvidence(),
    };
    const outputPath = path.join(OUTPUT, 'combat-extra.json');
    fs.mkdirSync(OUTPUT, { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      weapon: WEAPON,
      afterimage: { source: actionSource, firstFrame, frames: frames.length, hitAtMs, attackDurationMs },
      sound: { source: sound.source, status: sound.status, url: sound.url, bytes: sound.bytes },
      initialPlayer: output.initialPlayer.status,
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { DATA, OUTPUT, ASSETS, main };
