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
const petsJson = await readFile(new URL('../../../../shared/pets.json', import.meta.url), 'utf8');
const petsUrl = `data:application/json;base64,${Buffer.from(petsJson).toString('base64')}`;
const namesCode = compile(await readFile(new URL('../inventory/names.ts', import.meta.url), 'utf8'))
  .replace(/import .* from '..\/..\/app\/i18n';/, i18nStub)
  .replace(/^import catalog from '.*items\.json';$/m, `import catalog from ${JSON.stringify(itemsUrl)} with { type: 'json' };`)
  .replace(/^import petCatalog from '.*pets\.json';$/m, `import petCatalog from ${JSON.stringify(petsUrl)} with { type: 'json' };`);
const namesUrl = `data:text/javascript;base64,${Buffer.from(namesCode).toString('base64')}`;

// dialogue.ts also pulls the tab → WZ category table from view-model.ts, which
// reads names.ts, so it has to travel through the same inlined module graph.
const viewModelCode = compile(await readFile(new URL('../inventory/view-model.ts', import.meta.url), 'utf8'))
  .replace(/from '\.\/names'/, `from ${JSON.stringify(namesUrl)}`);
const viewModelUrl = `data:text/javascript;base64,${Buffer.from(viewModelCode).toString('base64')}`;

const code = compile(source)
  .replace(/import .* from '..\/..\/app\/i18n';/, i18nStub)
  .replace(/'..\/inventory\/names'/, JSON.stringify(namesUrl))
  .replace(/'..\/inventory\/view-model'/, JSON.stringify(viewModelUrl));
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

  // --- Sell panel: payout filter, WZ category mapping and rebuild gating ---
  const sellView = new NpcDialogueView({}, {}, () => {}, () => true);
  sellView.shopCurrent = { shopId: 'shop-9' };
  sellView.itemNames = {};
  sellView.manifest = {};
  sellView.itemPrices = { '1002043': 200, '4000019': 6, '3010000': 40, '4000011': 1 };
  sellView.playerInventory = [
    { slot: 1, itemId: '1002043', quantity: 1 },
    { slot: 2, itemId: '4000019', quantity: 10 },
    { slot: 3, itemId: '3010000', quantity: 2 },
    // No price at all: the server refuses it, so it is not listed.
    { slot: 4, itemId: '2431174', quantity: 4 },
    // Arrows author no catalog price but sell at a flat 1 meso apiece.
    { slot: 5, itemId: '2060000', quantity: 120 },
    // A price-1 item floors at a one-meso payout, not zero.
    { slot: 6, itemId: '4000011', quantity: 3 },
  ];
  const entries = sellView.sellEntries();
  assert.equal(entries.length, 5, 'An item with no price at all is refused server-side, so it is not listed');
  const byItem = Object.fromEntries(entries.map(entry => [entry.itemId, entry]));
  assert.equal(byItem['2431174'], undefined, 'Unpriced rows never get a sell button');
  assert.equal(byItem['4000019'].inventoryType, 4, 'Etc stacks must carry WZ category 4, not tab + 1');
  assert.equal(byItem['3010000'].inventoryType, 3, 'Setup stacks must carry WZ category 3');
  assert.equal(byItem['1002043'].inventoryType, 1, 'Equip stacks carry WZ category 1');
  assert.equal(byItem['4000019'].preview, 30, 'Preview is the rounded payout times the stack');
  assert.equal(byItem['1002043'].preview, 100);
  assert.equal(byItem['4000011'].preview, 3, 'A price-1 item sells for a minimum of one meso apiece');
  assert.equal(byItem['2060000'].preview, 120, 'Arrows preview one meso per arrow even without a catalog price');
  assert.equal(byItem['2060000'].inventoryType, 2, 'Arrows sell from the Consume tab');

  // The sell panel is refreshed by every snapshot, and rebuilding the rows
  // between a press and its release swallows the click on the sell button, so
  // an unchanged bag must leave the built rows alone.
  const rebuilds = { replace: 0, rows: 0 };
  sellView.shopSellRoot = { replaceChildren() { rebuilds.replace++; }, appendChild() { rebuilds.rows++; } };
  sellView.shopRow = () => ({});
  sellView.renderSellList(true);
  assert.equal(rebuilds.replace, 1);
  sellView.renderSellList();
  sellView.renderSellList();
  assert.equal(rebuilds.replace, 1, 'An unchanged snapshot must not rebuild the sell rows');
  sellView.playerInventory = sellView.playerInventory.filter(item => item.itemId !== '4000019');
  sellView.renderSellList();
  assert.equal(rebuilds.replace, 2, 'A changed bag must rebuild the sell rows');
  sellView.destroy();
  console.log('NPC shop sell panel: zero-payout filter, WZ category mapping and snapshot gating passed.');

  // --- Sell quantity confirm: stacks over 1 ask for a count first ---
  const element = () => ({
    children: [],
    className: '', type: '', value: '', min: '', max: '', textContent: '',
    style: {}, listeners: {},
    appendChild(child) { this.children.push(child); },
    append(...kids) { this.children.push(...kids); },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    remove() {}, focus() {}, select() {},
    querySelector: () => null,
  });
  globalThis.document = { createElement: element };
  const confirmSent = [];
  const confirmView = new NpcDialogueView({}, {}, () => {}, message => { confirmSent.push(message); return true; });
  confirmView.shopCurrent = { shopId: 'shop-confirm' };
  const single = { itemId: '1002043', inventoryType: 1, slot: 1, quantity: 1, preview: 100, name: 'hat' };
  const stack = { itemId: '4000067', inventoryType: 4, slot: 7, quantity: 113, preview: 1695, name: '角' };

  confirmView.sell(single);
  assert.equal(confirmSent.length, 1, 'A quantity-1 row sells straight away');
  assert.equal(confirmSent[0].quantity, 1);

  confirmView.sell(stack);
  assert.equal(confirmSent.length, 1, 'A stack over 1 opens the confirm dialog instead of selling it all');
  assert.equal(confirmView.sellConfirmEntry, stack, 'The dialog is bound to the pressed stack');

  assert.equal(confirmView.sellConfirmCount(stack, { value: '500' }), 113, 'The typed count clamps to the stack size');
  assert.equal(confirmView.sellConfirmCount(stack, { value: '0' }), 1, 'The typed count floors at one');
  assert.equal(confirmView.sellConfirmCount(stack, { value: 'abc' }), 0, 'Garbage input sells nothing');

  confirmView.sendSell(stack, 3);
  assert.equal(confirmSent[1].quantity, 3, 'The confirmed count is what the request carries');

  escape();
  assert.ok(!confirmView.sellConfirmRoot, 'Escape dismisses the quantity dialog');
  assert.ok(confirmView.shopCurrent, 'The shop itself stays open behind the dialog');
  confirmView.destroy();
  console.log('NPC sell quantity confirm: partial-stack dialog, clamped count and Escape scoping passed.');
} finally {
  Object.assign(globalThis, original);
}
