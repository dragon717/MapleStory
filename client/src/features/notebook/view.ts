//! 冒险笔记（图鉴）窗口：一个壳，四个页签。
//!
//! 这是**展示**层（计划 §4.2）：它把目录（`/assets/notebook.json`）和服务器给的
//! 那一页私有事实拼成画面，自己不做任何判定。三条硬边界：
//! - 它从不自己算 `obtained`／`registered`，也从不补一个服务器没给的分母。
//! - 任务页永远没有「未获得」开关：未获得的任务条目从服务器的基集合里就不存在，
//!   这里也就不可能有问号格（`browseModesFor`）。
//! - 目录版本不一致时**拒绝排版**，而不是拿旧页码去解释新目录（§12.2）。
//!
//! 快速切页靠 `requestId` 丢弃过期响应：只有与当前待答请求同 id、同页签的那一份
//! 会被采纳，上一页的结果永远不能覆盖当前页（§6.5）。

import { displayText, uiLocale, uiText } from '../../app/i18n';
import {
  bringToFront,
  clampIntoHost,
  installWindowDrag,
  type AssetButtonState,
} from '../ui/window-shell';
import { itemDetails, itemName } from '../inventory/names';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import type {
  ClientMessage,
  NotebookRow,
  NotebookSection,
  NotebookSlot,
  NotebookSummary,
  ServerMessage,
} from '../../../../shared/protocol';
import {
  browseModesFor,
  defaultModeFor,
  isMountFamily,
  MOUNT_SUBSECTIONS,
  NOTEBOOK_TABS,
  pageWindow,
  progressOf,
  regionList,
  rowDefinition,
  tabKeyFor,
  type BrowseMode,
} from './view-model';
import {
  loadNotebookDirectory,
  type NotebookDirectory,
} from './directory';
import type { SectionContext } from './section-context';
import { renderMonsterPage } from './monster-section';
import { renderItemPage } from './item-section';

type NotebookStateMessage = Extract<ServerMessage, { type: 'notebookState' }>;

export interface NotebookViewOptions {
  /** 发一条客户端消息；返回 false 表示当前没有可用连接。 */
  send: (message: ClientMessage) => boolean;
  /** 一行中文提示（连接断开、目录加载失败等）。 */
  status?: (message: string) => void;
  /** 目录加载器；默认读 `/assets/notebook.json`，测试可注入。 */
  loadDirectory?: () => Promise<NotebookDirectory>;
}

/** 每个页签自己记住页码／筛选／浏览方式（计划 §6.4）。 */
interface TabState {
  page: number;
  filter: string;
  mode: BrowseMode;
}

/** 详情面板里选中的一格。 */
interface Selection {
  row: NotebookRow;
  slot?: NotebookSlot;
}

/** 一页的私有快照。 */
interface PageSnapshot {
  section: NotebookSection;
  page: number;
  pageCount: number;
  rows: NotebookRow[];
  summary: NotebookSummary;
  scope: 'account' | 'character';
  revision: number;
  catalogVersion: string;
  blockedReason?: string;
}

export class NotebookView {
  readonly element: HTMLDivElement;
  private readonly manifest: Manifest;
  private readonly send: (message: ClientMessage) => boolean;
  private readonly statusLine: (message: string) => void;
  private readonly loadDirectory: () => Promise<NotebookDirectory>;
  private readonly disposeDrag: () => void;

  private open_ = false;
  private directory?: NotebookDirectory;
  private directoryError?: string;
  private section: NotebookSection = 'monster';
  private readonly tabs = new Map<NotebookSection, TabState>();
  private snapshot?: PageSnapshot;
  private pending?: { requestId: string; section: NotebookSection };
  private sequence = 0;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private selection?: Selection;
  private revision = new Map<NotebookSection, number>();
  private destroyed = false;

  private readonly background: HTMLImageElement;
  private readonly titleNode: HTMLSpanElement;
  private readonly progressNode: HTMLSpanElement;
  private readonly tabStrip: HTMLDivElement;
  private readonly side: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly pager: HTMLDivElement;
  private readonly detail: HTMLDivElement;
  private readonly notice: HTMLDivElement;

