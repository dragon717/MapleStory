import type { ClientMessage, NpcState, PlayerState } from '../../../../shared/protocol';

const MAGE_JOB_WHITELIST = new Set([200, 210, 211, 212, 220, 221, 222, 230, 231, 232]);
const ICE_LIGHTNING_JOB_WHITELIST = new Set([220, 221, 222]);
export const SHORTCUT_SKILLS: Readonly<Record<string, number>> = {
  Digit1: 2001008, Numpad1: 2001008, Digit2: 2001009, Numpad2: 2001009, Digit3: 2001002, Numpad3: 2001002,
  Digit4: 2201008, Numpad4: 2201008, Digit5: 2201005, Numpad5: 2201005, Digit6: 2201001, Numpad6: 2201001, Digit7: 2201009, Numpad7: 2201009,
  Digit8: 2211002, Numpad8: 2211002, Digit9: 2211014, Numpad9: 2211014, Digit0: 2211011, Numpad0: 2211011,
};
export const FOURTH_SHORTCUT_SKILLS: Readonly<Record<string, number>> = {
  Digit1: 2221006, Digit2: 2221012, Digit3: 2221007, Digit4: 2221004,
  Digit5: 2221005, Digit6: 2221011, Digit7: 2221008, Digit8: 2221000, Digit9: 2221052, Digit0: 2221054,
};

/** Shared by keyboard input and the HUD; these are the project's current bindings. */
export function shortcutSkill(job: number | undefined, code: string, shift = false): number | undefined {
  const digit = code.replace('Numpad', 'Digit');
  if (shift && job === 222) return FOURTH_SHORTCUT_SKILLS[digit];
  if (job === 0) return ({ Digit1: 1000, Digit2: 1001, Digit3: 1002 } as Record<string, number>)[digit];
  return SHORTCUT_SKILLS[digit];
}

interface Interactable {
  nearestDrop: () => string | null;
  enterPortal: () => void;
  nearestNpc: () => NpcState | null;
  talkTo: (npc: NpcState) => void;
  toggleQuestLog: () => void;
  toggleSkills?: () => void;
  /** Send a server-owned skill intent; this input layer never applies damage or MP. */
  castSkill?: (skillId: number, direction?: -1 | 0 | 1, vertical?: -1 | 0 | 1) => string | void;
  /** Latest authoritative self state, used only to distinguish grounded jump from air float. */
  playerState?: () => PlayerState | undefined;
  /** UI-owned modal state; prevents gameplay input from crossing the window boundary. */
  isBlocked?: () => boolean;
}

export class PlayerInput {
  private held = new Set<string>();
  private channel?: { code: string; requestId: string };
  private seq = 0;
  private attackSeq = 0;
  private pickupSeq = 0;
  private ready = false;
  private pickupTimer?: ReturnType<typeof setInterval>;
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
  private direction(): -1 | 0 | 1 { return (Number(this.held.has('ArrowRight') || this.held.has('KeyD')) - Number(this.held.has('ArrowLeft') || this.held.has('KeyA'))) as -1 | 0 | 1; }
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
    this.emit(false, true);
  }
  private pickup = () => {
    if (!this.ready) return;
    if (this.blocked()) { this.releaseBlockedInput(); return; }
    const dropId = this.targets.nearestDrop();
    if (dropId) this.send({ type: 'pickup', requestId: `pickup-${Date.now()}-${++this.pickupSeq}`, dropId });
  };
  private stopPickup() { clearInterval(this.pickupTimer); this.pickupTimer = undefined; }
  private down = (event: KeyboardEvent) => {
    if (!this.ready || event.defaultPrevented || event.isComposing || event.metaKey || event.altKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'KeyX', 'KeyZ', 'KeyQ', 'KeyK', ...Object.keys(SHORTCUT_SKILLS)].includes(event.code)) return;
    if (event.code === 'KeyK' && event.ctrlKey) return;
    if (this.blocked()) {
      // A modal window or a focused text control owns the keyboard: clear any
      // movement held before focus moved, and never re-add keys from key
      // repeat while blocked — otherwise the player keeps walking during chat.
      this.releaseBlockedInput();
      return;
    }
    event.preventDefault();
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
    if (['ControlLeft', 'ControlRight', 'KeyX'].includes(event.code)) this.send({ type: 'attack', requestId: `attack-${Date.now()}-${++this.attackSeq}` });
    else this.emit(event.code === 'Space');
  };
  private castJumpSkill() {
    if (!this.targets.castSkill) return false;
    const player = this.targets.playerState?.();
    if (!player || player.job === undefined || !MAGE_JOB_WHITELIST.has(player.job) || !player.skills) return false;
    const waveLevel = player.skills['2001011'] ?? 0;
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
    const jobAllowed = skillId >= 1000 && skillId <= 1002 ? player.job === 0 || MAGE_JOB_WHITELIST.has(player.job ?? -1) : skillId >= 2220000 ? player.job === 222 : skillId >= 2210000 ? [221, 222].includes(player.job ?? -1) : skillId >= 2200000 ? ICE_LIGHTNING_JOB_WHITELIST.has(player.job ?? -1) : MAGE_JOB_WHITELIST.has(player.job ?? -1);
    return jobAllowed && (player.skills[String(skillId)] ?? 0) > 0;
  }
  private up = (event: KeyboardEvent) => {
    if (this.channel?.code === event.code) this.releaseChannel();
    if (this.blocked()) { this.releaseBlockedInput(); return; }
    if (event.code === 'KeyZ') this.stopPickup();
    if (this.held.delete(event.code)) { event.preventDefault(); this.emit(false); }
  };
  private releaseChannel() {
    if (this.channel) this.send({ type: 'releaseSkill', requestId: this.channel.requestId });
    this.channel = undefined;
  }
  reset = () => { this.releaseChannel(); this.stopPickup(); this.held.clear(); this.emit(false, true); };
  private visibility = () => { if (document.hidden) this.reset(); };
  private focus = () => { if (this.blocked()) this.reset(); };
  destroy() { this.reset(); clearInterval(this.timer); window.removeEventListener('keydown', this.down); window.removeEventListener('keyup', this.up); window.removeEventListener('blur', this.reset); document.removeEventListener('visibilitychange', this.visibility); document.removeEventListener('focusin', this.focus); }
}
