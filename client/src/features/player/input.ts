import type { ClientMessage, NpcState, PlayerState } from '../../../../shared/protocol';
import type { Action, KeyBinding } from '../keybindings/model';

export const MAGE_JOB_WHITELIST = new Set([200, 210, 211, 212, 220, 221, 222, 230, 231, 232]);
export const ICE_LIGHTNING_JOB_WHITELIST = new Set([220, 221, 222]);
export const FIRE_POISON_JOB_WHITELIST = new Set([210, 211, 212]);
export const CLERIC_JOB_WHITELIST = new Set([230, 231, 232]);

/**
 * 技能书 → 能持有该书的职业集合；**这是客户端唯一的书准入权威**，
 * 技能窗（canLearn / castBlockReason / books）、HUD 快捷栏（jobAllows）与
 * 键盘快捷键（canCastShortcut）三处都读它，不再各自内联 bookId 判断。
 *
 * 放在这里是因为本模块是「不引运行期依赖」的叶子模块：技能窗与 HUD 都已经
 * import 它，搬进来不会出现 `skills/view.ts ←→ player/input.ts` 的循环引用。
 *
 * 页签语义是「转职层级」而不是「技能书」：同层三个分支（火毒 210 / 冰雷 220 / 僧侶 230 的 2 转）
 * 共用一个页签下标（见 `scripts/tms273_skill_manifest.cjs` 的 SKILL_BOOK_TABS），
 * 实际进入哪本由职业决定 ⇒ 两张表必须同时维护。
 *
 * 表里没有的书沿用「不限制职业」的旧行为（战士书 '100' 依赖这条：它的门控由
 * derivedStats.regenerationPassives.bookId 决定，不是职业号）。
 */
export const BOOK_JOBS: Readonly<Record<string, ReadonlySet<number>>> = {
  '0': new Set([0, ...MAGE_JOB_WHITELIST]),
  '200': MAGE_JOB_WHITELIST,
  '210': FIRE_POISON_JOB_WHITELIST,
  '220': ICE_LIGHTNING_JOB_WHITELIST,
  '230': CLERIC_JOB_WHITELIST,
  '211': new Set([211, 212]),
  '221': new Set([221, 222]),
  '231': new Set([231, 232]),
  '212': new Set([212]),
  '222': new Set([222]),
  '232': new Set([232]),
};

export function bookAllowsJob(bookId: string, job: number | undefined): boolean {
  const allowed = BOOK_JOBS[bookId];
  return allowed ? allowed.has(job ?? -1) : true;
}

/**
 * 书号从技能 id 派生（高两位），与 `server/src/mage.rs` 的 `book = skill_id / 10000` 同一口径。
 * 快捷键与 HUD 都靠它把「一个 skillId」折成「一本权威表里的书」，
 * 从而不必再写 `skillId >= 2200000` 这类数值区间——那个写法会把 23xxxxx（僧侶）
 * 一并吞进冰雷分支，把主教技能判成「职业不可用」。
 */
export function bookIdForSkill(skillId: number): string {
  return String(Math.floor(skillId / 10000));
}

export const SHORTCUT_SKILLS: Readonly<Record<string, number>> = {
  Digit1: 2001008, Numpad1: 2001008, Digit2: 2001009, Numpad2: 2001009, Digit3: 2001002, Numpad3: 2001002,
  Digit4: 2201008, Numpad4: 2201008, Digit5: 2201005, Numpad5: 2201005, Digit6: 2201001, Numpad6: 2201001, Digit7: 2201009, Numpad7: 2201009,
  Digit8: 2211002, Numpad8: 2211002, Digit9: 2211014, Numpad9: 2211014, Digit0: 2211011, Numpad0: 2211011,
};
/** 冰雷四转（222）的 Shift+数字 快捷栏。 */
export const FOURTH_SHORTCUT_SKILLS: Readonly<Record<string, number>> = {
  Digit1: 2221006, Digit2: 2221012, Digit3: 2221007, Digit4: 2221004,
  Digit5: 2221005, Digit6: 2221011, Digit7: 2221008, Digit8: 2221000, Digit9: 2221052, Digit0: 2221054,
};
/**
 * 另外两条分支的四转快捷栏。**只放「服务端已接执行链」的技能**（与
 * `skills/view.ts::ACTIVE_SKILLS` 同一纪律）：快捷键按下去一定要有反应，
 * 摆一个只回「尚未开放施放」的键位等于给玩家一个坏按钮。
 * 火毒 212 与主教 232 各一套，键位与冰雷那套对齐（1..0）。
 */
