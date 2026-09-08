import type { PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';

export type HudPlayer = Pick<PlayerState, 'username' | 'hp' | 'maxHp' | 'mp' | 'maxMp' | 'level' | 'exp' | 'expToNext' | 'mesos' | 'inventory'>;
export function gaugeRatio(value: number, maximum: number): number {
  return Number.isFinite(value) && Number.isFinite(maximum) && maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0;
}
export function expRatio(value: number, expToNext: number): number {
  if (!Number.isFinite(expToNext)) return 0;
  return expToNext === 0 ? 1 : gaugeRatio(value, expToNext);
}
const BUTTONS = [
  ['CashShop', '商城'], ['Event', '活动'], ['Character', '角色与背包'],
  ['Community', '社群'], ['Setting', '设置'], ['Menu', '菜单'],
] as const;

/** The 273 StatusBar3 panel uses source origins inside a responsive HUD row. */
export class HudView {
  private root = document.createElement('div');
  private name = document.createElement('span');
  private level = document.createElement('span');
  private exp = document.createElement('div');
  private expText = document.createElement('span');
  private gauges = new Map<string, { fill: HTMLDivElement; text: HTMLSpanElement; width: number }>();
  private assets: Record<string, AssetFrame>;

  constructor(private host: HTMLElement, manifest: Manifest, private status: (message: string) => void, private onInventory?: () => void, private onMenu?: (trigger: HTMLElement) => void, private onShortcut?: (trigger: HTMLElement) => void) {
    this.assets = manifest.hud ?? {};
    this.root.className = 'tms-hud';
    this.root.hidden = true;
    this.host.hidden = true;
    const row = document.createElement('div');
    row.className = 'tms-hud-row';
    const panel = document.createElement('div');
    panel.className = 'tms-status';
    this.image('mainBar/status/backgrnd', panel, true);
    for (const key of ['hp', 'mp']) {
      const asset = this.assets[`mainBar/status/gauge/${key}/layer:0`];
      if (!asset) throw new Error(`273 HUD 缺少 ${key} 素材`);
      const fill = document.createElement('div');
      fill.className = 'tms-gauge-fill';
      Object.assign(fill.style, { left: `${-asset.origin.x}px`, top: `${-asset.origin.y}px`, width: `${asset.width}px`, height: `${asset.height}px` });
      this.image(`mainBar/status/gauge/${key}/layer:0`, fill);
      panel.append(fill);
      const text = document.createElement('span');
      text.className = 'tms-gauge-text';
      Object.assign(text.style, { left: `${-asset.origin.x}px`, top: `${-asset.origin.y}px`, width: `${asset.width}px`, height: `${asset.height}px` });
      this.gauges.set(key, { fill, text, width: asset.width });
    }
    this.image('mainBar/status/layer:cover', panel, true);
    for (const gauge of this.gauges.values()) panel.append(gauge.text);
    this.image('mainBar/status/layer:Lv', panel, true);
    this.level.className = 'tms-level';
    this.name.className = 'tms-player-name';
    panel.append(this.level, this.name);
    row.append(panel);
    const actions = document.createElement('nav');
    actions.className = 'tms-hud-actions';
    actions.setAttribute('aria-label', '游戏菜单');
    for (const [key, label] of BUTTONS) {
      const button = document.createElement('button');
      button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
      const prefix = `mainBar/menu/button:${key}`;
      const image = this.image(`${prefix}/normal/0`, button);
      const state = (value: string) => { if (this.assets[`${prefix}/${value}/0`]) image.src = this.assets[`${prefix}/${value}/0`].url; };
      button.addEventListener('pointerenter', () => state('mouseOver'));
      button.addEventListener('pointerleave', () => state('normal'));
      button.addEventListener('pointerdown', () => state('pressed'));
      button.addEventListener('pointerup', () => state('mouseOver'));
      button.addEventListener('pointercancel', () => state('normal'));
      button.addEventListener('click', () => {
        if (key === 'Character') this.onInventory?.();
        else if (key === 'Menu' || key === 'Setting') this.onMenu?.(button);
        else if (key === 'Community') document.querySelector<HTMLInputElement>('.chat-input')?.focus();
        else this.status(`${label}业务尚未接入。`);
      });
      actions.append(button);
    }
    const shortcuts = document.createElement('button');
    shortcuts.className = 'tms-shortcuts'; shortcuts.type = 'button'; shortcuts.textContent = '快捷键';
    shortcuts.addEventListener('click', () => this.onShortcut?.(shortcuts));
    actions.append(shortcuts);
    row.append(actions);
    const expTrack = document.createElement('div');
    expTrack.className = 'tms-exp'; expTrack.setAttribute('role', 'progressbar'); expTrack.setAttribute('aria-label', '经验');
    this.exp.className = 'tms-exp-fill';
    const gauge = this.assets['mainBar/EXPBar/800/layer:gauge'];
    if (gauge) this.exp.style.backgroundImage = `url("${gauge.url}")`;
    this.expText.className = 'tms-exp-text';
    expTrack.append(this.exp, this.expText);
    this.root.append(row, expTrack); this.host.replaceChildren(this.root);
  }

  update(player: HudPlayer | undefined) {
    this.host.hidden = !player; this.root.hidden = !player;
    if (!player) return;
    this.name.textContent = player.username; this.name.title = player.username;
    if (this.level.dataset.value !== String(player.level)) {
      this.level.dataset.value = String(player.level);
      this.level.replaceChildren();
      for (const digit of String(player.level)) this.image(`mainBar/status/lvNumber/${digit}`, this.level);
    }
    for (const key of ['hp', 'mp'] as const) {
      const maximum = key === 'hp' ? player.maxHp : player.maxMp;
      const value = Math.max(0, player[key]), gauge = this.gauges.get(key)!;
      gauge.fill.style.width = `${gauge.width * gaugeRatio(value, maximum)}px`;
      gauge.text.textContent = `${value} / ${maximum}`;
      gauge.text.setAttribute('aria-label', `${key.toUpperCase()} ${value} / ${maximum}`);
    }
    const percent = 100 * expRatio(player.exp, player.expToNext);
    this.exp.style.width = `${percent}%`;
    const track = this.exp.parentElement;
    track?.setAttribute('aria-valuenow', percent.toFixed(2));
    track?.setAttribute('aria-valuemin', '0'); track?.setAttribute('aria-valuemax', '100');
    track?.setAttribute('aria-valuetext', player.expToNext === 0
      ? `${player.exp} / MAX · ${percent.toFixed(2)}%`
      : `${player.exp} / ${player.expToNext} · ${percent.toFixed(2)}%`);
    this.expText.textContent = player.expToNext === 0
      ? `${player.exp} / MAX [${percent.toFixed(2)}% · 封顶]`
      : `${player.exp} / ${player.expToNext} [${percent.toFixed(2)}%]`;
  }

  clear() { this.host.hidden = true; this.root.hidden = true; }
  destroy() { this.host.replaceChildren(); this.host.hidden = true; }

  private image(key: string, parent: HTMLElement, positioned = false): HTMLImageElement {
    const frame = this.assets[key];
    if (!frame) throw new Error(`273 HUD 素材缺失：${key}`);
    const image = document.createElement('img'); image.src = frame.url; image.alt = ''; image.draggable = false;
    image.width = frame.width; image.height = frame.height;
    if (positioned) Object.assign(image.style, { position: 'absolute', left: `${-frame.origin.x}px`, top: `${-frame.origin.y}px` });
    parent.append(image); return image;
  }
}
