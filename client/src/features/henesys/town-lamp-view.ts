import type { ClientMessage, PlayerState, TownLampAction, TownLampResult } from '../../../../shared/protocol';
import type { Manifest } from '../../assets/manifest';
import { bringToFront, clampIntoHost, createAssetButton, installWindowDrag } from '../ui/window-shell';
import east from '../../../../shared/chuxian-east.json';
import rules from '../../../../shared/town-lamps.json';
import { HENESYS_MAP_ID, PIXELS_PER_METRE, segmentAt } from './coordinates';
import { TOWN_LAMP_GUARD_ID } from './town-lamps';
import './town-lamp-style.css';

const messages: Record<string, string> = {
  lamp_town_only: '灯具服务仅在初弦地开放。', lamp_guard_required: '请向门口的初弦地守卫购买或升级。',
  npc_too_far: '请靠近门口守卫后再购买或升级。', lamp_level_required: '角色等级还不足以使用这档灯具。',
  invalid_lamp_upgrade: '升级需要持有前一档灯具。', lamp_not_better: '已持有同档或更好的灯具。',
  invalid_lamp_cost: '灯具价格已变化，请刷新后重试。', insufficient_mesos: '枫币不足。',
  lamp_missing: '当前没有携带灯具。', dead: '请复活后再使用灯具服务。',
  idempotency_conflict: '该请求已用于另一笔操作，请重新操作。', persistence: '灯具未能保存，请稍后再试。',
};

