import type { PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { ACTIVE_SKILLS } from '../skills/view';
import { itemName } from '../inventory/names';
import { createAssetButton, installWindowDrag } from '../ui/window-shell';
import { ACTIONS, SUPPORTED_CODES, keyLabel, type Action, type KeyBinding, KeyBindings } from './model';
import './style.css';

const ACTION_NAMES: Record<Action, string> = {
  attack: '普通攻击', jump: '跳跃', pickup: '拾取', talk: 'NPC对话', skills: '技能', quests: '任务',
  inventory: '背包', equipment: '装备', worldmap: '世界地图', keybind: '键盘设置', character: '角色信息',
  pets: '宠物', left: '向左', right: '向右',
  // 骑宠键：装备栏里双击骑宠槽是同一个开关（`MountStatusView::toggleCurrent`），
  // 这里只是把它也做成一个可绑定、可按的动作。
  mount: '骑宠',
};
// Source keyPos ids are the PC scan codes used by the authored key labels.
const SOURCE_CODES: Record<number, string> = {
  1: 'Escape', 12: 'Minus', 13: 'Equal', 26: 'BracketLeft', 27: 'BracketRight', 29: 'ControlLeft',
  39: 'Semicolon', 40: 'Quote', 41: 'Backquote', 42: 'ShiftLeft', 43: 'Backslash',
  51: 'Comma', 52: 'Period', 54: 'ShiftRight', 56: 'AltLeft', 57: 'Space',
  70: 'ScrollLock', 71: 'Home', 73: 'PageUp', 79: 'End', 81: 'PageDown', 82: 'Insert', 83: 'Delete',
  87: 'F11', 88: 'F12', 89: 'ControlRight', 90: 'AltRight',
};
['1','2','3','4','5','6','7','8','9','0'].forEach((digit, i) => SOURCE_CODES[i + 2] = `Digit${digit}`);
[...'QWERTYUIOP'].forEach((letter, i) => SOURCE_CODES[i + 16] = `Key${letter}`);
[...'ASDFGHJKL'].forEach((letter, i) => SOURCE_CODES[i + 30] = `Key${letter}`);
[...'ZXCVBNM'].forEach((letter, i) => SOURCE_CODES[i + 44] = `Key${letter}`);
for (let i = 0; i < 10; i++) SOURCE_CODES[59 + i] = `F${i + 1}`;
const SKILL_MIME = 'application/x-maplestory-skill';
const BINDING_MIME = 'application/x-maplestory-binding';

export class KeybindingsView {
  private root = document.createElement('div');
  private panel = document.createElement('section');
  private keyboard = document.createElement('div');
  private palette = document.createElement('div');
  private quick = document.createElement('div');
  private hint = document.createElement('p');
  private keySelect = document.createElement('select');
  private shiftToggle = document.createElement('input');
  private player?: PlayerState;
  private selected: KeyBinding = null;
  private selectedKey?: { code: string; shift: boolean };
  private selectedSlot?: number;
  private unsubscribe: () => void;
  private dragDispose: () => void;
  private filter: 'skill' | 'action' | 'item' = 'skill';
  private keys = new Map<string, HTMLButtonElement>();
  private paletteSignature = '';
  private hudObserver?: ResizeObserver;
  constructor(host: HTMLElement, private manifest: Manifest, private bindings: KeyBindings, private status: (text: string) => void) {
    this.root.className = 'keybindings-host'; this.root.hidden = true;
    this.panel.className = 'keybindings-window'; this.panel.tabIndex = -1;
    this.panel.setAttribute('role', 'dialog'); this.panel.setAttribute('aria-label', '自定义键盘与快捷栏');
    const art = manifest.keybindingsUi;
    if (art) this.panel.style.setProperty('--keybindings-art', `url("${art.background.url}")`);
    const header = document.createElement('header'); header.className = 'keybindings-title';
    header.setAttribute('aria-label', '自定义键设定');
    const close = createAssetButton({ assets: art?.buttons ?? {}, base: 'button:close', label: '关闭键盘设置', action: () => this.close() });
    if (close) { close.button.className = 'keybindings-close'; header.append(close.button); }
    else header.append(this.button('关闭', () => this.close()));
    this.keyboard.className = 'keybindings-keyboard'; this.keyboard.setAttribute('aria-label', '键盘位置');
    for (const [id, point] of Object.entries(art?.keyPositions ?? {})) {
      const code = SOURCE_CODES[Number(id)]; if (!code) continue;
      const key = this.button(keyLabel(code), () => this.chooseKey(code, this.shiftToggle.checked));
      key.className = 'keybindings-key'; key.dataset.code = code; key.dataset.sourceId = id;
      key.style.left = `${point.x}px`; key.style.top = `${point.y - 67}px`;
      if (!SUPPORTED_CODES.includes(code)) { key.disabled = true; key.title = `${keyLabel(code)} · 保留按键`; }
      this.acceptDrop(key, skill => { this.selected = { type: 'skill', skillId: skill }; this.chooseKey(code, this.shiftToggle.checked); }, binding => { this.selected = binding; this.chooseKey(code, this.shiftToggle.checked); });
      key.addEventListener('contextmenu', event => { event.preventDefault(); this.clearKey(code, this.shiftToggle.checked); });
      key.addEventListener('dragstart', event => {
        const binding = bindings.resolve(code, this.shiftToggle.checked);
        if (!binding) { event.preventDefault(); return; }
        event.dataTransfer?.setData(BINDING_MIME, JSON.stringify(binding));
      });
      this.keys.set(code, key); this.keyboard.append(key);
    }
    const controls = document.createElement('div'); controls.className = 'keybindings-controls';
    const shiftLabel = document.createElement('label'); this.shiftToggle.type = 'checkbox';
    shiftLabel.append(this.shiftToggle, ' Shift 组合键');
    this.shiftToggle.addEventListener('change', () => this.render());
    this.keySelect.setAttribute('aria-label', '选择键盘按键');
    for (const code of SUPPORTED_CODES) { const option = document.createElement('option'); option.value = code; option.textContent = keyLabel(code); this.keySelect.append(option); }
    controls.append(shiftLabel, this.keySelect, this.button('指定按键', () => this.chooseKey(this.keySelect.value, this.shiftToggle.checked)), this.button('清除所选键', () => {
      if (this.selectedKey) this.clearKey(this.selectedKey.code, this.selectedKey.shift);
      else this.message('先点击键盘上的按键。');
    }));
    const tabs = document.createElement('nav'); tabs.className = 'keybindings-tabs';
    for (const [value, label] of [['skill', '已学技能'], ['action', '基本动作'], ['item', '消耗品']] as const) {
      const button = this.button(label, () => { this.filter = value; this.selected = null; this.paletteSignature = ''; this.render(); });
      button.dataset.filter = value; tabs.append(button);
    }
    this.palette.className = 'keybindings-palette'; this.palette.setAttribute('aria-label', '可绑定技能与动作');
    const quickLabel = document.createElement('div'); quickLabel.className = 'keybindings-quick-label'; quickLabel.textContent = '快捷栏 · 点击格子，再按键或选择键位';
    this.quick.className = 'keybindings-quick'; this.quick.setAttribute('aria-label', '快捷栏显示位置');
    const footer = document.createElement('footer'); footer.className = 'keybindings-footer';
    this.hint.setAttribute('role', 'status'); this.hint.textContent = '选择技能或动作，再点键盘；也可将技能拖到按键或快捷栏。';
    footer.append(this.hint, this.button('恢复默认', () => { this.selected = null; this.selectedSlot = undefined; this.persist(this.bindings.resetDefaults()); }), this.button('完成', () => this.close()));
    const note = document.createElement('small'); note.textContent = '修改即时生效，按角色保存在当前浏览器。右键按键可清除；方向键和 Esc 保留。'; footer.append(note);
    const toolbar = document.createElement('div'); toolbar.className = 'keybindings-toolbar'; toolbar.append(controls, tabs);
    this.panel.append(header, this.keyboard, toolbar, this.palette, quickLabel, this.quick, footer);
    this.root.append(this.panel); host.append(this.root);
    this.unsubscribe = bindings.subscribe(() => this.render());
    this.dragDispose = installWindowDrag(this.root, this.panel, { titleHeight: 28, isOpen: () => this.isOpen() });
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.fit);
    const hud = document.querySelector('#hud');
    if (hud && typeof ResizeObserver !== 'undefined') { this.hudObserver = new ResizeObserver(this.fit); this.hudObserver.observe(hud); }
    this.render();
  }
  isOpen() { return !this.root.hidden; }
  open(skillId?: number) {
    this.root.hidden = false; this.selectedSlot = undefined;
    this.selected = skillId && this.canBindSkill(skillId) ? { type: 'skill', skillId } : null;
    this.message(this.selected ? `已选择 ${this.bindingLabel(this.selected)}，请点目标按键或快捷栏。` : '选择技能或动作，再点键盘；也可拖入技能。');
    this.render(); this.fit(); this.panel.focus({ preventScroll: true });
  }
  close() { this.root.hidden = true; this.selectedSlot = undefined; this.selected = null; document.querySelector<HTMLElement>('#game')?.focus({ preventScroll: true }); }
  update(player?: PlayerState) {
    const changed = JSON.stringify([this.player?.id, this.player?.job, this.player?.skills, this.player?.inventory]) !== JSON.stringify([player?.id, player?.job, player?.skills, player?.inventory]);
    this.player = player;
    if (!player) this.close();
    if (changed && this.isOpen()) this.render();
  }
  selectSlot(index: number) { this.selectedSlot = index; this.selected = null; this.message(`快捷栏第 ${index + 1} 格：请按想显示的按键，或用上方按键列表选择。`); this.render(); this.panel.focus({ preventScroll: true }); }
  bindSkillToSlot(index: number, skillId: number) {
    if (!this.canBindSkill(skillId)) { this.message('只能配置当前角色已学习的主动技能。'); return; }
    const slot = this.bindings.slots[index]; if (!slot) return;
    this.persist(this.bindings.bind(slot.code, slot.shift, { type: 'skill', skillId }));
  }
  bindItemToSlot(index: number, itemId: number) {
    if (!this.canBindItem(itemId)) { this.message('只能配置背包里的消耗品或椅子。'); return; }
    const slot = this.bindings.slots[index]; if (!slot) return;
    this.persist(this.bindings.bind(slot.code, slot.shift, { type: 'item', itemId }));
  }
  skillKeys(skillId: number) {
    return SUPPORTED_CODES.flatMap(code => [false, true].flatMap(shift => {
      const binding = this.bindings.resolve(code, shift);
      return binding?.type === 'skill' && binding.skillId === skillId ? [keyLabel(code, shift)] : [];
    })).join(' / ');
  }
  bindingLabel(binding: KeyBinding): string {
    if (!binding) return '未配置';
    if (binding.type === 'skill') return this.manifest.skillCatalog?.[String(binding.skillId)]?.name ?? `技能 ${binding.skillId}`;
    if (binding.type === 'item') return itemName(String(binding.itemId).padStart(8, '0'));
    return ACTION_NAMES[binding.action];
  }
  private icon(binding: KeyBinding): Pick<AssetFrame, 'url'> | undefined {
    if (binding?.type === 'skill') return this.manifest.skillCatalog?.[String(binding.skillId)]?.icons.normal;
    if (binding?.type === 'item') return this.manifest.items?.[String(binding.itemId).padStart(8, '0')];
  }
  private canBindSkill(skillId: number) { return ACTIVE_SKILLS.has(String(skillId)) && (this.player?.skills?.[String(skillId)] ?? 0) > 0; }
  /**
   * 快捷栏能绑的道具＝背包里真带着的**消耗品**（类 2）或**设置栏件**（类 3，椅子在
   * 这一栏）。为什么设置栏整栏放行而不在这里认椅子：椅子的身份只在服务端
   * （`inventory::is_chair_item` 按源分组 `0301*` / `0302` 判），客户端刻意不打包
   * `chairs.json`（见 `inventory/names.ts` 的体积说明），而客户端手上两份椅子表
   * （`chair-names.json`、`manifest.rideScenes.chairs`）都**含非椅子装饰件**——拿它们
   * 当判据会把"能绑"说成比"能坐"更宽的事。绑错的装饰件在按下时由服务端以具名的
   * `not_a_chair` 退回，界面照译（`inventory/view.ts`），不在这里猜。
   */
  private canBindItem(itemId: number) {
    const category = Math.floor(itemId / 1e6);
    if (category !== 2 && category !== 3) return false;
    return Boolean(this.player?.inventory.some(item => Number(item.itemId) === itemId && item.quantity > 0));
  }
  private validBinding(binding: KeyBinding) {
    if (binding?.type === 'skill') return this.canBindSkill(binding.skillId);
    if (binding?.type === 'action') return ACTIONS.includes(binding.action);
    return binding?.type === 'item' && this.canBindItem(binding.itemId);
  }
  private chooseKey(code: string, shift: boolean) {
    if (!SUPPORTED_CODES.includes(code)) return;
    this.selectedKey = { code, shift }; this.keySelect.value = code;
    if (this.selectedSlot !== undefined) {
      const index = this.selectedSlot; this.selectedSlot = undefined;
      this.persist(this.bindings.setSlot(index, code, shift)); return;
    }
    if (this.selected) {
      if (!this.validBinding(this.selected)) { this.message('该技能或道具目前不可配置。'); return; }
      const replaced = this.bindings.resolve(code, shift);
      const name = this.bindingLabel(this.selected);
      if (this.bindings.bind(code, shift, this.selected)) this.message(`${keyLabel(code, shift)} → ${name}${replaced ? `（已替换 ${this.bindingLabel(replaced)}）` : ''}`);
      else this.persist(false);
      this.selected = null;
    } else this.message(`${keyLabel(code, shift)}：${this.bindingLabel(this.bindings.resolve(code, shift) ?? null)}。选择下方技能后再点此键可替换。`);
    this.render();
  }
  private clearKey(code: string, shift: boolean) { this.selected = null; this.persist(this.bindings.bind(code, shift, null)); }
  private persist(ok: boolean) { this.message(ok ? '配置已保存。' : this.bindings.lastSaveError ?? '无法保存配置，请重新选择有效按键。'); this.render(); }
  private message(text: string) { this.hint.textContent = text; this.status(text); }
  private onKeyDown = (event: KeyboardEvent) => {
    if (!this.isOpen()) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.close(); return; }
    if (event.isComposing || event.metaKey || (event.altKey && !event.code.startsWith('Alt')) || (event.ctrlKey && !event.code.startsWith('Control')) || event.repeat) return;
    if (this.selectedSlot === undefined || event.target instanceof HTMLSelectElement || event.code === 'Tab') return;
    if (SUPPORTED_CODES.includes(event.code)) { event.preventDefault(); event.stopImmediatePropagation(); this.chooseKey(event.code, event.shiftKey); }
  };
  private render() {
    for (const [code, key] of this.keys) {
      const binding = this.bindings.resolve(code, this.shiftToggle.checked) ?? null;
      this.paint(key, binding, keyLabel(code));
      const labelArt = this.manifest.keybindingsUi?.keys[key.dataset.sourceId ?? ''];
      if (labelArt) {
        const label = key.querySelector('.keybindings-label')!;
        const image = document.createElement('img'); image.src = labelArt.url; image.alt = keyLabel(code); image.draggable = false;
        image.style.width = `${labelArt.width}px`; image.style.height = `${labelArt.height}px`;
        label.replaceChildren(image);
      }
      key.title = `${keyLabel(code, this.shiftToggle.checked)} · ${this.bindingLabel(binding)}`;
      key.setAttribute('aria-label', key.title); key.draggable = Boolean(binding);
      key.classList.toggle('is-selected', this.selectedKey?.code === code && this.selectedKey.shift === this.shiftToggle.checked);
    }
    this.quick.replaceChildren();
    this.bindings.slots.forEach((slot, index) => {
      const button = this.button('', () => {
        if (this.selected) {
          this.persist(this.bindings.bind(slot.code, slot.shift, this.selected)); this.selected = null;
        } else this.selectSlot(index);
      });
      button.className = 'keybindings-slot'; button.dataset.slot = String(index);
      this.paint(button, this.bindings.resolve(slot.code, slot.shift) ?? null, keyLabel(slot.code, slot.shift));
      button.title = `第 ${index + 1} 格 · ${keyLabel(slot.code, slot.shift)} · ${this.bindingLabel(this.bindings.resolve(slot.code, slot.shift) ?? null)}`;
      button.setAttribute('aria-label', button.title); button.classList.toggle('is-selected', this.selectedSlot === index);
      this.acceptDrop(button, skillId => this.bindSkillToSlot(index, skillId), binding => this.persist(this.bindings.bind(slot.code, slot.shift, binding)));
      this.quick.append(button);
    });
    const signature = JSON.stringify([this.filter, this.player?.skills, this.player?.inventory, this.selected]);
    if (signature === this.paletteSignature) return; this.paletteSignature = signature;
    this.panel.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === this.filter)));
    this.palette.replaceChildren();
    let choices: KeyBinding[];
    if (this.filter === 'skill') choices = Object.keys(this.player?.skills ?? {}).filter(id => this.canBindSkill(Number(id))).map(id => ({ type: 'skill', skillId: Number(id) }));
    else if (this.filter === 'action') choices = ACTIONS.filter(action => !['left', 'right'].includes(action)).map(action => ({ type: 'action', action }));
    else choices = [...new Set(this.player?.inventory.filter(item => Math.floor(Number(item.itemId) / 1e6) === 2 && item.quantity > 0).map(item => Number(item.itemId)) ?? [])].map(itemId => ({ type: 'item', itemId }));
    for (const binding of choices) {
      const button = this.button('', () => { this.selected = binding; this.selectedSlot = undefined; this.message(`已选择 ${this.bindingLabel(binding)}，请点目标按键或快捷栏。`); this.render(); });
      button.className = 'keybindings-choice'; this.paint(button, binding, this.bindingLabel(binding));
      button.title = this.bindingLabel(binding); button.setAttribute('aria-label', button.title);
      button.draggable = true; button.classList.toggle('is-selected', JSON.stringify(this.selected) === JSON.stringify(binding));
      button.addEventListener('dragstart', event => { event.dataTransfer?.setData(BINDING_MIME, JSON.stringify(binding)); });
      this.palette.append(button);
    }
    if (!choices.length) { const empty = document.createElement('p'); empty.textContent = this.filter === 'skill' ? '尚无已学主动技能。可在技能窗先分配技能点。' : '背包中没有消耗品。'; this.palette.append(empty); }
  }
  private paint(button: HTMLButtonElement, binding: KeyBinding, label: string) {
    button.replaceChildren();
    const art = this.icon(binding);
    if (art) { const image = document.createElement('img'); image.src = art.url; image.alt = ''; image.draggable = false; button.append(image); }
    else if (binding) { const action = document.createElement('span'); action.className = 'keybindings-action'; action.textContent = this.bindingLabel(binding); button.append(action); }
    const key = document.createElement('span'); key.className = 'keybindings-label'; key.textContent = label; button.append(key);
  }
  private acceptDrop(target: HTMLElement, skill: (id: number) => void, action: (binding: KeyBinding) => void) {
    target.addEventListener('dragover', event => { if (event.dataTransfer?.types.some(type => [SKILL_MIME, BINDING_MIME].includes(type))) event.preventDefault(); });
    target.addEventListener('drop', event => {
      event.preventDefault();
      const skillId = Number(event.dataTransfer?.getData(SKILL_MIME));
      if (skillId && this.canBindSkill(skillId)) { skill(skillId); return; }
      try {
        const binding = JSON.parse(event.dataTransfer?.getData(BINDING_MIME) ?? '') as KeyBinding;
        if (this.validBinding(binding)) action(binding); else this.message('无法配置未学习技能或无效道具。');
      } catch { this.message('无法读取拖入的快捷键。'); }
    });
  }
  private fit = () => {
    if (!this.isOpen()) return;
    const host = this.root.getBoundingClientRect();
    const hud = document.querySelector('#hud')?.getBoundingClientRect();
    const available = Math.max(160, Math.min(host.height, hud && hud.height > 0 ? hud.top - host.top : host.height) - 12);
    this.panel.style.maxHeight = `${available}px`;
    this.panel.style.top = `${Math.max(6, (available - this.panel.getBoundingClientRect().height) / 2 + 6)}px`;
  };
  private button(label: string, action: () => void) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', action); return button; }
  destroy() { this.hudObserver?.disconnect(); window.removeEventListener('resize', this.fit); this.unsubscribe(); this.dragDispose(); window.removeEventListener('keydown', this.onKeyDown, true); this.root.remove(); }
}
