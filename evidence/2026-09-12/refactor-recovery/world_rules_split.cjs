// 一次性搬移脚本：world.rs 规则/配置 impl 群 -> gameplay.rs + combat_rules.rs
// winA = impl QuestSpec + impl Gameplay（连续）；winB = impl PlayerConfig。
// 方法路线：无需 glob。pub 方法（Gameplay::load/validate）保持 pub。
const fs = require('fs');
const path = require('path');

const SRC = '/Users/muniao/Library/Mobile Documents/com~apple~CloudDocs/游戏/github/MapleStory/server/src';
const worldPath = path.join(SRC, 'world.rs');
const lines = fs.readFileSync(worldPath, 'utf8').split('\n');

const questIdx = lines.indexOf('impl QuestSpec {');
const pcIdx = lines.indexOf('impl PlayerConfig {');
if (questIdx < 0 || pcIdx < 0) { console.error('定位失败'); process.exit(1); }
if (lines[questIdx - 1] !== '') { console.error('QuestSpec 前非空行'); process.exit(1); }

// struct Gameplay 定义夹在 impl QuestSpec 与 impl Gameplay 之间——留原地
const gsIdx = lines.findIndex((l) => l.startsWith('pub struct Gameplay {'));
if (gsIdx < 0) { console.error('找不到 struct Gameplay'); process.exit(1); }
let a = gsIdx - 1;
while (a >= 0 && (lines[a].startsWith('#[') || lines[a].startsWith('///') || lines[a].startsWith('//'))) a -= 1;
if (lines[a] !== '') { console.error('struct Gameplay 前置属性定位失败: ' + JSON.stringify(lines[a])); process.exit(1); }
{
  // 其上（跳空行）应为 impl QuestSpec 的闭括号 '}'
  let j = a - 1;
  while (lines[j] === '') j -= 1;
  if (lines[j] !== '}') { console.error('QuestSpec impl 尾断言失败: ' + JSON.stringify(lines[j])); process.exit(1); }
  if (lines[j - 1] !== '    }') { console.error('QuestSpec 方法尾断言失败'); process.exit(1); }
}
const implGpIdx = lines.indexOf('impl Gameplay {');
if (implGpIdx < 0) { console.error('找不到 impl Gameplay'); process.exit(1); }
if (lines[implGpIdx - 1] !== '') { console.error('impl Gameplay 前非空行'); process.exit(1); }

// winB 尾：从 AwayWindow doc 向上——空行 -> '}'(PlayerConfig impl 尾)
const awayDocIdx = lines.findIndex((l) => l.startsWith('/// The single fact describing one continuous absence.'));
if (awayDocIdx < 0) { console.error('找不到 AwayWindow doc'); process.exit(1); }
let i = awayDocIdx - 1;
while (lines[i] === '') i -= 1;
if (lines[i] !== '}') { console.error('PlayerConfig 尾断言失败: ' + JSON.stringify(lines[i])); process.exit(1); }
const winBEnd = i;

const winA1 = lines.slice(questIdx, a); // impl QuestSpec（到 struct Gameplay 前空行止）
const winA2 = lines.slice(implGpIdx, pcIdx); // impl Gameplay（到 impl PlayerConfig 前，含尾空行）
const winB = lines.slice(pcIdx, winBEnd + 1); // impl PlayerConfig

