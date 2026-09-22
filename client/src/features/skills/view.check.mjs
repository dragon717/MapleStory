#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const require = createRequire(import.meta.url);
const { skillManifest } = require(path.join(root, 'scripts/tms273_skill_manifest.cjs'));
const readJson = async name => JSON.parse(await readFile(path.join(root, 'resources/tms273-export', `${name}.json`), 'utf8'));

// `view.ts` 的 import 行在下面会被整段剥掉（原样保留了「页面里 import 什么就
// 在全局注入什么」的做法），所以共享的书准入权威必须**在导入 view.ts 之前**
// 落到 globalThis 上：BOOK_JOBS / GRANTED_FIXED_SKILLS 都是模块顶层 const，
// 导入那一刻就要读这些名字。
const inputSource = await readFile(new URL('../player/input.ts', import.meta.url), 'utf8');
const inputJs = ts.transpileModule(inputSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const inputModule = await import(`data:text/javascript;base64,${Buffer.from(inputJs).toString('base64')}`);
const {
  PlayerInput, SHORTCUT_SKILLS, FOURTH_SHORTCUT_SKILLS, FIRE_FOURTH_SHORTCUT_SKILLS, HOLY_FOURTH_SHORTCUT_SKILLS,
  MAGE_JOB_WHITELIST, ICE_LIGHTNING_JOB_WHITELIST, FIRE_POISON_JOB_WHITELIST, CLERIC_JOB_WHITELIST,
  BOOK_JOBS, bookAllowsJob, bookIdForSkill, branchFourthJob,
} = inputModule;
Object.assign(globalThis, {
  SHORTCUT_SKILLS, FOURTH_SHORTCUT_SKILLS, FIRE_FOURTH_SHORTCUT_SKILLS, HOLY_FOURTH_SHORTCUT_SKILLS,
  MAGE_JOB_WHITELIST, ICE_LIGHTNING_JOB_WHITELIST, FIRE_POISON_JOB_WHITELIST, CLERIC_JOB_WHITELIST,
  BOOK_JOBS, bookAllowsJob, bookIdForSkill, branchFourthJob,
});

const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const runnable = `const displayText = value => value;\n${outputText.replace(/^import .*;\r?\n/gm, '')}`;
const { SkillView, sourceText } = await import(`data:text/javascript;base64,${Buffer.from(runnable).toString('base64')}`);

const skills = await readJson('skills');
const windowExport = await readJson('windows-skills');
const catalog = skillManifest(windowExport, skills).skillCatalog;
const rendered = catalog['2201009'].levelDescriptions[0];
const cleaned = sourceText(rendered);
assert.match(rendered, /#c6%機率/);
assert.match(cleaned, /6%機率/);
assert.doesNotMatch(cleaned, /#?c6%/);
assert.equal(sourceText(`${rendered}\\n#c中文\\n#unknown #xyz`), `${cleaned}\n中文\n#unknown #xyz`);

const makeView = (player, sendMessages, statuses) => {
  const view = Object.create(SkillView.prototype);
  view.player = player;
  view.selectedBookId = '200';
  view.requestSequence = 0;
  view.send = message => { sendMessages.push(message); return true; };
  view.status = message => statuses.push(message);
  return view;
};
const mage = (overrides = {}) => ({
  job: 200,
  hp: 100,
  action: 'stand',
  skills: {},
  skillPoints: { '200': 5 },
  ...overrides,
});
const energyBolt = catalog['2001008'];
const magicWave = catalog['2001011'];
const shieldPrerequisite = catalog['2000010'];
const fixedFreeze = catalog['2200011'];
const meditation = catalog['2201001'];
const thunderBolt = catalog['2201005'];
const coldBeam = catalog['2201008'];
const iceTeleport = catalog['2201009'];
assert.ok(fixedFreeze && meditation && thunderBolt && coldBeam && iceTeleport, 'book 220 catalog entries are exported');

let sent = [];
let statuses = [];
let view = makeView(mage(), sent, statuses);
assert.equal(view.canLearn(energyBolt), true, 'book 200 reads SP from key 200');
view.player.skillPoints = { '1': 5 };
assert.equal(view.canLearn(energyBolt), false, 'SP key 1 cannot impersonate book 200');
view.player.skillPoints = { '200': 5 };
view.player.skills = { '2000010': 0, '2001002': 0 };
assert.equal(view.canLearn(shieldPrerequisite), false, 'missing prerequisite level rejects learning');
view.player.skills['2001002'] = 3;
assert.equal(view.canLearn(shieldPrerequisite), true, 'satisfied prerequisite permits learning');
view.player.skills['2001008'] = energyBolt.maxLevel;
assert.equal(view.canLearn(energyBolt), false, 'max-level skill rejects learning');
view.player = mage({ job: 0 });
assert.equal(view.canLearn(energyBolt), false, 'wrong job rejects learning');
view.player = mage({ skills: { '2001008': 0 } });
view.learnSkill(energyBolt);
view.learnSkill(energyBolt);
assert.equal(sent.length, 2, 'valid learning sends each request');
assert.notEqual(sent[0].requestId, sent[1].requestId, 'learning request IDs are unique');
assert.equal(view.player.skills['2001008'], 0, 'learning intent does not mutate the local level');
assert.equal(view.player.skillPoints['200'], 5, 'learning intent does not mutate local SP');

view.player = mage({ skills: { '2001008': 1 } });
assert.equal(view.canCast(energyBolt), true, 'learned active skill is castable by a live mage');
view.player = mage({ job: 220, skills: { '2001008': 0 } });
assert.equal(view.canLearn(energyBolt), true, 'ice-lightning mage inherits first-job learning');
view.player = mage({ job: 220, skills: { '2001008': 1 } });
assert.equal(view.canCast(energyBolt), true, 'ice-lightning mage inherits first-job casting');
view.player = mage({ job: 0, skills: { '2001008': 1 } });
assert.equal(view.canCast(energyBolt), false, 'non-mage cannot cast');
view.player = mage({ job: 999, skills: { '2001008': 1 } });
assert.equal(view.canCast(energyBolt), false, 'unknown job cannot cast');
view.player = mage({ hp: 0, skills: { '2001008': 1 } });
assert.equal(view.canCast(energyBolt), false, 'dead HP cannot cast');
view.player = mage({ action: 'dead', skills: { '2001008': 1 } });
assert.equal(view.canCast(energyBolt), false, 'dead action cannot cast');
view.player = mage({ skills: { '2001008': 0 } });
assert.equal(view.canCast(energyBolt), false, 'unlearned active skill cannot cast');
view.player = mage({ skills: { '2001011': 1 } });
view.castSkill(magicWave);
const wave = sent.at(-1);
assert.equal(wave.skillId, 2001011, 'wave cast uses the selected skill');
assert.equal(wave.vertical, -1, 'wave cast sends the upward intent');
assert.equal(view.player.skills['2001011'], 1, 'casting intent does not mutate local level');

view.selectedBookId = '220';
view.player = mage({ job: 200, skills: { '2201001': 1, '2201005': 1, '2201008': 1, '2201009': 1 }, skillPoints: { '220': 5 } });
assert.equal(view.canLearn(coldBeam), false, 'first-job mage cannot learn book-220 skills');
assert.equal(view.canCast(coldBeam), false, 'first-job mage cannot cast book-220 skills');
view.player = mage({ job: 220, skills: { '2200000': 3, '2201001': 0, '2201005': 0, '2201008': 0, '2201009': 0 }, skillPoints: { '220': 5 } });
assert.equal(view.canLearn(coldBeam), true, 'ice-lightning mage can learn book-220 cold beam');
assert.equal(view.canLearn(thunderBolt), true, 'ice-lightning mage can learn book-220 thunder bolt');
assert.equal(view.canLearn(meditation), true, 'ice-lightning mage can learn book-220 meditation');
assert.equal(view.canLearn(iceTeleport), true, 'ice-lightning mage can learn book-220 teleport');
assert.equal(view.canLearn(fixedFreeze), false, 'fixed freeze effect never spends skill points');
assert.equal(view.learnedLevel(fixedFreeze.id), 1, 'fixed freeze effect is automatically enabled');
view.player.skills = { '2201001': 1, '2201005': 1, '2201008': 1, '2201009': 1 };
for (const entry of [meditation, thunderBolt, coldBeam, iceTeleport]) assert.equal(view.canCast(entry), true, `${entry.id} is an active learned book-220 skill`);
assert.equal(view.isToggleSkill(meditation), false, 'meditation refreshes a timed buff');
assert.equal(view.isToggleSkill(iceTeleport), true, 'ice teleport is rendered as a toggle');
view.player.skillPoints = { '200': 5 };
assert.equal(view.canLearn(thunderBolt), false, 'book-200 points cannot impersonate book-220 points');
console.log('PASS: source text plus book-200 SP, learning gates, unique intents, live-mage casting, and wave direction.');

assert.deepEqual([SHORTCUT_SKILLS.Digit8, SHORTCUT_SKILLS.Digit9, SHORTCUT_SKILLS.Digit0], [2211002, 2211014, 2211011]);
view.manifest = skillManifest(windowExport, skills);
view.player = mage({ job: 220, skills: { '2211002': 1 }, skillPoints: { '221': 5 } });
assert(!view.books().some(([id]) => id === '221'));
assert.equal(view.canLearn(catalog['2211002']), false);
assert.equal(view.canCast(catalog['2211002']), false);
view.player.job = 221;
view.selectedBookId = '221';
assert(view.books().some(([id]) => id === '221'));
assert.equal(view.canLearn(catalog['2211002']), true);
assert.equal(view.canCast(catalog['2211002']), true);
assert.equal(view.canLearn(catalog['2211015']), false);
assert.equal(view.canCast(catalog['2211015']), false);
assert(!view.visibleSkills('221').some(skill => skill.id === '2211015'));
view.player.skills['2211012'] = 1;
view.player.derivedStats = { adaptationCooldownMs: 1001 };
assert.match(view.castBlockReason(catalog['2211012']), /2 秒/);
view.player.derivedStats.adaptationCooldownMs = 0;
assert.equal(view.canCast(catalog['2211012']), true);
assert.equal(view.isToggleSkill(catalog['2211012']), false);
assert.equal(view.isToggleSkill(catalog['2211007']), true);
assert.equal(view.isToggleSkill(catalog['2211017']), true);
const input = Object.create(PlayerInput.prototype);
input.targets = { playerState: () => view.player }; input.held = new Set(['ArrowDown']);
assert.equal(input.vertical(), 1, 'down-arrow uses the server anchor direction');
assert.equal(input.canCastShortcut(2211002), true);
view.player.job = 220;
assert.equal(input.canCastShortcut(2211002), false);
console.log('PASS: third-job book/SP gates, hidden node, cooldown feedback, toggles and shortcut direction.');

assert.equal(FOURTH_SHORTCUT_SKILLS.Digit6, 2221011);
view.player = mage({ job: 221, skills: { '2221011': 1 }, skillPoints: { '222': 3 } });
assert(!view.books().some(([id]) => id === '222'));
assert.equal(view.canCast(catalog['2221011']), false);
assert.equal(input.canCastShortcut(2221011), false);
view.player.job = 222; view.selectedBookId = '222';
assert(view.books().some(([id]) => id === '222'));
assert.equal(view.canLearn(catalog['2221006']), true);
assert.equal(view.canLearn(catalog['2220015']), false);
assert.equal(view.canCast(catalog['2220013']), false);
assert.equal(view.canCast(catalog['2221011']), true);
assert.equal(input.canCastShortcut(2221011), true);
// 火毒（210/211/212）与主教（230/231/232）读同一张书准入表，书号从技能 id 派生
// （`bookIdForSkill` = skillId / 10000，与 server/src/mage.rs 同口径）。
// 早先按 `skillId >= 2200000` 分段，把 23xxxxx 也划进了冰雷区间，
// 于是整条主教分支的技能都被判成「职业不可用」。
assert.deepEqual(
  [bookIdForSkill(1000), bookIdForSkill(2121006), bookIdForSkill(2321001)],
  ['0', '212', '232'],
  '书号由技能 id 高两位派生',
);
for (const [job, skillId, allowed] of [
  [211, 2121006, false], [212, 2121006, true],
  [220, 2201008, true], [221, 2211002, true], [220, 2211002, false], [220, 2221011, false],
  [230, 2301005, true], [231, 2321001, false], [232, 2321001, true], [222, 2321001, false],
]) {
  view.player = mage({ job, skills: { [String(skillId)]: 1 } });
  assert.equal(input.canCastShortcut(skillId), allowed, `job ${job} 对 ${skillId} 的快捷栏准入`);
}
view.player = mage({ job: 0, skills: { '1000': 1, '2121006': 1 } });
assert.equal(input.canCastShortcut(1000), true, '初心者可以施放自己的技能');
assert.equal(input.canCastShortcut(2121006), false, '初心者不能借表施放法师技能');
// 恢复四转状态：下面几条断言（冷却/持续施放提示）读的是同一个 222 视角。
view.player = mage({ job: 222, skills: { '2221011': 1 }, skillPoints: { '222': 3 } });
view.player.derivedStats = { skillCooldowns: { '2221011': 1001 } };
assert.match(view.castBlockReason(catalog['2221011']), /2 秒/);
view.player.derivedStats = { skillBuffs: { '2221011': 5000 } };
assert.match(view.castBlockReason(catalog['2221011']), /松开/);
view.player.derivedStats = {};
// Object.create skips class field initializers; execute the actual release initializer.
view.releaseChannel = Function(`return ${outputText.match(/releaseChannel = (\(\) => \{[\s\S]*?\n    \});/)[1]}`).call(view);
view.channelRequestId = view.castSkill(catalog['2221011']);
const holdId = sent.at(-1).requestId;
view.releaseChannel(); view.releaseChannel();
assert.equal(sent.at(-1).type, 'releaseSkill');
assert.equal(sent.at(-1).requestId, holdId);
assert.equal(sent.filter(message => message.type === 'releaseSkill' && message.requestId === holdId).length, 1);
console.log('PASS: fourth book gates, fixed/passive skills, hold and cooldown feedback, matching release.');

// A 初心者 has not taken the magician job: the 法师 pages stay out of the
// window until Hans actually advances the character.
const beginner = { job: 0, hp: 100, action: 'stand', skills: {}, skillPoints: { '0': 3 } };
view.player = beginner;
const beginnerBooks = view.books().map(([id]) => id);
assert.ok(beginnerBooks.includes('0'), 'a beginner keeps the 初心者 book');
assert.ok(!beginnerBooks.includes('200'), 'a beginner must not see the 法师入门 book');
assert.ok(!beginnerBooks.includes('220'), 'a beginner must not see the 冰/雷魔法指南 book');
assert.equal(view.canLearn(catalog['2001008']), false, 'a beginner cannot learn magician skills');
view.player = mage();
const magicianBooks = view.books().map(([id]) => id);
assert.ok(magicianBooks.includes('200'), 'a magician sees the 法师入门 book');
console.log('PASS: beginner skill window hides every magician book; magician keeps them.');

// 火毒 / 冰雷 / 僧侶三条分支：同层的三本书**共用同一个页签下标**（职业决定进哪一本），
// 所以「别的分支的书必须留在窗外」是页签正确性的核心判据，不是可选的美化。
const branchBooks = (job) => {
  view.player = mage({ job, skills: {}, skillPoints: {} });
  return view.books().map(([id]) => id);
};
const SECOND_JOB_BOOKS = ['210', '220', '230'];
const THIRD_JOB_BOOKS = ['211', '221', '231'];
assert.deepEqual(branchBooks(210).filter(id => SECOND_JOB_BOOKS.includes(id)), ['210'], '火毒 2 转只看到火毒书');
assert.deepEqual(branchBooks(220).filter(id => SECOND_JOB_BOOKS.includes(id)), ['220'], '冰雷 2 转只看到冰雷书');
assert.deepEqual(branchBooks(230).filter(id => SECOND_JOB_BOOKS.includes(id)), ['230'], '僧侶 2 转只看到僧侶书');
assert.deepEqual(branchBooks(211).filter(id => THIRD_JOB_BOOKS.includes(id)), ['211'], '火毒 3 转只看到火毒书');
assert.deepEqual(branchBooks(221).filter(id => THIRD_JOB_BOOKS.includes(id)), ['221'], '冰雷 3 转只看到冰雷书');
assert.deepEqual(branchBooks(231).filter(id => THIRD_JOB_BOOKS.includes(id)), ['231'], '祭司 3 转只看到祭司书');
// 授予的 fixLevel 技能（源里 maxLevel＝1）只能由转职 NPC 给，不能用 SP 学；
// 等级由职业推断，因此既不依赖服务端落库，也不会发给别的分支。
for (const [job, skillId] of [[210, '2100009'], [220, '2200011'], [230, '2300009']]) {
  view.player = mage({ job, skills: {}, skillPoints: {} });
  assert.equal(view.learnedLevel(skillId), 1, `${skillId} 应由 ${job} 转职授予`);
  assert.equal(view.canLearn(catalog[skillId]), false, `${skillId} 是固定等级技能，不能用 SP 学`);
}
view.player = mage({ job: 230, skills: {}, skillPoints: {} });
// 未学习时 learnedLevel 返回 0（有技能快照但没这一条），不是 undefined。
assert.equal(view.learnedLevel('2100009'), 0, '僧侶不该持有火毒的授予技能');
assert.equal(view.learnedLevel('2200011'), 0, '僧侶不该持有冰雷的授予技能');
console.log('PASS: 火毒/冰雷/僧侶三条分支的书与授予技能都按职业门控。');
