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
  private status = document.createElement('p');
  private journal = document.createElement('p');
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
    const title = document.createElement('h2'); title.textContent = '余途 · 回风原'; this.root.append(title);
    this.root.append(this.button('关闭', () => this.close()));
    for (const [name, description, action, image] of [
      ['风铃岛', '沿根道攀登、放下树桥，或借热流抵达树梢驿站。', 'enterIsland', 'island-keyart'],
      ['风铃桥渡口', '河谷两岸的来路。桥上运货，桥下读纸；东岸石脊通向风铃岛。↓＋空格可落到桥下。', 'enterBridge', 'bridge-dormant'],
    ] as const) {
      const card = document.createElement('article'); const art = document.createElement('img');
      art.src = resolveAssetUrl(`/assets/windbell/${image}.png`); art.alt = name;
      const heading = document.createElement('h3'); heading.textContent = name;
      const copy = document.createElement('p'); copy.textContent = description;
      card.append(art, heading, copy, this.button('进入', () => { this.send(action); this.close(); })); this.root.append(card);
    }
    const hint = document.createElement('p'); hint.textContent = '每次远行留下来路，每次归来遇见变化。原创世界 · 方向键移动，空格跳跃，↑↓攀绳。可随时返回进入前的位置。'; this.root.append(hint);
    this.dock.className = 'windbell-dock'; this.dock.hidden = true; this.dock.setAttribute('aria-label', '风铃场景互动');
    this.dialogue.setAttribute('aria-live', 'polite');
    const memories = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '我的来路';
    memories.append(summary, this.journal);
    this.dock.append(this.actions, this.status, this.dialogue, memories, this.button('返回来处', () => this.act('leave')));
    host.append(this.root, this.dock); document.addEventListener('keydown', this.escape, true);
  }
  private button(label: string, action: () => void) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', action); return b;
  }
  isOpen() { return this.open; }
  talk() { this.act('talk'); }
  show() { this.open = true; this.root.hidden = false; this.root.querySelector('button')?.focus(); }
  close() { this.open = false; this.root.hidden = true; this.focus(); }
  private act(action: WindbellAction) { if (this.state) this.send(action, action === 'enterIsland' || action === 'enterBridge' ? undefined : this.state.instanceId); this.focus(); }
  update(state?: WindbellState, player?: PlayerState, npcs: NpcState[] = []) {
    this.state = state; this.dock.hidden = !state;
    if (!state || !player) { this.signature = '\0'; return; }
    const choices: Array<[WindbellAction, string, number, number]> = state.scene === 'island' ? [
      ['cutSupport', state.treeBridge === 'held' ? '斩断支撑绳' : '查看树桥', config.island.treeBridge.support.x, config.island.treeBridge.support.y],
      ['ignite', state.heat === 'dry' ? '点燃干枝' : '查看火槽', config.island.heat.branch.x, config.island.heat.branch.y],
      ['deployLeafwing', state.leafwing ? '叶翼已展开' : '展开叶翼', config.island.heat.branch.x, config.island.heat.branch.y],
    ] : [
      ...(!state.cartUpright ? [['braceCart', '帮阿苇扶车', config.bridge.cart.x, config.bridge.cart.y] as [WindbellAction, string, number, number]] : []),
      ...(state.planks > 0 ? [['deliverPlank', '交接一块木板', config.bridge.material.x, config.bridge.material.y] as [WindbellAction, string, number, number]] : []),
      ...(state.ropes > 0 ? [['deliverRope', '交接一条绳索', config.bridge.material.x, config.bridge.material.y] as [WindbellAction, string, number, number]] : []),
      ...(state.livelihood ? [['rest', `歇脚补给（余 ${state.livelihood.shelter} 份）`, config.bridge.segments.at(-1)!.x2, config.bridge.segments.at(-1)!.y2] as [WindbellAction, string, number, number]] : []),
      ...(state.livelihood && state.livelihood.paperMoisture > 0 ? [['dryRecords', '用一份补给帮忙烘纸', config.bridge.archive.x, config.bridge.archive.y] as [WindbellAction, string, number, number]] : []),
      ['enterIsland', '沿石脊前往风铃岛', 2350, 700],
    ];
    if (state.leafwingLearned && !player.grounded) {
      const thermal = choices.findIndex(([action]) => action === 'deployLeafwing');
      if (thermal >= 0) choices.splice(thermal, 1);
      choices.push(['deployLeafwing', state.leafwing ? '叶翼已展开' : '展开叶翼', player.x, player.y]);
    }
    const npc=npcs.filter(n=>n.templateId.startsWith('windbell-')).sort((a,b)=>Math.hypot(a.x-player.x,a.y-player.y)-Math.hypot(b.x-player.x,b.y-player.y))[0];
    if(npc)choices.push(['talk', `与${npc.nameZh || npc.name}交谈`, npc.x, npc.y]);
    const nearby = choices.filter(([, , x, y]) => Math.abs(player.x-x) <= 120 && Math.abs(player.y-y) <= 110);
    const signature = nearby.map(x => x.slice(0,2).join(':')).join('|');
    if (signature !== this.signature) {
      this.actions.replaceChildren(...nearby.map(([action, label]) => this.button(label, () => this.act(action))));
      if (!nearby.length) this.actions.textContent = '靠近人物或道具，可在这里互动。';
      this.signature = signature;
    }
    const life = state.livelihood;
    const work = life ? { loading: '阿苇在林圃装货', outbound: '补给正运过桥', resting: '阿苇在对岸歇脚', returning: '空车正返回林圃' }[life.phase] : '';
    const archive = life ? life.paperMoisture ? `${life.paperMoisture === 3 ? '桥下纸页仍湿。' : life.paperMoisture === 2 ? '桥下水汽渐散。' : '桥下字迹渐清。'}${state.archiveSafe ? '槐生正在照看火盆。' : '蜗牛靠近石台，槐生暂时停手。'}` : '桥下旧路记已可阅读。' : '桥下槐生在等待补给。';
    this.status.textContent = state.scene === 'island' ? `根道始终开放。攀绳可抵达树桥支撑点。${state.leafwingLearned ? '跃下后可展开叶翼。' : '树梢驿站的岚织懂得折叶御风。'}` : life ? `${work}。林圃 ${life.source} · 车上 ${life.cargo} · 歇脚棚 ${life.shelter} 份补给。${archive}` : `现场剩余材料：木板 ${state.planks} · 绳索 ${state.ropes}。${archive}`;
    const journey = state.journey;
    this.journal.textContent = journey ? [
      journey.arrived && '曾亲自走到风铃岛树梢。', journey.leafwingLearned && '岚织教会了我折叶御风；在风铃岛和渡口都能用。',
      journey.braceCart && '曾替阿苇扶住车辕。', (journey.deliveredPlanks || journey.deliveredRopes) && `曾交接 ${journey.deliveredPlanks} 块木板、${journey.deliveredRopes} 捆绳。`,
      journey.lastAttempt === 'failed' && '上次热流没能把我留在树梢；根道仍然开放。',
      journey.huaishengMet && '在桥下遇见了想保存旧路的槐生。', journey.archiveHelped && '曾与槐生一起托住湿纸。', journey.archiveRead && '读过旧路记：根道上树梢，折叶返桥影。',
    ].filter(Boolean).join(' ') || '来路从亲自走出的第一步开始。' : '';
    const text = state.dialogue?.join('\n') || '';
    if (this.dialogue.textContent !== text) this.dialogue.textContent = text;
  }
  destroy() { document.removeEventListener('keydown', this.escape, true); this.root.remove(); this.dock.remove(); }
}