export const FIRE_FOURTH_SHORTCUT_SKILLS: Readonly<Record<string, number>> = {
  Digit1: 2121006, Digit2: 2121011, Digit3: 2121007, Digit4: 2121003,
};
export const HOLY_FOURTH_SHORTCUT_SKILLS: Readonly<Record<string, number>> = {
  Digit1: 2321001, Digit2: 2321007, Digit3: 2321008,
};

/** 按分支取四转快捷栏（未转四转/其它职业返回 undefined）。 */
export function fourthShortcutTable(job: number | undefined): Readonly<Record<string, number>> | undefined {
  if (job === 222) return FOURTH_SHORTCUT_SKILLS;
  if (job === 212) return FIRE_FOURTH_SHORTCUT_SKILLS;
  if (job === 232) return HOLY_FOURTH_SHORTCUT_SKILLS;
  return undefined;
}

/**
 * HUD 的 Shift 行在「还没转四转」时也要把该分支的四转技能摆出来（禁用态），
 * 否则这一行会变成一排没有解释的空格。所以需要从二/三转职业反推该分支的四转书：
 * 210/211 → 212、220/221 → 222、230/231 → 232。
 * 初心者与其它职业沿用旧的 222 占位（冰雷四转技能当挡位，显示为不可用）。
 */
export function branchFourthJob(job: number | undefined): number {
  const branch = Math.floor((job ?? 0) / 10);
  if (branch === 21) return 212;
  if (branch === 23) return 232;
  return 222;
}

/** Shared by keyboard input and the HUD; these are the project's current bindings. */
export function shortcutSkill(job: number | undefined, code: string, shift = false): number | undefined {
  const digit = code.replace('Numpad', 'Digit');
  const fourth = shift ? fourthShortcutTable(job) : undefined;
  if (fourth) return fourth[digit];
  if (job === 0) return ({ Digit1: 1000, Digit2: 1001, Digit3: 1002 } as Record<string, number>)[digit];
  return SHORTCUT_SKILLS[digit];
}

export interface Interactable {
  nearestDrop: () => string | null;
  enterPortal: () => void;
  nearestNpc: () => NpcState | null;
  talkTo: (npc: NpcState) => void;
  /** Nearest usable map reactor; attacking near one strikes it (original behaviour). */
  nearestReactor?: () => string | null;
  /** Send a server-owned reactor intent; range and state are decided there. */
  hitReactor?: (reactorId: string) => string | void;
  toggleQuestLog: () => void;
  toggleSkills?: () => void;
  /** Send a server-owned skill intent; this input layer never applies damage or MP. */
  castSkill?: (skillId: number, direction?: -1 | 0 | 1, vertical?: -1 | 0 | 1) => string | void;
  /** Latest authoritative self state, used only to distinguish grounded jump from air float. */
  playerState?: () => PlayerState | undefined;
  basicMovementOnly?: () => boolean;
  mapDirection?: (raw: -1|0|1) => -1|0|1;
  /** UI-owned modal state; prevents gameplay input from crossing the window boundary. */
  isBlocked?: () => boolean;
  /** Optional per-character key layout. Null means this key is explicitly unbound; absent getter keeps legacy input. */
  resolveBinding?: (code: string, shift: boolean) => KeyBinding;
  /** Routes UI actions owned by the app shell (inventory, world map, keybind, etc.). */
  performAction?: (action: Action) => void;
  /** Routes a custom consumable shortcut to the app/inventory owner. */
  useItem?: (itemId: number) => void;
}

