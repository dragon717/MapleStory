import type { AbilityStat, ClientMessage, PlayerState, ServerMessage } from '../../../../shared/protocol';
import type { Manifest, SkillArt } from '../../assets/manifest';
import { installWindowDrag, bringToFront } from '../ui/window-shell.ts';
import './style.css';

type CharacterField =
  | 'username'
  | 'job'
  | 'level'
  | 'hp'
  | 'mp'
  | 'exp'
  | 'availableAp'
  | 'mesos'
  | 'magicAttack'
  | 'defense'
  | 'moveSpeed'
  | 'magicGuard'
  | 'strength'
  | 'dexterity'
  | 'intelligence'
  | 'luck'
  | 'meditation'
  | 'iceTeleport';

type AllocateApRequest = Extract<ClientMessage, { type: 'allocateAp' }>;
type AbilityResult = Extract<ServerMessage, { type: 'abilityResult' }>;
const ABILITY_STATS: readonly AbilityStat[] = ['strength', 'dexterity', 'intelligence', 'luck'];
const ABILITY_BUTTON_NAMES: Record<AbilityStat, string> = { strength: 'Str', dexterity: 'Dex', intelligence: 'Int', luck: 'Luk' };
/** Draggable strip: the dark frame band above the white card.  The source
 *  `common/main/backgrnd` paints its green CHARACTER INFO header inside the
 *  top 26 px (white card starts at y32, close button sits at y12..23), so the
 *  whole band is the title bar (spec R1: title height recorded as a constant). */
const CHARACTER_TITLE_HEIGHT = 26;

type CharacterDerivedStats = NonNullable<PlayerState['derivedStats']> &
  Partial<Record<'strength' | 'dexterity' | 'intelligence' | 'luck', number>>;

const CHARACTER_JOBS: Record<number, string> = {
  0: '新手',
  200: '法师',
  210: '火毒法师',
  220: '冰雷法师',
  230: '牧师',
};

/** Display name for a server-owned job id.  Shared with the party roster so a
 *  member's job reads the same in both windows. */
export function characterJobName(job: number | undefined) {
  if (job === undefined) return '—';
  return CHARACTER_JOBS[job] ?? `职业 ${job}`;
}

