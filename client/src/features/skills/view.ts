import type { ClientMessage, PlayerState, RegenerationPassive } from '../../../../shared/protocol';
import type { SkillArt, SkillCatalogEntry, SkillWindowData, Manifest } from '../../assets/manifest';
import { displayText } from '../../app/i18n';
import { SHORTCUT_SKILLS, FOURTH_SHORTCUT_SKILLS } from '../player/input';
import './style.css';

type SkillBook = { name: string; tabIndex: number };
type SkillMetric = 'mpCon' | 'damage' | 'mobCount' | 'attackCount';
type SkillRequest = Extract<ClientMessage, { type: 'learnSkill' | 'castSkill' | 'releaseSkill' | 'resetHyper' }>;

export interface SkillViewOptions {
  send?: (message: SkillRequest) => boolean;
  status?: (message: string) => void;
}

const BOTTOM_BUTTONS: ReadonlyArray<readonly [string, string]> = [
  ['BtHyper', '超级技能'],
  ['BtGuildSkill', '公会技能'],
  ['BtRide', '骑宠'],
  ['BtSequence', '技能顺序'],
  ['BtMacro', '技能指令'],
];

const METRICS: ReadonlyArray<readonly [SkillMetric, string, string]> = [
  ['mpCon', '消耗 MP', ''],
  ['damage', '伤害倍率', '%'],
  ['mobCount', '目标数', ''],
  ['attackCount', '攻击段数', ''],
];

const ACTIVE_SKILLS = new Set(['2221045', '2221052', '2221053', '2221054', '1000', '1001', '1002', '2001002', '2001008', '2001009', '2001011', '2001012', '2201001', '2201005', '2201008', '2201009', '2211002', '2211007', '2211011', '2211012', '2211014', '2211017', '2221000', '2221004', '2221005', '2221006', '2221007', '2221008', '2221011', '2221012']);
const TOGGLE_SKILLS = new Set(['2221045', '2221054', '2001002', '2201009', '2211007', '2211017']);
const FIXED_SKILLS = new Set(['2200011', '2220015']);
const MAGE_JOB_WHITELIST = new Set([200, 210, 211, 212, 220, 221, 222, 230, 231, 232]);
const ICE_LIGHTNING_JOB_WHITELIST = new Set([220, 221, 222]);

/**
 * Source-backed TMS273 skill directory and detail view.
 * Learning and casting remain server intents; the client only renders the
 * authoritative snapshot and sends a request after the local affordance check.
 */