/** Original town service inside the existing draggable, closable window system. */
export class TownLampPanel {
  private host = document.createElement('div');
  private window = document.createElement('section');
  private balance = document.createElement('p');
  private held = document.createElement('p');
  private hint = document.createElement('p');
  private feedback = document.createElement('p');
  private rows: { tier: number; buy: HTMLButtonElement; upgrade: HTMLButtonElement }[] = [];
  private discard = document.createElement('button');
  private player?: PlayerState;
  private mapId?: string;
  private npcId = TOWN_LAMP_GUARD_ID;
  private pending?: string;
  private dragDispose: () => void;
  private observer: ResizeObserver;
  private guardX = east.spawn.x + rules.guard.spawnOffsetPixels;
  private guardY: number;
  private keydown = (event: KeyboardEvent) => {
    if (!this.isOpen() || event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); this.close(); }
  };
  constructor(host: HTMLElement, manifest: Manifest, private status: (text: string) => void, private send: (message: ClientMessage) => boolean) {
    const { a, b } = segmentAt(this.guardX); this.guardY = a.y + (b.y - a.y) * (this.guardX - a.x) / (b.x - a.x);
    this.host.className = 'ui-windows town-lamp-host'; this.host.hidden = true;
    this.window.className = 'town-lamp-panel'; this.window.tabIndex = -1;
    this.window.setAttribute('role', 'dialog'); this.window.setAttribute('aria-modal', 'false'); this.window.setAttribute('aria-label', '初弦地灯具');
    const title = document.createElement('header'); title.textContent = '初弦地灯具';
    const close = createAssetButton({ assets: manifest.questUi ?? {}, base: 'button:close', label: '关闭灯具窗口', className: 'town-lamp-close', action: () => this.close() })?.button ?? document.createElement('button');
    if (!close.childElementCount) { close.type = 'button'; close.textContent = '×'; close.className = 'town-lamp-close'; close.setAttribute('aria-label', '关闭灯具窗口'); close.addEventListener('click', () => this.close()); }
    title.append(close); this.window.append(title, this.held, this.balance, this.hint);
    const list = document.createElement('div'); list.className = 'town-lamp-options';
    for (const data of rules.tiers) {
      const row = document.createElement('article'), name = document.createElement('strong'), detail = document.createElement('p'), actions = document.createElement('div');
      name.textContent = `${['低', '中', '高'][data.tier - 1]}档 · ${data.name}`;
      detail.textContent = `照明范围 ${data.rangeMetres} 米 · 需要 ${data.requiredLevel} 级`;
      detail.title = `${data.intensityCandela} cd；最大作用距离 ${data.rangeMetres} m，边缘渐暗。`;
      actions.className = 'town-lamp-actions';
      const buy = document.createElement('button'); buy.type = 'button'; buy.textContent = `购买 ${data.buyPrice} 枫币`; buy.addEventListener('click', () => this.request('buy', data.tier));
      const upgrade = document.createElement('button'); upgrade.type = 'button'; upgrade.textContent = `升级 ${data.upgradePrice} 枫币`; upgrade.addEventListener('click', () => this.request('upgrade', data.tier));
      actions.append(buy, upgrade); row.append(name, detail, actions); list.append(row); this.rows.push({ tier: data.tier, buy, upgrade });
    }
    this.discard.type = 'button'; this.discard.className = 'town-lamp-discard'; this.discard.textContent = '丢弃携带的灯'; this.discard.addEventListener('click', () => this.request('discard', 0));
    const note = document.createElement('p'); note.className = 'town-lamp-note'; note.textContent = '守卫初次赠灯一次。丢弃后需重新购买，镇内默认携带已持有的灯。';
    this.feedback.className = 'town-lamp-feedback'; this.feedback.setAttribute('aria-live', 'polite');
    this.window.append(list, this.discard, note, this.feedback); this.host.append(this.window); host.append(this.host);
    this.window.addEventListener('pointerdown', () => bringToFront(this.host, this.window));
    this.dragDispose = installWindowDrag(this.host, this.window, { titleHeight: 32, isOpen: () => this.isOpen(), onActivate: () => bringToFront(this.host, this.window) });
    this.observer = new ResizeObserver(() => clampIntoHost(this.host, this.window)); this.observer.observe(host);
    document.addEventListener('keydown', this.keydown);
  }
  update(player: PlayerState | undefined, mapId?: string) {
    this.player = player; this.mapId = mapId;
    if (!player || mapId !== HENESYS_MAP_ID) { this.pending = undefined; this.close(); }
    this.refresh();
  }
  open(npcId = TOWN_LAMP_GUARD_ID) {
    if (npcId !== TOWN_LAMP_GUARD_ID || !this.player || this.mapId !== HENESYS_MAP_ID) return false;
    this.npcId = npcId; this.host.hidden = false; this.refresh(); bringToFront(this.host, this.window); this.window.focus(); return true;
  }
  isOpen() { return !this.host.hidden; }
  close() { this.host.hidden = true; }
  private nearGuard() { const p = this.player; return Boolean(p && Math.abs(p.x - this.guardX) <= rules.guard.interactionRangeMetres * PIXELS_PER_METRE && Math.abs(p.y - this.guardY) <= rules.guard.verticalRangeMetres * PIXELS_PER_METRE); }
  private refresh() {
    const p = this.player, tier = p?.townLamp?.tier ?? 0, alive = Boolean(p && p.hp > 0 && p.action !== 'dead'), ready = alive && !this.pending;
    this.held.textContent = `携带：${rules.tiers.find(t => t.tier === tier)?.name ?? '无灯具'}`;
    this.balance.textContent = `枫币：${p?.mesos.toLocaleString() ?? '—'}`;
    this.hint.textContent = this.pending ? '正在等待守卫确认…' : this.nearGuard() ? '可购买更好的灯，或逐档升级。' : '请靠近门口的初弦地守卫后购买或升级。';
    for (const row of this.rows) {
      const data = rules.tiers[row.tier - 1], allowed = ready && this.nearGuard() && (p?.level ?? 0) >= data.requiredLevel;
      row.buy.disabled = !allowed || row.tier <= tier || (p?.mesos ?? 0) < data.buyPrice;
      row.upgrade.hidden = tier === 0 || row.tier !== tier + 1;
      row.upgrade.disabled = !allowed || (p?.mesos ?? 0) < data.upgradePrice;
    }
    this.discard.disabled = !ready || tier === 0;
  }
  private request(action: TownLampAction, tier: number) {
    if (this.pending || !this.player || this.mapId !== HENESYS_MAP_ID) return;
    const data = rules.tiers.find(t => t.tier === tier);
    const expectedCost = action === 'discard' ? 0 : action === 'buy' ? data?.buyPrice : data?.upgradePrice;
    if (expectedCost === undefined) return;
    const requestId = crypto.randomUUID(); this.pending = requestId;
    if (!this.send({ type: 'townLamp', requestId, action, tier: tier as 0 | 1 | 2 | 3, expectedCost, ...(action === 'discard' ? {} : { npcId: this.npcId }) })) {
      this.pending = undefined; this.feedback.textContent = '当前未连接，灯具操作未发送。';
    } else this.feedback.textContent = '';
    this.refresh();
  }
  handle(result: TownLampResult) {
    if (result.action === 'issued') { this.status('初弦地守卫赠给你一盏近行提灯。'); return; }
    if (result.requestId !== this.pending) return;
    this.pending = undefined;
    const text = result.success ? result.action === 'discard' ? '已丢弃灯具，之后需重新购买。' : `已${result.action === 'buy' ? '购买' : '升级'}${rules.tiers.find(t => t.tier === result.townLamp.tier)?.name ?? '灯具'}。` : messages[result.code] ?? '灯具操作未完成。';
    // A replay receipt may describe an old balance. The next snapshot owns panel state.
    this.feedback.textContent = text; this.status(text); this.refresh();
  }
  reject(requestId?: string, code = 'persistence') { if (requestId !== this.pending) return; this.pending = undefined; this.feedback.textContent = messages[code] ?? '灯具操作未完成。'; this.refresh(); }
  destroy() { document.removeEventListener('keydown', this.keydown); this.observer.disconnect(); this.dragDispose(); this.host.remove(); }
}