  constructor(
    private host: HTMLElement,
    manifest: Manifest,
    options: NotebookViewOptions,
  ) {
    this.manifest = manifest;
    this.send = options.send;
    this.statusLine = options.status ?? (() => { });
    this.loadDirectory = options.loadDirectory ?? loadNotebookDirectory;

    this.element = document.createElement('div');
    this.element.className = 'notebook-window ui-window';
    this.element.hidden = true;
    this.element.dataset.section = this.section;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'false');

    this.background = document.createElement('img');
    this.background.className = 'notebook-backgrnd';
    this.background.alt = '';
    this.background.draggable = false;

    this.titleNode = document.createElement('span');
    this.titleNode.className = 'notebook-title';
    this.progressNode = document.createElement('span');
    this.progressNode.className = 'notebook-progress';
    this.tabStrip = document.createElement('div');
    this.tabStrip.className = 'notebook-tabs';
    this.tabStrip.setAttribute('role', 'tablist');
    this.side = document.createElement('div');
    this.side.className = 'notebook-side';
    this.content = document.createElement('div');
    this.content.className = 'notebook-content';
    this.pager = document.createElement('div');
    this.pager.className = 'notebook-pager';
    this.detail = document.createElement('div');
    this.detail.className = 'notebook-detail';
    this.detail.hidden = true;
    this.notice = document.createElement('div');
    this.notice.className = 'notebook-notice';
    this.notice.hidden = true;

    this.element.append(
      this.background,
      this.titleNode,
      this.progressNode,
      this.tabStrip,
      this.side,
      this.content,
      this.pager,
      this.detail,
      this.notice,
    );
    // 共享 UI host：只 append 自己的节点，绝不 replaceChildren 清掉别人（§6.4）。
    this.host.append(this.element);

