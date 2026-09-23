import type { PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest, SkillCatalogEntry } from '../../assets/manifest';
import { shortcutSkill, bookAllowsJob, branchFourthJob } from '../player/input.ts';
import type { KeyBinding } from '../keybindings/model';
import { INVENTORY_DROP_ZONE_ATTRIBUTE, hasInventoryDrag, readInventoryDrag } from '../inventory/drag-controller';
import { BuffBar } from './buff-bar.ts';
import { resolveAssetUrl } from '../../assets/resource-url';

export type HudPlayer = Pick<PlayerState, 'username' | 'hp' | 'maxHp' | 'mp' | 'maxMp' | 'level' | 'exp' | 'expToNext' | 'mesos' | 'inventory' | 'job' | 'skills' | 'derivedStats' | 'action' | 'climbing'>;
export function gaugeRatio(value: number, maximum: number): number {
  return Number.isFinite(value) && Number.isFinite(maximum) && maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0;
}

export function expRatio(value: number, expToNext: number): number {
  if (!Number.isFinite(expToNext)) return 0;
  return expToNext === 0 ? 1 : gaugeRatio(value, expToNext);
}
const BUTTONS = [
  ['CashShop', '商店'], ['Event', '活动'], ['Character', '角色与背包'],
  ['Community', '社群'], ['Setting', '设置'], ['Menu', '菜单'],
] as const;

const SHORTCUT_BINDINGS = [
  ...(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const).map((label, index) => ({
    code: `Digit${label}`,
    label,
    shift: false,
    sourceSlot: index,
  })),
  ...(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const).map((label, index) => ({
    code: `Digit${label}`,
    label: `⇧${label}`,
    shift: true,
    sourceSlot: 16 + index,
  })),
] as const;

const SOURCE_SLOT_COLUMNS = 16;
const SOURCE_SLOT_SIZE = 32;
const SOURCE_SLOT_STEP = 35;

export interface HudViewOptions {
  openCashShop?: () => void;
  openActivities?: () => void;
  /** Opens the source-backed TMS273 pet-management window. */
  openPets?: () => void;
  castSkill?: (skillId: number) => string | void;
  releaseSkill?: (requestId: string) => void;
  keySlots?: () => readonly { code: string; shift: boolean }[];
  resolveBinding?: (code: string, shift: boolean) => KeyBinding | null;
  bindingLabel?: (binding: KeyBinding) => string;
  activateBinding?: (binding: KeyBinding) => void;
  editSlot?: (slot: number) => void;
  bindSkill?: (slot: number, skillId: number) => void;
  /** 背包拖到快捷栏格子上的道具绑定（消耗品／椅子）。 */
  bindItem?: (slot: number, itemId: number) => void;
}

type ShortcutBinding = { code: string; label: string; shift: boolean; sourceSlot: number };
type ShortcutCell = {
  button: HTMLButtonElement;
  icon: HTMLImageElement;
  level: HTMLSpanElement;
  cooldown: HTMLSpanElement;
  key: HTMLSpanElement;
  binding: ShortcutBinding;
  action?: KeyBinding | null;
};

/** The 273 StatusBar3 panel uses source origins inside a responsive HUD row. */
export class HudView {
  private readonly manifest: Manifest;
  private root = document.createElement('div');
  private name = document.createElement('span');
  private level = document.createElement('span');
  private exp = document.createElement('div');
  private expText = document.createElement('span');
  private gauges = new Map<string, { fill: HTMLDivElement; text: HTMLSpanElement; width: number }>();
  private assets: Record<string, AssetFrame>;
  private skillCatalog: Record<string, SkillCatalogEntry>;
  private quickSlot?: HTMLDivElement;
  private quickGrid?: HTMLDivElement;
  private quickToggle?: HTMLButtonElement;
  private quickToggleImage?: HTMLImageElement;
  private quickToggleState: 'normal' | 'mouseOver' | 'pressed' | 'disabled' = 'normal';
  private buffBar?: BuffBar;
  private shortcutCells: ShortcutCell[] = [];
  private channelRequestId?: string;
  private quickSlotsExpanded = true;