// 名字覆盖断言
const fnsA = winA1.concat(winA2).map((l) => (l.match(/^    (?:pub(\(super\))? )?fn ([a-z_][a-z0-9_]*)\(/) || [])[2]).filter(Boolean);
const expectA = ['valid_reward', 'executable', 'valid_execution', 'load', 'validate', 'apply_deferred_quest_drops', 'validate_spawns_against_maps', 'validate_quest_maps'];
if (JSON.stringify(fnsA) !== JSON.stringify(expectA)) { console.error('winA 覆盖失败: ' + fnsA.join(',')); process.exit(1); }
const fnsB = winB.map((l) => (l.match(/^    (?:pub(\(super\))? )?fn ([a-z_][a-z0-9_]*)\(/) || [])[2]).filter(Boolean);
const expectB = ['with_ability_stats', 'with_equipment', 'attack_damage', 'attack_range_against', 'attack_damage_against', 'attack_range', 'attack_bounds', 'contact_damage'];
if (JSON.stringify(fnsB) !== JSON.stringify(expectB)) { console.error('winB 覆盖失败: ' + fnsB.join(',')); process.exit(1); }

const t = (win) => win.map((l) => (/^    fn /.test(l) ? l.replace(/^    fn /, '    pub(super) fn ') : l));

fs.writeFileSync(path.join(SRC, 'gameplay.rs'), [
  '//! 数据驱动定义的加载与规则校验。',
  '//!',
  '//! 负责：`Gameplay` 配置的加载与全套校验（`load` / `validate` / 延迟掉落应用 /',
  '//! 刷怪与任务地图交叉校验），以及任务定义 `QuestSpec` 的规则判定',
  '//! （`valid_reward` / `executable` / `valid_execution`）。',
  '//! 不负责：任务运行时进度与效果结算（`quest.rs`）、怪物/掉落的运行时行为',
  '//! （`monsters.rs` / 运行时 drops）、配置类型定义（struct 留在 `world.rs`）。',
  '//! 方法可见性：pub 保持 pub（`main` 直接调用 `Gameplay::load`/`validate`），',
  '//! 私有改 pub(super) 可达范围不变；全为方法调用、无需 glob。',
  '',
  'use super::*;',
  '',
  ...t(winA1),
  '',
  ...t(winA2),
].join('\n') + '\n');

fs.writeFileSync(path.join(SRC, 'combat_rules.rs'), [
  '//! 战斗数值公式（`PlayerConfig` 的派生方法）。',
  '//!',
  '//! 负责：玩家攻击数值与范围的来源公式（`attack_damage` / `attack_range_against` /',
  '//! `attack_damage_against` / `attack_range` / `attack_bounds`）、怪物接触伤害',
  '//! （`contact_damage`，含 tenacity 击退折减口径）与装备派生',
  '//! （`with_ability_stats` / `with_equipment`）。',
  '//! 不负责：攻击结算流程（`attacks.rs`）、移动（`movement.rs`）、',
  '//! 怪物模板数据（`MonsterTemplate` 定义留在 `world.rs`）。',
  '//! 方法可见性 pub(super) 与原 private 可达范围相同；全为方法调用、无需 glob。',
  '',
  'use super::*;',
  '',
  ...t(winB),
].join('\n') + '\n');

// ---- 重组 world.rs（从后往前 splice）----
const w = [...lines];
w.splice(pcIdx, winB.length);
w.splice(implGpIdx, winA2.length);
w.splice(questIdx, winA1.length);
const at = w.indexOf('mod attacks;');
if (at < 0) { console.error('找不到 mod attacks;'); process.exit(1); }
w.splice(at + 1, 0,
  '#[path = "gameplay.rs"]',
  'mod gameplay;',
  '#[path = "combat_rules.rs"]',
  'mod combat_rules;',
);
fs.writeFileSync(worldPath, w.join('\n'));

// ---- 自校验 ----
const errs = [];
{
  const body = t(winA1).concat([''], t(winA2));
  const rs = fs.readFileSync(path.join(SRC, 'gameplay.rs'), 'utf8').split('\n');
  const start = rs.indexOf(body[0]);
  if (start < 0) errs.push('gameplay.rs 无法定位内容');
  else rs.slice(start, start + body.length).forEach((l, k) => {
    if (l !== body[k]) errs.push(`gameplay.rs diff @${k}`);
  });
}
{
  const body = t(winB);
  const rs = fs.readFileSync(path.join(SRC, 'combat_rules.rs'), 'utf8').split('\n');
  const start = rs.indexOf(body[0]);
  if (start < 0) errs.push('combat_rules.rs 无法定位内容');
  else rs.slice(start, start + body.length).forEach((l, k) => {
    if (l !== body[k]) errs.push(`combat_rules.rs diff @${k}`);
  });
}
const na = w.join('\n');
for (const s of ['impl QuestSpec {', 'impl Gameplay {', 'impl PlayerConfig {']) {
  if (na.includes(s)) errs.push(`world.rs 仍含 ${s}`);
}
for (const s of ['struct QuestSpec {', 'pub struct Gameplay {', 'pub struct PlayerConfig {', 'mod gameplay;', 'mod combat_rules;', 'struct AwayWindow {']) {
  if (!na.includes(s)) errs.push(`world.rs 丢失 ${s}`);
}
if (!na.includes('Gameplay::load(') && !na.includes('gameplay: Gameplay')) { /* 构造由调用方持有，仅提示 */ }

if (errs.length) {
  console.error('SELF-CHECK FAILED:\n' + errs.join('\n'));
  process.exit(1);
}
console.log('OK: quest=%d gameplay=%d combat_rules=%d; world.rs %d -> %d lines', winA1.length, winA2.length, winB.length, lines.length, w.length);
