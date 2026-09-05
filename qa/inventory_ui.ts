// Browser-only fixture: no account, network mutation, or persistent game data.
import { InventoryView } from '../client/src/features/inventory/view';
import type { PlayerState } from '../shared/protocol';
import '../client/src/app/style.css';

document.body.innerHTML = `<div id="game-shell" style="position:relative;width:960px;height:540px;margin:20px;background:#badbd0"><div id="game" tabindex="0"></div><div id="ui-windows"></div></div><pre id="status"></pre><pre id="requests"></pre>`;
const manifest = await fetch('/assets/manifest.json').then(response => response.json());
const requests: unknown[] = [];
const view = new InventoryView(document.getElementById('ui-windows')!, manifest,
  message => { document.getElementById('status')!.textContent = message; },
  request => { requests.push(request); document.getElementById('requests')!.textContent = JSON.stringify(requests); return true; });
const player: Pick<PlayerState, 'inventory' | 'equipped' | 'mesos'> = {
  mesos: 100000,
  inventory: [
    { slot: 1, itemId: '1002067', quantity: 1 },
    { slot: 1, itemId: '2000000', quantity: 4 },
    { slot: 2, itemId: '2040002', quantity: 1 },
    { slot: 1, itemId: '4000019', quantity: 200 },
  ],
  equipped: [
    { slot: 11, itemId: '1302000', quantity: 1 },
    { slot: 5, itemId: '1040002', quantity: 1 },
    { slot: 1, itemId: '1002067', quantity: 1, stats: { incPDD: 10 }, remainingSlots: 6, upgradeCount: 1 },
  ],
};
view.update(player);
view.open();
setInterval(() => view.update(player), 50);