  constructor(private host: HTMLElement, manifest: Manifest, private status: (message: string) => void, private onInventory?: () => void, private onMenu?: (trigger: HTMLElement) => void, private onShortcut?: (trigger: HTMLElement) => void, private options: HudViewOptions = {}) {
    this.manifest = manifest;
    // The buff plate and the quick-slot fold keys live in `buffUi` (they come
    // from the BuffSetting / quickSlot subtrees); merge them so every HUD
    // control resolves its frames through one map.
    this.assets = { ...(manifest.hud ?? {}), ...(manifest.buffUi?.ui ?? {}) };
    this.skillCatalog = manifest.skillCatalog ?? {};
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
      const state = (value: string) => { if (this.assets[`${prefix}/${value}/0`]) image.src = resolveAssetUrl(this.assets[`${prefix}/${value}/0`].url); };
      button.addEventListener('pointerenter', () => state('mouseOver'));
      button.addEventListener('pointerleave', () => state('normal'));
      button.addEventListener('pointerdown', () => state('pressed'));
      button.addEventListener('pointerup', () => state('mouseOver'));
      button.addEventListener('pointercancel', () => state('normal'));
      button.addEventListener('click', () => {
        if (key === 'Character') this.onInventory?.();
        else if (key === 'Menu' || key === 'Setting') this.onMenu?.(button);
        else if (key === 'Community') document.querySelector<HTMLInputElement>('.chat-input')?.focus();
        else if (key === 'Event') this.options.openActivities?.();
        else if (key === 'CashShop') this.options.openCashShop?.();
        else this.status(`${label}业务尚未接入。`);
      });
      actions.append(button);
      if (key === 'Character') {
        const petButton = this.createPetButton();
        if (petButton) actions.append(petButton);
      }
    }
    row.append(actions);
    this.createQuickSlots(row);
    // The buff row closes the HUD line: source plate + one icon per active
    // server-owned buff.  It renders nothing until the server sends durations.
    this.buffBar = new BuffBar(row, manifest);
    const expTrack = document.createElement('div');
    expTrack.className = 'tms-exp'; expTrack.setAttribute('role', 'progressbar'); expTrack.setAttribute('aria-label', '经验');
    this.exp.className = 'tms-exp-fill';
    const gauge = this.assets['mainBar/EXPBar/800/layer:gauge'];
    if (gauge) this.exp.style.backgroundImage = `url("${gauge.url}")`;
    this.expText.className = 'tms-exp-text';
    expTrack.append(this.exp, this.expText);
    this.root.append(row, expTrack); this.host.replaceChildren(this.root);
    window.addEventListener('pointerup', this.releaseChannel);
    window.addEventListener('pointercancel', this.releaseChannel);
    window.addEventListener('blur', this.releaseChannel);
    window.addEventListener('keyup', this.releaseChannelKey);
    document.addEventListener('visibilitychange', this.releaseHiddenChannel);
    document.addEventListener('focusin', this.releaseOutsideChannel);
  }

  update(player: HudPlayer | undefined) {
    this.host.hidden = !player; this.root.hidden = !player;
    if (!player || player.hp <= 0 || player.action === 'dead') {
      this.releaseChannel();
    }
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
    this.updateShortcuts(player);
    // Buffs are server-owned: the snapshot only carries the remaining ms, so the
    // row is a pure render of `skillBuffs` (empty ⇒ the whole bar hides).
    this.buffBar?.update(player.derivedStats?.skillBuffs);
  }

  clear() {
    this.releaseChannel();
    this.buffBar?.clear();
    this.host.hidden = true;
    this.root.hidden = true;
  }

  /** Release the only channelled shortcut action owned by the HUD. */
  releaseChannel = () => {
    const requestId = this.channelRequestId;
    this.channelRequestId = undefined;
    if (requestId) this.options.releaseSkill?.(requestId);
    this.shortcutCells.forEach(cell => cell.button.classList.remove('is-channeling'));
  };

  destroy() {
    this.releaseChannel();
    window.removeEventListener('pointerup', this.releaseChannel);
    window.removeEventListener('pointercancel', this.releaseChannel);
    window.removeEventListener('blur', this.releaseChannel);
    window.removeEventListener('keyup', this.releaseChannelKey);
    document.removeEventListener('visibilitychange', this.releaseHiddenChannel);
    document.removeEventListener('focusin', this.releaseOutsideChannel);
    this.buffBar?.destroy();
    this.buffBar = undefined;
    this.host.replaceChildren(); this.host.hidden = true;
  }

  private image(key: string, parent: HTMLElement, positioned = false): HTMLImageElement {
    const frame = this.assets[key];
    if (!frame) throw new Error(`273 HUD 素材缺失：${key}`);
    const image = document.createElement('img'); image.src = resolveAssetUrl(frame.url); image.alt = ''; image.draggable = false;
    image.width = frame.width; image.height = frame.height;
    if (positioned) Object.assign(image.style, { position: 'absolute', left: `${-frame.origin.x}px`, top: `${-frame.origin.y}px` });
    parent.append(image); return image;
  }

  private createPetButton() {
    const states = this.petButtonStates();
    const normal = states?.normal;
    if (!normal) return undefined;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tms-hud-pet-button';
    button.title = '宠物';
    button.setAttribute('aria-label', '宠物');
    const image = document.createElement('img');
    image.src = resolveAssetUrl(normal.url);
    image.width = normal.width;
    image.height = normal.height;
    image.alt = '';
    image.draggable = false;
    button.append(image);
    const state = (name: 'normal' | 'mouseOver' | 'pressed' | 'disabled') => {
      const frame = states[name] ?? normal;
      image.src = resolveAssetUrl(frame.url);
      image.width = frame.width;
      image.height = frame.height;
    };
    button.addEventListener('pointerenter', () => state('mouseOver'));
    button.addEventListener('pointerleave', () => state('normal'));
    button.addEventListener('pointerdown', () => state('pressed'));
    button.addEventListener('pointerup', () => state('mouseOver'));
    button.addEventListener('pointercancel', () => state('normal'));
    button.addEventListener('click', () => this.options.openPets?.());
    return button;
  }

  private petButtonStates() {
    return this.manifest.petUi?.buttons.character;
  }

  private releaseHiddenChannel = () => { if (document.hidden) this.releaseChannel(); };
  private releaseChannelKey = (event: KeyboardEvent) => {
    if (event.code === 'Space' || event.code === 'Enter') this.releaseChannel();
  };
  private releaseOutsideChannel = () => this.releaseChannel();

  private createQuickSlots(parent: HTMLElement) {
    const background = this.assets['mainBar/quickSlot/backgrnd'];
    if (!background) return;
    const panel = document.createElement('div');
    panel.className = 'tms-quick-slot';
    panel.setAttribute('aria-label', '快捷技能栏');
    panel.style.setProperty('--quick-slot-background', `url("${background.url}")`);
    this.quickSlot = panel;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tms-quick-slot-toggle';
    toggle.setAttribute('aria-controls', 'tms-quick-slot-grid');
    const toggleImage = document.createElement('img');
    toggleImage.className = 'tms-quick-slot-toggle-image';
    toggleImage.alt = '';
    toggleImage.draggable = false;
    toggle.append(toggleImage);
    toggle.addEventListener('click', () => this.toggleQuickSlots());
    toggle.addEventListener('pointerenter', () => this.applyQuickToggleState('mouseOver'));
    toggle.addEventListener('pointerleave', () => this.applyQuickToggleState('normal'));
    toggle.addEventListener('pointerdown', event => { event.preventDefault(); this.applyQuickToggleState('pressed'); });
    toggle.addEventListener('pointerup', () => this.applyQuickToggleState('normal'));
    toggle.addEventListener('pointercancel', () => this.applyQuickToggleState('normal'));
    this.quickToggle = toggle;
    this.quickToggleImage = toggleImage;
    panel.append(toggle);

    const grid = document.createElement('div');
    grid.id = 'tms-quick-slot-grid';
    grid.className = 'tms-quick-slot-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', '技能快捷键');
    this.quickGrid = grid;
    for (let sourceSlot = 0; sourceSlot < 32; sourceSlot += 1) {
      const binding = this.options.keySlots ? { code: '', label: '', shift: false, sourceSlot } : SHORTCUT_BINDINGS.find(item => item.sourceSlot === sourceSlot);
      if (binding) {
        const cell = this.createShortcutCell(binding);
        this.shortcutCells.push(cell);
        grid.append(cell.button);
      } else {
        const empty = document.createElement('span');
        empty.className = 'tms-shortcut-cell tms-shortcut-empty';
        empty.setAttribute('aria-hidden', 'true');
        this.setSourceSlotBackground(empty, sourceSlot);
        grid.append(empty);
      }
    }
    panel.append(grid);
    parent.append(panel);
    this.updateQuickSlotToggle();
  }

  private createShortcutCell(binding: ShortcutBinding): ShortcutCell {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tms-shortcut-cell';
    button.dataset.shortcutCode = binding.code;
    button.dataset.shortcutShift = String(binding.shift);
    this.setSourceSlotBackground(button, binding.sourceSlot);

    const icon = document.createElement('img');
    icon.className = 'tms-shortcut-icon';
    icon.alt = '';
    icon.draggable = false;
    button.append(icon);

    const key = document.createElement('span');
    key.className = 'tms-shortcut-key';
    key.textContent = binding.label;
    button.append(key);

    const level = document.createElement('span');
    level.className = 'tms-shortcut-level';
    button.append(level);

    const cooldown = document.createElement('span');
    cooldown.className = 'tms-shortcut-cooldown';
    cooldown.hidden = true;
    button.append(cooldown);

    const cell: ShortcutCell = { button, icon, level, cooldown, key, binding };
    if (this.options.editSlot) {
      button.addEventListener('contextmenu', event => { event.preventDefault(); this.options.editSlot?.(binding.sourceSlot); });
      // 这一格自报为背包拖拽的落点：document 级「拖出窗口 = 丢弃」因此不接管它。
      button.setAttribute(INVENTORY_DROP_ZONE_ATTRIBUTE, '');
      button.addEventListener('dragover', event => {
        if (event.dataTransfer?.types.includes('application/x-maplestory-skill') || hasInventoryDrag(event.dataTransfer)) event.preventDefault();
      });
      button.addEventListener('drop', event => {
        const dragged = readInventoryDrag(event.dataTransfer);
        if (dragged) {
          event.preventDefault();
          const itemId = Number(dragged.itemId);
          if (Number.isSafeInteger(itemId) && itemId > 0) this.options.bindItem?.(binding.sourceSlot, itemId);
          return;
        }
        const skillId = Number(event.dataTransfer?.getData('application/x-maplestory-skill'));
        if (!Number.isSafeInteger(skillId) || skillId <= 0) return;
        event.preventDefault(); this.options.bindSkill?.(binding.sourceSlot, skillId);
      });
      button.addEventListener('dragstart', event => {
        if (!cell.button.dataset.skillId) { event.preventDefault(); return; }
        event.dataTransfer?.setData('application/x-maplestory-skill', cell.button.dataset.skillId);
      });
    }
    button.addEventListener('pointerdown', event => this.shortcutPointerDown(event, cell));
    button.addEventListener('click', event => this.shortcutClick(event, cell));
    button.addEventListener('keydown', event => this.shortcutKeyDown(event, cell));
    button.addEventListener('keyup', event => this.shortcutKeyUp(event, cell));
    return cell;
  }

  private setSourceSlotBackground(element: HTMLElement, sourceSlot: number) {
    const column = sourceSlot % SOURCE_SLOT_COLUMNS;
    const row = Math.floor(sourceSlot / SOURCE_SLOT_COLUMNS);
    element.style.setProperty('--slot-x', `${column * SOURCE_SLOT_STEP}px`);
    element.style.setProperty('--slot-y', `${row * SOURCE_SLOT_STEP}px`);
  }

  private toggleQuickSlots() {
    this.quickSlotsExpanded = !this.quickSlotsExpanded;
    this.updateQuickSlotToggle();
  }

  private updateQuickSlotToggle() {
    this.quickSlot?.classList.toggle('is-collapsed', !this.quickSlotsExpanded);
    if (!this.quickToggle) return;
    this.quickToggle.title = this.quickSlotsExpanded ? '收起快捷栏' : '展开快捷栏';
    this.quickToggle.setAttribute('aria-label', this.quickToggle.title);
    this.quickToggle.setAttribute('aria-expanded', String(this.quickSlotsExpanded));
    this.applyQuickToggleState('normal');
  }

  /**
   * Show the authored fold / extend keys.
   *
   * `mainBar/quickSlot/button:Extend` (collapsed → offers to expand) and
   * `button:Fold` (open → offers to collapse) each ship four states.  If the
   * export is missing the control falls back to the old text glyph so the
   * quick bar never becomes a dead surface.
   */
  private applyQuickToggleState(state: 'normal' | 'mouseOver' | 'pressed' | 'disabled') {
    const toggle = this.quickToggle;
    const image = this.quickToggleImage;
    if (!toggle) return;
    const key = this.quickSlotsExpanded ? 'Fold' : 'Extend';
    const frame = this.assets[`mainBar/quickSlot/button:${key}/${state}/0`]
      ?? this.assets[`mainBar/quickSlot/button:${key}/normal/0`];
    this.quickToggleState = state;
    toggle.dataset.state = state;
    if (!frame) {
      toggle.textContent = this.quickSlotsExpanded ? '−' : '+';
      return;
    }
    if (toggle.textContent) toggle.textContent = '';
    if (image) {
      image.src = resolveAssetUrl(frame.url);
      image.width = frame.width;
      image.height = frame.height;
    }
  }

  private updateShortcuts(player: HudPlayer) {
    for (const cell of this.shortcutCells) {
      const slot = this.options.keySlots?.()[cell.binding.sourceSlot];
      if (slot) {
        cell.binding.code = slot.code; cell.binding.shift = slot.shift;
        cell.binding.label = `${slot.shift ? '⇧' : ''}${slot.code.replace(/^Key|^Digit/, '').replace('Numpad', 'Num').replace('Control', 'Ctrl').replace('Left', 'L').replace('Right', 'R')}`;
        cell.key.textContent = cell.binding.label;
        cell.button.dataset.shortcutCode = slot.code;
        cell.button.dataset.shortcutShift = String(slot.shift);
      }
      cell.action = this.options.resolveBinding?.(cell.binding.code, cell.binding.shift);
      const id = this.options.resolveBinding ? (cell.action?.type === 'skill' ? cell.action.skillId : undefined) : this.shortcutId(player.job, cell.binding);
      if (this.options.resolveBinding && cell.action?.type !== 'skill') {
        const action = cell.action;
        const label = action ? this.options.bindingLabel?.(action) ?? '动作' : '尚未配置';
        cell.button.dataset.skillId = ''; cell.button.dataset.skillName = '';
        cell.button.dataset.available = String(Boolean(action)); cell.button.dataset.blockReason = action ? '' : '尚未配置';
        cell.button.disabled = false; cell.button.draggable = false;
        cell.button.setAttribute('aria-disabled', String(!action));
        cell.button.title = `${cell.binding.label} · ${label} · 右键设置`;
        cell.button.setAttribute('aria-label', cell.button.title);
        const itemArt = action?.type === 'item' ? this.manifest.items?.[String(action.itemId).padStart(8, '0')] : undefined;
        cell.icon.hidden = !itemArt; if (itemArt) cell.icon.src = resolveAssetUrl(itemArt.url);
        cell.level.hidden = false; cell.level.textContent = action?.type === 'item'
          ? String(player.inventory.filter(item => Number(item.itemId) === action.itemId).reduce((sum, item) => sum + item.quantity, 0)) : action ? label.slice(0, 4) : '';
        cell.cooldown.hidden = true;
        cell.button.classList.toggle('is-disabled', !action);
        cell.button.classList.remove('is-cooldown', 'is-active');
        continue;
      }
      const entry = id === undefined ? undefined : this.skillCatalog[String(id)];
      const level = id === undefined ? 0 : this.skillLevel(player, id);
      const cooldownMs = id === undefined ? 0 : this.skillCooldown(player, id);
      const reason = this.shortcutBlockReason(player, id, entry, level, cooldownMs);
      const icon = entry?.icons[reason ? 'disabled' : 'normal'] ?? entry?.icons.disabled ?? entry?.icons.normal;
      cell.button.dataset.skillId = id === undefined ? '' : String(id);
      cell.button.dataset.skillName = entry?.name ?? '';
      cell.button.dataset.available = String(!reason);
      cell.button.disabled = !this.options.editSlot && Boolean(reason);
      cell.button.draggable = Boolean(this.options.editSlot && id && level > 0);
      cell.button.setAttribute('aria-disabled', String(Boolean(reason)));
      cell.button.title = entry ? `${cell.binding.label} · ${entry.name}${reason ? ` · ${reason}` : ''}` : `${cell.binding.label} · 尚未配置`;
      cell.button.setAttribute('aria-label', entry ? `${cell.binding.label}：${entry.name}，等级 ${level}${reason ? `，${reason}` : ''}` : `${cell.binding.label}：尚未配置`);
      if (icon) {
        cell.icon.src = resolveAssetUrl(icon.url);
        cell.icon.width = icon.width ?? SOURCE_SLOT_SIZE;
        cell.icon.height = icon.height ?? SOURCE_SLOT_SIZE;
        cell.icon.hidden = false;
      } else {
        cell.icon.removeAttribute('src');
        cell.icon.hidden = true;
      }
      cell.level.textContent = level > 0 ? `Lv${level}` : '';
      cell.level.hidden = level <= 0;
      cell.cooldown.hidden = cooldownMs <= 0;
      cell.cooldown.textContent = cooldownMs > 0 ? `${Math.ceil(cooldownMs / 1000)}` : '';
      cell.cooldown.setAttribute('aria-label', cooldownMs > 0 ? `冷却 ${Math.ceil(cooldownMs / 1000)} 秒` : '');
      cell.button.classList.toggle('is-disabled', Boolean(reason));
      cell.button.classList.toggle('is-cooldown', cooldownMs > 0);
      cell.button.classList.toggle('is-active', this.skillActive(player, id));
      cell.button.dataset.blockReason = reason ?? '';
    }
  }

  private shortcutId(job: number | undefined, binding: ShortcutBinding): number | undefined {
    // Keep the HUD on the same project mapping as physical keyboard input. A
    // fourth-job icon remains visible before the fourth job so the disabled
    // state explains the reserved Shift row instead of turning it into an
    // unexplained gap — and it is the player's *own* branch row (火毒 212 /
    // 冰雷 222 / 主教 232), not always the ice/lightning one.
    return binding.shift ? shortcutSkill(branchFourthJob(job), binding.code, true) : shortcutSkill(job, binding.code, false);
  }

  private skillLevel(player: HudPlayer, skillId: number): number {
    const level = player.skills?.[String(skillId)];
    return typeof level === 'number' && Number.isSafeInteger(level) && level > 0 ? level : 0;
  }

  private skillCooldown(player: HudPlayer, skillId: number) {
    const remaining = player.derivedStats?.skillCooldowns?.[String(skillId)] ?? 0;
    return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
  }

  private skillActive(player: HudPlayer, skillId: number | undefined) {
    if (skillId === undefined) return false;
    const stats = player.derivedStats;
    return skillId === 2001002 ? Boolean(stats?.magicGuard)
      : skillId === 2201009 ? Boolean(stats?.iceTeleport)
        : skillId === 2211007 ? Boolean(stats?.teleportMastery)
          : skillId === 2221054 ? Boolean(stats?.hyperBarrierActive)
          : skillId === 2211017 ? Boolean(stats?.teleportBoost)
            : false;
  }

  private shortcutBlockReason(player: HudPlayer, skillId: number | undefined, entry: SkillCatalogEntry | undefined, level: number, cooldownMs: number) {
    if (skillId === undefined || !entry) return '技能未导出';
    if (!this.jobAllows(entry, player.job)) return '职业不可用';
    if (player.hp <= 0 || player.action === 'dead') return '角色已死亡';
    if (player.climbing) return '攀爬中不可用';
    if ((player.derivedStats?.skillBuffs?.['2221011'] ?? 0) > 0 || (player.derivedStats?.skillBuffs?.['2221052'] ?? 0) > 0) return '持续施放中';
    if (level <= 0) return '尚未学习';
    if (cooldownMs > 0) return `冷却 ${Math.ceil(cooldownMs / 1000)} 秒`;
    const mpCon = entry.levelValues?.find(value => value.level === level)?.mpCon;
    if (typeof mpCon === 'number' && Number.isFinite(mpCon) && player.mp < mpCon) return 'MP不足';
    return undefined;
  }

  private jobAllows(entry: SkillCatalogEntry, job: number | undefined) {
    if (job === undefined) return false;
    // 与技能窗 canLearn/castBlockReason 读同一张权威表（`../player/input` 的
    // BOOK_JOBS）：这里再写一份 switch 就只能在加分支时漏掉一格，
    // 火毒/主教的书号（210/211/212/230/231/232）就是这么被 default 判成不可用的。
    return bookAllowsJob(entry.bookId, job);
  }

  private shortcutPointerDown(event: PointerEvent, cell: ShortcutCell) {
    if (event.button !== 0 || cell.button.disabled || cell.button.dataset.blockReason) return;
    // Pointer use keeps gameplay focus; keyboard users can still Tab into the bar.
    event.preventDefault();
    const skillId = Number(cell.button.dataset.skillId);
    if (![2221011, 2221052].includes(skillId)) return;
    this.releaseChannel();
    const requestId = this.options.castSkill?.(skillId);
    if (requestId) {
      this.channelRequestId = requestId;
      cell.button.classList.add('is-channeling');
    }
  }

  private shortcutClick(event: MouseEvent, cell: ShortcutCell) {
    if (this.options.resolveBinding && cell.action?.type !== 'skill') {
      if (cell.action) this.options.activateBinding?.(cell.action);
      else this.options.editSlot?.(cell.binding.sourceSlot);
      return;
    }
    if (cell.button.dataset.blockReason) return;
    const skillId = Number(cell.button.dataset.skillId);
    if (!Number.isSafeInteger(skillId) || cell.button.disabled) return;
    if ([2221011, 2221052].includes(skillId)) {
      event.preventDefault();
      return;
    }
    this.options.castSkill?.(skillId);
  }

  private shortcutKeyDown(event: KeyboardEvent, cell: ShortcutCell) {
    if (!['Space', 'Enter'].includes(event.code) || event.repeat || cell.button.disabled || cell.button.dataset.blockReason) return;
    const skillId = Number(cell.button.dataset.skillId);
    if (![2221011, 2221052].includes(skillId)) return;
    event.preventDefault();
    this.releaseChannel();
    const requestId = this.options.castSkill?.(skillId);
    if (requestId) {
      this.channelRequestId = requestId;
      cell.button.classList.add('is-channeling');
    }
  }

  private shortcutKeyUp(event: KeyboardEvent, cell: ShortcutCell) {
    if (['Space', 'Enter'].includes(event.code) && [2221011, 2221052].includes(Number(cell.button.dataset.skillId))) this.releaseChannel();
  }
}
