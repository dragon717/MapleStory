// Isolated view fixture. Synthetic snapshots never reach an account or game server.
import { SkillView } from '../client/src/features/skills/view';
import type { PlayerState } from '../shared/protocol';
import '../client/src/app/style.css';

document.body.innerHTML = `<div id="game-shell" style="position:relative;width:100vw;height:100vh;margin:0;overflow:hidden"><div id="game" tabindex="0"></div><div id="ui-windows"></div></div><div id="fixture-controls" style="position:fixed;z-index:50;left:6px;top:6px;display:flex;flex-wrap:wrap;gap:4px;max-width:240px"><button id="learned">已学示例</button><button id="empty">未学习</button><button id="legacy">旧协议状态</button><button id="open">重新打开</button><button id="clear">断线清除</button></div>`;
document.body.style.margin = '0';
const manifest = await fetch('/assets/manifest.json').then(response => response.json());
const view = new SkillView(document.getElementById('ui-windows')!, manifest);
const player = { job: 220, skills: { '2001008': 5, '2201008': 1 }, skillPoints: { '1': 7 } } as unknown as PlayerState;
let snapshot: PlayerState | undefined = player;
view.update(snapshot);
view.open();
// Match the runtime snapshot cadence to reveal focus/scroll resets in the view.
const timer = setInterval(() => view.update(snapshot), 50);
window.addEventListener('pagehide', () => { clearInterval(timer); view.destroy(); }, { once: true });
document.getElementById('learned')!.onclick = () => { snapshot = player; view.update(snapshot); };
document.getElementById('empty')!.onclick = () => { snapshot = { ...player, skills: {}, skillPoints: {} }; view.update(snapshot); };
document.getElementById('legacy')!.onclick = () => { snapshot = { ...player, skills: undefined, skillPoints: undefined }; view.update(snapshot); };
document.getElementById('open')!.onclick = () => view.open();
document.getElementById('clear')!.onclick = () => { snapshot = undefined; view.clear(); };