export class SkillView {
  private readonly manifest: Manifest;
  private readonly data?: SkillWindowData;
  private readonly root: HTMLDivElement;
  private readonly window: HTMLDivElement;
  private readonly tabs: HTMLElement;
  private readonly listView: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly bookLabel: HTMLSpanElement;
  private readonly detailView: HTMLDivElement;
  private readonly bottom: HTMLDivElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly skillPointValue = document.createElement('span');
  private readonly send: (message: SkillRequest) => boolean;
  private readonly status: (message: string) => void;
  private player?: PlayerState;
  private hasPlayerSnapshot = false;
  private selectedBookId?: string;
  private hyperMode = false;
  private hyperKind = 1;
  private selectedSkillId?: string;
  private openState = false;
  private destroyed = false;
  private requestSequence = 0;
  private channelRequestId?: string;
  releaseChannel = () => {
    if (this.channelRequestId) this.send({ type: 'releaseSkill', requestId: this.channelRequestId });
    this.channelRequestId = undefined;
  };
  private releaseChannelKey = (event: KeyboardEvent) => {
    if (event.code === 'Space' || event.code === 'Enter') this.releaseChannel();
  };
  private releaseHiddenChannel = () => { if (document.hidden) this.releaseChannel(); };
  private releaseOutsideChannel = (event: FocusEvent) => {
    if (event.target instanceof Node && !this.window.contains(event.target)) this.releaseChannel();
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (!this.openState || event.defaultPrevented || event.repeat || event.isComposing || event.metaKey || event.altKey || event.ctrlKey) return;
    const target = event.target;
    if (target instanceof Element && target.matches('input,textarea,select,[contenteditable="true"]')) return;
    const key = event.code === 'KeyK' || event.key.toLowerCase() === 'k';
    if (key || event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  };

  constructor(host: HTMLElement, manifest: Manifest, options: SkillViewOptions = {}) {
    this.manifest = manifest;
    this.data = manifest.skillWindow;
    this.send = options.send ?? (() => false);
    this.status = options.status ?? (() => {});
    this.root = document.createElement('div');
    this.root.className = 'tms273-skill-host';
    this.root.hidden = true;
    this.root.dataset.open = 'false';

    this.window = document.createElement('div');
    this.window.className = 'skill-window';
    this.window.setAttribute('role', 'dialog');
    this.window.setAttribute('aria-modal', 'false');
    this.window.setAttribute('aria-label', '技能');
    this.window.tabIndex = -1;
    this.window.style.setProperty('--skill-window-width', `${this.data?.width ?? 318}px`);
    this.window.style.setProperty('--skill-window-height', `${this.data?.height ?? 361}px`);
    this.root.append(this.window);
    host.append(this.root);

    this.appendBackgrounds();
    this.appendSkillPoint();

    this.tabs = document.createElement('nav');
    this.tabs.className = 'skill-tabs';
    this.tabs.setAttribute('aria-label', '技能书');
    this.tabs.setAttribute('role', 'tablist');
    this.window.append(this.tabs);

    this.closeButton = this.createCloseButton();
    this.window.append(this.closeButton);

    this.listView = document.createElement('div');
    this.listView.className = 'skill-list-view';
    this.bookLabel = document.createElement('span');
    this.bookLabel.className = 'skill-book-label';
    this.window.append(this.bookLabel);
    this.list = document.createElement('div');
    this.list.className = 'skill-list';
    this.list.setAttribute('role', 'list');
    this.listView.append(this.list);
    this.window.append(this.listView);

    this.detailView = document.createElement('div');
    this.detailView.className = 'skill-detail-view';
    this.detailView.hidden = true;
    this.window.append(this.detailView);

    this.bottom = document.createElement('div');
    this.bottom.className = 'skill-bottom-actions';
    this.appendBottomButtons();
    this.window.append(this.bottom);

    this.selectedBookId = this.books()[0]?.[0];
    document.addEventListener('keydown', this.handleKeyDown, true);
    window.addEventListener('pointerup', this.releaseChannel);
    window.addEventListener('pointercancel', this.releaseChannel);
    window.addEventListener('keyup', this.releaseChannelKey);
    window.addEventListener('blur', this.releaseChannel);
    document.addEventListener('visibilitychange', this.releaseHiddenChannel);
    document.addEventListener('focusin', this.releaseOutsideChannel);
    this.render();
  }

  update(player?: PlayerState) {
    if (this.destroyed) return;
    const changed = !this.hasPlayerSnapshot
      || !sameSkills(this.player?.skills, player?.skills)
      || !sameSkills(this.player?.skillPoints, player?.skillPoints)
      || !sameSkills(this.player?.hyperPoints, player?.hyperPoints)
      || this.player?.hyperResetCost !== player?.hyperResetCost
      || this.player?.mesos !== player?.mesos
      || this.player?.level !== player?.level
      || this.player?.job !== player?.job
      || this.castUiKey(this.player) !== this.castUiKey(player);
    this.player = player;
    if (!player || player.hp <= 0) this.releaseChannel();
    this.hasPlayerSnapshot = true;
    if (changed) this.renderPreservingViewport();
  }

  open() {
    if (this.destroyed) return;
    this.openState = true;
    this.root.hidden = false;
    this.root.dataset.open = 'true';
    this.window.hidden = false;
    this.render();
    requestAnimationFrame(() => {
      const target = this.selectedSkillId
        ? this.detailView.querySelector<HTMLElement>('.skill-detail-back')
        : this.tabs.querySelector<HTMLElement>('[aria-selected="true"]');
      (target ?? this.closeButton ?? this.window).focus({ preventScroll: true });
    });
  }

  toggle(): boolean {
    if (this.destroyed) return false;
    if (this.openState) this.close();
    else this.open();
    return true;
  }

  close() {
    this.releaseChannel();
    const wasOpen = this.openState;
    this.openState = false;
    this.root.hidden = true;
    this.root.dataset.open = 'false';
    this.window.hidden = true;
    if (wasOpen) this.focusGame();
  }

  isOpen(): boolean {
    return this.openState;
  }

  clear() {
    if (this.destroyed) return;
    this.player = undefined;
    this.selectedSkillId = undefined;
    this.close();
    this.render();
  }

  destroy() {
    if (this.destroyed) return;
    this.releaseChannel();
    this.destroyed = true;
    document.removeEventListener('keydown', this.handleKeyDown, true);
    window.removeEventListener('pointerup', this.releaseChannel);
    window.removeEventListener('pointercancel', this.releaseChannel);
    window.removeEventListener('keyup', this.releaseChannelKey);
    window.removeEventListener('blur', this.releaseChannel);
    document.removeEventListener('visibilitychange', this.releaseHiddenChannel);
    document.removeEventListener('focusin', this.releaseOutsideChannel);
    this.root.remove();
  }

  private appendBackgrounds() {
    for (const [key, art] of Object.entries(this.data?.backgrounds ?? {})) {
      this.appendArt(this.window, art, `skill-window-background skill-window-background-${key}`);
    }
    // Keep the original bottom edge when the web viewport shortens the window.
    const frame = this.data?.backgrounds.backgrnd;
    if (frame) this.appendArt(this.window, frame, 'skill-window-bottom-cap');
  }

  private appendSkillPoint() {
    const art = this.data?.skillPoint;
    if (!art) return;
    this.appendArt(this.window, art, 'skill-point-art');
    this.skillPointValue.className = 'skill-point-value';
    this.skillPointValue.textContent = '—';
    this.skillPointValue.setAttribute('aria-label', '技能点未知');
    this.window.append(this.skillPointValue);
  }

  private appendBottomButtons() {
    this.bottom.replaceChildren();
    if (this.hyperMode) {
      const back = this.createTextActionButton('普通技能', '返回普通技能', () => {
        this.hyperMode = false; this.selectedSkillId = undefined; this.render();
      }, 'skill-hyper-bottom');
      const reset = this.createTextActionButton('重置', '重置超级技能点', () => this.resetHyper(), 'skill-hyper-bottom');
      reset.dataset.hyperControl = 'reset';
      back.dataset.hyperControl = 'back';
      reset.disabled = !this.player || !(this.player.hyperResetCost && this.player.mesos >= this.player.hyperResetCost)
        || ![...this.catalog().values()].some(entry => entry.hyper && (this.learnedLevel(entry.id) ?? 0) > 0);
      reset.title = `重置费用：${this.player?.hyperResetCost?.toLocaleString() ?? '—'} 枫币`;
      this.bottom.append(reset, back);
      return;
    }
    for (const [key, label] of BOTTOM_BUTTONS) {
      const states = this.data?.buttons?.[key];
      const art = states?.normal ?? states?.disabled;
      if (!art) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `skill-bottom-button skill-bottom-button-${key}`;
      button.disabled = key !== 'BtHyper' || this.player?.job !== 222 || this.player.level < 140;
      if (key === 'BtHyper') {
        button.addEventListener('click', () => {
          this.hyperMode = true; this.selectedBookId = '222'; this.selectedSkillId = undefined; this.render();
        });
      }
      button.setAttribute('aria-label', label);
      button.title = key === 'BtHyper' && button.disabled ? '140级冰雷魔导师可学习超级技能' : label;
      button.style.left = `${art.x}px`;
      button.style.top = `${art.y}px`;
      button.style.width = `${art.width}px`;
      button.style.height = `${art.height}px`;
      this.appendArt(button, button.disabled ? states?.disabled ?? art : art, 'skill-bottom-button-art', true);
      button.dataset.button = key;
      this.bottom.append(button);
    }
  }

  private createCloseButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'skill-window-close';
    button.setAttribute('aria-label', '关闭技能窗口');
    button.title = '关闭';
    button.addEventListener('click', () => this.close());
    const art = this.manifest.closeButton?.['normal/0'];
    if (art) this.appendArt(button, art, 'skill-window-close-art', true);
    else button.textContent = '×';
    return button;
  }

