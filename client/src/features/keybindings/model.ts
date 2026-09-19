import { shortcutSkill } from '../player/input';

export const ACTIONS = [
  'attack', 'jump', 'pickup', 'talk', 'skills', 'quests', 'inventory', 'equipment',
  'worldmap', 'keybind', 'character', 'pets', 'mount', 'left', 'right',
] as const;
export type Action = (typeof ACTIONS)[number];

export type KeyBinding =
  | { type: 'skill'; skillId: number }
  | { type: 'action'; action: Action }
  | { type: 'item'; itemId: number }
  | null;

export interface KeySlot {
  code: string;
  shift: boolean;
  binding: KeyBinding;
}

type StoredSlot = Pick<KeySlot, 'code' | 'shift'>;
type StoredBindings = Record<string, KeyBinding>;
interface StoredConfig {
  version: number;
  customized: boolean;
  bindings: StoredBindings;
  slots: StoredSlot[];
  /** 这次读**补过**上一版没有的默认按键（不是存档里的字段，是迁移标记）。
   *  调用方据此立刻落盘一次，让迁移只做一遍。 */
  migrated?: boolean;
}

/**
 * 每一版新增的默认按键。  旧档里这些键**根本没出现过**（那一版没有它们），
 * 所以补上不覆盖任何人的自定义；同理，只有**旧版**存档才补——现行存档里
 * 一个键缺席就是玩家自己清掉了它，绝不复活。
 *
 * key 是 `bindingKey(code, shift)` 的写法，与存档里的键同构。
 */
const ADDED_DEFAULT_BINDINGS: Readonly<Record<string, KeyBinding>> = {
  // 骑宠键（第 33 格之外：源快捷栏只有 32 格，所以它只是一个可绑定按键）。
  'KeyR:0': { type: 'action', action: 'mount' },
};

