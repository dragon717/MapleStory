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
assert.equal(view.isToggleSkill(meditation), true, 'meditation is rendered as a toggle');
assert.equal(view.isToggleSkill(iceTeleport), true, 'ice teleport is rendered as a toggle');
view.player.skillPoints = { '200': 5 };
assert.equal(view.canLearn(thunderBolt), false, 'book-200 points cannot impersonate book-220 points');
console.log('PASS: source text plus book-200 SP, learning gates, unique intents, live-mage casting, and wave direction.');