  private appendArt(parent: HTMLElement, art: SkillArt, className: string, local = false) {
    const image = document.createElement('img');
    image.className = `skill-art ${className}`;
    image.src = art.url;
    image.alt = '';
    image.width = art.width;
    image.height = art.height;
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    Object.assign(image.style, {
      left: `${local ? 0 : art.x}px`, top: `${local ? 0 : art.y}px`, width: `${art.width}px`, height: `${art.height}px`,
    });
    parent.append(image);
    return image;
  }

  private render() {
    if (this.destroyed) return;
    if (this.player?.job !== 222) this.hyperMode = false;
    this.window.dataset.hyper = String(this.hyperMode);
    this.appendBottomButtons();
    const books = this.books();
    if (!this.selectedBookId || !books.some(([id]) => id === this.selectedBookId)) this.selectedBookId = books.find(([id]) => id === String(this.player?.job))?.[0] ?? books[0]?.[0];
    this.renderSkillPoint();
    this.renderTabs(books);
    const visible = this.visibleSkills(this.selectedBookId);
    if (!this.selectedSkillId || !visible.some(skill => skill.id === this.selectedSkillId)) {
      this.selectedSkillId = undefined;
      this.showList();
      this.renderList(visible);
    } else {
      this.listView.hidden = true;
      this.detailView.hidden = false;
      this.renderDetail(this.catalog().get(this.selectedSkillId)!);
    }
  }

