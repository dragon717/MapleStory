import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const inputSource = await readFile(new URL('../player/input.ts', import.meta.url), 'utf8');
const { outputText: inputJs } = ts.transpileModule(inputSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const inputUrl = `data:text/javascript;base64,${Buffer.from(inputJs).toString('base64')}`;
const source = await readFile(new URL('./model.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const modelJs = outputText.replace(/from ['"]\.\.\/player\/input['"]/, `from '${inputUrl}'`);
const { KeyBindings, SLOT_COUNT, STORAGE_VERSION, keyLabel, FIXED_CODES, STORAGE_PREFIX } = await import(`data:text/javascript;base64,${Buffer.from(modelJs).toString('base64')}`);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const storage = new MemoryStorage();
const changes = [];
const bindings = new KeyBindings({ storage });
const unsubscribe = bindings.subscribe(slots => changes.push(slots));
assert.equal(bindings.setCharacter('beginner', 0), true);
assert.equal(bindings.slots.length, SLOT_COUNT);
assert.deepEqual(bindings.resolve('Digit1'), { type: 'skill', skillId: 1000 });
assert.deepEqual(bindings.resolve('Numpad1'), { type: 'skill', skillId: 1000 });
assert.deepEqual(bindings.resolve('ControlLeft'), { type: 'action', action: 'attack' });
assert.deepEqual(bindings.resolve('KeyC'), { type: 'action', action: 'character' });
assert.equal(bindings.resolve('ArrowLeft'), null);
assert.ok(changes.length > 0);

assert.equal(bindings.bind('KeyB', false, { type: 'skill', skillId: 1000 }), true);
assert.deepEqual(bindings.resolve('KeyB'), { type: 'skill', skillId: 1000 });
assert.equal(bindings.bind('KeyA', false, null), true, 'clearing a default key is persisted');
assert.equal(bindings.resolve('KeyA'), null);
assert.equal(bindings.setSlot(0, 'KeyB', false), true, 'slot key can be selected independently');
assert.equal(bindings.slots[0].code, 'KeyB');
assert.equal(bindings.slots[0].binding?.type, 'skill');
assert.equal(bindings.setSlot(1, 'KeyB', false), true, 'duplicate display keys exchange slot positions');
assert.equal(bindings.slots[0].code, 'Digit2');
assert.equal(bindings.slots[1].code, 'KeyB');
assert.deepEqual(bindings.resolve('KeyB'), { type: 'skill', skillId: 1000 });

unsubscribe();
const restored = new KeyBindings({ storage });
assert.equal(restored.setCharacter('beginner', 200), true);
assert.deepEqual(restored.resolve('KeyB'), { type: 'skill', skillId: 1000 }, 'job change keeps a custom beginner binding');
assert.equal(restored.resolve('KeyA'), null, 'cleared default remains cleared');
assert.equal(restored.slots[0].code, 'Digit2');
assert.equal(restored.slots[1].code, 'KeyB');
assert.equal(restored.resetDefaults(), true);
assert.deepEqual(restored.resolve('Digit1'), { type: 'skill', skillId: 2001008 });
assert.equal(restored.resolve('KeyB'), null);

storage.setItem(`${STORAGE_PREFIX}bad`, '{broken');
const repaired = new KeyBindings({ storage });
assert.equal(repaired.setCharacter('bad', 200), true);
assert.equal(repaired.slots.length, SLOT_COUNT, 'bad JSON falls back to a complete layout');
assert.equal(JSON.parse(storage.getItem(`${STORAGE_PREFIX}bad`)).version, STORAGE_VERSION, 'bad JSON is replaced by the validated schema');

// v1 存档（骑宠键加入之前）：读进来要补上**这一版新增**的默认按键（KeyR → 骑宠），
// 而不是整份丢弃，也不是把玩家的自定义重置一遍。
const v1Slots = [
  ...['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0']
    .map(code => ({ code, shift: false })),
  ...['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0']
    .map(code => ({ code, shift: true })),
  ...['KeyX', 'Space', 'KeyZ', 'KeyT', 'KeyK', 'KeyQ', 'KeyI', 'KeyE', 'KeyM', 'KeyO', 'KeyA', 'KeyD']
    .map(code => ({ code, shift: false })),
];
assert.equal(v1Slots.length, SLOT_COUNT, 'v1 夹具必须恰好是现行格数（源快捷栏一直是 32 格）');
const v1Key = `${STORAGE_PREFIX}v1`;
storage.setItem(v1Key, JSON.stringify({
  version: 1,
  customized: true,
  bindings: { 'KeyB:0': { type: 'skill', skillId: 2001008 } },
  slots: v1Slots,
}));
const migrated = new KeyBindings({ storage });
assert.equal(migrated.setCharacter('v1', 200), true);
assert.deepEqual(migrated.resolve('KeyR'), { type: 'action', action: 'mount' }, 'v1 存档补上骑宠键的默认绑定');
assert.deepEqual(migrated.resolve('KeyB'), { type: 'skill', skillId: 2001008 }, 'v1 存档里的自定义绑定原样保留');
assert.equal(migrated.slots.length, SLOT_COUNT, '玩家自己的 32 格布局不动');
const rewritten = JSON.parse(storage.getItem(v1Key));
assert.equal(rewritten.version, STORAGE_VERSION, '迁移后按现行 schema 落盘，只迁一次');
assert.deepEqual(rewritten.bindings['KeyR:0'], { type: 'action', action: 'mount' }, '补进来的默认绑定也落盘');

// 现行 schema 里一个键缺席＝玩家自己清掉的：重开不能把它复活。
const cleared = new KeyBindings({ storage });
assert.equal(cleared.setCharacter('cleared', 0), true);
assert.equal(cleared.bind('KeyR', false, null), true, '玩家可以清掉骑宠键');
const reopened = new KeyBindings({ storage });
assert.equal(reopened.setCharacter('cleared', 0), true);
assert.equal(reopened.resolve('KeyR'), null, '现行存档里被清掉的键不会被迁移逻辑复活');

const errors = [];
const failing = new KeyBindings({
  storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } },
  onError: message => errors.push(message),
});
assert.equal(failing.setCharacter('quota', 0), false);
assert.equal(failing.bind('KeyB', false, { type: 'action', action: 'attack' }), false);
assert.equal(errors.length >= 2, true, 'save failures are observable');
assert.equal(failing.setSlot(0, FIXED_CODES[0], false), false, 'arrows remain fixed');
assert.equal(keyLabel('KeyA'), 'A');
assert.equal(keyLabel('Digit1', true), 'Shift + 1');
assert.equal(keyLabel('ArrowLeft'), '←');
console.log(`PASS: keybinding map, ${SLOT_COUNT} display slots, v1->v${STORAGE_VERSION} default-key migration, cleared keys stay cleared, persistence validation, job preservation, and save errors.`);
