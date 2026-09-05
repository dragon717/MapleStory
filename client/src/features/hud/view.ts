import type { PlayerState } from '../../../../shared/protocol';
import type { Manifest } from '../../assets/manifest';

const GAUGES = [
  { key: 'hp', label: 'HP', start: 0, width: 108, value: 'hp', maximum: 'maxHp' },
  { key: 'mp', label: 'MP', start: 109, width: 107, value: 'mp', maximum: 'maxMp' },
  { key: 'exp', label: 'EXP', start: 222, width: 118, value: 'exp', maximum: 'expToNext' },
] as const;

// BaseMenu.gd gives the source order.  The source points are anchors for the
// original 800px canvas; keeping them as per-button coordinates made a
// missing BtChat leave a hole and let the remaining buttons overlap.  The
// browser lays this same source-ordered list out as a right-anchored grid.
const BUTTONS = [
  { key: 'BtShop', label: '商城' },
  { key: 'BtChat', label: '聊天' },
  { key: 'BtNPT', label: '交易' },
  { key: 'BtMenu', label: '菜单' },
  { key: 'BtShort', label: '快捷栏' },
] as const;

export type HudPlayer = Pick<
  PlayerState,
  'username' | 'hp' | 'maxHp' | 'mp' | 'maxMp' | 'level' | 'exp' | 'expToNext' | 'mesos' | 'inventory'
> & { job?: string; jobName?: string };

type GlyphLine = HTMLDivElement;

/**
 * GMS83 StatusBar.img as responsive web components.
 *
 * The source art and gauge positions are kept for the wide layout. The
 * source-ordered action list becomes a right-anchored grid, and on
 * narrow/portrait layouts all source-backed controls flow with the page so
 * the game camera remains independent from the page HUD.
 */
export class HudView {
  private readonly hud?: Manifest['hud'];
  private readonly root: HTMLDivElement;
  private readonly art!: HTMLDivElement;
  private readonly gauges!: HTMLDivElement;
  private readonly actions!: HTMLDivElement;
  private readonly levelWide!: GlyphLine;
  private readonly levelFlow!: GlyphLine;
  private readonly glyphLines = new Map<string, GlyphLine>();
  private readonly observer?: ResizeObserver;
  private inventory: HudPlayer['inventory'] = [];

