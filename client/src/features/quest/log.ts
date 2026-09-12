import type { QuestLogEntry } from '../../../../shared/protocol';
import { uiLocale, displayText } from '../../app/i18n';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { installWindowDrag } from '../ui/window-shell.ts';

/**
 * Authored title strip of the Quest.img window.  The list frame is placed at
 * `questLayout.listLT` (y70) and the close sprite sits in the top row, so the
 * source reserves the first 21 px — the same height every other TMS273 window
 * uses.  The CSS-only fallback panel is titlebar-styled instead and drags by
 * its own 32 px header.
 */
const SOURCE_TITLE_HEIGHT = 21;
const FALLBACK_TITLE_HEIGHT = 32;
const CLOSE_STATES = ['normal', 'mouseOver', 'pressed', 'disabled'] as const;

/**
 * Quest log window.  The server owns the authoritative entries (status /
 * progress are persisted there) and pushes the localized display text
 * (questList after every join, questUpdate on transitions) resolved from the
 * offline `shared/quest-text.json` corpus in the player's language.  This
 * panel only renders what the server sent; it carries no translation table.
 * The window uses the TMS273 Quest.img list frame and authored content bounds;
 * opening is a hotkey (Q) so the log never needs its own world-space layout.
 *
 * Window chrome follows `docs/technical/UI_WINDOW_SYSTEM.md`: the frame drags by its title
 * strip, the close sprite carries all four authored states, and Escape closes
 * the log — the tracker moves the same way and answers a plain click by
 * opening the log.
 */