  private renderPreservingViewport() {
    const active = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)
      ? document.activeElement
      : undefined;
    const activeHyper = active?.dataset.hyperControl;
    const activeBookId = active?.dataset.bookId;
    const activeSkillId = active?.dataset.skillId;
    const wasClose = active === this.closeButton;
    const wasDetailBack = active?.classList.contains('skill-detail-back') ?? false;
    const listScroll = this.list.scrollTop;
    const detailScroll = this.detailView.scrollTop;
    this.render();
    this.list.scrollTop = listScroll;
    this.detailView.scrollTop = detailScroll;
    if (wasClose) this.closeButton.focus({ preventScroll: true });
    else if (activeHyper) Array.from(this.window.querySelectorAll<HTMLElement>('[data-hyper-control]')).find(node => node.dataset.hyperControl === activeHyper)?.focus({ preventScroll: true });
    else if (activeBookId) this.focusDataNode(this.tabs, 'bookId', activeBookId);
    else if (activeSkillId) this.focusDataNode(this.list, 'skillId', activeSkillId);
    else if (wasDetailBack) this.detailView.querySelector<HTMLElement>('.skill-detail-back')?.focus({ preventScroll: true });
  }

  private focusDataNode(parent: ParentNode, key: 'bookId' | 'skillId', value: string) {
    const node = Array.from(parent.querySelectorAll<HTMLElement>('[data-book-id],[data-skill-id]'))
      .find(candidate => candidate.dataset[key] === value);
    node?.focus({ preventScroll: true });
  }

  private renderTabs(books: Array<[string, SkillBook]>) {
    this.tabs.replaceChildren();
    if (this.hyperMode) {
      for (const [kind, name] of [[1, '强化技能'], [2, '主动技能']] as const) {
        const button = this.createTextActionButton(name, name, () => {
          this.hyperKind = kind; this.selectedSkillId = undefined; this.render();
          this.tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
        }, 'skill-hyper-tab');
        button.dataset.hyperControl = `tab-${kind}`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(this.hyperKind === kind));
        this.tabs.append(button);
      }
      return;
    }
    for (const [bookId, book] of books) {
      const selected = bookId === this.selectedBookId;
      const state = selected ? 'selected' : 'enabled';
      const art = this.data?.tabs?.[state]?.[book.tabIndex] ?? this.data?.tabs?.enabled?.[book.tabIndex] ?? this.data?.tabs?.disabled?.[book.tabIndex];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'skill-tab';
      button.dataset.bookId = bookId;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('aria-label', displayText(book.name));
      button.title = displayText(book.name);
      button.style.left = `${art?.x ?? 10 + book.tabIndex * 26}px`;
      button.style.top = `${art?.y ?? 29}px`;
      button.style.width = `${art?.width ?? 25}px`;
      button.style.height = `${art?.height ?? (selected ? 20 : 18)}px`;
      if (art) this.appendArt(button, art, 'skill-tab-art', true);
      const label = document.createElement('span');
      label.className = 'skill-tab-label';
      label.textContent = displayText(book.name);
      button.append(label);
      button.addEventListener('click', () => {
        this.selectedBookId = bookId;
        this.selectedSkillId = undefined;
        this.render();
        this.focusDataNode(this.tabs, 'bookId', bookId);
      });
      this.tabs.append(button);
    }
  }

  private renderList(visible: SkillCatalogEntry[]) {
    this.bookLabel.textContent = this.hyperMode ? `超级技能 · ${this.hyperKind === 1 ? '强化' : '主动'}` : displayText(this.books().find(([id]) => id === this.selectedBookId)?.[1].name ?? '技能目录');
    this.list.replaceChildren();
    if (this.hyperMode) {
      const guide = document.createElement('p');
      guide.className = 'skill-hyper-guide';
      guide.textContent = this.hyperKind === 1 ? '强化点：140 / 150 / 165 / 180 / 190级各获1点，选择强化已有技能。' : '主动点：140 / 160 / 190级各获1点。点击加号学习，再点击施放或使用快捷键。';
      this.list.append(guide);
    }
    const passives = this.regenerationPassives();
    for (const passive of passives) this.list.append(this.createRegenerationCard(passive));
    if (!visible.length && !passives.length) {
      const empty = document.createElement('p');
      empty.className = 'skill-empty';
      empty.textContent = this.selectedBookId === '0'
        ? '初心者技能资源尚未加载。'
        : '暂无可查看的技能。';
      this.list.append(empty);
      return;
    }
    for (const entry of visible) this.list.append(this.createSkillCard(entry));
  }

  private regenerationPassives() {
    if (this.hyperMode) return [];
    return (this.player?.derivedStats?.regenerationPassives ?? [])
      .filter(passive => String(passive.bookId) === this.selectedBookId);
  }

  private createRegenerationCard(passive: RegenerationPassive) {
    const names: Record<string, string> = {
      'beginner-recovery': '自然恢复',
      'magician-recovery': '魔力自然恢复',
      'warrior-recovery': '生命自然恢复',
    };
    const name = names[passive.id] ?? '自然恢复';
    const gain = [passive.hpPerSecond > 0 ? `HP+${passive.hpPerSecond}` : '',
      passive.mpPerSecond > 0 ? `MP+${passive.mpPerSecond}` : ''].filter(Boolean).join(' ');
    const description = `${name}：永久被动，每秒额外恢复 ${gain}。自动获得，不消耗技能点，可与其他自然恢复叠加；死亡暂停，复活后继续，满值停止，离线不累计。`;
    const item = document.createElement('div');
    item.className = 'skill-cell-item';
    item.setAttribute('role', 'listitem');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'skill-cell skill-regeneration';
    button.dataset.passiveId = passive.id;
    button.title = description;
    button.setAttribute('aria-label', description);
    const cell = this.data?.cells?.skill0 ?? this.data?.cells?.skillBlank;
    if (cell) this.appendArt(button, cell, 'skill-cell-art');
    for (const [className, text] of [['skill-cell-name', `${name} · 永久`], ['skill-cell-level', `${gain}/秒`]]) {
      const label = document.createElement('span');
      label.className = className;
      label.textContent = displayText(text);
      button.append(label);
    }
    button.addEventListener('click', () => this.status(description));
    item.append(button);
    return item;
  }

  private renderSkillPoint() {
    const group = this.selectedBookId;
    const points = this.hyperMode ? this.player?.hyperPoints?.[String(this.hyperKind)] : group === undefined || !this.player?.skillPoints ? undefined : (this.player.skillPoints[group] ?? 0);
    const known = typeof points === 'number' && Number.isSafeInteger(points) && points >= 0;
    this.skillPointValue.textContent = known ? String(points) : '—';
    this.skillPointValue.setAttribute('aria-label', known ? `技能点 ${points}` : '技能点未知');
  }

  private createSkillCard(entry: SkillCatalogEntry) {
    const level = this.learnedLevel(entry.id);
    const canLearn = this.canLearn(entry);
    const item = document.createElement('div');
    item.className = 'skill-cell-item';
    item.dataset.skillId = entry.id;
    item.setAttribute('role', 'listitem');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'skill-cell';
    button.dataset.skillId = entry.id;
    button.setAttribute('aria-label', `${displayText(entry.name)}，${this.levelLabel(level, entry.maxLevel)}`);
    button.title = displayText(entry.name);
    const cell = this.data?.cells?.skill0 ?? this.data?.cells?.skillBlank;
    if (cell) this.appendArt(button, cell, 'skill-cell-art');

    const icon = document.createElement('img');
    icon.className = 'skill-cell-icon';
    icon.alt = '';
    icon.draggable = false;
    icon.setAttribute('aria-hidden', 'true');
    const setIcon = (state: 'normal' | 'disabled' | 'mouseOver') => {
      const art = entry.icons[state] ?? entry.icons.normal ?? entry.icons.disabled;
      if (!art) {
        icon.hidden = true;
        return;
      }
      icon.hidden = false;
      icon.src = art.url;
      icon.width = art.width;
      icon.height = art.height;
    };
    setIcon(level !== undefined && level > 0 ? 'normal' : 'disabled');
    button.addEventListener('pointerenter', () => setIcon('mouseOver'));
    button.addEventListener('pointerleave', () => setIcon(level !== undefined && level > 0 ? 'normal' : 'disabled'));
    button.addEventListener('focus', () => setIcon('mouseOver'));
    button.addEventListener('blur', () => setIcon(level !== undefined && level > 0 ? 'normal' : 'disabled'));
    button.append(icon);

    const name = document.createElement('span');
    name.className = 'skill-cell-name';
    name.textContent = displayText(entry.name);
    button.append(name);
    const levelText = document.createElement('span');
    levelText.className = 'skill-cell-level';
    levelText.textContent = entry.hyper && (this.player?.level ?? 0) < (entry.requiredLevel ?? 0) ? `需要角色等级 ${entry.requiredLevel}` : this.levelLabel(level, entry.maxLevel);
    button.append(levelText);
    button.addEventListener('click', () => {
      this.selectedSkillId = entry.id;
      this.listView.hidden = true;
      this.detailView.hidden = false;
      this.renderDetail(entry);
      requestAnimationFrame(() => this.detailView.querySelector<HTMLElement>('.skill-detail-back')?.focus({ preventScroll: true }));
    });
    item.append(button);
    if (this.data?.buttons?.BtSpUp) {
      const learn = this.createSkillActionButton('BtSpUp', '学习技能', canLearn, () => this.learnSkill(entry), 'skill-cell-learn');
      item.append(learn);
      button.classList.add('has-learn-action');
    }
    if (this.isActiveSkill(entry)) {
      item.append(this.castButton(entry, 'skill-cell-cast'));
      button.classList.add('has-cast-action');
    }
    return item;
  }

  private createSkillActionButton(
    key: string,
    label: string,
    enabled: boolean,
    action: () => void,
    className: string,
  ) {
    const states = this.data?.buttons?.[key];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `skill-action ${className}`;
    button.disabled = !enabled;
    button.setAttribute('aria-label', label);
    button.title = label;
    const normal = states?.normal ?? states?.disabled;
    if (normal) {
      const image = this.appendArt(button, normal, 'skill-action-art', true);
      const setState = (state: 'normal' | 'mouseOver' | 'pressed' | 'disabled') => {
        const frame = states?.[state] ?? states?.normal ?? states?.disabled;
        if (frame) image.src = frame.url;
      };
      setState(enabled ? 'normal' : 'disabled');
      button.addEventListener('pointerenter', () => { if (enabled) setState('mouseOver'); });
      button.addEventListener('pointerleave', () => setState(enabled ? 'normal' : 'disabled'));
      button.addEventListener('pointerdown', () => { if (enabled) setState('pressed'); });
      button.addEventListener('pointerup', () => { if (enabled) setState('mouseOver'); });
    } else button.textContent = label;
    button.addEventListener('click', () => { if (enabled) action(); });
    return button;
  }

  private createTextActionButton(label: string, ariaLabel: string, action: () => void, className: string) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `skill-action ${className}`;
    button.textContent = label;
    button.setAttribute('aria-label', ariaLabel);
    button.title = ariaLabel;
    button.addEventListener('click', action);
    return button;
  }

  private renderDetail(entry: SkillCatalogEntry) {
    this.detailView.replaceChildren();
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'skill-detail-back';
    back.textContent = '‹ 返回技能列表';
    back.addEventListener('click', () => {
      this.selectedSkillId = undefined;
      this.showList();
      this.render();
      this.tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
    });
    this.detailView.append(back);

    const header = document.createElement('div');
    header.className = 'skill-detail-header';
    const iconArt = entry.icons.normal ?? entry.icons.disabled ?? entry.icons.mouseOver;
    if (iconArt) {
      const icon = document.createElement('img');
      icon.className = 'skill-detail-icon';
      icon.src = iconArt.url;
      icon.width = iconArt.width;
      icon.height = iconArt.height;
      icon.alt = '';
      icon.draggable = false;
      icon.setAttribute('aria-hidden', 'true');
      header.append(icon);
    }
    const title = document.createElement('div');
    title.className = 'skill-detail-title';
    const name = document.createElement('h2');
    name.textContent = displayText(entry.name);
    title.append(name);
    const level = document.createElement('p');
    level.textContent = `${this.levelLabel(this.learnedLevel(entry.id), entry.maxLevel)} · 最高等级 ${this.numberText(entry.maxLevel)}`;
    title.append(level);
    header.append(title);
    this.detailView.append(header);

    const actions = document.createElement('div');
    actions.className = 'skill-detail-actions';
    if (this.data?.buttons?.BtSpUp) actions.append(this.createSkillActionButton('BtSpUp', '学习技能', this.canLearn(entry), () => this.learnSkill(entry), 'skill-detail-learn'));
    if (this.isActiveSkill(entry)) {
      actions.append(this.castButton(entry, 'skill-detail-cast'));
    }
    if (actions.childElementCount) this.detailView.append(actions);

    const fourthKey = Object.entries(FOURTH_SHORTCUT_SKILLS).find(([, id]) => String(id) === entry.id)?.[0];
    const shortcut = fourthKey ? `Shift + ${fourthKey.slice(5)}` : this.player?.job === 0 && ['1000', '1001', '1002'].includes(entry.id) ? String(Number(entry.id) - 999) : Object.entries(SHORTCUT_SKILLS).find(([key, id]) => key.startsWith('Digit') && String(id) === entry.id)?.[0].slice(5);
    if (shortcut) {
      const hint = document.createElement('p');
      hint.className = 'skill-detail-description';
      hint.textContent = `快捷键：${shortcut}${entry.id === '2211011' ? '；按住 ↓ 再按 0 固定球体' : entry.id === '2221011' ? '；按住维持，松开结束' : ''}`;
      this.detailView.append(hint);
    }

    if ((entry.bookId === '0' || entry.bookId === '222') && this.isActiveSkill(entry)) {
      const state = document.createElement('p');
      state.className = 'skill-detail-description';
      const remaining = this.player?.derivedStats?.skillBuffs?.[entry.id] ?? 0;
      state.textContent = `${remaining > 0 ? `效果剩余 ${Math.ceil(remaining / 1000)} 秒 · ` : ''}${this.castBlockReason(entry) || '可施放'}`;
      this.detailView.append(state);
    }

    if (entry.id === '2211012') {
      const state = document.createElement('p');
      state.className = 'skill-detail-description';
      state.textContent = `剩余防护次数：${this.player?.derivedStats?.adaptationCharges ?? 0} · ${this.castBlockReason(entry) || '可启用'}
当前岛屿怪物没有致命异常攻击，防护不会由普通碰撞触发。`;
      this.detailView.append(state);
    }

    if (entry.hyper) {
      const hint = document.createElement('p');
      hint.className = 'skill-detail-description';
      hint.textContent = `需要角色等级 ${entry.requiredLevel} · 使用独立${entry.hyper === 1 ? '强化' : '主动'}点数。`;
      if (entry.id === '2221052') hint.textContent += '按住施放，松开触发最后一击。';
      if (entry.id === '2221053') hint.textContent += '当前队伍机制未开放，效果只作用于自身。';
      if (entry.id === '2221054') {
        hint.textContent += '开启后每秒消耗60 MP；生成漩涡后，站在范围内获得结界效果。';
        const vortex = this.createTextActionButton('生成漩涡', '向下施放冰雪结界', () => this.castSkill(entry, undefined, 1), 'skill-detail-cast');
        const cooldown = this.player?.derivedStats?.skillCooldowns?.['2221055'] ?? 0;
        vortex.disabled = !this.canCast(entry) || cooldown > 0;
        vortex.title = cooldown > 0 ? `漩涡冷却剩余 ${Math.ceil(cooldown / 1000)} 秒` : '生成30秒漩涡';
        this.detailView.append(vortex);
      }
      this.detailView.append(hint);
    }

    const description = sourceText(entry.description);
    if (description) {
      const block = document.createElement('p');
      block.className = 'skill-detail-description';
      block.textContent = description;
      this.detailView.append(block);
    }

    const prerequisites = Object.entries(entry.prerequisites ?? {});
    if (prerequisites.length) {
      const section = document.createElement('section');
      section.className = 'skill-detail-section';
      const heading = document.createElement('h3');
      heading.textContent = '学习前置';
      section.append(heading);
      const list = document.createElement('ul');
      for (const [requiredId, requiredLevel] of prerequisites) {
        const required = this.catalog().get(requiredId);
        const item = document.createElement('li');
        item.textContent = `${displayText(required?.name ?? requiredId)} · 需要等级 ${this.numberText(requiredLevel)}`;
        list.append(item);
      }
      section.append(list);
      this.detailView.append(section);
    }

    this.appendLevelValues(entry);
  }

  private appendLevelValues(entry: SkillCatalogEntry) {
    const values = entry.levelValues ?? [];
    const learned = this.learnedLevel(entry.id);
    const currentLevel = learned !== undefined && learned > 0 ? learned : undefined;
    const nextLevel = learned === undefined || learned === 0 ? 1 : learned < entry.maxLevel ? learned + 1 : undefined;
    const section = document.createElement('section');
    section.className = 'skill-detail-section skill-detail-values';
    const heading = document.createElement('h3');
    heading.textContent = '技能数值';
    section.append(heading);
    for (const [level, current] of [[currentLevel, true], [nextLevel, false]] as const) {
      if (level === undefined) continue;
      const description = sourceText(entry.levelDescriptions?.[level - 1]);
      const value = values.find(value => value.level === level);
      if (!description && !value) continue;
      const suffix = current ? '' : learned === undefined ? '（等级未同步）' : learned === 0 ? '（当前未学习）' : '';
      const title = `${current ? '当前等级' : '下一等级预览'} ${this.numberText(level)}${suffix}`;
      if (description) {
        const group = document.createElement('div');
        group.className = 'skill-metric-group';
        const label = document.createElement('h4');
        label.textContent = title;
        const text = document.createElement('p');
        text.className = 'skill-detail-description';
        text.textContent = description;
        group.append(label, text);
        section.append(group);
      } else if (value) section.append(this.metricGroup(title, value));
    }
    if (section.childElementCount === 1) return;
    this.detailView.append(section);
  }

  private metricGroup(title: string, value: { level: number; mpCon: number; damage: number; mobCount: number; attackCount: number }) {
    const group = document.createElement('div');
    group.className = 'skill-metric-group';
    const heading = document.createElement('h4');
    heading.textContent = title;
    group.append(heading);
    const metrics = document.createElement('dl');
    for (const [key, label, suffix] of METRICS) {
      const raw = value[key];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const term = document.createElement('div');
      const name = document.createElement('dt');
      name.textContent = label;
      const number = document.createElement('dd');
      number.textContent = `${this.numberText(raw)}${suffix}`;
      term.append(name, number);
      metrics.append(term);
    }
    if (metrics.childElementCount) group.append(metrics);
    return group;
  }

  private showList() {
    this.listView.hidden = false;
    this.detailView.hidden = true;
  }

  private isActiveSkill(entry: SkillCatalogEntry) {
    return ACTIVE_SKILLS.has(entry.id);
  }

  private isToggleSkill(entry: SkillCatalogEntry) {
    return TOGGLE_SKILLS.has(entry.id);
  }

  private canLearn(entry: SkillCatalogEntry) {
    if (entry.hidden || FIXED_SKILLS.has(entry.id) || this.player?.job === undefined || !this.player?.skills || entry.bookId !== this.selectedBookId) return false;
    if (entry.bookId === '0' && this.player.job !== 0 && !MAGE_JOB_WHITELIST.has(this.player.job)) return false;
    if (entry.bookId === '200' && !MAGE_JOB_WHITELIST.has(this.player.job)) return false;
    if (entry.bookId === '220' && !ICE_LIGHTNING_JOB_WHITELIST.has(this.player.job)) return false;
    if (entry.bookId === '222' && this.player.job !== 222) return false;
    if (entry.bookId === '221' && ![221, 222].includes(this.player.job)) return false;
    const level = this.learnedLevel(entry.id);
    if (level === undefined || level >= entry.maxLevel) return false;
    if ((this.player.level ?? 0) < (entry.requiredLevel ?? 0)) return false;
    const points = entry.hyper ? this.player.hyperPoints?.[String(entry.hyper)] : this.player.skillPoints?.[entry.bookId];
    if (typeof points !== 'number' || !Number.isSafeInteger(points) || points < 1) return false;
    return Object.entries(entry.prerequisites ?? {}).every(([requiredId, requiredLevel]) => {
      const learned = this.learnedLevel(requiredId);
      return learned !== undefined && learned >= requiredLevel;
    });
  }

  private castUiKey(player?: PlayerState): string {
    const stats = player?.derivedStats;
    return [Boolean(player && player.hp > 0 && player.action !== 'dead'), player?.climbing, stats?.magicGuard, stats?.iceTeleport,
      stats?.teleportMastery, stats?.teleportBoost, stats?.hyperBarrierActive, stats?.hyperTeleportEnabled, stats?.adaptationCharges,
      JSON.stringify(stats?.regenerationPassives ?? []),
      Object.entries(stats?.skillCooldowns ?? {}).map(([id, ms]) => `${id}:${Math.ceil(ms / 1000)}`).join(','),
      Object.entries(stats?.skillBuffs ?? {}).map(([id, ms]) => `${id}:${Math.ceil(ms / 1000)}`).join(','),
      Math.ceil((stats?.adaptationCooldownMs ?? 0) / 1000)].join(':');
  }

  private castBlockReason(entry: SkillCatalogEntry): string | undefined {
    const player = this.player;
    const jobAllowed = entry.bookId === '222' ? player?.job === 222 : entry.bookId === '0' ? player?.job === 0 || MAGE_JOB_WHITELIST.has(player?.job ?? -1) : entry.bookId === '221' ? [221, 222].includes(player?.job ?? -1)
      : entry.bookId === '220' ? ICE_LIGHTNING_JOB_WHITELIST.has(player?.job ?? -1) : MAGE_JOB_WHITELIST.has(player?.job ?? -1);
    if (entry.hidden || !this.isActiveSkill(entry)) return '此技能不直接施放';
    if (!jobAllowed) return '完成对应转职后可使用';
    if (!player || player.hp <= 0 || player.action === 'dead') return '复活后可使用';
    if (player.climbing) return '离开梯绳后可使用';
    if (entry.id === '2221045' && !player.derivedStats?.hyperTeleportEnabled && player.derivedStats?.teleportBoost) return '请先关闭瞬间移动爆发';
    if (entry.id === '2211017' && !player.derivedStats?.teleportBoost && player.derivedStats?.hyperTeleportEnabled) return '请先关闭超级瞬移距离';
    if ((player.derivedStats?.skillBuffs?.['2221052'] ?? 0) > 0) return '雷霆万钧持续中，松开按键结束';
    if ((player.derivedStats?.skillBuffs?.['2221011'] ?? 0) > 0) return '冰龙吐息持续中，松开按键结束';
    if (!(this.learnedLevel(entry.id)! > 0)) return '先学习此技能';
    const cooldown = player.derivedStats?.skillCooldowns?.[entry.id] ?? (entry.id === '2211012' ? player.derivedStats?.adaptationCooldownMs ?? 0 : 0);
    if (cooldown > 0) return `冷却中，剩余 ${Math.ceil(cooldown / 1000)} 秒`;
    return undefined;
  }

  private canCast(entry: SkillCatalogEntry) { return !this.castBlockReason(entry); }

  private castButton(entry: SkillCatalogEntry, className: string) {
    const state = this.player?.derivedStats;
    const enabled = entry.id === '2001002' ? state?.magicGuard : entry.id === '2201009' ? state?.iceTeleport
      : entry.id === '2221045' ? state?.hyperTeleportEnabled : entry.id === '2221054' ? state?.hyperBarrierActive
      : entry.id === '2211007' ? state?.teleportMastery : state?.teleportBoost;
    const channel = entry.id === '2221011' || entry.id === '2221052';
    const label = channel ? '按住施放' : this.isToggleSkill(entry) ? (enabled ? '关闭' : '开启') : '施放';
    const reason = this.castBlockReason(entry);
    const button = this.createTextActionButton(label, reason || `${label}技能`, () => { if (!channel) this.castSkill(entry); }, className);
    button.disabled = Boolean(reason);
    if (channel) {
      const start = () => { if (!this.channelRequestId) this.channelRequestId = this.castSkill(entry); };
      button.addEventListener('pointerdown', event => { if (event.button === 0) { event.preventDefault(); start(); } });
      button.addEventListener('keydown', event => {
        if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); if (!event.repeat) start(); }
      });
      // Assistive-technology activation is a tap; physical holds use the events above.
      button.addEventListener('click', event => { if (event.detail === 0) { start(); this.releaseChannel(); } });
    }
    return button;
  }

  private learnSkill(entry: SkillCatalogEntry) {
    if (!this.canLearn(entry)) {
      this.status('当前无法学习此技能。');
      return;
    }
    const message: SkillRequest = { type: 'learnSkill', requestId: this.requestId('learn'), skillId: Number(entry.id) };
    if (this.send(message)) this.status(`正在学习${displayText(entry.name)}…`);
    else this.status('技能学习需要保持在线。');
  }

  private castSkill(entry: SkillCatalogEntry, direction?: -1 | 0 | 1, vertical?: -1 | 0 | 1) {
    if (!this.canCast(entry)) {
      this.status(this.castBlockReason(entry) || '当前无法施放此技能。');
      return;
    }
    const resolvedVertical = vertical ?? (entry.id === '2001011' ? -1 : undefined);
    const message: SkillRequest = {
      type: 'castSkill',
      requestId: this.requestId('cast'),
      skillId: Number(entry.id),
      ...(direction === undefined ? {} : { direction }),
      ...(resolvedVertical === undefined ? {} : { vertical: resolvedVertical }),
    };
    if (this.send(message)) {
      this.status(`${this.isToggleSkill(entry) ? '切换' : '施放'}${displayText(entry.name)}…`);
      return message.requestId;
    }
    else this.status('技能施放需要保持在线。');
  }

  private resetHyper() {
    const cost = this.player?.hyperResetCost;
    if (!cost || !this.player || this.player.mesos < cost) return;
    if (!window.confirm(`消耗 ${cost.toLocaleString()} 枫币重置全部超级技能？返还强化与主动技能点，冷却时间保留。`)) return;
    if (this.send({ type: 'resetHyper', requestId: this.requestId('reset'), expectedCost: cost })) this.status('正在重置超级技能…');
    else this.status('重置需要保持在线。');
  }

  private requestId(kind: 'learn' | 'cast' | 'reset') {
    this.requestSequence += 1;
    return `skill-${kind}-${Date.now()}-${this.requestSequence}`;
  }

  private books(): Array<[string, SkillBook]> {
    const warrior = this.player?.derivedStats?.regenerationPassives?.some(passive => passive.bookId === 100);
    return Object.entries({ '0': { name: '初心者', tabIndex: 0 }, ...this.manifest.skillBooks,
      ...(warrior ? { '100': { name: '战士', tabIndex: 1 } } : {}) })
      .filter(([id]) => !warrior || id !== '200')
      .filter(([id]) => id !== '220' || ICE_LIGHTNING_JOB_WHITELIST.has(this.player?.job ?? -1))
      .filter(([id]) => id !== '222' || this.player?.job === 222)
      .filter(([id]) => id !== '221' || [221, 222].includes(this.player?.job ?? -1))
      .filter(([, book]) => book && Number.isSafeInteger(book.tabIndex))
      .sort(([, left], [, right]) => left.tabIndex - right.tabIndex);
  }

  private catalog(): Map<string, SkillCatalogEntry> {
    return new Map(Object.entries(this.manifest.skillCatalog ?? {}));
  }

  private visibleSkills(bookId?: string): SkillCatalogEntry[] {
    if (!bookId) return [];
    return [...this.catalog().values()]
      .filter(entry => entry.bookId === bookId && !entry.hidden && (this.hyperMode ? entry.hyper === this.hyperKind : !entry.hyper))
      .sort((left, right) => Number(left.id) - Number(right.id));
  }

  private learnedLevel(skillId: string): number | undefined {
    if (skillId === '2200011' && ICE_LIGHTNING_JOB_WHITELIST.has(this.player?.job ?? -1)) return 1;
    const skills = this.player?.skills;
    if (!skills) return undefined;
    const level = Object.prototype.hasOwnProperty.call(skills, skillId) ? skills[skillId] : 0;
    return Number.isSafeInteger(level) && level >= 0 ? level : undefined;
  }

  private levelLabel(level: number | undefined, maxLevel: number) {
    return `等级 ${level === undefined ? '—' : this.numberText(level)}/${this.numberText(maxLevel)}`;
  }

  private numberText(value: number) {
    return Number.isFinite(value) ? String(value) : '—';
  }

  private focusGame() {
    const game = document.querySelector<HTMLElement>('#game');
    if (!game) return;
    try {
      game.focus({ preventScroll: true });
    } catch {
      game.focus();
    }
  }
}

export function sourceText(value: unknown) {
  if (typeof value !== 'string') return '';
  return displayText(value)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/#[cbkrgedn](?=\d|[^A-Za-z0-9_]|$)/g, '')
    .replace(/#(?![A-Za-z_])/g, '')
    .trim();
}

function sameSkills(left?: Record<string, number>, right?: Record<string, number>) {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key]);
}
