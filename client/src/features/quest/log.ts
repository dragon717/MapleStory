import type { QuestLogEntry } from '../../../../shared/protocol';
import { uiLocale, displayText } from '../../app/i18n';
import type { Manifest } from '../../assets/manifest';

/**
 * Quest log window.  The server owns the authoritative entries (status /
 * progress are persisted there) and pushes the localized display text
 * (questList after every join, questUpdate on transitions) resolved from the
 * offline `shared/quest-text.json` corpus in the player's language.  This
 * panel only renders what the server sent; it carries no translation table.
 * The window uses the TMS273 Quest.img list frame and authored content bounds;
 * opening is a hotkey (Q) so the log never needs its own world-space layout.
 */
export class QuestLogView {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly badge: HTMLSpanElement;
  private readonly entries = new Map<string, QuestLogEntry>();
  private openState = false;

  constructor(private host: HTMLElement, manifest: Manifest) {
    this.root = document.createElement('div');
    this.root.className = 'quest-log';
    this.root.hidden = true;

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
    close.addEventListener('click', () => this.close());

    this.root.append(title, this.body, close);
    const source = manifest.questUi?.backgrnd, layout = manifest.questLayout;
    if (source && layout) {
      this.root.classList.add('tms-quest-log');
      Object.assign(this.root.style, { width: `${source.width}px`, height: `${source.height}px`, backgroundImage: `url("${source.url}")` });
      Object.assign(this.body.style, { left: `${layout.listLT.x}px`, top: `${layout.listLT.y}px`, width: `${layout.listRB.x-layout.listLT.x}px`, height: `${layout.listRB.y-layout.listLT.y}px` });
      const closeFrame = manifest.questUi?.['button:close/normal/0'];
      if (closeFrame) {
        close.textContent = '';
        Object.assign(close.style, { left: `${closeFrame.x}px`, top: `${closeFrame.y}px`, width: `${closeFrame.width}px`, height: `${closeFrame.height}px`, backgroundImage: `url("${closeFrame.url}")` });
      }
    }
    this.host.append(this.root);
    this.render();
  }

  setList(quests: QuestLogEntry[]) {
    this.entries.clear();
    for (const entry of quests) this.entries.set(entry.questId, entry);
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
    for (const entry of this.entries.values()) if (entry.status === 'active') count += 1;
    return count;
  }

  destroy() {
    this.root.remove();
  }

  private apply() {
    this.root.hidden = !this.openState;
    if (this.openState) this.render();
  }

  private render() {
    this.body.replaceChildren();
    const list = [...this.entries.values()]
      .map(entry => ({ entry, displayName: this.localize(entry).name }))
      .sort((a, b) => Number(b.entry.status === 'active') - Number(a.entry.status === 'active') || a.displayName.localeCompare(b.displayName))
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
      chip.textContent = uiLocale() === 'en'
        ? (entry.status === 'active' ? 'In progress' : 'Completed')
        : (entry.status === 'active' ? '进行中' : '已完成');
      head.append(name, chip);
      const summary = document.createElement('p');
      summary.textContent = localized.summary;
      row.append(head, summary);
      this.body.append(row);
    }
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
  private localize(entry: QuestLogEntry) {
    return {
      name: displayText(entry.name || entry.questId),
      summary: displayText(entry.summary),
    };
  }
}