export interface KeyBindingsOptions {
  /** Defaults to the browser's localStorage. Pass null to disable persistence. */
  storage?: StorageLike | null;
  /** Called when localStorage is unavailable or refuses a read/write. */
  onError?: (message: string, error?: unknown) => void;
  /** Alias useful to callers that already use save-error terminology. */
  onSaveError?: (message: string, error?: unknown) => void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** 快捷栏格数。  这是**源美术**的格数（两行 x 16 的槽位底板），不是可绑定键的
 *  上限：按键本身可以绑在任意 `SUPPORTED_CODES` 上（骑宠键就是这样，它没有格子）。 */
export const SLOT_COUNT = 32;
/** 存档 schema 版本。  1 = 骑宠键加入之前；2 = 现行。  读旧档时要补上这一版
 *  新增的默认按键（见 `ADDED_DEFAULT_BINDINGS`），但**不动**玩家自己的键。 */
export const STORAGE_VERSION = 2;
export const STORAGE_PREFIX = 'maplestory:keybindings:';

/** Arrow keys are always movement/talk controls and never occupy a slot. */
export const FIXED_CODES = Object.freeze(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const);

const LETTER_CODES = Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`);
const DIGIT_CODES = Array.from({ length: 10 }, (_, index) => `Digit${index}`);
const NUMPAD_CODES = Array.from({ length: 10 }, (_, index) => `Numpad${index}`);
const FUNCTION_CODES = Array.from({ length: 12 }, (_, index) => `F${index + 1}`);

/** KeyboardEvent.code values accepted by the keybind window. */
export const SUPPORTED_CODES: readonly string[] = Object.freeze([
  ...LETTER_CODES, ...DIGIT_CODES, ...NUMPAD_CODES, ...FUNCTION_CODES,
  'Space', 'Tab', 'Enter', 'Backspace', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'CapsLock', 'ContextMenu', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter',
  // Modifier keys can be assigned alone; Ctrl/Alt + another key stays native.
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
]);

const supportedCodes = new Set(SUPPORTED_CODES);
const fixedCodes = new Set<string>(FIXED_CODES);
const actions = new Set<string>(ACTIONS);

const LABELS: Record<string, string> = {
  Escape: 'Esc', ControlLeft: 'Ctrl L', ControlRight: 'Ctrl R', ShiftLeft: 'Shift L', ShiftRight: 'Shift R',
  AltLeft: 'Alt L', AltRight: 'Alt R', ScrollLock: 'Scroll',
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace',
  Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  CapsLock: 'Caps', ContextMenu: 'Menu', NumpadAdd: 'Num +', NumpadSubtract: 'Num −',
  NumpadMultiply: 'Num ×', NumpadDivide: 'Num ÷', NumpadDecimal: 'Num .', NumpadEnter: 'Num Enter',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
};

/** Human readable label for a KeyboardEvent.code, including an optional Shift prefix. */
export function keyLabel(code: string, shift = false): string {
  let label = LABELS[code];
  if (!label && /^Key[A-Z]$/.test(code)) label = code.slice(3);
  if (!label && /^Digit[0-9]$/.test(code)) label = code.slice(5);
  if (!label && /^Numpad[0-9]$/.test(code)) label = `Num ${code.slice(6)}`;
  if (!label && /^F(?:[1-9]|1[0-2])$/.test(code)) label = code;
  label ??= code;
  return shift ? `Shift + ${label}` : label;
}

function cloneBinding(binding: KeyBinding): KeyBinding {
  return binding && { ...binding };
}

function cloneSlot(slot: KeySlot): KeySlot {
  return { code: slot.code, shift: slot.shift, binding: cloneBinding(slot.binding) };
}

function sameKey(left: Pick<KeySlot, 'code' | 'shift'>, right: Pick<KeySlot, 'code' | 'shift'>) {
  return left.code === right.code && left.shift === right.shift;
}

function validBinding(binding: unknown): binding is KeyBinding {
  if (binding === null) return true;
  if (!binding || typeof binding !== 'object') return false;
  const value = binding as Record<string, unknown>;
  if (value.type === 'skill' || value.type === 'item') {
    return Number.isSafeInteger(value[`${value.type}Id`]) && Number(value[`${value.type}Id`]) > 0;
  }
  return value.type === 'action' && typeof value.action === 'string' && actions.has(value.action);
}

function validSlot(value: unknown): value is StoredSlot {
  if (!value || typeof value !== 'object') return false;
  const slot = value as Record<string, unknown>;
  return typeof slot.code === 'string' && supportedCodes.has(slot.code) && !fixedCodes.has(slot.code)
    && typeof slot.shift === 'boolean';
}

function parseStored(raw: string): StoredConfig | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const document = value as Record<string, unknown>;
    // 只认得现行的与上一版两种 schema：别的版本是坏档，不是旧档。
    const version = document.version;
    if ((version !== 1 && version !== STORAGE_VERSION) || typeof document.customized !== 'boolean' || !document.bindings || typeof document.bindings !== 'object' || !Array.isArray(document.slots) || document.slots.length !== SLOT_COUNT) return undefined;
    if (!document.slots.every(validSlot)) return undefined;
    const slots = document.slots.map(value => ({ code: value.code, shift: value.shift }));
    for (let index = 0; index < slots.length; index += 1) {
      if (slots.findIndex((slot, other) => other !== index && sameKey(slot, slots[index])) !== -1) return undefined;
    }
    const bindings: StoredBindings = {};
    for (const [key, binding] of Object.entries(document.bindings as Record<string, unknown>)) {
      const separator = key.lastIndexOf(':');
      const code = separator < 0 ? '' : key.slice(0, separator);
      const shift = separator < 0 ? '' : key.slice(separator + 1);
      if (!code || !supportedCodes.has(code) || fixedCodes.has(code) || !['0', '1'].includes(shift) || !validBinding(binding)) return undefined;
      bindings[key] = cloneBinding(binding);
    }
    // 旧版存档补默认按键：只补这一版**新增**的那些键（见 `ADDED_DEFAULT_BINDINGS`），
    // 而且只在存档里这个键根本没绑过时才补。现行存档一个键缺席＝玩家自己清掉的，
    // 一律不复活；旧档里的自定义绑定也一个都不动。
    let migrated = false;
    if (version !== STORAGE_VERSION) {
      for (const [key, binding] of Object.entries(ADDED_DEFAULT_BINDINGS)) {
        if (key in bindings) continue;
        bindings[key] = cloneBinding(binding);
        migrated = true;
      }
    }
    return { version: STORAGE_VERSION, customized: document.customized, bindings, slots, migrated };
  } catch {
    return undefined;
  }
}

function bindingKey(code: string, shift: boolean) { return `${code}:${shift ? 1 : 0}`; }

function defaultBindings(job: number): StoredBindings {
  const bindings: StoredBindings = {};
  const codes = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
  const allCodes = [...codes, ...codes.map(code => code.replace('Digit', 'Numpad'))];
  for (const code of allCodes) {
    for (const shift of [false, true]) {
      const skillId = shortcutSkill(job, code, shift);
      if (skillId !== undefined) bindings[bindingKey(code, shift)] = { type: 'skill', skillId };
    }
  }
  const defaultActions: Array<[string, Action]> = [
    ['ControlLeft', 'attack'], ['ControlRight', 'attack'], ['KeyX', 'attack'], ['Space', 'jump'], ['KeyZ', 'pickup'], ['KeyT', 'talk'],
    ['KeyK', 'skills'], ['KeyQ', 'quests'], ['KeyI', 'inventory'], ['KeyE', 'equipment'],
    ['KeyM', 'worldmap'], ['KeyO', 'keybind'], ['KeyC', 'character'], ['KeyY', 'pets'], ['KeyR', 'mount'],
    // ↑ 骑宠键只在这里（键盘绑定），不在 `defaultSlots()` 的 32 格里，理由见那边。
    ['KeyA', 'left'], ['KeyD', 'right'],
  ];
  for (const [code, action] of defaultActions) bindings[bindingKey(code, false)] = { type: 'action', action };
  return bindings;
}

function defaultSlots(): StoredSlot[] {
  const codes = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
  const slots: StoredSlot[] = [];
  for (const code of codes) slots.push({ code, shift: false });
  for (const code of codes) slots.push({ code, shift: true });
  const defaultActions: Array<[string, Action]> = [
    ['KeyX', 'attack'], ['Space', 'jump'], ['KeyZ', 'pickup'], ['KeyT', 'talk'],
    ['KeyK', 'skills'], ['KeyQ', 'quests'], ['KeyI', 'inventory'], ['KeyE', 'equipment'],
    // 骑宠键**没有格子**：源的快捷栏底板就只有 32 格（这里是 2 x 16），
    // 一个键要占一格就得把别人的格子挤掉。它只作为键盘绑定存在，要放进格子
    // 由玩家在键盘设置里自己拖（动作面板里有「骑宠」）。
    ['KeyM', 'worldmap'], ['KeyO', 'keybind'], ['KeyA', 'left'], ['KeyD', 'right'],
  ];
  for (const [code] of defaultActions) slots.push({ code, shift: false });
  return slots;
}

export class KeyBindings {
  private characterId?: string;
  private job = 0;
  private bindings: StoredBindings = defaultBindings(0);
  private current: StoredSlot[] = defaultSlots();
  private customized = false;
  private readonly listeners = new Set<(slots: readonly KeySlot[]) => void>();
  private readonly storageOverride: StorageLike | null | undefined;
  private readonly reportError?: (message: string, error?: unknown) => void;
  private _lastSaveError?: string;

  constructor(options: KeyBindingsOptions | ((message: string, error?: unknown) => void) = {}) {
    if (typeof options === 'function') {
      this.reportError = options;
      this.storageOverride = undefined;
    } else {
      this.storageOverride = options.storage;
      this.reportError = options.onError ?? options.onSaveError;
    }
  }

  get lastSaveError() { return this._lastSaveError; }

  setCharacter(id: string, job: number): boolean {
    if (!id) throw new Error('character id is required');
    if (this.characterId === id) {
      if (this.job !== job && !this.customized) {
        this.job = job;
        this.bindings = defaultBindings(job);
        this.current = defaultSlots();
        const saved = this.save();
        this.notify();
        return saved;
      } else {
        this.job = job;
      }
      return true;
    }
    this.characterId = id;
    this.job = job;
    this.customized = false;
    const stored = this.read(id);
    if (stored) {
      this.customized = stored.customized;
      this.bindings = stored.customized ? stored.bindings : defaultBindings(job);
      this.current = stored.customized ? stored.slots : defaultSlots();
      if (stored.migrated) {
        // 这份存档是上一版 schema，刚刚在 `parseStored` 里补过默认按键：立刻落盘，
        // 下一次登录读到的就是现行版本，迁移只做一遍。
        const saved = this.save();
        this.notify();
        return saved;
      }
    } else {
      this.bindings = defaultBindings(job);
      this.current = defaultSlots();
      const saved = this.save();
      this.notify();
      return saved;
    }
    this.notify();
    return true;
  }

  resolve(code: string, shift = false): KeyBinding {
    return cloneBinding(this.bindings[bindingKey(code, Boolean(shift))] ?? null);
  }

  get slots(): readonly KeySlot[] {
    return this.current.map(slot => ({ ...slot, binding: this.resolve(slot.code, slot.shift) }));
  }

  slotList(): readonly KeySlot[] { return this.slots; }

  bind(code: string, shift: boolean, binding: KeyBinding): boolean {
    if (!this.validKey(code) || !validBinding(binding)) return false;
    const key = bindingKey(code, Boolean(shift));
    if (binding === null) delete this.bindings[key];
    else this.bindings[key] = cloneBinding(binding);
    this.customized = true;
    return this.commit();
  }

  setSlot(index: number, code: string, shift: boolean): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.current.length || !this.validKey(code)) return false;
    const slot = this.current[index];
    const duplicate = this.current.findIndex((candidate, candidateIndex) => candidateIndex !== index && candidate.code === code && candidate.shift === Boolean(shift));
    if (duplicate >= 0) {
      this.current[duplicate].code = slot.code;
      this.current[duplicate].shift = slot.shift;
    }
    slot.code = code;
    slot.shift = Boolean(shift);
    this.customized = true;
    return this.commit();
  }

  resetDefaults(): boolean {
    this.bindings = defaultBindings(this.job);
    this.current = defaultSlots();
    this.customized = false;
    return this.commit();
  }

  subscribe(listener: (slots: readonly KeySlot[]) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private validKey(code: string) {
    return supportedCodes.has(code) && !fixedCodes.has(code);
  }

  private storage(): StorageLike | undefined {
    if (this.storageOverride !== undefined) return this.storageOverride ?? undefined;
    try {
      return typeof localStorage === 'undefined' ? undefined : localStorage;
    } catch (error) {
      this.fail('快捷键配置读取失败', error);
      return undefined;
    }
  }

  private key(id: string) { return `${STORAGE_PREFIX}${encodeURIComponent(id)}`; }

  private read(id: string) {
    const storage = this.storage();
    if (!storage) return undefined;
    try {
      const raw = storage.getItem(this.key(id));
      return raw === null ? undefined : parseStored(raw);
    } catch (error) {
      this.fail('快捷键配置读取失败', error);
      return undefined;
    }
  }

  private save() {
    if (!this.characterId) return true;
    const storage = this.storage();
    // `storage: null` is the explicit in-memory test mode.  A missing or
    // denied browser localStorage is a real persistence failure.
    if (!storage) return this.storageOverride === null;
    try {
      storage.setItem(this.key(this.characterId), JSON.stringify({ version: STORAGE_VERSION, customized: this.customized, bindings: this.bindings, slots: this.current }));
      this._lastSaveError = undefined;
      return true;
    } catch (error) {
      this.fail('快捷键配置保存失败', error);
      return false;
    }
  }

  private fail(message: string, error?: unknown) {
    this._lastSaveError = message;
    try { this.reportError?.(message, error); } catch { /* feedback must not break input */ }
  }

  private commit() {
    const saved = this.save();
    this.notify();
    return saved;
  }

  private notify() {
    const snapshot = this.slots;
    for (const listener of this.listeners) listener(snapshot);
  }
}
