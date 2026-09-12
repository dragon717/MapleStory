import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./dialogue.ts', import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const i18nStub = "const uiLocale = () => 'zh', uiText = x => x, displayText = x => x;";

// dialogue.ts imports `../inventory/names` at runtime, so that module must be
// loaded through the same module graph instead of a bare data: URL (whose base
// cannot resolve relative specifiers).  Transpile names.ts the same way the
// other checks do: stub i18n, keep the real shared/items.json via a JSON data
// URL module so itemCategoryTab / itemDetails read the authoritative catalog.
const itemsJson = await readFile(new URL('../../../../shared/items.json', import.meta.url), 'utf8');
const itemsUrl = `data:application/json;base64,${Buffer.from(itemsJson).toString('base64')}`;
const namesCode = compile(await readFile(new URL('../inventory/names.ts', import.meta.url), 'utf8'))
  .replace(/import .* from '..\/..\/app\/i18n';/, i18nStub)
  .replace(/^import catalog from '.*items\.json';$/m, `import catalog from ${JSON.stringify(itemsUrl)} with { type: 'json' };`);
const namesUrl = `data:text/javascript;base64,${Buffer.from(namesCode).toString('base64')}`;

const code = compile(source)
  .replace(/import .* from '..\/..\/app\/i18n';/, i18nStub)
  .replace(/'..\/inventory\/names'/, JSON.stringify(namesUrl));
const { NpcDialogueView } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const original = { window: globalThis.window, fetch: globalThis.fetch };
try {
  globalThis.window = new EventTarget();
  globalThis.fetch = async () => ({ json: async () => ({}) });
  const sent = [];
  const view = new NpcDialogueView({}, {}, () => {}, message => { sent.push(message); return true; });
  assert.equal(view.isOpen(), false);
  view.dialogueCurrent = { npcId: 'npc-1' };
  const escape = () => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', repeat: false });
    window.dispatchEvent(event);
    return event;
  };
  assert.equal(escape().defaultPrevented, true);
  assert.equal(view.isOpen(), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].npcId, 'npc-1');
  assert.equal(sent[0].step, 'end');
  assert.equal(escape().defaultPrevented, false);
  assert.equal(sent.length, 1, 'Closing twice cannot send a second end request');
  view.shopCurrent = { shopId: 'shop-1' };
  escape();
  assert.equal(view.isOpen(), false);
  assert.equal(sent.length, 1, 'A shop close does not advance a dialogue');
  view.dialogueCurrent = { npcId: 'npc-2' };
  view.shopCurrent = { shopId: 'shop-2' };
  view.currentRequestId = 'old-request';
  view.clear();
  view.receive({ requestId: 'old-request', npcId: 'npc-2', dialog: { kind: 'ok', text: 'stale' } });
  assert.equal(view.isOpen(), false, 'Disconnect/map change rejects late replies and clears both windows');
  view.destroy();
  assert.equal(escape().defaultPrevented, false);
  await new Promise(resolve => setImmediate(resolve));
  console.log('NPC modal lifecycle: Escape, repeat close, shop, disconnect and teardown passed.');
} finally {
  Object.assign(globalThis, original);
}
