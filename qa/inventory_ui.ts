// Browser-only fixture: no account, network mutation, or persistent game data.
import { InventoryView } from '../client/src/features/inventory/view';
import type { InventoryItem, PlayerState } from '../shared/protocol';
import '../client/src/app/style.css';

document.body.style.margin = '0';
document.body.style.background = '#182c27';
document.body.innerHTML = `<main style="box-sizing:border-box;width:100%;min-height:100vh;padding:8px;color:#f4e2a4;font:12px/16px Verdana,sans-serif">
  <div id="controls" style="display:flex;flex-wrap:wrap;gap:6px;margin:0 auto 8px;max-width:960px">
    <button id="toggle-cap" type="button">切换帽子对比</button>
    <button id="clear-cap" type="button">移除帽子</button>
    <span id="cap-state" style="align-self:center"></span>
  </div>
  <div id="game-shell" style="position:relative;width:min(960px,calc(100vw - 16px));height:min(540px,calc(100vh - 120px));min-height:220px;margin:0 auto;background:#badbd0;overflow:visible">
    <div id="game" tabindex="0"></div><div id="ui-windows"></div>
  </div>
  <pre id="status" style="max-width:960px;margin:8px auto 0;white-space:pre-wrap"></pre>
  <pre id="requests" style="max-width:960px;margin:4px auto 0;white-space:pre-wrap"></pre>
</main>`;
const manifest = await fetch('/assets/manifest.json').then(response => response.json());
const requests: unknown[] = [];
const view = new InventoryView(document.getElementById('ui-windows')!, manifest,
  message => { document.getElementById('status')!.textContent = message; },
  request => { requests.push(request); document.getElementById('requests')!.textContent = JSON.stringify(requests); return true; });
const inventory: InventoryItem[] = [
  { slot: 1, itemId: '1002067', quantity: 1, stats: { incPDD: 0, incINT: 5, incMAD: 7 }, remainingSlots: 8 },
  { slot: 2, itemId: '1040017', quantity: 1, stats: { incPDD: 7, incMDD: 5 }, remainingSlots: 8 },
  { slot: 3, itemId: '1302000', quantity: 1, stats: { incPAD: 15, incMAD: 4 }, remainingSlots: 8 },
  { slot: 4, itemId: '1312000', quantity: 1 },
  { slot: 5, itemId: '2000000', quantity: 4 },
  { slot: 6, itemId: '4000019', quantity: 200 },
];
const capStates: (InventoryItem | undefined)[] = [
  { slot: 1, itemId: '1002043', quantity: 1, stats: { incPDD: 10, incINT: 2, incMAD: 3 }, remainingSlots: 8 },
  { slot: 1, itemId: '1002067', quantity: 1, stats: { incPDD: 0, incINT: 5, incMAD: 7 }, remainingSlots: 8 },
  undefined,
];
let capState = 0;
const player: Pick<PlayerState, 'inventory' | 'equipped' | 'mesos'> = {
  mesos: 100000,
  inventory,
  equipped: [],
};
const render = () => {
  player.equipped = [
    capStates[capState],
    { slot: 5, itemId: '1040002', quantity: 1, stats: { incPDD: 2 }, remainingSlots: 8 },
    { slot: 11, itemId: '1302000', quantity: 1, stats: { incPAD: 15, incMAD: 0 }, remainingSlots: 8 },
  ].filter((item): item is InventoryItem => Boolean(item));
  document.getElementById('cap-state')!.textContent = capState === 2 ? '当前帽子：无已装备' : `当前帽子：${player.equipped[0]?.itemId}`;
  view.update(player);
};
document.getElementById('toggle-cap')!.addEventListener('click', () => {
  capState = (capState + 1) % capStates.length;
  render();
});
document.getElementById('clear-cap')!.addEventListener('click', () => {
  capState = 2;
  render();
});
render();
view.open();