    this.disposeDrag = installWindowDrag(host, this.element, {
      titleHeight: 24,
      isOpen: () => this.open_,
      onActivate: () => bringToFront(this.host, this.element),
    });
    // ESC 只关最上层该关的窗口；搜索框里的按键不参与（§6.5）。
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    // 空间不足就切流式布局（计划 §6.5 的 1440×900 / 1024×768 / 844×390 / 390×844）。
    this.resizeObserver = new ResizeObserver(() => this.applyCompact());
    this.resizeObserver.observe(host);
    this.applyCompact();
  }

  private resizeObserver?: ResizeObserver;

  /** 装不下源尺寸时改用流式布局，保住标题／页签／分页与内容滚动。 */
  private applyCompact(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    const compact = width > 0 && height > 0 && (width < 900 || height < 690);
    this.element.classList.toggle('notebook-compact', compact);
    if (compact) {
      this.element.style.width = '';
      this.element.style.height = '';
    } else {
      clampIntoHost(this.host, this.element);
    }
  }

  private readonly onDocumentKeyDown = (event: KeyboardEvent) => {
    if (!this.open_ || event.key !== 'Escape') return;
    const target = event.target;
    if (target instanceof Element && target.matches('input,textarea,select,[contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  isOpen(): boolean { return this.open_; }

  /** 打开窗口。  首次打开才下载目录；每一次打开都重新问服务器要一次私有快照。 */
  open(section?: NotebookSection): void {
    if (this.destroyed) return;
    if (section) this.section = section;
    this.open_ = true;
    // 每次开窗都重新读一次私有事实：上一次开窗留下的行不是这一次的事实（§6.5）。
    this.snapshot = undefined;
    this.element.hidden = false;
    this.element.dataset.section = this.section;
    bringToFront(this.host, this.element);
    this.paintChrome();
    this.render();
    void this.refresh();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.element.hidden = true;
    // 关窗即停：不再持有私有行，动画与重绘也一起停下（§6.5）。
    this.snapshot = undefined;
    this.pending = undefined;
    this.selection = undefined;
    this.content.replaceChildren();
    this.detail.hidden = true;
  }

  toggle(section?: NotebookSection): boolean {
    if (this.open_ && (!section || section === this.section)) { this.close(); return false; }
    this.open(section);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    this.resizeObserver?.disconnect();
    this.disposeDrag();
    this.element.remove();
  }

  /** 窗口尺寸变化时把它夹回 host 内（与别的窗口同一套规则）。 */
  onResize(): void {
    clampIntoHost(this.host, this.element);
  }

  /** 服务器给的一页私有事实。  `requestId` 或页签对不上就是过期响应，直接丢。 */
  receiveState(message: NotebookStateMessage): void {
    if (this.destroyed) return;
    if (!this.pending || this.pending.requestId !== message.requestId) return;
    if (this.pending.section !== message.section) return;
    this.pending = undefined;
    if (!this.directory) return;
    // 版本错配：拒绝排版。  旧页码解释新目录会把玩家看到的内容整个错位。
    if (message.catalogVersion !== this.directory.catalogVersion) {
      this.snapshot = undefined;
      this.showNotice(uiText('notebookCatalogMismatch', '图鉴目录版本与服务器不一致，请刷新页面后重试。'));
      this.statusLine(uiText('notebookCatalogMismatch', '图鉴目录版本与服务器不一致，请刷新页面后重试。'));
      this.render();
      return;
    }
    this.revision.set(message.section, message.revision);
    this.snapshot = {
      section: message.section,
      page: message.page,
      pageCount: message.pageCount,
      rows: message.rows,
      summary: message.summary,
      scope: message.scope,
      revision: message.revision,
      catalogVersion: message.catalogVersion,
      blockedReason: message.blockedReason,
    };
    this.clearNotice();
    this.render();
  }

  /** 私有事实变了。  revision 跳变就重新问一次，绝不自己推测加了什么。 */
  receiveChange(message: Extract<ServerMessage, { type: 'notebookChanged' }>): void {
    if (this.destroyed) return;
    const known = this.revision.get(message.section);
    this.revision.set(message.section, message.revision);
    if (!this.open_) return;
    if (message.section !== this.section) return;
    if (known !== undefined && known >= message.revision) return;
    void this.refresh();
  }

  /** 换角色／登出：清掉私有缓存，下一次开窗重新读（§6.5）。 */
  reset(): void {
    this.snapshot = undefined;
    this.pending = undefined;
    this.selection = undefined;
    this.revision.clear();
    this.tabs.clear();
  }

  // ---------------------------------------------------------------- 取数

  private tab(section: NotebookSection): TabState {
    const existing = this.tabs.get(section);
    if (existing) return existing;
    const fresh: TabState = { page: 0, filter: '', mode: defaultModeFor(section) };
    this.tabs.set(section, fresh);
    return fresh;
  }

  /** 拉一次当前页签的私有快照。  目录没到位就先加载目录。 */
  private async refresh(): Promise<void> {
    if (this.destroyed || !this.open_) return;
    if (!this.directory) {
      this.renderLoading();
      try {
        this.directory = await this.loadDirectory();
        this.directoryError = undefined;
      } catch (error) {
        this.directoryError = String(error instanceof Error ? error.message : error);
        this.statusLine(uiText('notebookLoadFailed', '图鉴目录加载失败。'));
        this.render();
        return;
      }
      // 目录可能来得很慢：等到手时窗口也许已经关了，或已经换了页签。
      if (this.destroyed || !this.open_) return;
    }
    this.request();
  }

  private request(): void {
    const directory = this.directory;
    if (!directory) return;
    const state = this.tab(this.section);
    const requestId = `notebook-${this.section}-${++this.sequence}`;
    this.pending = { requestId, section: this.section };
    const message: ClientMessage = {
      type: 'notebookQuery',
      requestId,
      section: this.section,
      page: state.page,
      catalogVersion: directory.catalogVersion,
      ...(state.filter ? { filter: state.filter } : {}),
      ...(this.section === 'monster' ? {} : { mode: state.mode }),
    };
    if (!this.send(message)) {
      this.pending = undefined;
      this.statusLine(uiText('notebookOffline', '当前未连接服务器，无法读取图鉴。'));
      this.render();
      return;
    }
    this.renderLoading();
  }

  // ---------------------------------------------------------------- 绘制

  /** 窗口壳上与页签无关的部分：底板、标题、页签条、关闭键、页签条下缘线。 */
  private paintChrome(): void {
    const frames = this.manifest.notebook?.frames.monster ?? {};
    const back = frames['backgrnd'];
    if (back) {
      this.background.src = back.url;
      this.background.width = back.width;
      this.background.height = back.height;
      this.element.style.setProperty('--notebook-width', `${back.width}px`);
      this.element.style.setProperty('--notebook-height', `${back.height}px`);
    }
    this.titleNode.textContent = displayText(uiText('notebookTitle', '冒险笔记（图鉴）'));
    this.element.setAttribute('aria-label', this.titleNode.textContent ?? '');
    if (this.element.querySelector('.notebook-close')) return;

    // 页签条下缘的分隔线是源 `layer:tab_line`（865x8），不是自绘的 1px 边框：
    // 源板在白纸上没有横线，少它这一段页签会「浮」在纸面上。
    const rule = frames['layer:tab_line'];
    if (rule) {
      const image = document.createElement('img');
      image.className = 'notebook-tab-rule';
      image.src = rule.url;
      image.width = rule.width;
      image.height = rule.height;
      image.alt = '';
      image.draggable = false;
      image.setAttribute('aria-hidden', 'true');
      this.element.append(image);
    }

    const close = this.frameButton(frames, 'button:Close', uiText('notebookClose', '关闭冒险笔记'));
    if (close) {
      close.classList.add('notebook-close');
      close.addEventListener('click', () => this.close());
      this.place(close, frames['button:Close/normal']);
      this.element.append(close);
    }
  }

  /** 用源的 `<base>/<state>` 帧拼一个四态按钮；`normal` 缺失就不画（不留死按钮）。 */
  private frameButton(frames: Record<string, AssetFrame>, base: string, label: string): HTMLButtonElement | undefined {
    const normal = frames[`${base}/normal`];
    if (!normal) return undefined;
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    const image = document.createElement('img');
    image.src = normal.url;
    image.width = normal.width;
    image.height = normal.height;
    image.alt = '';
    image.draggable = false;
    button.append(image);
    const setState = (state: AssetButtonState) => {
      const frame = frames[`${base}/${state}`] ?? normal;
      image.src = frame.url;
      image.width = frame.width;
      image.height = frame.height;
    };
    const idle = () => setState(button.disabled ? 'disabled' : 'normal');
    button.addEventListener('pointerenter', () => { if (!button.disabled) setState('mouseOver'); });
    button.addEventListener('pointerleave', idle);
    button.addEventListener('pointerdown', () => { if (!button.disabled) setState('pressed'); });
    button.addEventListener('pointerup', idle);
    idle();
    return button;
  }

  private place(button: HTMLElement, frame: AssetFrame | undefined, padding = 4): void {
    if (!frame) return;
    button.style.left = `${frame.x - padding}px`;
    button.style.top = `${frame.y - padding}px`;
    button.style.width = `${frame.width + padding * 2}px`;
    button.style.height = `${frame.height + padding * 2}px`;
  }

  private renderLoading(): void {
    this.content.replaceChildren();
    const line = document.createElement('p');
    line.className = 'notebook-loading';
    line.textContent = uiText('notebookLoading', '正在读取图鉴……');
    this.content.append(line);
  }

  private showNotice(text: string): void {
    this.notice.textContent = text;
    this.notice.hidden = false;
  }

  private clearNotice(): void {
    this.notice.hidden = true;
    this.notice.textContent = '';
  }

  private context(): SectionContext | undefined {
    const directory = this.directory;
    if (!directory) return undefined;
    const snapshot = this.snapshot;
    return {
      directory,
      manifest: this.manifest,
      section: this.section,
      rows: snapshot?.rows ?? [],
      selectedKey: this.selection?.row.key,
      onSelect: (row, slotKey) => this.select(row, slotKey),
      blockedReason: snapshot?.blockedReason,
      // 页码／总页数都是服务器在 `notebookState` 里给的：渲染器只写进页眉，
      // 不参与判定，也不自己补一个服务器没给的分母。
      page: snapshot?.page ?? this.tab(this.section).page,
      ...(snapshot ? { pageCount: snapshot.pageCount } : {}),
      pageLabel: this.pageLabel(),
    };
  }

  /** 页眉上那一行「页签名 · 细分」。  全部是已本地化的可见名，不另外造词。 */
  private pageLabel(): string {
    // 鞍具不是页签：它的页眉要先说父页签（骑宠），再说子页（鞍具），
    // 否则页面上是一页看不出归属的条目。
    const tab = displayText(uiText(tabKeyFor(this.section), this.section));
    if (this.section === 'monster') {
      const region = this.directory ? regionList(this.directory)[this.tab('monster').page] : undefined;
      return region ? `${tab} · ${displayText(region.name)}` : tab;
    }
    const mode = this.tab(this.section).mode;
    const modeKey = `notebookMode${mode[0].toUpperCase()}${mode.slice(1)}`;
    const parts = [tab];
    if (this.section === 'saddle') parts.push(displayText(uiText('notebookSubSaddle', '鞍具')));
    parts.push(displayText(uiText(modeKey, mode)));
    return parts.join(' · ');
  }

  /** 整窗重绘。  结构（页签／侧栏／分页）与内容都在这里，纯展示。 */
  private render(): void {
    this.renderTabs();
    this.renderProgress();
    this.renderSide();
    this.renderPager();
    this.renderContent();
    this.renderDetail();
  }

  private renderTabs(): void {
    this.tabStrip.replaceChildren();
    // 鞍具是骑宠页的子页：顶栏仍是六个页签，子页里的鞍具要把父页签标成选中，
    // 否则玩家看到的是一页没有归属的条目（映射只在 `tabKeyFor` 里写一次）。
    const activeKey = tabKeyFor(this.section);
    for (const { section, key } of NOTEBOOK_TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notebook-tab';
      button.dataset.section = section;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tabKeyFor(section) === activeKey ? 'true' : 'false');
      button.textContent = displayText(uiText(key, section));
      // 底板不贴源图：`Tab/enabled|disabled` 把页签文字**烧在位图里**，贴上去
      // 会与这里画的文案叠字。样式表按源实测配色重画底板，选中态由
      // `aria-selected` 选中（计划 §6.4：四类内容导航是 P：界面扩展，
      // 可读文字按本地化自己画）。
      button.addEventListener('click', () => this.switchSection(section));
      this.tabStrip.append(button);
    }
  }

  private switchSection(section: NotebookSection): void {
    if (section === this.section) return;
    this.section = section;
    this.element.dataset.section = section;
    this.snapshot = undefined;
    this.selection = undefined;
    this.pending = undefined;
    void this.refresh();
  }

  /** 骑宠页的两个子页之间切换（骑宠 ⇄ 鞍具）。  与换页签同一套收尾：丢掉旧快照、
   *  丢掉选中格、丢掉待答请求，再重新问一次服务器——**自己绝不推测**。
   *  子页各自持有自己的页码／浏览方式（`tab(section)`），所以切回来还停在原处。 */
  private switchSubSection(section: NotebookSection): void {
    if (section === this.section) return;
    this.section = section;
    this.element.dataset.section = section;
    this.snapshot = undefined;
    this.selection = undefined;
    this.pending = undefined;
    void this.refresh();
  }

  /** 一位源位图数字（`number/0..9`，9x13）。缺帧返回 undefined。 */
  private progressDigit(digit: string): HTMLImageElement | undefined {
    const frame = this.manifest.notebook?.frames.monster?.[`number/${digit}`];
    if (!frame) return undefined;
    const image = document.createElement('img');
    image.src = frame.url;
    image.width = frame.width;
    image.height = frame.height;
    image.alt = '';
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    return image;
  }

  /** 一段纯数字：整段用源位图数字；**任何一位缺帧就整段退回文本**，
   *  不把两套字形混在一行里（混排的数字看起来像两个不同的计数器）。 */
  private digitRun(text: string, fallbackClass: string): HTMLElement {
    const images = [...text].map(character => this.progressDigit(character));
    if (images.some(image => !image)) {
      const fallback = document.createElement('span');
      fallback.className = `notebook-progress-fallback ${fallbackClass}`;
      fallback.textContent = text;
      return fallback;
    }
    const run = document.createElement('span');
    run.className = 'notebook-progress-digits';
    run.append(...(images as HTMLImageElement[]));
    return run;
  }

  /** 进度行。  任务页没有分母——未来的任务条目不是公开信息（§5.5）。 */
  private renderProgress(): void {
    const snapshot = this.snapshot;
    this.progressNode.replaceChildren();
    if (!snapshot) return;
    const progress = progressOf(snapshot.section, snapshot.summary);
    this.progressNode.append(this.digitRun(String(progress.done), 'notebook-progress-done'));
    if (progress.total !== null) {
      const slash = document.createElement('span');
      slash.className = 'notebook-progress-slash';
      slash.textContent = '/';
      this.progressNode.append(slash, this.digitRun(String(progress.total), 'notebook-progress-total'));
    }
    if (progress.note) {
      const note = document.createElement('span');
      note.className = 'notebook-progress-note';
      note.textContent = uiLocale() === 'en'
        ? `Collectable now: ${progress.note}`
        : `当前可收集 ${progress.note}`;
      this.progressNode.append(note);
    }
    if (snapshot.scope === 'account') {
      const scope = document.createElement('span');
      scope.className = 'notebook-progress-scope';
      scope.textContent = uiLocale() === 'en' ? 'Account-wide' : '账号共享';
      this.progressNode.append(scope);
    }
  }

  /** 侧栏：搜索框 + （怪物页的地区列表 / 物品页的浏览方式）。 */
  private renderSide(): void {
    this.side.replaceChildren();
    const directory = this.directory;
    if (!directory) return;

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'notebook-search';
    search.placeholder = uiText('notebookSearch', '搜索名称');
    search.value = this.tab(this.section).filter;
    search.maxLength = 32;
    search.setAttribute('aria-label', uiText('notebookSearch', '搜索名称'));
    search.addEventListener('input', () => {
      const state = this.tab(this.section);
      state.filter = search.value.trim();
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { state.page = 0; this.request(); }, 250);
    });
    // 搜索框里的按键（含输入法组词）绝不能漏到角色操作上。
    search.addEventListener('keydown', event => event.stopPropagation());
    this.side.append(search);

    if (this.section === 'monster') this.renderRegionList(directory);
    else {
      // 骑宠页先给「骑宠 / 鞍具」子页，再给浏览方式：子页决定看哪半张表，
      // 浏览方式决定在这半张表里筛什么。
      if (isMountFamily(this.section)) this.renderSubSections();
      this.renderBrowseModes();
    }
  }

  /** 骑宠页的两个子页按钮。  子页**不是**页签：顶栏仍是六个分区，这里只切这一页
   *  的查询分区（服务端把鞍具当独立分区，所以切换就是换一种查询，不是本地过滤）。 */
  private renderSubSections(): void {
    const group = document.createElement('div');
    group.className = 'notebook-subtabs';
    group.setAttribute('role', 'tablist');
    group.setAttribute('aria-label', uiText('notebookSubMount', '骑宠'));
    for (const { section, key } of MOUNT_SUBSECTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notebook-subtab';
      button.dataset.section = section;
      button.dataset.active = section === this.section ? 'true' : 'false';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', section === this.section ? 'true' : 'false');
      button.textContent = displayText(uiText(key, section));
      button.addEventListener('click', () => this.switchSubSection(section));
      group.append(button);
    }
    this.side.append(group);
  }

  private renderRegionList(directory: NotebookDirectory): void {
    const regions = regionList(directory);
    const current = this.tab('monster').page;
    const list = document.createElement('div');
    list.className = 'notebook-regions';
    regions.forEach((region, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notebook-region';
      button.dataset.active = index === current ? 'true' : 'false';
      // 源里有一个地区没有名字（region 100）。空名字直接当标题会得到一个
      // 认不出来的空按钮，所以标出「源未命名」而不是留白、也不编名字。
      button.textContent = displayText(region.name || uiText('notebookUnnamedRegion', '（源未命名地区）'));
      button.addEventListener('click', () => {
        const state = this.tab('monster');
        if (state.page === index) return;
        state.page = index;
        this.snapshot = undefined;
        this.request();
      });
      list.append(button);
    });
    this.side.append(list);
  }

  private renderBrowseModes(): void {
    const state = this.tab(this.section);
    const modes = document.createElement('div');
    modes.className = 'notebook-modes';
    for (const mode of browseModesFor(this.section)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notebook-mode';
      button.dataset.active = mode === state.mode ? 'true' : 'false';
      button.textContent = displayText(uiText(`notebookMode${mode[0].toUpperCase()}${mode.slice(1)}`, mode));
      button.addEventListener('click', () => {
        if (state.mode === mode) return;
        state.mode = mode;
        state.page = 0;
        this.snapshot = undefined;
        this.request();
      });
      modes.append(button);
    }
    this.side.append(modes);
  }

  private renderPager(): void {
    const frames = this.manifest.notebook?.frames.monster ?? {};
    this.pager.replaceChildren();
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const state = this.tab(snapshot.section);

    const prev = this.frameButton(frames, 'Collection/button:Prev', uiText('notebookPrev', '上一页'));
    if (prev) {
      prev.disabled = state.page <= 0;
      prev.addEventListener('click', () => this.gotoPage(state.page - 1));
      this.place(prev, frames['Collection/button:Prev/normal']);
      this.pager.append(prev);
    }
    const next = this.frameButton(frames, 'Collection/button:Next', uiText('notebookNext', '下一页'));
    if (next) {
      next.disabled = state.page + 1 >= snapshot.pageCount;
      next.addEventListener('click', () => this.gotoPage(state.page + 1));
      this.place(next, frames['Collection/button:Next/normal']);
      this.pager.append(next);
    }

    const numbers = document.createElement('div');
    numbers.className = 'notebook-pages';
    for (const entry of pageWindow(state.page, snapshot.pageCount)) {
      if (entry === '…') {
        const gap = document.createElement('span');
        gap.className = 'notebook-page-gap';
        gap.textContent = '…';
        numbers.append(gap);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notebook-page';
      button.dataset.active = entry === state.page ? 'true' : 'false';
      button.textContent = String(entry + 1);
      button.addEventListener('click', () => this.gotoPage(entry));
      numbers.append(button);
    }
    this.pager.append(numbers);
  }

  private gotoPage(page: number): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const state = this.tab(snapshot.section);
    const clamped = Math.min(Math.max(page, 0), Math.max(0, snapshot.pageCount - 1));
    if (clamped === state.page) return;
    state.page = clamped;
    this.request();
  }

  private renderContent(): void {
    const directory = this.directory;
    if (!directory) {
      this.content.replaceChildren();
      if (this.directoryError) {
        const line = document.createElement('p');
        line.className = 'notebook-error';
        line.textContent = uiText('notebookLoadFailed', '图鉴目录加载失败。');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'notebook-retry';
        retry.textContent = uiText('notebookRetry', '重试');
        retry.addEventListener('click', () => { this.directoryError = undefined; void this.refresh(); });
        this.content.append(line, retry);
      }
      return;
    }
    const context = this.context();
    if (!context) return;
    this.content.replaceChildren();
    if (this.section === 'monster') {
      const region = regionList(directory)[this.tab('monster').page];
      this.content.append(renderMonsterPage(context, region?.name ?? ''));
    } else {
      this.content.append(renderItemPage(context));
    }
  }

  private select(row: NotebookRow, slotKey?: string): void {
    const slot = slotKey ? row.slots?.find(entry => entry.key === slotKey) : undefined;
    this.selection = { row, ...(slot ? { slot } : {}) };
    this.renderDetail();
  }

  /** 详情面板。  物品页只读：这里只显示模板说明，不提供穿戴／使用／丢弃。 */
  private renderDetail(): void {
    const selection = this.selection;
    if (!selection) { this.detail.hidden = true; return; }
    const { row, slot } = selection;
    this.detail.replaceChildren();
    const heading = document.createElement('h5');
    heading.className = 'notebook-detail-title';
    const title = slot ? (slot.label || uiText('notebookUnknown', '未知怪物'))
      : (row.label || itemName(row.itemId ?? row.key));
    heading.textContent = displayText(title);
    this.detail.append(heading);

    const lines: string[] = [];
    // 配置 ID 先说：名字在源里可能根本不存在（骑宠 935 件里 840 件没有名字），
    // 只有源 id 与坐骑档是稳定的。
    const configId = slot ? slot.monsterTemplateId : (row.itemId ?? row.key);
    if (configId) lines.push(`${uiText('notebookConfigId', '配置 ID')}：${configId}`);
    if (slot) {
      lines.push(slot.registered
        ? uiText('notebookRegistered', '已登记')
        : slot.collectable ? uiText('notebookUnregistered', '尚未登记')
          : uiText('notebookUncollectable', '尚不可收集'));
      if (slot.detail) lines.push(displayText(slot.detail));
      if (slot.spawnMapIds?.length) {
        const maps = slot.spawnMapIds
          .map(id => this.manifest.mapCatalog?.maps.find(entry => entry.id === id)?.name)
          .filter((name): name is string => Boolean(name));
        if (maps.length) lines.push(`${uiText('notebookSpawn', '出没地图')}：${maps.map(displayText).join('、')}`);
      }
    } else {
      lines.push(row.obtained ? uiText('notebookObtained', '已获得') : uiText('notebookNotObtained', '未获得'));
      const itemId = row.itemId ?? row.key;
      // 骑宠额外报出它指向的坐骑档（`info.tamingMob`）：同一档坐骑共一套骑行数值，
      // 查源与核对骑行都要靠它。源里没有这一档就如实说没有。
      const mount = this.directory?.mounts?.[itemId];
      if (mount) {
        lines.push(`${uiText('notebookMountTier', '坐骑档')}：${mount.tamingMob === null
          ? uiText('notebookMountTierMissing', '源未提供')
          : mount.tamingMob}`);
      }
      // 鞍具额外报出它自己的佩戴等级：**没有**「坐骑档」这一行，因为源不给鞍具
      // `tamingMob`（骑乘判定也从不把它当坐骑）。等级缺席＝源没写，照实说。
      const saddle = this.directory?.saddles?.[itemId];
      if (saddle) {
        lines.push(`${uiText('notebookSaddleReqLevel', '佩戴等级')}：${saddle.reqLevel === null
          ? uiText('notebookMountTierMissing', '源未提供')
          : saddle.reqLevel}`);
      }
      // 椅子额外报出恢复量与节拍：源声明了恢复量就有节拍（椅子系统的固定 10 秒），
      // 两栏一起缺席＝源里这把椅子没有恢复量，照实说"源未提供"。
      const chair = this.directory?.chairs?.[itemId];
      if (chair) {
        const amounts = [
          chair.recoveryHP === null ? '' : `HP ${chair.recoveryHP}`,
          chair.recoveryMP === null ? '' : `MP ${chair.recoveryMP}`,
        ].filter(Boolean).join(' / ');
        const recovery = amounts
          ? `${amounts}（${Math.round((chair.recoveryIntervalMs ?? 0) / 1000)} 秒）`
          : uiText('notebookChairRecoveryMissing', '源未提供');
        lines.push(`${uiText('notebookChairRecovery', '恢复')}：${recovery}`);
      }
      const info = itemDetails(itemId);
      if (info) lines.push(info);
      if (row.firstRecordMs !== undefined && !row.timeUnknown) {
        lines.push(`${uiText('notebookFirstRecord', '首次记录')}：${new Date(row.firstRecordMs).toLocaleString()}`);
      } else if (row.timeUnknown) {
        // 补记的时间不是获得时间：如实说时间未知，不拿补记时刻冒充。
        lines.push(uiText('notebookTimeUnknown', '首次获得时间未知（历史补记）'));
      }
    }
    if (!lines.length) lines.push(uiText('notebookSourceUnverified', '获取来源待核实'));

    const body = document.createElement('p');
    body.className = 'notebook-detail-body';
    body.textContent = lines.join('\n');
    this.detail.append(body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'notebook-detail-close';
    close.textContent = '×';
    close.title = uiText('notebookClose', '关闭');
    close.setAttribute('aria-label', uiText('notebookDetailClose', '关闭详情'));
    close.addEventListener('click', () => { this.selection = undefined; this.renderDetail(); });
    this.detail.append(close);
    this.detail.hidden = false;
  }

  /** 给外部（main.ts）用的行键 → 行定义，便于将来接跳转；目前仅供断言。 */
  rowDefinitionOf(rowKey: string) {
    return this.directory ? rowDefinition(this.directory, rowKey) : undefined;
  }
}