export class PlayerInput {
  private held = new Set<string>();
  private heldLeft = new Set<string>();
  private heldRight = new Set<string>();
  private channel?: { code: string; requestId: string };
  private seq = 0;
  private attackSeq = 0;
  private pickupSeq = 0;
  private ready = false;
  private pickupTimer?: ReturnType<typeof setInterval>;
  private pickupCode?: string;
  private timer: ReturnType<typeof setInterval>;
  constructor(private send: (message: ClientMessage) => void, private targets: Interactable = {
    nearestDrop: () => null,
    enterPortal: () => {},
    nearestNpc: () => null,
    talkTo: () => {},
    toggleQuestLog: () => {},
  }) {
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    window.addEventListener('blur', this.reset);
    document.addEventListener('visibilitychange', this.visibility);
    document.addEventListener('focusin', this.focus);
    this.timer = setInterval(() => this.emit(false), 150);
  }
  setReady(ready: boolean) { if (this.ready !== ready) this.reset(); this.ready = ready; }
  private blocked() {
    const active = document.activeElement as (Element & { isContentEditable?: boolean }) | null;
    const control = active?.matches?.('input, textarea, select, button, [contenteditable]:not([contenteditable="false"])')
      || active?.closest?.('input, textarea, select, button, [contenteditable]:not([contenteditable="false"])');
    return Boolean(this.targets.isBlocked?.() || control || active?.isContentEditable);
  }
  private direction(): -1 | 0 | 1 {
    const legacy = !this.targets.resolveBinding;
    const right = this.held.has('ArrowRight') || (legacy && this.held.has('KeyD')) || this.heldRight.size > 0;
    const left = this.held.has('ArrowLeft') || (legacy && this.held.has('KeyA')) || this.heldLeft.size > 0;
    const raw = (Number(right) - Number(left)) as -1 | 0 | 1;
    return this.targets.mapDirection?.(raw) ?? raw;
  }
  private vertical(): -1 | 0 | 1 { return (Number(this.held.has('ArrowDown')) - Number(this.held.has('ArrowUp'))) as -1 | 0 | 1; }
  private emit(jump: boolean, force = false) {
    if (!this.ready) return;
    if (!force && this.blocked()) {
      this.releaseBlockedInput();
      return;
    }
    this.send({ type: 'input', seq: ++this.seq, direction: this.direction(), jump, vertical: this.vertical() });
  }
  private releaseBlockedInput() {
    this.releaseChannel();
    this.stopPickup();
    if (!this.held.size) return;
    this.held.clear();
    this.heldLeft.clear();
    this.heldRight.clear();
    this.emit(false, true);
  }
  private pickup = () => {
    if (!this.ready) return;
    if (this.blocked()) { this.releaseBlockedInput(); return; }
    const dropId = this.targets.nearestDrop();
    if (dropId) this.send({ type: 'pickup', requestId: `pickup-${Date.now()}-${++this.pickupSeq}`, dropId });
  };
  private stopPickup() { clearInterval(this.pickupTimer); this.pickupTimer = undefined; this.pickupCode = undefined; }
  private down = (event: KeyboardEvent) => {
    const fixedArrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code);
    const modifierKey = event.code === 'ControlLeft' || event.code === 'ControlRight' || event.code === 'AltLeft' || event.code === 'AltRight';
    if (!this.ready || event.defaultPrevented || event.isComposing || event.metaKey || (event.ctrlKey && !modifierKey && !fixedArrow) || (event.altKey && !modifierKey && !fixedArrow)) return;
    const custom = this.targets.resolveBinding && !fixedArrow ? this.targets.resolveBinding(event.code, event.shiftKey) : undefined;
    if (!this.targets.resolveBinding && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'KeyX', 'KeyZ', 'KeyQ', 'KeyK', ...Object.keys(SHORTCUT_SKILLS)].includes(event.code)) return;
    if (event.code === 'KeyK' && event.ctrlKey) return;
    if (this.blocked()) {
      // A modal window or a focused text control owns the keyboard: clear any
      // movement held before focus moved, and never re-add keys from key
      // repeat while blocked — otherwise the player keeps walking during chat.
      this.releaseBlockedInput();
      return;
    }
    // An explicit empty slot consumes neither browser controls nor movement;
    // leave the event alone so Tab/Enter and other unbound keys remain native.
    if (this.targets.resolveBinding && !fixedArrow && (custom === null || custom === undefined)) return;
    event.preventDefault();
    if (this.targets.resolveBinding && !fixedArrow) {
      if (event.repeat || !custom) return;
      this.handleBinding(custom, event);
      return;
    }
    if (event.code === 'KeyQ' || event.code === 'KeyK') {
      if (event.repeat) return;
      if (event.code === 'KeyK') this.targets.toggleSkills?.();
      else this.targets.toggleQuestLog();
      return;
    }
    if (event.repeat) return;
    const shortcut = shortcutSkill(this.targets.playerState?.()?.job, event.code, event.shiftKey);
    if (SHORTCUT_SKILLS[event.code] !== undefined) {
      if (shortcut !== undefined && this.canCastShortcut(shortcut)) {
        const requestId = this.targets.castSkill?.(shortcut, this.direction(), this.vertical());
        if ([2221011, 2221052].includes(shortcut) && requestId && !this.channel) this.channel = { code: event.code, requestId };
      }
      // Number keys belong to the skill bar even when this job has not learned
      // the mapped skill; never let an unlearned shortcut become movement input.
      return;
    }
    if (event.code === 'Space' && this.castJumpSkill()) return;
    if (event.code === 'KeyZ') {
      if (this.held.has('KeyZ')) return;
      this.held.add('KeyZ');
      this.pickupCode = event.code;
      this.pickup();
      this.pickupTimer = setInterval(this.pickup, 200);
      return;
    }
    this.held.add(event.code);
    if (event.code === 'ArrowUp') {
      // `↑` tries the closest npc first, then falls back to portal entry.
      const npc = this.targets.nearestNpc();
      if (npc) {
        this.targets.talkTo(npc);
      } else {
        this.targets.enterPortal();
      }
    }
    if (['ControlLeft', 'ControlRight', 'KeyX'].includes(event.code)) this.sendAttack();
    else this.emit(event.code === 'Space');
  };
  private handleBinding(binding: KeyBinding, event: KeyboardEvent) {
    if (!binding) return;
    if (binding.type === 'skill') {
      if (this.canCastShortcut(binding.skillId)) {
        const requestId = this.targets.castSkill?.(binding.skillId, this.direction(), this.vertical());
        if ([2221011, 2221052].includes(binding.skillId) && requestId && !this.channel) this.channel = { code: event.code, requestId };
      }
      return;
    }
    if (binding.type === 'item') {
      this.targets.useItem?.(binding.itemId);
      return;
    }
    switch (binding.action) {
      case 'attack': this.sendAttack(); return;
      case 'jump':
        if (!this.castJumpSkill()) {
          this.held.add(event.code);
          this.emit(true);
        }
        return;
      case 'pickup':
        if (this.held.has(event.code)) return;
        this.held.add(event.code);
        this.pickupCode = event.code;
        this.pickup();
        this.pickupTimer = setInterval(this.pickup, 200);
        return;
      case 'talk': {
        const npc = this.targets.nearestNpc();
        if (npc) this.targets.talkTo(npc);
        else this.targets.enterPortal();
        return;
      }
      case 'skills': this.targets.toggleSkills?.(); return;
      case 'quests': this.targets.toggleQuestLog(); return;
      case 'left':
        this.held.add(event.code);
        this.heldLeft.add(event.code);
        this.emit(false);
        return;
      case 'right':
        this.held.add(event.code);
        this.heldRight.add(event.code);
        this.emit(false);
        return;
      default: this.targets.performAction?.(binding.action); return;
    }
  }
  /**
   * A normal swing doubles as the map-reactor interaction, exactly like the
   * original: standing next to a flower and attacking shakes it.  Only the
   * intent is sent — the server decides range, whether the prop is still
   * usable, and the resulting state, so a client cannot skip an animation or
   * harvest a prop twice.
   */
  private sendAttack() {
    const reactorId = this.targets.nearestReactor?.();
    if (reactorId && this.targets.hitReactor) {
      this.targets.hitReactor(reactorId);
      return;
    }
    this.send({ type: 'attack', requestId: `attack-${Date.now()}-${++this.attackSeq}` });
  }
  private castJumpSkill() {
    if (this.targets.basicMovementOnly?.()) return false;
    if (!this.targets.castSkill) return false;
    const player = this.targets.playerState?.();
    if (!player || player.job === undefined || !MAGE_JOB_WHITELIST.has(player.job) || !player.skills) return false;
    const waveLevel = player.skills['2001011'] ?? 0;
    // While swimming the body is never grounded, but the jump key must still
    // swim/jump rather than cast: routing it to the air-float skill here made
    // the mage unable to act in water (and the server then rejected the cast
    // with skill_cooldown).
    if (player.swimming) return false;
    // Same for climbing: a body on a ladder/rope is never grounded, and the
    // air-float cast swallowed the jump key entirely, so the mage could never
    // hop off the rope. The server detaches climbing bodies on jump+direction.
    if (player.climbing) return false;
    if (!player.grounded) {
      if (waveLevel <= 0 || (player.skills['2001012'] ?? 0) <= 0) return false;
      this.targets.castSkill(2001012, this.direction(), this.vertical());
      return true;
    }
    if (this.held.has('ArrowUp') && waveLevel > 0) {
      this.targets.castSkill(2001011, this.direction(), this.vertical());
      return true;
    }
    return false;
  }
  private canCastShortcut(skillId: number) {
    const player = this.targets.playerState?.();
    if (!player || player.hp <= 0 || player.action === 'dead' || !player.skills) return false;
    // 书准入统一走 BOOK_JOBS：书号从 skillId 派生，三个分支（火毒 210/冰雷 220/僧侶 230）
    // 一视同仁。早先按 `skillId >= 2200000` 分段把 23xxxxx 也算进了冰雷区间。
    const jobAllowed = bookAllowsJob(bookIdForSkill(skillId), player.job);
    return jobAllowed && (player.skills[String(skillId)] ?? 0) > 0;
  }
  private up = (event: KeyboardEvent) => {
    if (this.channel?.code === event.code) this.releaseChannel();
    if (this.blocked()) { this.releaseBlockedInput(); return; }
    if (this.pickupCode === event.code) this.stopPickup();
    if (this.held.delete(event.code)) {
      this.heldLeft.delete(event.code);
      this.heldRight.delete(event.code);
      event.preventDefault();
      this.emit(false);
    }
  };
  private releaseChannel() {
    if (this.channel) this.send({ type: 'releaseSkill', requestId: this.channel.requestId });
    this.channel = undefined;
  }
  reset = () => { this.releaseChannel(); this.stopPickup(); this.held.clear(); this.heldLeft.clear(); this.heldRight.clear(); this.emit(false, true); };
  /** Losing input focus is not leaving the game: the window may simply be
   *  unfocused while still visible.  Only hidden pages start an away window,
   *  so a second monitor or a side-by-side window is not misread as absence. */
  private visibility = () => { if (document.hidden) this.reset(); };
  private focus = () => { if (this.blocked()) this.reset(); };
  destroy() { this.reset(); clearInterval(this.timer); window.removeEventListener('keydown', this.down); window.removeEventListener('keyup', this.up); window.removeEventListener('blur', this.reset); document.removeEventListener('visibilitychange', this.visibility); document.removeEventListener('focusin', this.focus); }
}
