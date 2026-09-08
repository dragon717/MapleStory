import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const runnable = `const displayText = value => value;\n${outputText.replace(/^import .*;\r?\n/gm, '')}`;
const { SkillView } = await import(`data:text/javascript;base64,${Buffer.from(runnable).toString('base64')}`);
const view = Object.create(SkillView.prototype);
view.manifest = { skillBooks: { '200': { name: '法师', tabIndex: 1 } } };
view.player = { job: 0, skillPoints: { '0': 1, '200': 5 }, skills: {} };
view.skillPointValue = { setAttribute() {} };
assert.equal(view.books()[0][0], '0');
view.selectedBookId = '0';
view.renderSkillPoint();
assert.equal(view.skillPointValue.textContent, '1');
assert.equal(view.canLearn({ id: '2001008', bookId: '200', maxLevel: 20 }), false);
view.selectedBookId = '200';
view.renderSkillPoint();
assert.equal(view.skillPointValue.textContent, '5');
view.player.skillPoints = {};
view.renderSkillPoint();
assert.equal(view.skillPointValue.textContent, '0');
view.player = undefined;
view.renderSkillPoint();
assert.equal(view.skillPointValue.textContent, '—');
console.log('PASS: beginner SP tab, separate book balances, zero/unknown, mage learning gate.');

const beginner = { id: '1001', bookId: '0', maxLevel: 3, prerequisites: {} };
view.player = { job: 0, hp: 50, action: 'stand', skills: { '1001': 0 }, skillPoints: { '0': 1 } };
view.selectedBookId = '0';
assert.equal(view.canLearn(beginner), true);
assert.equal(view.canCast(beginner), false);
view.player.skills['1001'] = 1;
assert.equal(view.canCast(beginner), true);
view.player.derivedStats = { skillCooldowns: { '1001': 119_000 } };
assert.match(view.castBlockReason(beginner), /119/);
view.player.derivedStats = {};
view.player.job = 200;
assert.equal(view.canLearn(beginner), true, 'advancement preserves beginner learning');
assert.equal(view.canCast(beginner), true, 'advancement preserves beginner casting');
view.player.skillPoints = { '200': 10 };
assert.equal(view.canLearn(beginner), false, 'mage points cannot pay for beginner learning');
view.player.skills['1001'] = 3;
view.player.skillPoints['0'] = 6;
assert.equal(view.canLearn(beginner), false, 'source max level is enforced');
console.log('PASS: beginner learn/cast, max level, separate SP, inherited use and cooldown feedback.');