/** Source-backed UICharacterInfo window with a native-size, scrollable canvas. */
export class CharacterInfoView {
  hotkeysEnabled = true;
  private readonly manifest: Manifest;
  private readonly root: HTMLDivElement;
  private readonly window: HTMLDivElement;
  private readonly fields = new Map<CharacterField, HTMLSpanElement[]>();
  private readonly derivedFields = new Map<AbilityStat, HTMLSpanElement[]>();
  private readonly abilityButtons = new Map<AbilityStat, HTMLButtonElement>();
  private readonly abilityButtonImages = new Map<AbilityStat, HTMLImageElement>();
  private readonly status: (message: string) => void;
  private readonly send?: (message: AllocateApRequest) => boolean;
  private readonly pendingAllocations = new Map<string, AbilityStat>();
  private player?: PlayerState;
  private openState = false;
  private destroyed = false;
  private requestSequence = 0;
  private readonly dragDispose: () => void;

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (this.destroyed || event.defaultPrevented || event.repeat || event.isComposing) return;
    if (event.metaKey || event.altKey || event.ctrlKey) return;
    const target = event.target as (HTMLElement & { matches?: (selector: string) => boolean }) | null;
    if (target?.matches?.('input,textarea,select,[contenteditable="true"]') || target?.isContentEditable) return;
    if (event.key === 'Escape') {
      if (!this.openState) return;
      event.preventDefault();
      this.close();
      return;
    }
    if (this.hotkeysEnabled && event.code === 'KeyC' && this.player) {
      event.preventDefault();
      this.toggle();
    }
  };

  constructor(root: HTMLElement, manifest: Manifest, status: (message: string) => void, send?: (message: AllocateApRequest) => boolean) {
    this.manifest = manifest;
    this.status = status;
    this.send = send;
    this.root = document.createElement('div');
    this.root.className = 'ui-windows tms273-character-host';
    this.root.hidden = true;
    this.root.dataset.open = 'false';

    this.window = document.createElement('div');
    this.window.className = 'character-window';
    this.window.setAttribute('role', 'dialog');
    this.window.setAttribute('aria-modal', 'false');
    this.window.setAttribute('aria-label', '角色信息');
    this.window.tabIndex = -1;

    // Overlay hit strip for the window drag (spec R2): sits on the source
    // frame band, leaves the close button (higher z-index) clickable.
    const titlebar = document.createElement('div');
    titlebar.className = 'character-titlebar';
    titlebar.setAttribute('aria-hidden', 'true');
    this.window.append(titlebar);

    const scroll = document.createElement('div');
    scroll.className = 'character-scroll';
    scroll.tabIndex = 0;
    const content = document.createElement('div');
    content.className = 'character-scroll-content';
    content.append(this.createMainCard(), this.createDetailCard());
    scroll.append(content);
    this.window.append(scroll);
    this.root.append(this.window);
    root.append(this.root);

    // R2/R3: drag by the title strip, raise on activation, clamp to the host.
    this.dragDispose = installWindowDrag(this.root, this.window, {
      titleHeight: CHARACTER_TITLE_HEIGHT,
      isOpen: () => this.openState,
      onActivate: () => bringToFront(this.root, this.window),
    });
    document.addEventListener('keydown', this.handleKeyDown, true);
    if (!manifest.characterUi?.['common/main/backgrnd'] || !manifest.characterUi?.['local/detail/backgrnd']) {
      this.status('角色信息底图未加载，窗口将保留可用数据。');
    }
    this.update(undefined);
  }

  update(player?: PlayerState) {
    if (this.destroyed) return;
    this.player = player;
    if (!player) this.pendingAllocations.clear();
    const derived = player?.derivedStats as CharacterDerivedStats | undefined;
    const ability = player?.abilityStats;
    this.setField('username', player?.username ?? '—');
    this.setField('job', this.jobName(player?.job));
    this.setField('level', player ? `Lv. ${this.formatNumber(player.level)}` : '—');
    this.setField('hp', player ? this.pair(player.hp, player.maxHp) : '—');
    this.setField('mp', player ? this.pair(player.mp, player.maxMp) : '—');
    this.setField('exp', player ? this.expProgress(player.exp, player.expToNext) : '—');
    this.setField('availableAp', ability ? this.numberOrDash(ability.availableAp) : '—');
    this.setField('mesos', player ? this.formatNumber(player.mesos) : '—');
    this.setField('magicAttack', this.numberOrDash(derived?.magicAttack));
    this.setField('defense', this.numberOrDash(derived?.defense));
    this.setField('moveSpeed', this.speedOrDash(derived?.moveSpeed));
    this.setField('magicGuard', derived ? (derived.magicGuard ? '开启' : '关闭') : '—');
    this.setField('meditation', this.remainingText(derived?.meditationRemainingMs));
    this.setField('iceTeleport', derived?.iceTeleport === undefined ? '—' : (derived.iceTeleport ? '开启' : '关闭'));
    for (const stat of ABILITY_STATS) {
      this.setField(stat, this.numberOrDash(ability?.[stat] ?? derived?.[stat]));
      this.setDerivedField(stat, derived?.[stat] === undefined ? '' : `总 ${this.numberOrDash(derived[stat])}`);
    }
    this.refreshAbilityButtons();
    if (!player) this.close();
  }

  receiveAbilityResult(result: AbilityResult) {
    if (this.destroyed) return;
    this.pendingAllocations.delete(result.requestId);
    this.refreshAbilityButtons();
  }

  toggle(): boolean {
    if (this.destroyed) return false;
    if (this.openState) {
      this.close();
      return true;
    }
    if (!this.player) return false;
    this.open();
    return true;
  }

  open() {
    if (this.destroyed || !this.player) return;
    this.openState = true;
    this.root.hidden = false;
    this.root.dataset.open = 'true';
    this.window.hidden = false;
    this.focusWindow();
  }

  close() {
    const wasOpen = this.openState;
    this.openState = false;
    this.root.hidden = true;
    this.root.dataset.open = 'false';
    this.window.hidden = true;
    if (wasOpen) document.querySelector<HTMLElement>('#game')?.focus({ preventScroll: true });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dragDispose();
    document.removeEventListener('keydown', this.handleKeyDown, true);
    this.root.remove();
  }

  private createMainCard() {
    const card = document.createElement('section');
    card.className = 'character-main-card';
    this.appendArt(card, this.manifest.characterUi?.['common/main/backgrnd'], 'character-main-background');
    const level = this.appendField(card, 'level', 'character-field character-level', '等级');
    const job = this.appendField(card, 'job', 'character-field character-job', '职业');
    const username = this.appendField(card, 'username', 'character-field character-name', '名称');
    this.place(level, 'common/main/vector:lvPos', { x: 244, y: 33 });
    this.place(job, 'common/main/vector:jobPos', { x: 76, y: 42 });
    this.place(username, 'common/main/vector:namePos', { x: 237, y: 173 });

    const vitals = document.createElement('div');
    vitals.className = 'character-main-vitals';
    this.appendField(vitals, 'hp', 'character-field character-main-vital character-hp', 'HP');
    this.appendField(vitals, 'mp', 'character-field character-main-vital character-mp', 'MP');
    this.appendField(vitals, 'exp', 'character-field character-main-vital character-exp', 'EXP');
    this.appendField(vitals, 'availableAp', 'character-field character-main-vital character-ap', '可用AP');
    const growthNote = document.createElement('small');
    growthNote.className = 'character-growth-note';
    growthNote.textContent = 'P：临时成长规则（曲线至60级，每级 +5 AP）';
    vitals.append(growthNote);
    card.append(vitals);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'character-window-close';
    close.setAttribute('aria-label', '关闭角色信息');
    close.title = '关闭';
    const normal = this.manifest.characterUi?.['common/main/button:close/normal/0'];
    const image = normal ? this.appendArt(close, normal, 'character-window-close-art', true) : undefined;
    if (!image) close.textContent = '×';
    close.addEventListener('click', () => this.close());
    if (image) this.bindButtonState(close, image);
    card.append(close);
    return card;
  }

  private createDetailCard() {
    const detail = document.createElement('section');
    detail.className = 'character-detail-card';
    // Chrome only: back canvases stay, the four source *Font label layers are
    // dropped because the HTML rows below replace their (traditional-Chinese)
    // labels — keeping both printed every stat twice, misaligned (P note).
    this.appendArt(detail, this.manifest.characterUi?.['local/detail/backgrnd'], 'character-detail-background');
    this.appendArt(detail, this.manifest.characterUi?.['local/detail/layer:stat'], 'character-detail-stat-layer');
    // attackBack bakes its own 戰鬥力 header strip into the top 33 px, which
    // overlaps the window title strip; clipped so only the gray stat panel shows.
    this.appendArt(detail, this.manifest.characterUi?.['common/detailStat/canvas:attackBack'], 'character-detail-attack-back');
    this.appendArt(detail, this.manifest.characterUi?.['common/detailStat/canvas:utilityBack'], 'character-detail-utility-back');
    this.appendArt(detail, this.manifest.characterUi?.['local/detailStat/canvas:mainStatBack'], 'character-detail-main-stat-back');

    const title = document.createElement('h2');
    title.className = 'character-detail-title';
    title.textContent = '角色属性';
    detail.append(title);

    // Rows sit on the source gray canvases: mainStatBack (y38..119) for the
    // ability rows, attackBack's panel (y123..300) for combat stats,
    // utilityBack (y314..406) for buff status — spec R6 alignment.
    const abilityStats = document.createElement('dl');
    abilityStats.className = 'character-live-stats character-ability-stats';
    this.appendStat(abilityStats, 'availableAp', '可用AP');
    this.appendStat(abilityStats, 'mesos', '金币');
    this.appendAbilityStat(abilityStats, 'strength', '力量');
    this.appendAbilityStat(abilityStats, 'dexterity', '敏捷');
    this.appendAbilityStat(abilityStats, 'intelligence', '智力');
    this.appendAbilityStat(abilityStats, 'luck', '运气');
    detail.append(abilityStats);

    const combatStats = document.createElement('dl');
    combatStats.className = 'character-live-stats character-combat-stats';
    this.appendStat(combatStats, 'magicAttack', '魔法攻击');
    this.appendStat(combatStats, 'defense', '防御');
    this.appendStat(combatStats, 'moveSpeed', '移动速度');
    this.appendStat(combatStats, 'magicGuard', '魔心防御');
    detail.append(combatStats);

    const statusStats = document.createElement('dl');
    statusStats.className = 'character-live-stats character-status-stats';
    this.appendStat(statusStats, 'meditation', '精神强化');
    this.appendStat(statusStats, 'iceTeleport', '寒冰迅移');
    detail.append(statusStats);
    return detail;
  }

  private appendStat(parent: HTMLElement, field: CharacterField, label: string) {
    const row = document.createElement('div');
    row.className = 'character-live-stat';
    const labelNode = document.createElement('dt');
    labelNode.textContent = label;
    const value = document.createElement('dd');
    value.textContent = '—';
    value.dataset.field = field;
    this.registerField(field, value);
    row.append(labelNode, value);
    parent.append(row);
  }

  private appendAbilityStat(parent: HTMLElement, stat: AbilityStat, label: string) {
    const row = document.createElement('div');
    row.className = 'character-live-stat character-ability-stat';
    const labelNode = document.createElement('dt');
    labelNode.textContent = label;
    const value = document.createElement('dd');
    const base = document.createElement('span');
    base.className = 'character-ability-base';
    base.dataset.field = stat;
    base.textContent = '—';
    this.registerField(stat, base);
    const total = document.createElement('span');
    total.className = 'character-ability-total';
    total.dataset.derivedField = stat;
    total.textContent = '';
    this.registerDerivedField(stat, total);
    value.append(base, total);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'character-ap-button';
    button.textContent = '+1';
    button.title = `增加${label}`;
    button.setAttribute('aria-label', `增加${label}`);
    button.addEventListener('click', () => this.allocate(stat));
    this.abilityButtons.set(stat, button);
    const prefix = `local/detailStat/button:lvUp${ABILITY_BUTTON_NAMES[stat]}`;
    const normal = this.manifest.characterUi?.[`${prefix}/normal/0`];
    if (normal) {
      button.textContent = '';
      const image = this.appendArt(button, normal, 'character-ap-button-art', true);
      if (image) {
        this.abilityButtonImages.set(stat, image);
        this.bindAbilityButtonState(button, stat);
      }
    } else {
      button.classList.add('character-ap-button-fallback');
    }
    value.append(button);
    row.append(labelNode, value);
    parent.append(row);
  }

  private appendField(parent: HTMLElement, field: CharacterField, className: string, label: string) {
    const node = document.createElement('span');
    node.className = className;
    node.dataset.field = field;
    node.setAttribute('aria-label', label);
    const labelNode = document.createElement('span');
    labelNode.className = 'character-field-label';
    labelNode.textContent = `${label} `;
    const value = document.createElement('span');
    value.className = 'character-field-value';
    value.textContent = '—';
    node.append(labelNode, value);
    this.registerField(field, value);
    parent.append(node);
    return node;
  }

  private registerField(field: CharacterField, value: HTMLSpanElement) {
    const values = this.fields.get(field) ?? [];
    values.push(value);
    this.fields.set(field, values);
  }

  private registerDerivedField(stat: AbilityStat, value: HTMLSpanElement) {
    const values = this.derivedFields.get(stat) ?? [];
    values.push(value);
    this.derivedFields.set(stat, values);
  }

  private appendArt(parent: HTMLElement, art: SkillArt | undefined, className: string, local = false) {
    if (!art) return undefined;
    const image = document.createElement('img');
    image.className = className;
    image.src = art.url;
    image.width = art.width;
    image.height = art.height;
    image.alt = '';
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    image.style.left = `${local ? 0 : art.x}px`;
    image.style.top = `${local ? 0 : art.y}px`;
    parent.append(image);
    return image;
  }

  private bindButtonState(button: HTMLButtonElement, image: HTMLImageElement) {
    const base = 'common/main/button:close/';
    const state = (name: 'normal' | 'mouseOver' | 'pressed') => {
      const art = this.manifest.characterUi?.[`${base}${name}/0`];
      if (art) image.src = art.url;
    };
    button.addEventListener('pointerover', () => state('mouseOver'));
    button.addEventListener('pointerout', () => state('normal'));
    button.addEventListener('pointerdown', () => state('pressed'));
    button.addEventListener('pointerup', () => state('normal'));
  }

  private place(node: HTMLElement, key: string, fallback: { x: number; y: number }) {
    const position = this.manifest.characterLayout?.[key] ?? fallback;
    node.style.left = `${position.x}px`;
    node.style.top = `${position.y}px`;
  }

  private setField(field: CharacterField, value: string) {
    for (const node of this.fields.get(field) ?? []) node.textContent = value;
  }

  private setDerivedField(stat: AbilityStat, value: string) {
    for (const node of this.derivedFields.get(stat) ?? []) node.textContent = value;
  }

  private refreshAbilityButtons() {
    const ability = this.player?.abilityStats;
    const enabled = Boolean(this.player && this.player.hp > 0 && ability && ability.availableAp > 0 && this.send);
    for (const stat of ABILITY_STATS) {
      const button = this.abilityButtons.get(stat);
      if (!button) continue;
      const pending = [...this.pendingAllocations.values()].includes(stat);
      button.disabled = !enabled || pending;
      button.setAttribute('aria-busy', pending ? 'true' : 'false');
      this.setAbilityButtonImage(stat, button.disabled ? 'disabled' : 'normal');
    }
  }

  private bindAbilityButtonState(button: HTMLButtonElement, stat: AbilityStat) {
    const state = (name: 'normal' | 'mouseOver' | 'pressed' | 'disabled') => this.setAbilityButtonImage(stat, name);
    button.addEventListener('pointerover', () => state('mouseOver'));
    button.addEventListener('pointerout', () => state(button.disabled ? 'disabled' : 'normal'));
    button.addEventListener('pointerdown', () => state('pressed'));
    button.addEventListener('pointerup', () => state(button.disabled ? 'disabled' : 'normal'));
  }

  private setAbilityButtonImage(stat: AbilityStat, state: 'normal' | 'mouseOver' | 'pressed' | 'disabled') {
    const image = this.abilityButtonImages.get(stat);
    if (!image) return;
    const prefix = `local/detailStat/button:lvUp${ABILITY_BUTTON_NAMES[stat]}`;
    const art = this.manifest.characterUi?.[`${prefix}/${state}/0`] ?? this.manifest.characterUi?.[`${prefix}/normal/0`];
    if (art) image.src = art.url;
  }

  private allocate(stat: AbilityStat) {
    const ability = this.player?.abilityStats;
    if (!this.player || this.player.hp <= 0 || !ability || ability.availableAp <= 0 || !this.send || [...this.pendingAllocations.values()].includes(stat)) return;
    const requestId = `ap-${Date.now()}-${++this.requestSequence}`;
    this.pendingAllocations.set(requestId, stat);
    if (this.send({ type: 'allocateAp', requestId, stat })) {
      this.refreshAbilityButtons();
      return;
    }
    this.pendingAllocations.delete(requestId);
    this.refreshAbilityButtons();
    this.status('连接已断开，无法分配属性点。');
  }

  private focusWindow() {
    const focus = () => this.window.focus({ preventScroll: true });
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
    else focus();
  }

  private jobName(job: number | undefined) {
    return characterJobName(job);
  }

  private pair(current: number, maximum: number) {
    return `${this.formatNumber(current)} / ${this.formatNumber(maximum)}`;
  }

  private formatNumber(value: number) {
    return Number.isFinite(value) ? String(value) : '—';
  }

  private expProgress(value: number, target: number) {
    if (!Number.isFinite(value)) return '—';
    if (!Number.isFinite(target) || target <= 0) return `${this.formatNumber(value)} / MAX · 100%`;
    const percent = Math.max(0, Math.min(100, (value / target) * 100));
    return `${this.formatNumber(value)} / ${this.formatNumber(target)} · ${percent.toFixed(2)}%`;
  }

  private numberOrDash(value: number | undefined) {
    return value !== undefined && Number.isFinite(value) ? String(value) : '—';
  }

  private speedOrDash(value: number | undefined) {
    return value !== undefined && Number.isFinite(value) ? `${value} px/s` : '—';
  }

  private remainingText(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value)) return '—';
    return value > 0 ? `${Math.ceil(value / 1000)} 秒` : '关闭';
  }
}

export { CharacterInfoView as CharacterView };