  constructor(private host: HTMLElement, manifest: Manifest, private status: (message: string) => void, private onInventory?: () => void, private onMenu?: () => void, private onShortcut?: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'maple-hud';
    this.root.hidden = true;
    this.hud = manifest.hud;
    this.host.hidden = true;
    host.replaceChildren(this.root);
    if (!this.hud) return;

    this.art = document.createElement('div');
    this.art.className = 'hud-art';
    this.addAssetImage('base/backgrnd', this.art, 'hud-backgrnd');
    this.addAssetImage('base/backgrnd2', this.art, 'hud-backgrnd2');
    this.createIdentity(this.art);
    this.levelWide = this.createGlyphLine('hud-level hud-level-wide', this.art);
    this.root.append(this.art);

    this.levelFlow = this.createGlyphLine('hud-level hud-level-flow', this.root);
    this.gauges = document.createElement('div');
    this.gauges.className = 'hud-gauges';
    for (const gauge of GAUGES) this.createGauge(gauge);
    this.root.append(this.gauges);

    this.actions = document.createElement('div');
    this.actions.className = 'hud-actions';
    const buttonList = this.getButtonList();
    if (buttonList.length !== BUTTONS.length) this.root.dataset.availableButtons = String(buttonList.length);
    for (const button of buttonList) this.createButton(button.key, button.label, button.testIndex);
    this.root.append(this.actions);

    this.observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => this.layout());
    this.observer?.observe(host);
    this.layout();
    this.clear();
  }

  update(player: HudPlayer | undefined) {
    if (!this.hud) return;
    this.host.hidden = !player;
    this.root.hidden = !player;
    if (!player) {
      this.clear();
      return;
    }
    this.inventory = player.inventory;
    this.updateIdentity(player);
    for (const gauge of GAUGES) {
      const element = this.gauges.querySelector<HTMLDivElement>(`[data-gauge="${gauge.key}"]`);
      if (!element) continue;
      const value = Number(player[gauge.value]);
      const maximum = Number(player[gauge.maximum]);
      const fill = maximum > 0 && value > 0 ? Math.max(1, Math.min(gauge.width, Math.floor((value / maximum) * gauge.width))) : 0;
      const fillClip = element.querySelector<HTMLElement>('.hud-gauge-fill');
      if (fillClip) fillClip.style.width = `${fill}px`;
    }
    const hp = Math.max(0, player.hp);
    const maxHp = Math.max(0, player.maxHp);
    const mp = Math.max(0, player.mp);
    const maxMp = Math.max(0, player.maxMp);
    const exp = Math.max(0, player.exp);
    const next = Math.max(0, player.expToNext);
    const percent = next > 0 ? Math.max(0, Math.min(100, Math.floor((exp * 100) / next))) : 0;
    this.setGlyphLine('hp', `[${hp}/${maxHp}]`, 'number');
    this.setGlyphLine('mp', `[${mp}/${maxMp}]`, 'number');
    this.setGlyphLine('exp', `${exp}[${percent}%]`, 'number');
    this.setGlyphLine('level', String(Math.max(1, player.level)), 'number');
    this.updateInventoryData(this.inventory);
    this.root.dataset.mesos = String(Math.max(0, Math.floor(player.mesos)));
  }

  clear() {
    this.host.hidden = true;
    this.root.hidden = true;
    for (const line of this.glyphLines.values()) line.replaceChildren();
    this.gauges?.querySelectorAll<HTMLElement>('.hud-gauge-fill').forEach(fill => { fill.style.width = '0'; });
    this.inventory = [];
  }

  destroy() {
    this.observer?.disconnect();
    this.root.remove();
    this.host.replaceChildren();
    this.host.hidden = true;
  }

  private layout() {
    const compact = this.host.clientWidth > 0 && this.host.clientWidth < 800;
    this.root.classList.toggle('hud-compact', compact);
  }

  private createGauge(gauge: (typeof GAUGES)[number]) {
    const outer = document.createElement('div');
    outer.className = `hud-gauge hud-gauge-${gauge.key}`;
    outer.dataset.gauge = gauge.key;
    outer.style.setProperty('--source-start', `${gauge.start}px`);
    outer.style.setProperty('--source-width', `${gauge.width}px`);
    const fill = document.createElement('div');
    fill.className = 'hud-gauge-fill';
    const bar = this.addAssetImage('gauge/bar', fill, 'hud-gauge-bar');
    if (bar) bar.style.left = `${-gauge.start}px`;
    outer.append(fill);
    const graduation = this.addAssetImage('gauge/graduation', outer, 'hud-gauge-graduation');
    if (graduation) graduation.style.left = `${-gauge.start}px`;
    const line = this.createGlyphLine(`hud-gauge-number hud-gauge-number-${gauge.key}`, outer);
    this.glyphLines.set(gauge.key, line);
    this.gauges.append(outer);
  }

  private getButtonList() {
    const available = BUTTONS.filter(button => Boolean(this.hud?.[`${button.key}/normal/0`]))
      .map(button => ({ ...button }));
    const minWidth = Math.max(54, ...available.map(button => this.hud?.[`${button.key}/normal/0`]?.width ?? 0));
    this.root.style.setProperty('--hud-action-min-width', `${minWidth}px`);
    const params = typeof window === 'undefined' ? undefined : new URLSearchParams(window.location.search);
    const count = params?.get('qaHudButtons') === '8' ? 8 : available.length;
    const testLayout = count !== available.length;
    const list = Array.from({ length: count }, (_, index) => ({
      ...(available[index % Math.max(available.length, 1)] ?? BUTTONS[index % BUTTONS.length]),
      testIndex: testLayout ? index + 1 : undefined,
    }));
    if (testLayout) {
      this.root.dataset.testLayout = 'hud-buttons';
      this.root.dataset.testHudButtons = String(count);
      const columns = Number(params?.get('qaHudColumns'));
      if (Number.isInteger(columns) && columns > 0 && columns <= count) {
        this.root.style.setProperty('--hud-action-columns', String(columns));
        // Keep an explicit QA column count inside the same source-sized row.
        // The normal action group remains compact; only the requested test
        // geometry gets the width needed by its source-sized buttons.
        this.root.style.setProperty('--hud-action-width', `${columns * minWidth + (columns - 1) * 2}px`);
      }
    }
    return list;
  }

  private createButton(key: string, label: string, testIndex?: number) {
    const normal = this.hud?.[`${key}/normal/0`];
    if (!normal) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hud-button';
    button.dataset.button = key;
    if (testIndex !== undefined) button.dataset.testLayout = `hud-buttons-${testIndex}`;
    button.setAttribute('aria-label', testIndex === undefined ? label : `${label}（布局测试 ${testIndex}）`);
    button.title = label;
    button.style.setProperty('--button-width', `${normal.width}px`);
    button.style.setProperty('--button-height', `${normal.height}px`);
    const image = this.addAssetImage(`${key}/normal/0`, button, 'hud-button-image');
    if (!image) return;
    const setState = (state: 'normal' | 'pressed' | 'mouseOver') => {
      const frame = this.hud?.[`${key}/${state}/0`];
      if (frame) image.src = frame.url;
    };
    button.addEventListener('pointerover', () => setState('mouseOver'));
    button.addEventListener('pointerout', () => setState('normal'));
    button.addEventListener('pointerdown', () => setState('pressed'));
    button.addEventListener('pointerup', () => setState('normal'));
    button.addEventListener('click', () => {
      if (key === 'BtMenu' && this.onMenu) this.onMenu();
      else if (key === 'BtShort' && this.onShortcut) this.onShortcut();
      else if (key === 'BtShort' && this.onInventory) this.onInventory();
      else if (key === 'BtShort') this.status('快捷栏暂未开放。');
      else if (key === 'BtMenu') this.status('菜单暂未开放。');
      else if (key === 'BtShop') this.status('商城暂未开放。');
      else if (key === 'BtNPT') this.status('交易暂未开放。');
    });
    this.actions.append(button);
  }

  private addAssetImage(key: string, parent: HTMLElement, className: string): HTMLImageElement | undefined {
    const frame = this.hud?.[key];
    if (!frame) return undefined;
    const image = document.createElement('img');
    image.className = className;
    image.src = frame.url;
    image.alt = '';
    image.draggable = false;
    image.dataset.asset = key;
    image.width = frame.width;
    image.height = frame.height;
    parent.append(image);
    return image;
  }

  private createGlyphLine(className: string, parent: HTMLElement): GlyphLine {
    const line = document.createElement('div');
    line.className = className;
    parent.append(line);
    return line;
  }

  private setGlyphLine(name: string, value: string, font: 'number' | 'FontMemo') {
    const targets = name === 'level' ? [this.levelWide, this.levelFlow] : [this.glyphLines.get(name)].filter((line): line is GlyphLine => Boolean(line));
    for (const target of targets) {
      target.replaceChildren();
      for (const character of value) {
        const key = character === '[' ? 'number/Lbracket' : character === ']' ? 'number/Rbracket' : character === '/' ? 'number/slash' : character === '%' ? 'number/percent' : `${font}/${character}`;
        this.addAssetImage(key, target, 'hud-glyph');
      }
    }
  }

  private updateInventoryData(inventory: HudPlayer['inventory']) {
    this.root.dataset.inventory = inventory.map(item => `${item.itemId}:${item.quantity}`).join(',');
  }

  private createIdentity(parent: HTMLDivElement) {
    const identity = document.createElement('div');
    identity.className = 'hud-identity';
    identity.innerHTML = '<span class="hud-username"></span><span class="hud-job" hidden></span>';
    identity.setAttribute('aria-label', '角色信息');
    parent.append(identity);
  }

  private updateIdentity(player: HudPlayer) {
    const identity = this.art.querySelector<HTMLElement>('.hud-identity');
    const username = identity?.querySelector<HTMLElement>('.hud-username');
    const job = identity?.querySelector<HTMLElement>('.hud-job');
    if (username) username.textContent = player.username;
    const jobName = player.jobName ?? player.job;
    if (job) {
      job.hidden = !jobName;
      job.textContent = jobName ? `· ${jobName}` : '';
    }
  }
}