export class QuestLogView {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly badge: HTMLSpanElement;
  private readonly tracker: HTMLButtonElement;
  private readonly entries = new Map<string, QuestLogEntry>();
  private openState = false;
  private hasSourceFrame = false;
  private dragDispose?: () => void;
  private trackerDispose?: () => void;
  private closeStates?: Partial<Record<(typeof CLOSE_STATES)[number], AssetFrame>>;

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (!this.openState || event.defaultPrevented || event.repeat) return;
    if (event.key !== 'Escape' && event.code !== 'Escape') return;
    const target = event.target;
    if (target instanceof Element && target.matches('input,textarea,select,[contenteditable="true"]')) return;
    event.preventDefault();
    this.close();
  };

  constructor(private host: HTMLElement, manifest: Manifest) {
    this.root = document.createElement('div');
    this.root.className = 'quest-log';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'false');

    const title = document.createElement('div');
    title.className = 'quest-log-title';
    const label = document.createElement('span');
    label.textContent = uiLocale() === 'en' ? 'Quest Log' : '任务日志';
    this.badge = document.createElement('span');
    this.badge.className = 'quest-log-badge';
    this.badge.setAttribute('aria-live', 'polite');
    title.append(label, this.badge);

    this.body = document.createElement('div');
    this.body.className = 'quest-log-body';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'quest-log-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', uiLocale() === 'en' ? 'Close quest log' : '关闭任务日志');
    close.title = uiLocale() === 'en' ? 'Close' : '关闭';
    close.addEventListener('click', () => this.close());

    this.root.append(title, this.body, close);
    const source = manifest.questUi?.backgrnd, layout = manifest.questLayout;
    if (source && layout) {
      this.hasSourceFrame = true;
      this.root.classList.add('tms-quest-log');
      Object.assign(this.root.style, { width: `${source.width}px`, height: `${source.height}px`, backgroundImage: `url("${source.url}")` });
      Object.assign(this.body.style, { left: `${layout.listLT.x}px`, top: `${layout.listLT.y}px`, width: `${layout.listRB.x-layout.listLT.x}px`, height: `${layout.listRB.y-layout.listLT.y}px` });
      this.closeStates = Object.fromEntries(CLOSE_STATES.map(state => [
        state,
        manifest.questUi?.[`button:close/${state}/0`],
      ])) as typeof this.closeStates;
      const normal = this.closeStates?.normal;
      if (normal) {
        close.textContent = '';
        Object.assign(close.style, { left: `${normal.x}px`, top: `${normal.y}px`, width: `${normal.width}px`, height: `${normal.height}px`, backgroundImage: `url("${normal.url}")` });
        this.bindCloseStates(close, normal);
      }
    }
    this.tracker = document.createElement('button');
    this.tracker.type = 'button';
    this.tracker.className = 'quest-tracker';
    this.tracker.title = '打开任务日志（Q）';
    this.tracker.addEventListener('click', () => this.open());
    this.host.append(this.root, this.tracker);

    this.dragDispose = installWindowDrag(this.host, this.root, {
      titleHeight: () => this.hasSourceFrame ? SOURCE_TITLE_HEIGHT : FALLBACK_TITLE_HEIGHT,
      isOpen: () => this.openState,
    });
    // The tracker *is* a button, so it opts out of the "never drag on a
    // button" gate; the built-in activation distance keeps a plain click on it
    // opening the log instead of nudging the strip by a pixel.
    this.trackerDispose = installWindowDrag(this.host, this.tracker, {
      titleHeight: () => this.tracker.getBoundingClientRect().height,
      isOpen: () => !this.tracker.hidden,
      allowOnButtons: true,
      onActivate: () => { this.tracker.style.right = 'auto'; },
    });
    document.addEventListener('keydown', this.handleKeyDown, true);
    this.render();
  }

  /** Four authored close states; the source ships normal/mouseOver/pressed/disabled. */
  private bindCloseStates(button: HTMLButtonElement, normal: AssetFrame) {
    const show = (state: (typeof CLOSE_STATES)[number]) => {
      const frame = this.closeStates?.[state] ?? normal;
      button.style.backgroundImage = `url("${frame.url}")`;
      button.dataset.state = state;
    };
    button.addEventListener('pointerenter', () => show('mouseOver'));
    button.addEventListener('pointerleave', () => show('normal'));
    button.addEventListener('pointerdown', () => show('pressed'));
    button.addEventListener('pointerup', () => show('normal'));
    button.addEventListener('pointercancel', () => show('normal'));
  }

  setList(quests: QuestLogEntry[]) {
    this.entries.clear();
    for (const entry of quests) this.entries.set(entry.questId, entry);
    this.render();
  }

  clear() {
    this.entries.clear();
    this.close();
    this.render();
  }

  upsert(entry: QuestLogEntry) {
    this.entries.set(entry.questId, entry);
    this.render();
  }

  toggle(): boolean {
    this.openState = !this.openState;
    this.apply();
    return this.openState;
  }

  open() {
    this.openState = true;
    this.apply();
  }

  close() {
    this.openState = false;
    this.apply();
  }

  isOpen() {
    return this.openState;
  }

  /** Number of in-progress quests, shown to the player as a small hint. */
  activeCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.status === 'active' || entry.status === 'objectivesComplete') count += 1;
    return count;
  }

  destroy() {
    document.removeEventListener('keydown', this.handleKeyDown, true);
    this.dragDispose?.();
    this.dragDispose = undefined;
    this.trackerDispose?.();
    this.trackerDispose = undefined;
    this.root.remove();
    this.tracker.remove();
  }

  private apply() {
    this.root.hidden = !this.openState;
    this.render();
  }

  private render() {
    this.body.replaceChildren();
    const list = [...this.entries.values()]
      .map(entry => ({ entry, displayName: this.localize(entry).name }))
      .sort((a, b) => this.priority(a.entry) - this.priority(b.entry) || a.displayName.localeCompare(b.displayName))
      .map(item => item.entry);
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'quest-log-empty';
      empty.textContent = uiLocale() === 'en'
        ? 'No quests yet. Talk to the marked travellers to get started.'
        : '还没有任务。与岛上的旅行者交谈，接受任务吧。';
      this.body.append(empty);
    }
    for (const entry of list) {
      const row = document.createElement('article');
      row.className = `quest-log-row quest-log-${entry.status}`;
      const head = document.createElement('div');
      head.className = 'quest-log-head';
      const name = document.createElement('strong');
      const localized = this.localize(entry);
      name.textContent = localized.name;
      const chip = document.createElement('span');
      chip.className = 'quest-log-status';
      chip.textContent = this.statusLabel(entry);
      head.append(name, chip);
      const summary = document.createElement('p');
      summary.textContent = localized.summary;
      row.append(head, summary);
      for (const objective of entry.objectives ?? []) {
        const progress = document.createElement('p');
        progress.textContent = `${displayText(objective.text)} ${objective.current} / ${objective.required}`;
        row.append(progress);
      }
      if (entry.nextAction || entry.blockReason) {
        const next = document.createElement('p');
        next.className = 'quest-next';
        next.textContent = displayText(entry.blockReason || entry.nextAction || '');
        row.append(next);
      }
      this.body.append(row);
    }
    const tracked = list.find(entry => entry.status !== 'completed');
    this.tracker.hidden = !tracked || this.openState;
    if (tracked) this.tracker.textContent = `${this.statusLabel(tracked)} · ${displayText(tracked.name)}
${displayText(tracked.blockReason || tracked.nextAction || tracked.summary)}${(tracked.objectives ?? []).map(o => `
${displayText(o.text)} ${o.current}/${o.required}`).join('')}
任务日志（Q）`;
    const active = this.activeCount();
    this.badge.hidden = !active;
    this.badge.textContent = uiLocale() === 'en' ? `${active} active` : `${active} 个进行中`;
  }

  /**
   * Display text is authoritative from the server (already localized to the
   * player's language server-side, with en -> id fallbacks).  The only local
   * guard is a blank-name fallback to the quest id so a row can never be
   * rendered without a title.
   */
  private priority(entry: QuestLogEntry): number {
    return { objectivesComplete: 0, active: 1, available: 2, completed: 3 }[entry.status];
  }

  private statusLabel(entry: QuestLogEntry): string {
    const labels = uiLocale() === 'en'
      ? { available: 'Available', active: 'In progress', objectivesComplete: 'Ready to claim', completed: 'Claimed' }
      : { available: '可接取', active: '进行中', objectivesComplete: '可交付', completed: '已领奖' };
    return labels[entry.status];
  }

  private localize(entry: QuestLogEntry) {
    return {
      name: displayText(entry.name || entry.questId),
      summary: displayText(entry.summary),
    };
  }
}
