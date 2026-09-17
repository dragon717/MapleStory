import type { WindbellAction, WindbellState, PlayerState, NpcState } from '../../../../shared/protocol';
import config from '../../../../shared/windbell.json';
import { resolveAssetUrl } from '../../assets/resource-url';
import './style.css';

/** Menus send intentions; the server owns entry, proximity and world facts. */
export class ActivitiesView {
  private root = document.createElement('section');
  private dock = document.createElement('section');
  private actions = document.createElement('div');
  private dialogue = document.createElement('p');
  private state?: WindbellState;
  private open = false;
  private signature = '\0';
  private escape = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.open) { e.preventDefault(); e.stopPropagation(); this.close(); }
    if (e.key === 'Tab' && this.open) {
      const buttons = Array.from(this.root.querySelectorAll('button'));
      const first=buttons[0], last=buttons[buttons.length-1];
      if (e.shiftKey && document.activeElement===first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement===last) { e.preventDefault(); first?.focus(); }
    }
  };
  constructor(host: HTMLElement, private send: (action: WindbellAction, instanceId?: string) => void, private focus: () => void) {
    this.root.className = 'windbell-activities'; this.root.hidden = true;
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-label', '活动清单');
    const title = document.createElement('h2'); title.textContent = '活动清单'; this.root.append(title);
    this.root.append(this.button('关闭', () => this.close()));
    for (const [name, description, action, image] of [
      ['风铃岛', '沿根道攀登、放下树桥，或借热流抵达树梢驿站。', 'enterIsland', 'island-keyart'],
      ['风铃桥渡口', '扶正货车、交接材料，看一座公共桥恢复通行。', 'enterBridge', 'bridge-dormant'],
    ] as const) {
      const card = document.createElement('article'); const art = document.createElement('img');
      art.src = resolveAssetUrl(`/assets/windbell/${image}.png`); art.alt = name;
      const heading = document.createElement('h3'); heading.textContent = name;
      const copy = document.createElement('p'); copy.textContent = description;
      card.append(art, heading, copy, this.button('进入', () => { this.send(action); this.close(); })); this.root.append(card);
    }
    const hint = document.createElement('p'); hint.textContent = '原创活动 · 方向键移动，空格跳跃，↑↓攀绳。可随时返回进入前的位置。'; this.root.append(hint);
    this.dock.className = 'windbell-dock'; this.dock.hidden = true; this.dock.setAttribute('aria-label', '风铃场景互动');
    this.dialogue.setAttribute('aria-live', 'polite');
    this.dock.append(this.actions, this.dialogue, this.button('离开活动', () => this.act('leave')));
    host.append(this.root, this.dock); document.addEventListener('keydown', this.escape, true);
  }
  private button(label: string, action: () => void) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', action); return b;
  }
  isOpen() { return this.open; }
  talk() { this.act('talk'); }
  show() { this.open = true; this.root.hidden = false; this.root.querySelector('button')?.focus(); }
  close() { this.open = false; this.root.hidden = true; this.focus(); }
  private act(action: WindbellAction) { if (this.state) this.send(action, this.state.instanceId); this.focus(); }
  update(state?: WindbellState, player?: PlayerState, npcs: NpcState[] = []) {
    this.state = state; this.dock.hidden = !state;
    if (!state || !player) { this.signature = '\0'; return; }
    const choices: Array<[WindbellAction, string, number, number]> = state.scene === 'island' ? [
      ['cutSupport', state.treeBridge === 'held' ? '斩断支撑绳' : '查看树桥', config.island.treeBridge.support.x, config.island.treeBridge.support.y],
      ['ignite', state.heat === 'dry' ? '点燃干枝' : '查看火槽', config.island.heat.branch.x, config.island.heat.branch.y],
      ['deployLeafwing', state.leafwing ? '叶翼已展开' : '展开叶翼', config.island.heat.branch.x, config.island.heat.branch.y],
    ] : [
      ['braceCart', state.cartUpright ? '查看货车' : '帮阿苇扶车', 450, 700],
      ['deliverPlank', '交接一块木板', 650, 700], ['deliverRope', '交接一条绳索', 650, 700],
    ];
    const npc=npcs.filter(n=>n.templateId.startsWith('windbell-')).sort((a,b)=>Math.hypot(a.x-player.x,a.y-player.y)-Math.hypot(b.x-player.x,b.y-player.y))[0];
    if(npc)choices.push(['talk', `与${npc.nameZh || npc.name}交谈`, npc.x, npc.y]);
    const nearby = choices.filter(([, , x, y]) => Math.abs(player.x-x) <= 120 && Math.abs(player.y-y) <= 110);
    const signature = nearby.map(x => x.slice(0,2).join(':')).join('|');
    if (signature !== this.signature) {
      this.actions.replaceChildren(...nearby.map(([action, label]) => this.button(label, () => this.act(action))));
      if (!nearby.length) this.actions.textContent = '靠近人物或道具，可在这里互动。';
      this.signature = signature;
    }
    const text = state.dialogue?.join('\n') || (state.scene === 'island' ? '根道始终开放。攀绳可抵达树桥支撑点。' : `现场剩余材料：木板 ${state.planks} · 绳索 ${state.ropes}`);
    if (this.dialogue.textContent !== text) this.dialogue.textContent = text;
  }
  destroy() { document.removeEventListener('keydown', this.escape, true); this.root.remove(); this.dock.remove(); }
}
