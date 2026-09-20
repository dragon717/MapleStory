import type { WindbellAction, WindbellState, PlayerState, NpcState } from '../../../../shared/protocol';
import config from '../../../../shared/windbell.json';
import type { Manifest } from '../../assets/manifest';
import { createAssetButton, installWindowDrag, bringToFront, clampIntoHost } from '../ui/window-shell';
import type { ColossusControl } from '../colossus/view';
import colossus from '../../../../shared/colossus.json';
import { resolveAssetUrl } from '../../assets/resource-url';
import './style.css';

/** Menus send intentions; the server owns entry, proximity and world facts. */
export class ActivitiesView {
  private root = document.createElement('section');
  private content = document.createElement('div');
  private disposeDrag?: () => void;
  private resize?: ResizeObserver;
  private dock = document.createElement('section');
  private actions = document.createElement('div');
  private dialogue = document.createElement('p');
  private status = document.createElement('p');
  private journal = document.createElement('p');
  private state?: WindbellState;
  private open = false;
  private signature = '\0';
  private colossusCard?: HTMLElement;
  private colossusEnter?: HTMLButtonElement;
  private colossusControls?: HTMLElement;
  private inColossus = false;
  private escape = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.open) { e.preventDefault(); e.stopPropagation(); this.close(); }
  };
  constructor(host: HTMLElement, private send: (action: WindbellAction, instanceId?: string) => void, private focus: () => void, enterColossus?: () => void, controlColossus?: (action: ColossusControl) => void, openKeys?: () => void, manifest?: Manifest) {
    this.root.className = 'windbell-activities'; this.root.hidden = true;
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'false'); this.root.setAttribute('aria-label', '活动清单');
    const title = document.createElement('h2'); title.textContent = '活动'; this.root.append(title);
    // Reuse the existing UtilDlgEx slices and dialog option interaction; no activity-specific skin.
    for (const name of ['t','c','s']) { const art = manifest?.dialogUi?.[name]; if (art) this.root.style.setProperty('--activity-'+name, 'url("'+art.url+'")'); }
    const close = createAssetButton({ assets: manifest?.inventoryUi ?? {}, base: 'AutoBuild/button:close', label: '关闭活动', action: () => this.close() });
    if (close) { close.button.className = 'activity-close'; this.root.append(close.button); }
    else this.root.append(this.button('关闭', () => this.close()));
    this.content.className = 'activity-content'; this.root.append(this.content);
    this.disposeDrag = installWindowDrag(host, this.root, { titleHeight: 28, isOpen: () => this.open, onActivate: () => bringToFront(host, this.root) });
    this.root.addEventListener('pointerdown', () => bringToFront(host, this.root));
    this.resize = new ResizeObserver(() => clampIntoHost(host, this.root)); this.resize.observe(host);
    for (const [name, description, action, image] of [
      ['风铃岛', '沿根道攀登、放下树桥，或借热流抵达树梢驿站。', 'enterIsland', 'island-keyart'],
      ['风铃桥渡口', '河谷两岸的来路。桥上运货，桥下读纸；东岸石脊通向风铃岛。↓＋空格可落到桥下。', 'enterBridge', 'bridge-dormant'],
    ] as const) {
      const card = document.createElement('article'); const art = document.createElement('img');
      art.src = resolveAssetUrl(`/assets/windbell/${image}.png`); art.alt = name;
      const heading = document.createElement('h3'); heading.textContent = name;
      const copy = document.createElement('p'); copy.textContent = description;
      card.append(art, heading, copy, this.button('进入', () => { this.send(action); this.close(); })); this.content.append(card);
    }
    if (enterColossus) {
      const card=document.createElement('article'), art=document.createElement('img'), heading=document.createElement('h3'), copy=document.createElement('p');
      art.src=resolveAssetUrl(colossus.art['activity-cover']);art.alt='蓝旗港口与海中苏醒的巨像';heading.textContent='巨石之约';copy.textContent='沿蓝旗登上高台。脚下的道路、海中的礁石，都还有另一面。';
      this.colossusEnter = this.button('登岸',()=>{enterColossus();this.close();});
      this.colossusControls = document.createElement('div');
      this.colossusControls.className = 'activity-scene-controls';
      this.colossusControls.hidden = true;
      const help = document.createElement('p');
      help.textContent = '沿用冒险岛的移动、跳跃与攻击按键。桥头靠近藤蔓再攻击；路口按 ↑ 通行。小地图、世界地图、聊天和活动都从原有入口打开。失足可走安全坡道；手掌停稳后可从高台登上巨像。演出可跳过，也可回看。';
      const actions = document.createElement('div');
      for (const [action, label] of [['replay','回看远景'],['skip','跳过演出'],['orbit','换个视角'],['quality','切换省电画质'],['leave','返回来处']] as const) actions.append(this.button(label, () => { controlColossus?.(action); this.close(); }));
      actions.append(this.button('键盘设置', () => { this.close(false); openKeys?.(); }));
      this.colossusControls.append(help, actions);
      this.colossusCard = card;
      card.append(art,heading,copy,this.colossusEnter,this.colossusControls);this.content.append(card);
    }
    const hint = document.createElement('p'); hint.textContent = '每次远行留下来路，每次归来遇见变化。原创世界 · 方向键移动，空格跳跃，↑↓攀绳。可随时返回进入前的位置。'; this.content.append(hint);
    this.dock.className = 'windbell-dock'; this.dock.hidden = true; this.dock.setAttribute('aria-label', '风铃场景互动');
    this.dialogue.setAttribute('aria-live', 'polite');
    const memories = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '我的来路';
    memories.append(summary, this.journal);
    this.dock.append(this.actions, this.status, this.dialogue, memories, this.button('返回来处', () => this.act('leave')));
    host.append(this.root, this.dock); document.addEventListener('keydown', this.escape, true);
  }
  private button(label: string, action: () => void) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = 'npc-dlg-opt'; b.addEventListener('click', action); return b;
  }
  isOpen() { return this.open; }
  talk() { this.act('talk'); }
  show() { this.open = true; this.root.hidden = false; this.root.querySelector('button')?.focus(); if (this.inColossus) this.colossusCard?.scrollIntoView({ block: 'nearest' }); }
  updateColossus(active: boolean) { this.inColossus = active; if (this.colossusEnter) this.colossusEnter.hidden = active; if (this.colossusControls) this.colossusControls.hidden = !active; }
  close(restoreFocus = true) { this.open = false; this.root.hidden = true; if (restoreFocus) this.focus(); }
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
  destroy() { this.disposeDrag?.(); this.resize?.disconnect(); document.removeEventListener('keydown', this.escape, true); this.root.remove(); this.dock.remove(); }
}
