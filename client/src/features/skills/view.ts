import type { ClientMessage, PlayerState } from '../../../../shared/protocol';
import type { SkillArt, SkillCatalogEntry, SkillWindowData, Manifest } from '../../assets/manifest';
import { displayText } from '../../app/i18n';
import './style.css';

type SkillBook = { name: string; tabIndex: number };
type SkillMetric = 'mpCon' | 'damage' | 'mobCount' | 'attackCount';
type SkillRequest = Extract<ClientMessage, { type: 'learnSkill' | 'castSkill' }>;

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

const ACTIVE_SKILLS = new Set(['2001002', '2001008', '2001009', '2001011', '2001012', '2201001', '2201005', '2201008', '2201009']);
const TOGGLE_SKILLS = new Set(['2201001', '2201009']);
const FIXED_SKILLS = new Set(['2200011']);
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
  private selectedSkillId?: string;
  private openState = false;
  private destroyed = false;
  private requestSequence = 0;

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
    this.render();
  }

  update(player?: PlayerState) {
    if (this.destroyed) return;
    const changed = !this.hasPlayerSnapshot
      || !sameSkills(this.player?.skills, player?.skills)
      || !sameSkills(this.player?.skillPoints, player?.skillPoints)
      || this.player?.job !== player?.job;
    this.player = player;
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
    this.destroyed = true;
    document.removeEventListener('keydown', this.handleKeyDown, true);
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
    for (const [key, label] of BOTTOM_BUTTONS) {
      const states = this.data?.buttons?.[key];
      const art = states?.normal ?? states?.disabled;
      if (!art) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `skill-bottom-button skill-bottom-button-${key}`;
      button.disabled = true;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.style.left = `${art.x}px`;
      button.style.top = `${art.y}px`;
      button.style.width = `${art.width}px`;
      button.style.height = `${art.height}px`;
      this.appendArt(button, art, 'skill-bottom-button-art', true);
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
    const books = this.books();
    if (!this.selectedBookId || !books.some(([id]) => id === this.selectedBookId)) this.selectedBookId = books[0]?.[0];
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
    this.bookLabel.textContent = displayText(this.books().find(([id]) => id === this.selectedBookId)?.[1].name ?? '技能目录');
    this.list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'skill-empty';
      empty.textContent = '暂无可查看的技能。';
      this.list.append(empty);
      return;
    }
    for (const entry of visible) this.list.append(this.createSkillCard(entry));
  }

  private renderSkillPoint() {
    const group = this.selectedBookId;
    const points = group === undefined ? undefined : this.player?.skillPoints?.[group];
    const known = typeof points === 'number' && Number.isSafeInteger(points) && points >= 0;
    this.skillPointValue.textContent = known ? String(points) : '—';
    this.skillPointValue.setAttribute('aria-label', known ? `技能点 ${points}` : '技能点未知');
  }

  private createSkillCard(entry: SkillCatalogEntry) {
    const level = this.learnedLevel(entry.id);
    const canLearn = this.canLearn(entry);
    const canCast = this.canCast(entry);
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
    levelText.textContent = this.levelLabel(level, entry.maxLevel);
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
    if (canCast) {
      const label = this.isToggleSkill(entry) ? '切换' : '施放';
      const cast = this.createTextActionButton(label, `${label}技能`, () => this.castSkill(entry), 'skill-cell-cast');
      item.append(cast);
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
      const label = this.isToggleSkill(entry) ? '切换' : '施放';
      actions.append(this.createTextActionButton(label, `${label}技能`, () => this.castSkill(entry), 'skill-detail-cast'));
    }
    if (actions.childElementCount) this.detailView.append(actions);

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
    if (FIXED_SKILLS.has(entry.id) || !this.player?.job || !this.player?.skills || entry.bookId !== this.selectedBookId) return false;
    if (entry.bookId === '200' && !MAGE_JOB_WHITELIST.has(this.player.job)) return false;
    if (entry.bookId === '220' && !ICE_LIGHTNING_JOB_WHITELIST.has(this.player.job)) return false;
    const level = this.learnedLevel(entry.id);
    if (level === undefined || level >= entry.maxLevel) return false;
    const points = this.player.skillPoints?.[entry.bookId];
    if (typeof points !== 'number' || !Number.isSafeInteger(points) || points < 1) return false;
    return Object.entries(entry.prerequisites ?? {}).every(([requiredId, requiredLevel]) => {
      const learned = this.learnedLevel(requiredId);
      return learned !== undefined && learned >= requiredLevel;
    });
  }

  private canCast(entry: SkillCatalogEntry) {
    const player = this.player;
    const level = this.learnedLevel(entry.id);
    const jobAllowed = entry.bookId === '220' ? ICE_LIGHTNING_JOB_WHITELIST.has(player?.job ?? -1) : MAGE_JOB_WHITELIST.has(player?.job ?? -1);
    return player?.job !== undefined
      && jobAllowed
      && player.hp > 0
      && player.action !== 'dead'
      && this.isActiveSkill(entry)
      && level !== undefined
      && level > 0;
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
      this.status('技能尚未学习。');
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
    if (this.send(message)) this.status(`${this.isToggleSkill(entry) ? '切换' : '施放'}${displayText(entry.name)}…`);
    else this.status('技能施放需要保持在线。');
  }

  private requestId(kind: 'learn' | 'cast') {
    this.requestSequence += 1;
    return `skill-${kind}-${Date.now()}-${this.requestSequence}`;
  }

  private books(): Array<[string, SkillBook]> {
    return Object.entries(this.manifest.skillBooks ?? {})
      .filter(([id]) => id !== '220' || ICE_LIGHTNING_JOB_WHITELIST.has(this.player?.job ?? -1))
      .filter(([, book]) => book && Number.isSafeInteger(book.tabIndex))
      .sort(([, left], [, right]) => left.tabIndex - right.tabIndex);
  }

  private catalog(): Map<string, SkillCatalogEntry> {
    return new Map(Object.entries(this.manifest.skillCatalog ?? {}));
  }

  private visibleSkills(bookId?: string): SkillCatalogEntry[] {
    if (!bookId) return [];
    return [...this.catalog().values()]
      .filter(entry => entry.bookId === bookId && !entry.hidden)
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
