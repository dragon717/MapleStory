import type { AbilityStat, ClientMessage, PlayerState, ServerMessage } from '../../../../shared/protocol';
import type { Manifest, SkillArt } from '../../assets/manifest';
import { installWindowDrag, bringToFront } from '../ui/window-shell.ts';
import './style.css';
import { resolveAssetUrl } from '../../assets/resource-url';

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
  | 'movementNote'
  | 'strength'
  | 'dexterity'
  | 'intelligence'
  | 'luck';

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
  private readonly holdRing = document.createElement('div');
  private hold?: { stat: AbilityStat; pointerId: number; started: number; last: number; active: boolean };
  private holdFrame = 0;
  private suppressClick = false;
  private readonly cancelHold = () => this.stopHold(true);
  private readonly moveHold = (event: PointerEvent) => {
    if (!this.hold || event.pointerId !== this.hold.pointerId) return;
    this.positionHoldRing(event);
    const button = this.abilityButtons.get(this.hold.stat)!;
    const rect = button.getBoundingClientRect();
    if (!event.buttons || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.stopHold(true);
  };
  private readonly releaseHold = (event: PointerEvent) => {
    if (this.hold?.pointerId === event.pointerId) this.stopHold(this.hold.active);
  };
  private readonly visibilityHold = () => { if (document.hidden) this.stopHold(true); };
  private readonly tickHold = (now: number) => {
    const hold = this.hold;
    if (!hold) return;
    if (!this.openState || !this.player || this.player.hp <= 0 || !this.player.abilityStats?.availableAp) { this.stopHold(true); return; }
    const elapsed = now - hold.started;
    this.holdRing.style.setProperty('--hold-progress', String(Math.min(1, elapsed / 3000)));
    const label = elapsed >= 3000 ? '+' : String(Math.ceil((3000 - elapsed) / 1000));
    if (this.holdRing.textContent !== label) this.holdRing.textContent = label;
    if (elapsed >= 3000) {
      hold.active = true;
      this.suppressClick = true;
      if (!this.pendingAllocations.size && now - hold.last >= 120) {
        hold.last = now;
        this.allocate(hold.stat);
      }
    }
    if (this.hold) this.holdFrame = requestAnimationFrame(this.tickHold);
  };

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
    this.holdRing.className = 'character-hold-ring';
    this.holdRing.hidden = true;
    this.holdRing.setAttribute('aria-label', '长按三秒后连续加点');
    document.body.append(this.holdRing);
    document.addEventListener('pointermove', this.moveHold, true);
    document.addEventListener('pointerup', this.releaseHold, true);
    document.addEventListener('pointercancel', this.cancelHold, true);
    document.addEventListener('visibilitychange', this.visibilityHold);
    window.addEventListener('blur', this.cancelHold);
    this.update(undefined);
  }

  update(player?: PlayerState) {
    if (this.destroyed) return;
    if (player?.id !== this.player?.id || !player) this.pendingAllocations.clear();
    if (player?.id !== this.player?.id || !player || player.hp <= 0 || !player.abilityStats?.availableAp) this.stopHold(true);
    this.player = player;
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
    this.setField('moveSpeed', this.speedOrDash(derived?.currentMoveSpeed ?? (player?.mount || player?.abnormalStatus?.slowMs ? undefined : derived?.moveSpeed)));
    this.setField('movementNote', `属性速度 ${this.speedOrDash(derived?.moveSpeed)} · 当前速度由服务器计算，临时效果见快捷栏上方`);
    for (const stat of ABILITY_STATS) {
      this.setField(stat, this.numberOrDash(ability?.[stat] ?? derived?.[stat]));
      this.setDerivedField(stat, derived?.[stat] === undefined ? '' : `总 ${this.numberOrDash(derived[stat])}`);
    }
    this.refreshAbilityButtons();
    if (!player) this.close();
  }

  receiveAbilityResult(result: AbilityResult) {
    if (this.destroyed) return;
    if (!this.pendingAllocations.delete(result.requestId)) return;
    // The acknowledgement carries the new AP balance before the following world snapshot.
    if (this.player) this.update({ ...this.player, abilityStats: result.abilityStats });
    if (!result.success) this.stopHold(true);
    this.refreshAbilityButtons();
  }

  isOpen() { return this.openState; }

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
    this.stopHold(true);
    const wasOpen = this.openState;
    this.openState = false;
    this.root.hidden = true;
    this.root.dataset.open = 'false';
    this.window.hidden = true;
    if (wasOpen) document.querySelector<HTMLElement>('#game')?.focus({ preventScroll: true });
  }

  destroy() {
    if (this.destroyed) return;
    this.stopHold(true);
    this.destroyed = true;
    document.removeEventListener('pointermove', this.moveHold, true);
    document.removeEventListener('pointerup', this.releaseHold, true);
    document.removeEventListener('pointercancel', this.cancelHold, true);
    document.removeEventListener('visibilitychange', this.visibilityHold);
    window.removeEventListener('blur', this.cancelHold);
    this.holdRing.remove();
    this.dragDispose();
    document.removeEventListener('keydown', this.handleKeyDown, true);
    this.root.remove();
  }

  private createMainCard() {
    const card = document.createElement('section');
    card.className = 'character-main-card';
    this.appendArt(card, this.manifest.characterUi?.['common/main/backgrnd'], 'character-main-background');
    this.appendField(card, 'level', 'character-field character-level', '等级');
    this.appendField(card, 'job', 'character-field character-job', '职业');
    this.appendField(card, 'username', 'character-field character-name', '名称');

    const vitals = document.createElement('div');
    vitals.className = 'character-main-vitals';
    this.appendField(vitals, 'hp', 'character-field character-main-vital character-hp', 'HP');
    this.appendField(vitals, 'mp', 'character-field character-main-vital character-mp', 'MP');
    this.appendField(vitals, 'exp', 'character-field character-main-vital character-exp', 'EXP');
    this.appendField(vitals, 'availableAp', 'character-field character-main-vital character-ap', '可用AP');
    const growthNote = document.createElement('small');
    growthNote.className = 'character-growth-note';
    growthNote.textContent = '升级获得 5 AP · 当前成长至 60 级';
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
    // Reuse the source frame; a single flow of DOM labels replaces baked stat plates.
    this.appendArt(detail, this.manifest.characterUi?.['local/detail/backgrnd'], 'character-detail-background');

    const title = document.createElement('h2');
    title.className = 'character-detail-title';
    title.textContent = '角色属性';
    detail.append(title);

    const abilityStats = document.createElement('dl');
    abilityStats.className = 'character-live-stats character-ability-stats';
    this.appendStat(abilityStats, 'availableAp', '可用AP');
    this.appendStat(abilityStats, 'mesos', '金币');
    this.appendAbilityStat(abilityStats, 'strength', '力量');
    this.appendAbilityStat(abilityStats, 'dexterity', '敏捷');
    this.appendAbilityStat(abilityStats, 'intelligence', '智力');
    this.appendAbilityStat(abilityStats, 'luck', '运气');
    const hint = document.createElement('p');
    hint.className = 'character-allocation-hint';
    hint.textContent = '点击 + 加 1 点；按住 3 秒，圆环满后连续加点，松开停止。';
    detail.append(this.groupTitle('能力与加点'), abilityStats, hint);

    const combatStats = document.createElement('dl');
    combatStats.className = 'character-live-stats character-combat-stats';
    this.appendStat(combatStats, 'magicAttack', '魔法攻击');
    this.appendStat(combatStats, 'defense', '防御');
    this.appendStat(combatStats, 'moveSpeed', '当前移动速度');
    const movementNote = this.appendField(combatStats, 'movementNote', 'character-movement-note', '速度说明');
    movementNote.querySelector('.character-field-label')?.remove();
    detail.append(this.groupTitle('战斗与移动'), combatStats);

    return detail;
  }

  private groupTitle(text: string) {
    const heading = document.createElement('h3');
    heading.className = 'character-group-title';
    heading.textContent = text;
    return heading;
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
    button.title = `增加${label}；长按 3 秒连续加点`;
    button.dataset.stat = stat;
    button.setAttribute('aria-label', `增加${label}`);
    button.addEventListener('pointerdown', event => this.startHold(stat, event));
    button.addEventListener('click', event => {
      if (event.detail !== 0 && this.suppressClick) { this.suppressClick = false; return; }
      this.allocate(stat);
    });
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
    image.src = resolveAssetUrl(art.url);
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
      if (art) image.src = resolveAssetUrl(art.url);
    };
    button.addEventListener('pointerover', () => state('mouseOver'));
    button.addEventListener('pointerout', () => state('normal'));
    button.addEventListener('pointerdown', () => state('pressed'));
    button.addEventListener('pointerup', () => state('normal'));
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
      const pending = this.pendingAllocations.size > 0;
      button.disabled = !enabled || (pending && this.hold?.stat !== stat);
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
    if (art) image.src = resolveAssetUrl(art.url);
  }

  private positionHoldRing(event: PointerEvent) {
    this.holdRing.style.left = `${event.clientX}px`;
    this.holdRing.style.top = `${event.clientY}px`;
  }

  private startHold(stat: AbilityStat, event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || !this.openState || this.abilityButtons.get(stat)?.disabled) return;
    this.stopHold(true);
    this.suppressClick = false;
    this.hold = { stat, pointerId: event.pointerId, started: performance.now(), last: -Infinity, active: false };
    this.holdRing.style.setProperty('--hold-progress', '0');
    this.holdRing.textContent = '3';
    this.holdRing.hidden = false;
    this.positionHoldRing(event);
    this.holdFrame = requestAnimationFrame(this.tickHold);
  }

  private stopHold(suppressClick: boolean) {
    if (this.hold) this.suppressClick = suppressClick;
    this.hold = undefined;
    cancelAnimationFrame(this.holdFrame);
    this.holdFrame = 0;
    this.holdRing.hidden = true;
    this.refreshAbilityButtons();
  }

  /** Rejected commands are terminal for a held gesture, including persistence failures. */
  receiveReject(requestId?: string) {
    if (requestId && this.pendingAllocations.delete(requestId)) { this.stopHold(true); this.refreshAbilityButtons(); }
  }

  private allocate(stat: AbilityStat) {
    const ability = this.player?.abilityStats;
    if (!this.player || this.player.hp <= 0 || !ability || ability.availableAp <= 0 || !this.send || this.pendingAllocations.size) return;
    const requestId = `ap-${Date.now()}-${++this.requestSequence}`;
    this.pendingAllocations.set(requestId, stat);
    if (this.send({ type: 'allocateAp', requestId, stat })) {
      this.refreshAbilityButtons();
      return;
    }
    this.pendingAllocations.delete(requestId);
    this.refreshAbilityButtons();
    this.stopHold(true);
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
    return value !== undefined && Number.isFinite(value) ? `${Number(value.toFixed(1))} px/s` : '—';
  }
}

export { CharacterInfoView as CharacterView };
