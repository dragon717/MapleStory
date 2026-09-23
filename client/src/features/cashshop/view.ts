import type { ClientMessage, PlayerState, ServerMessage } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { displayText, uiLocale } from '../../app/i18n';
import { resolveAssetUrl } from '../../assets/resource-url';
import { appearanceLayer, appearanceWeaponType, composeAppearance, loadAppearanceLayers, type AppearanceCatalog } from '../entry/appearance';
import { installWindowDrag, bringToFront, clampIntoHost } from '../ui/window-shell.ts';

type SendClientMessage = (message: ClientMessage) => boolean;

/** One category of the assembled catalogue (`/assets/cashshop.json`). */
export interface CashCategory {
  id: string;
  label: string;
}

/** A source fashion subcategory.  `families` contains the WZ equip prefixes. */
export interface CashFashionSubcategory {
  id: string;
  label: string;
  families?: number[] | null;
}

/** One purchasable source row (Etc/Commodity.img, OnSale=1). */
export interface CashCommodity {
  sn: string;
  itemId: string;
  count: number;
  price: number;
  bonus: number;
  period: number;
  gender: number;
  reqLevel: number;
  reqPop: number;
  priority: number;
  limit: number;
  refundable: boolean;
  tab: string;
  /** Optional fields are emitted by newer catalogue exports. */
  family?: number | string;
  effect?: string;
  featured?: boolean;
}

export interface CashShopData {
  contentVersion: string;
  categories: CashCategory[];
  commodities: CashCommodity[];
  itemNames: Record<string, string>;
  fashionSubcategories?: CashFashionSubcategory[];
  /** Alias kept for the exporter transition. */
  fashionSubs?: CashFashionSubcategory[];
}

/** One row of the cart: a deal plus how many times the player takes it. */
export interface CartEntry {
  sn: string;
  quantity: number;
}

interface PendingBuy {
  sn: string;
  itemId: string;
  quantity: number;
  source: 'cart' | 'direct';
}

interface FashionSubcategory extends CashFashionSubcategory {
  families: number[] | null;
}

const CASH_SHOP_TITLE_HEIGHT = 31; // TMS273 CashShop base top strip.

const SOURCE_SIDEBAR: readonly CashCategory[] = [
  { id: 'home', label: '主頁' },
  { id: 'event', label: '活動' },
  { id: 'gacha', label: '轉蛋' },
  { id: 'enhance', label: '強化' },
  { id: 'game', label: '遊戲' },
  { id: 'beauty', label: '美容' },
  { id: 'fashion', label: '時裝' },
  { id: 'pet', label: '寵物' },
  { id: 'package', label: '套裝' },
  { id: 'search', label: '搜尋' },
];

/* The source export currently carries this in the node exporter.  Keeping the
 * fallback here lets an older cashshop.json still expose the authored browse
 * groups while the data bundle is rebuilt. */
const DEFAULT_FASHION_SUBS: readonly FashionSubcategory[] = [
  { id: 'all', label: '全部', families: null },
  { id: 'cap', label: '帽子', families: [100] },
  { id: 'face', label: '臉飾', families: [101, 102, 103] },
  { id: 'overall', label: '連身衣', families: [105] },
  { id: 'coat', label: '上衣', families: [104] },
  { id: 'pants', label: '褲／裙', families: [106] },
  { id: 'shoes', label: '鞋子', families: [107] },
  { id: 'glove', label: '手套', families: [108] },
  { id: 'cape', label: '披風／飾品', families: [109, 110, 111, 112, 113, 116, 118, 120, 160] },
  { id: 'weapon', label: '武器', families: [170] },
];

const RECHARGE_NAME = /(?:楓點|枫点|楓葉點數|枫叶点数|點數|点数)\s*(?:充值|儲值|储值|交換券|兑换券)|(?:充值|儲值|储值)\s*(?:楓點|枫点|點數|点数)/i;
const EXTENSION_NAME = /(?:擴充|扩充).*(?:欄|栏|格)|(?:欄|栏|格).*(?:擴充|扩充)/i;

/** Numeric and padded item spellings used by the old and new cash exports. */
export function itemIdKeys(itemId: string | number): string[] {
  const raw = String(itemId).trim();
  if (!/^\d+$/.test(raw)) return [raw];
  const numeric = String(Number(raw));
  return [...new Set([raw, numeric, raw.padStart(8, '0'), numeric.padStart(8, '0')])];
}

/** TMS item family, shared by the fashion filters and home highlights. */
export function cashItemFamily(itemId: string | number): number | undefined {
  const numeric = Number(String(itemId).trim());
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric / 10000) : undefined;
}

function commodityName(nameOf: (itemId: string) => string, entry: CashCommodity): string {
  return nameOf(entry.itemId) || entry.itemId;
}

function isDisplayableCommodity(entry: CashCommodity, nameOf: (itemId: string) => string): boolean {
  return Number.isFinite(entry.price) && entry.price > 0 && !RECHARGE_NAME.test(commodityName(nameOf, entry));
}

/** Remove recharge rows and return the source priority order for one view. */
export function filterCashCommodities(
  commodities: readonly CashCommodity[],
  tab: string,
  query: string,
  fashionSub: CashFashionSubcategory | undefined,
  nameOf: (itemId: string) => string,
): CashCommodity[] {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = commodities.filter(entry => {
    if (!isDisplayableCommodity(entry, nameOf)) return false;
    if (needle) {
      const haystack = `${commodityName(nameOf, entry)} ${entry.itemId} ${entry.sn}`.toLocaleLowerCase();
      return haystack.includes(needle);
    }
    if (tab === 'search') return false;
    if (entry.tab !== tab) return false;
    if (tab !== 'fashion' || !fashionSub || !fashionSub.families?.length) return true;
    const family = typeof entry.family === 'number' ? entry.family : cashItemFamily(entry.itemId);
    return family !== undefined && fashionSub.families.includes(family);
  });
  return filtered.slice().sort((left, right) => (left.priority - right.priority) || left.sn.localeCompare(right.sn));
}

function textFor(key: string, zh: string, en: string): string {
  return uiLocale() === 'en' ? en : displayText(zh || key);
}

function slotTokens(value?: string): string[] {
  return value?.match(/.{2}/g) ?? [];
}

/** Page components of the 現金商店 window, painted over the source shell. */
export class CashShopView {
  private readonly host: HTMLElement;
  private readonly manifest: Manifest;
  private root?: HTMLDivElement;
  private grid?: HTMLElement;
  private gridList?: HTMLDivElement;
  private detail?: HTMLDivElement;
  private cartRoot?: HTMLDivElement;
  private balanceEl?: HTMLElement;
  private totalEl?: HTMLElement;
  private statusLine?: HTMLElement;
  private resultCount?: HTMLElement;
  private searchInput?: HTMLInputElement;
  private fashionSubRoot?: HTMLDivElement;
  private previewStage?: HTMLDivElement;
  private previewCaption?: HTMLElement;
  private previewClear?: HTMLButtonElement;
  private previewRequest = 0;
  private readonly loadingAppearanceIds = new Set<string>();
  private dragDispose?: () => void;
  private resizeObserver?: ResizeObserver;
  private activeTab = 'home';
  private fashionSub = 'all';
  private searchTerm = '';
  private previewEntry?: CashCommodity;
  private player?: PlayerState;
  private readonly cart = new Map<string, CartEntry>();
  private readonly pending = new Map<string, PendingBuy>();
  /** Authoritative wallet from the latest `cashState` / `cashBuyResult`. */
  private cash = 0;
  private data?: CashShopData;
  private readonly send: SendClientMessage;
  private requestSequence = 0;
  private readonly status: (message: string, error?: boolean) => void;

  constructor(host: HTMLElement, manifest: Manifest, status: (message: string, error?: boolean) => void, send: SendClientMessage = () => false) {
    this.host = host;
    this.manifest = manifest;
    this.send = send;
    this.status = status;
    window.addEventListener('keydown', this.onKeyDown, true);
    void this.loadData();
  }

  isOpen(): boolean {
    return Boolean(this.root);
  }

  open() {
    if (this.root) return;
    if (!this.data) {
      this.status('现金商店资源加载中，请稍候再试。', true);
      return;
    }
    this.buildWindow();
    // Opening asks the server for the fresh wallet; the readout updates when
    // cashState lands and remains seeded by the latest PlayerState snapshot.
    this.request('cashOpen');
  }

  close() {
    this.previewRequest += 1;
    this.root?.removeEventListener('pointerdown', this.activate);
    this.dragDispose?.();
    this.dragDispose = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.root?.remove();
    this.root = undefined;
    this.grid = undefined;
    this.gridList = undefined;
    this.detail = undefined;
    this.cartRoot = undefined;
    this.balanceEl = undefined;
    this.totalEl = undefined;
    this.statusLine = undefined;
    this.resultCount = undefined;
    this.searchInput = undefined;
    this.fashionSubRoot = undefined;
    this.previewStage = undefined;
    this.previewCaption = undefined;
    this.previewClear = undefined;
  }

  clear() {
    this.close();
  }

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.close();
  }

  /** Accept the complete snapshot so preview uses the same look as the actor. */
  syncPlayer(player: PlayerState) {
    this.player = player;
    if (typeof player.cash === 'number') this.cash = player.cash;
    this.renderBalance();
    if (this.root) {
      this.renderPreview(this.previewEntry);
      this.ensureAppearanceLayers(this.previewEntry);
    }
  }

  receive(message: Extract<ServerMessage, { type: 'cashState' | 'cashBuyResult' }>) {
    if (!message.requestId.startsWith('cash-')) return;
    this.cash = message.cash;
    this.renderBalance();
    if (message.type !== 'cashBuyResult') return;

    const pending = this.pending.get(message.requestId);
    this.pending.delete(message.requestId);
    if (!pending) return;
    if (message.success) {
      if (pending.source === 'cart') {
        const row = this.cart.get(pending.sn);
        if (row) {
          row.quantity -= pending.quantity;
          if (row.quantity <= 0) this.cart.delete(pending.sn);
        }
      }
      this.notify(`已购买 ${this.nameOf(message.itemId || pending.itemId)}。`);
    } else {
      // The cart row remains intact so the player can correct the request or
      // retry after a transient send/server failure.
      this.notify(`购买失败：${this.codeText(message.code)}`, true);
    }
    this.renderCart();
  }

  // ------------------------------------------------------------------ data

  private async loadData() {
    try {
      const response = await fetch(resolveAssetUrl('/assets/cashshop.json'));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.data = (await response.json()) as CashShopData;
      if (this.root) this.renderAll();
    } catch (error) {
      this.status(`现金商店数据加载失败：${(error as Error).message}`, true);
    }
  }

  private nameOf(itemId: string): string {
    const names = this.data?.itemNames ?? {};
    for (const key of itemIdKeys(itemId)) {
      const value = names[key];
      if (value) return value;
    }
    return itemId;
  }

  private frameOf(itemId: string): AssetFrame | undefined {
    const frames = this.manifest.cashItems ?? {};
    for (const key of itemIdKeys(itemId)) {
      const value = frames[key];
      if (value) return value;
    }
    return undefined;
  }

  private codeText(code: string): string {
    const zh: Record<string, string> = {
      cash_sn_unknown: '商品不存在或已下架',
      cash_not_purchasable: '该商品不支持直接购买',
      cash_not_enough: '楓點余额不足',
      cash_inventory_full: '背包已满',
      cash_item_unknown: '道具不存在',
      cash_req_level: '等级不足',
      cash_req_pop: '人气度不足',
      cash_limit: '已达该商品的购买上限',
      cash_gender: '该商品不适合当前角色',
      cash_quantity_invalid: '数量无效',
      cash_shop_unavailable: '商店暂不可用',
      cash_rejected: '购买被拒绝',
    };
    return zh[code] ?? code;
  }

  private request(type: 'cashOpen' | 'cashBuy', sn?: string, quantity?: number): boolean {
    const requestId = `cash-${++this.requestSequence}-${Date.now().toString(36)}`;
    const message: ClientMessage = type === 'cashBuy' && sn
      ? { type: 'cashBuy', requestId, sn, quantity: quantity ?? 1 }
      : { type: 'cashOpen', requestId };
    const accepted = this.send(message);
    if (!accepted) {
      this.notify(type === 'cashBuy' ? '购买请求未发送，请检查连接。' : '现金商店请求未发送，请检查连接。', true);
      return false;
    }
    return true;
  }

  private requestBuy(entry: CashCommodity, quantity: number, source: PendingBuy['source']): boolean {
    const requestId = `cash-${++this.requestSequence}-${Date.now().toString(36)}`;
    const accepted = this.send({ type: 'cashBuy', requestId, sn: entry.sn, quantity });
    if (!accepted) {
      this.notify('购买请求未发送，请检查连接。', true);
      return false;
    }
    this.pending.set(requestId, { sn: entry.sn, itemId: entry.itemId, quantity, source });
    this.renderCart();
    return true;
  }

  private notify(message: string, error = false) {
    this.status(message, error);
    if (this.statusLine) {
      this.statusLine.textContent = message;
      this.statusLine.classList.toggle('is-error', error);
    }
  }

  // ---------------------------------------------------------------- window

  private get ui(): Record<string, AssetFrame> {
    return this.manifest.cashshopUi ?? {};
  }

  private safeImage(asset: { url: string; width?: number; height?: number }, className: string, owner?: HTMLElement): HTMLImageElement {
    const image = document.createElement('img');
    image.className = className;
    image.src = resolveAssetUrl(asset.url);
    if (asset.width && asset.width > 0) image.width = asset.width;
    if (asset.height && asset.height > 0) image.height = asset.height;
    image.alt = '';
    image.draggable = false;
    image.decoding = 'async';
    image.setAttribute('aria-hidden', 'true');
    image.addEventListener('error', () => {
      image.remove();
      owner?.classList.add('is-missing');
    }, { once: true });
    return image;
  }

  private sourceImage(key: string, className: string, owner?: HTMLElement): HTMLImageElement | undefined {
    const frame = this.ui[key];
    if (!frame) return undefined;
    return this.safeImage(frame, className, owner);
  }

  private buildWindow() {
    const root = document.createElement('div');
    root.className = 'cash-shop';
    root.dataset.layout = 'source';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', textFor('cashShop', '現金商店', 'Cash Shop'));

    const handle = document.createElement('div');
    handle.className = 'cash-shop-drag-handle';
    handle.style.height = `${CASH_SHOP_TITLE_HEIGHT}px`;
    handle.title = textFor('drag', '拖動商店視窗', 'Drag shop window');
    root.appendChild(handle);

    const base = this.sourceImage('backgrnd', 'cash-shop-layer cash-shop-layer-base', root);
    if (base) root.appendChild(base);
    const heading = document.createElement('h2');
    heading.className = 'cash-shop-title sr-only';
    heading.textContent = textFor('cashShop', '現金商店', 'Cash Shop');
    root.appendChild(heading);

    const balance = document.createElement('div');
    balance.className = 'cash-shop-balance';
    balance.setAttribute('aria-label', textFor('cash', '楓點余额', 'Cash balance'));
    const balanceLabel = document.createElement('span');
    balanceLabel.className = 'cash-shop-balance-label';
    balanceLabel.textContent = textFor('cash', '楓點', 'Cash');
    this.balanceEl = document.createElement('b');
    balance.append(balanceLabel, this.balanceEl);
    root.appendChild(balance);

    const sidebar = document.createElement('nav');
    sidebar.className = 'cash-shop-sidebar';
    sidebar.setAttribute('aria-label', textFor('categories', '商品分類', 'Categories'));
    root.appendChild(sidebar);
    this.renderSidebarSprite();

    const exit = this.spriteButton('BtExit', () => this.close(), textFor('close', '離開', 'Close'));
    exit.classList.add('cash-shop-exit');
    root.appendChild(exit);

    const toolbar = document.createElement('div');
    toolbar.className = 'cash-shop-toolbar';
    const searchLabel = document.createElement('label');
    searchLabel.className = 'cash-shop-search-label';
    searchLabel.textContent = textFor('search', '搜尋商品', 'Search');
    const search = document.createElement('input');
    search.className = 'cash-shop-search-input';
    search.type = 'search';
    search.placeholder = textFor('searchPlaceholder', '輸入道具名稱或編號', 'Item name or id');
    search.autocomplete = 'off';
    search.setAttribute('aria-label', searchLabel.textContent);
    search.addEventListener('input', () => {
      this.searchTerm = search.value;
      if (this.searchTerm.trim()) this.activeTab = 'search';
      this.renderSidebar();
      this.renderGrid();
    });
    this.searchInput = search;
    const searchButton = this.spriteButton('Bt_magnifier', () => {
      search.focus();
      if (!this.searchTerm.trim()) {
        this.activeTab = 'search';
        this.renderSidebar();
        this.renderGrid();
      }
    }, textFor('search', '搜尋', 'Search'));
    searchButton.classList.add('cash-shop-search-button');
    searchLabel.htmlFor = search.id = `cash-shop-search-${Date.now().toString(36)}`;
    toolbar.append(searchLabel, search, searchButton);
    this.fashionSubRoot = document.createElement('div');
    this.fashionSubRoot.className = 'cash-fashion-subcategories';
    toolbar.appendChild(this.fashionSubRoot);
    this.resultCount = document.createElement('span');
    this.resultCount.className = 'cash-shop-result-count';
    toolbar.appendChild(this.resultCount);
    root.appendChild(toolbar);

    const grid = document.createElement('section');
    grid.className = 'cash-shop-grid';
    grid.setAttribute('aria-live', 'polite');
    this.grid = grid;
    this.gridList = document.createElement('div');
    this.gridList.className = 'cash-grid-list';
    grid.appendChild(this.gridList);
    root.appendChild(grid);

    const preview = document.createElement('section');
    preview.className = 'cash-shop-preview';
    preview.setAttribute('aria-label', textFor('preview', '角色預覽', 'Character preview'));
    this.previewStage = document.createElement('div');
    this.previewStage.className = 'cash-preview-stage';
    this.previewCaption = document.createElement('p');
    this.previewCaption.className = 'cash-preview-caption';
    this.previewClear = document.createElement('button');
    this.previewClear.type = 'button';
    this.previewClear.className = 'cash-preview-clear';
    this.previewClear.textContent = textFor('clearPreview', '顯示目前外觀', 'Show current look');
    this.previewClear.addEventListener('click', () => {
      this.previewEntry = undefined;
      this.previewRequest += 1;
      this.renderPreview();
    });
    preview.append(this.previewStage, this.previewCaption, this.previewClear);
    root.appendChild(preview);

    const cartPanel = document.createElement('section');
    cartPanel.className = 'cash-shop-cart-panel';
    const cartHead = document.createElement('div');
    cartHead.className = 'cash-shop-cart-head';
    const cartTitle = document.createElement('span');
    cartTitle.textContent = textFor('cart', '購物車', 'Cart');
    const clearCart = document.createElement('button');
    clearCart.type = 'button';
    clearCart.className = 'cash-shop-cart-clear';
    clearCart.textContent = textFor('clearCart', '清空', 'Clear');
    clearCart.addEventListener('click', () => {
      this.cart.clear();
      this.renderCart();
    });
    cartHead.append(cartTitle, clearCart);

    const cart = document.createElement('div');
    cart.className = 'cash-shop-cart';
    this.cartRoot = cart;
    const cartFoot = document.createElement('div');
    cartFoot.className = 'cash-shop-cart-foot';
    this.statusLine = document.createElement('div');
    this.statusLine.className = 'cash-shop-status';
    const total = document.createElement('div');
    total.className = 'cash-shop-total';
    const totalLabel = document.createElement('span');
    totalLabel.textContent = textFor('total', '合計', 'Total');
    this.totalEl = document.createElement('b');
    total.append(totalLabel, this.totalEl);
    const checkout = this.spriteButton('BtBuy', () => this.checkout(), textFor('checkout', '結算', 'Checkout'));
    checkout.classList.add('cash-shop-checkout');
    cartFoot.append(this.statusLine, total, checkout);
    cartPanel.append(cartHead, cart, cartFoot);
    root.appendChild(cartPanel);

    this.host.appendChild(root);
    this.root = root;
    root.addEventListener('pointerdown', this.activate);
    this.activate();
    this.dragDispose = installWindowDrag(this.host, root, { titleHeight: CASH_SHOP_TITLE_HEIGHT, isOpen: () => Boolean(this.root) && !this.detail });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.fitRootToHost());
      this.resizeObserver.observe(this.host);
    }
    this.fitRootToHost();
    this.renderAll();
  }

  private activate = () => {
    if (this.root) bringToFront(this.host, this.root);
  };

  private fitRootToHost() {
    if (!this.root) return;
    const rect = this.host.getBoundingClientRect();
    const hostWidth = rect.width || window.innerWidth;
    const hostHeight = rect.height || window.innerHeight;
    const availableWidth = Math.max(280, Math.floor(hostWidth - 12));
    const availableHeight = Math.max(200, Math.floor(hostHeight - 12));
    // The source artwork is a fixed 1024×768 composition.  Its toolbar,
    // preview and cart coordinates are authored in that same pixel space, so
    // scaling only the root produces overlaps as soon as one axis is shorter
    // than the artwork.  Use the source layout only when the host can contain
    // it; all smaller hosts use the responsive flow layout.
    if (availableWidth >= 1024 && availableHeight >= 768) {
      this.root.dataset.layout = 'source';
      this.root.style.width = '1024px';
      this.root.style.height = '768px';
    } else {
      this.root.dataset.layout = 'reflow';
      this.root.style.width = `${Math.min(1024, availableWidth)}px`;
      this.root.style.height = `${Math.min(768, availableHeight)}px`;
    }
    clampIntoHost(this.host, this.root);
  }

  private sidebarCategories(): CashCategory[] {
    const labels = new Map((this.data?.categories ?? []).map(category => [category.id, category.label]));
    const result = SOURCE_SIDEBAR.map(category => ({ ...category, label: labels.get(category.id) ?? category.label }));
    for (const category of this.data?.categories ?? []) {
      if (!result.some(existing => existing.id === category.id)) result.push(category);
    }
    return result;
  }

  /** Paint the source sidebar art; labels remain in buttons for narrow layouts. */
  private renderSidebarSprite() {
    const sidebar = this.root?.querySelector<HTMLElement>('.cash-shop-sidebar');
    if (!sidebar) return;
    if (this.root) this.root.dataset.tab = this.activeTab;
    sidebar.querySelector('.cash-shop-sidebar-sprite')?.remove();
    const sprite = this.sourceImage(`tab:${this.activeTab}`, 'cash-shop-sidebar-sprite', sidebar)
      ?? this.sourceImage('tab:home', 'cash-shop-sidebar-sprite', sidebar);
    if (sprite) sidebar.prepend(sprite);
    const existing = new Set<string>();
    for (const row of Array.from(sidebar.querySelectorAll<HTMLButtonElement>('.cash-shop-cat'))) existing.add(row.dataset.tab ?? '');
    for (const category of this.sidebarCategories()) {
      if (existing.has(category.id)) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cash-shop-cat';
      row.dataset.tab = category.id;
      row.textContent = displayText(category.label);
      row.title = displayText(category.label);
      row.addEventListener('click', () => this.selectTab(category.id));
      sidebar.appendChild(row);
    }
    for (const row of Array.from(sidebar.querySelectorAll<HTMLButtonElement>('.cash-shop-cat'))) {
      row.classList.toggle('is-active', row.dataset.tab === this.activeTab);
    }
  }

  private selectTab(tab: string) {
    this.activeTab = tab;
    if (tab !== 'search') {
      this.searchTerm = '';
      if (this.searchInput) this.searchInput.value = '';
    }
    this.renderSidebar();
    this.renderGrid();
    if (tab === 'search') this.searchInput?.focus();
  }

  private renderSidebar() {
    if (!this.root) return;
    this.renderSidebarSprite();
  }

  private fashionSubcategories(): FashionSubcategory[] {
    const source = this.data?.fashionSubcategories ?? this.data?.fashionSubs;
    const list = source?.length ? source : DEFAULT_FASHION_SUBS;
    return list.map(sub => ({ ...sub, families: sub.families?.length ? sub.families : null }));
  }

  private renderFashionSubcategories() {
    if (!this.fashionSubRoot) return;
    this.fashionSubRoot.replaceChildren();
    const visible = this.activeTab === 'fashion' && !this.searchTerm.trim();
    this.fashionSubRoot.hidden = !visible;
    if (!visible) return;
    for (const sub of this.fashionSubcategories()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cash-fashion-sub';
      button.textContent = displayText(sub.label);
      button.classList.toggle('is-active', sub.id === this.fashionSub);
      button.addEventListener('click', () => {
        this.fashionSub = sub.id;
        this.renderGrid();
      });
      this.fashionSubRoot.appendChild(button);
    }
  }

  private renderAll() {
    this.renderBalance();
    this.renderSidebar();
    this.renderGrid();
    this.renderCart();
    this.renderPreview(this.previewEntry);
    this.ensureAppearanceLayers(this.previewEntry);
  }

  private renderBalance() {
    if (this.balanceEl) this.balanceEl.textContent = this.cash.toLocaleString();
  }

  private currentFashionSub(): FashionSubcategory | undefined {
    return this.fashionSubcategories().find(sub => sub.id === this.fashionSub) ?? this.fashionSubcategories()[0];
  }

  private commoditiesFor(tab = this.activeTab, query = this.searchTerm): CashCommodity[] {
    return filterCashCommodities(this.data?.commodities ?? [], tab, query, this.currentFashionSub(), itemId => this.nameOf(itemId));
  }

  private isFashion(entry: CashCommodity): boolean {
    const family = typeof entry.family === 'number' ? entry.family : cashItemFamily(entry.itemId);
    return entry.tab === 'fashion' || (family !== undefined && family >= 100 && family <= 170);
  }

  private featuredEntries(): Array<{ label: string; entry: CashCommodity }> {
    const nameOf = (itemId: string) => this.nameOf(itemId);
    const available = (this.data?.commodities ?? []).filter(entry => isDisplayableCommodity(entry, nameOf));
    const find = (predicate: (entry: CashCommodity) => boolean) => {
      const entry = available
        .filter(predicate)
        .sort((left, right) => (left.priority - right.priority) || left.sn.localeCompare(right.sn))[0];
      return entry;
    };
    const extension = find(entry => EXTENSION_NAME.test(this.nameOf(entry.itemId)));
    const pet = find(entry => cashItemFamily(entry.itemId) === 500);
    const fashion = find(entry => [104, 105].includes(cashItemFamily(entry.itemId) ?? 0))
      ?? find(entry => this.isFashion(entry));
    return [
      extension && { label: textFor('extension', '欄位擴充', 'Slot expansion'), entry: extension },
      pet && { label: textFor('pet', '寵物', 'Pets'), entry: pet },
      fashion && { label: textFor('fashion', '時裝', 'Fashion'), entry: fashion },
    ].filter((value): value is { label: string; entry: CashCommodity } => Boolean(value));
  }

  /** One card of the ItemGrid: icon, name, deal size, price and condition tags. */
  private itemCard(entry: CashCommodity): HTMLElement {
    const card = document.createElement('article');
    card.className = 'cash-card';
    card.dataset.sn = entry.sn;
    card.tabIndex = 0;
    card.setAttribute('role', 'group');
    const icon = document.createElement('div');
    icon.className = 'cash-card-icon';
    const frame = this.frameOf(entry.itemId);
    if (frame) icon.appendChild(this.safeImage(frame, 'cash-item-image', icon));
    else icon.classList.add('is-missing');
    if (entry.count > 1) {
      const badge = document.createElement('span');
      badge.className = 'cash-card-count';
      badge.textContent = `×${entry.count}`;
      icon.appendChild(badge);
    }
    const name = document.createElement('div');
    name.className = 'cash-card-name';
    name.textContent = displayText(this.nameOf(entry.itemId));
    name.title = name.textContent;
    const tags = document.createElement('div');
    tags.className = 'cash-card-tags';
    if (entry.period > 0) this.addTag(tags, `${entry.period}天`);
    if (entry.gender !== 2) this.addTag(tags, entry.gender === 0 ? '男' : '女');
    if (entry.reqLevel > 0) this.addTag(tags, `${entry.reqLevel}级+`);
    const price = document.createElement('div');
    price.className = 'cash-card-price';
    price.textContent = `${entry.price.toLocaleString()} 楓點`;
    const actions = document.createElement('div');
    actions.className = 'cash-card-actions';
    const details = this.spriteButton('Bt_magnifier', () => this.openDetail(entry), textFor('details', '詳情', 'Details'));
    details.classList.add('cash-card-details');
    const buy = this.spriteButton('BtBuy', () => this.buyDirect(entry), textFor('buy', '購買', 'Buy'));
    buy.classList.add('cash-card-buy');
    actions.append(details, buy);
    card.append(icon, name, tags, price, actions);
    card.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('button')) return;
      this.openDetail(entry);
    });
    card.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === card) {
        event.preventDefault();
        this.openDetail(entry);
      }
    });
    card.addEventListener('contextmenu', event => {
      if (!this.isFashion(entry)) return;
      event.preventDefault();
      this.tryOn(entry);
    });
    return card;
  }

  private addTag(parent: HTMLElement, label: string) {
    const tag = document.createElement('span');
    tag.className = 'cash-card-tag';
    tag.textContent = label;
    parent.appendChild(tag);
  }

  private renderGrid() {
    if (!this.gridList) return;
    this.renderFashionSubcategories();
    this.gridList.replaceChildren();
    const entries = this.commoditiesFor();
    if (this.resultCount) this.resultCount.textContent = `${entries.length}${textFor('items', ' 件', ' items')}`;

    if (this.activeTab === 'home' && !this.searchTerm.trim()) {
      const features = this.featuredEntries();
      if (features.length) {
        const featureTitle = document.createElement('h3');
        featureTitle.className = 'cash-home-title';
        featureTitle.textContent = textFor('featured', '推薦商品', 'Featured');
        const featureGrid = document.createElement('div');
        featureGrid.className = 'cash-home-features';
        for (const feature of features) {
          const card = this.itemCard(feature.entry);
          card.classList.add('cash-card-feature');
          card.setAttribute('data-feature-label', feature.label);
          featureGrid.appendChild(card);
        }
        this.gridList.append(featureTitle, featureGrid);
      }
    }

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'cash-grid-empty';
      const image = this.sourceImage('noItem', 'cash-grid-empty-image', empty);
      if (image) empty.appendChild(image);
      const note = document.createElement('p');
      note.textContent = this.activeTab === 'search' && !this.searchTerm.trim()
        ? textFor('searchHint', '請輸入商品名稱或編號。', 'Type an item name or id to search.')
        : textFor('noItems', '該分類暫時沒有在售商品。', 'Nothing is on sale here yet.');
      empty.appendChild(note);
      this.gridList.appendChild(empty);
      return;
    }
    const listTitle = document.createElement('h3');
    listTitle.className = 'cash-grid-title';
    listTitle.textContent = this.activeTab === 'home' && !this.searchTerm.trim()
      ? textFor('homeItems', '全部商品', 'All items')
      : textFor('items', '商品列表', 'Items');
    const list = document.createElement('div');
    list.className = 'cash-grid-items';
    for (const entry of entries) list.appendChild(this.itemCard(entry));
    this.gridList.append(listTitle, list);
  }

  // ---------------------------------------------------------------- detail

  private openDetail(entry: CashCommodity) {
    this.closeDetail();
    const overlay = document.createElement('div');
    overlay.className = 'cash-detail';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', displayText(this.nameOf(entry.itemId)));
    const name = document.createElement('div');
    name.className = 'cash-detail-name';
    name.textContent = displayText(this.nameOf(entry.itemId));
    const icon = document.createElement('div');
    icon.className = 'cash-detail-icon';
    const frame = this.frameOf(entry.itemId);
    if (frame) icon.appendChild(this.safeImage(frame, 'cash-item-image', icon));
    else icon.classList.add('is-missing');

    const facts = document.createElement('ul');
    facts.className = 'cash-detail-facts';
    const rows: string[] = [
      `價格：${entry.price.toLocaleString()} 楓點`,
      entry.count > 1 ? `每次購買 ${entry.count} 個` : '每次購買 1 個',
      entry.period > 0 ? `有效期 ${entry.period} 天` : '永久有效',
      entry.gender !== 2 ? (entry.gender === 0 ? '限定男性角色' : '限定女性角色') : '男女通用',
    ];
    if (entry.reqLevel > 0) rows.push(`需要等級 ${entry.reqLevel}`);
    if (entry.limit > 0) rows.push(`限購 ${entry.limit} 次`);
    for (const value of rows) {
      const row = document.createElement('li');
      row.textContent = value;
      facts.appendChild(row);
    }

    const qtyRow = document.createElement('div');
    qtyRow.className = 'cash-detail-qty';
    const qtyLabel = document.createElement('span');
    qtyLabel.textContent = '購買次數';
    const input = document.createElement('input');
    input.className = 'cash-detail-input';
    input.type = 'number';
    input.min = '1';
    input.max = '99';
    input.value = '1';
    const total = document.createElement('span');
    total.className = 'cash-detail-total';
    const count = () => Math.min(99, Math.max(1, Math.floor(Number(input.value) || 1)));
    const updateTotal = () => { total.textContent = `合計 ${(entry.price * count()).toLocaleString()} 楓點`; };
    input.addEventListener('input', updateTotal);
    updateTotal();
    qtyRow.append(qtyLabel, input, total);

    const buttons = document.createElement('div');
    buttons.className = 'cash-detail-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cash-shop-tab-btn';
    cancel.textContent = textFor('close', '關閉', 'Close');
    cancel.addEventListener('click', () => this.closeDetail());
    if (this.isFashion(entry)) {
      const layer = this.appearanceLayer(entry);
      const hasIndex = this.manifest.appearanceCatalog && this.hasAppearanceIndex(this.manifest.appearanceCatalog, entry.itemId);
      if (layer || hasIndex) {
        const tryOn = document.createElement('button');
        tryOn.type = 'button';
        tryOn.className = 'cash-shop-tab-btn cash-detail-try-on';
        tryOn.textContent = textFor('tryOn', '試穿', 'Try on');
        tryOn.addEventListener('click', () => this.tryOn(entry));
        buttons.appendChild(tryOn);
      }
    }
    const addCart = this.spriteButton('BtBuy', () => {
      this.addToCart(entry.sn, count());
      this.closeDetail();
    }, textFor('addCart', '加入購物車', 'Add to cart'));
    addCart.classList.add('cash-detail-cart');
    const buyNow = this.spriteButton('BtBuy', () => {
      this.closeDetail();
      this.buyDirect(entry, count());
    }, textFor('buy', '立即購買', 'Buy now'));
    buyNow.classList.add('cash-detail-buy');
    buttons.prepend(cancel);
    buttons.append(addCart, buyNow);
    overlay.append(name, icon, facts, qtyRow, buttons);
    this.root?.appendChild(overlay);
    this.detail = overlay;
  }

  private closeDetail() {
    this.detail?.remove();
    this.detail = undefined;
  }

  // ------------------------------------------------------------------ cart

  private addToCart(sn: string, quantity: number) {
    const amount = Math.min(99, Math.max(1, Math.floor(quantity) || 1));
    const entry = this.cart.get(sn);
    if (entry) entry.quantity = Math.min(99, entry.quantity + amount);
    else this.cart.set(sn, { sn, quantity: amount });
    this.notify('已加入購物車。');
    this.renderCart();
  }

  private pendingFor(sn: string): number {
    let count = 0;
    for (const request of this.pending.values()) if (request.sn === sn) count += 1;
    return count;
  }

  private cartTotal(): number {
    let total = 0;
    for (const entry of this.cart.values()) {
      const commodity = this.data?.commodities.find(row => row.sn === entry.sn);
      if (commodity) total += commodity.price * entry.quantity;
    }
    return total;
  }

  private renderCart() {
    if (!this.cartRoot) return;
    this.cartRoot.replaceChildren();
    if (!this.cart.size) {
      const empty = document.createElement('div');
      empty.className = 'cash-cart-empty';
      empty.textContent = textFor('cartEmpty', '購物車是空的。', 'The cart is empty.');
      this.cartRoot.appendChild(empty);
    }
    for (const entry of this.cart.values()) {
      const commodity = this.data?.commodities.find(row => row.sn === entry.sn);
      if (!commodity) continue;
      const pending = this.pendingFor(entry.sn) > 0;
      const row = document.createElement('div');
      row.className = 'cash-cart-row';
      row.classList.toggle('is-pending', pending);
      const icon = document.createElement('div');
      icon.className = 'cash-cart-icon';
      const frame = this.frameOf(commodity.itemId);
      if (frame) icon.appendChild(this.safeImage(frame, 'cash-item-image', icon));
      else icon.classList.add('is-missing');
      const info = document.createElement('div');
      info.className = 'cash-cart-info';
      const name = document.createElement('div');
      name.className = 'cash-cart-name';
      name.textContent = displayText(this.nameOf(commodity.itemId));
      name.title = name.textContent;
      const price = document.createElement('div');
      price.className = 'cash-cart-price';
      price.textContent = `${(commodity.price * entry.quantity).toLocaleString()} 楓點`;
      info.append(name, price);
      const qty = document.createElement('input');
      qty.className = 'cash-cart-qty';
      qty.type = 'number';
      qty.min = '1';
      qty.max = '99';
      qty.value = String(entry.quantity);
      qty.disabled = pending;
      qty.addEventListener('change', () => {
        if (pending) return;
        entry.quantity = Math.min(99, Math.max(1, Math.floor(Number(qty.value) || 1)));
        this.renderCart();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cash-cart-remove';
      remove.textContent = '×';
      remove.disabled = pending;
      remove.setAttribute('aria-label', textFor('remove', '移除', 'Remove'));
      remove.addEventListener('click', () => {
        if (pending) return;
        this.cart.delete(entry.sn);
        this.renderCart();
      });
      if (pending) {
        const marker = document.createElement('span');
        marker.className = 'cash-cart-pending';
        marker.textContent = textFor('pending', '處理中', 'Pending');
        row.append(icon, info, marker, qty, remove);
      } else row.append(icon, info, qty, remove);
      this.cartRoot.appendChild(row);
    }
    if (this.totalEl) this.totalEl.textContent = this.cartTotal().toLocaleString();
  }

  private checkout() {
    if (!this.cart.size) {
      this.notify('購物車是空的。', true);
      return;
    }
    if (this.cartTotal() > this.cash) {
      this.notify('楓點余额不足，无法结算。', true);
      return;
    }
    let submitted = 0;
    for (const entry of [...this.cart.values()]) {
      if (this.pendingFor(entry.sn) > 0) continue;
      const commodity = this.data?.commodities.find(row => row.sn === entry.sn);
      if (commodity && this.requestBuy(commodity, entry.quantity, 'cart')) submitted += 1;
    }
    if (submitted) this.notify('購買請求已送出，等待伺服器回覆。');
  }

  private buyDirect(entry: CashCommodity, quantity = 1) {
    if (this.pendingFor(entry.sn) > 0) {
      this.notify('這件商品正在處理中。', true);
      return;
    }
    this.requestBuy(entry, quantity, 'direct');
  }

  // -------------------------------------------------------------- appearance

  private appearanceLayer(entry: CashCommodity) {
    const catalog = this.manifest.appearanceCatalog;
    return catalog ? appearanceLayer(catalog, entry.itemId) : undefined;
  }

  private tryOn(entry: CashCommodity) {
    if (!this.isFashion(entry)) return;
    const catalog = this.manifest.appearanceCatalog;
    const indexed = catalog && this.hasAppearanceIndex(catalog, entry.itemId);
    if (!this.appearanceLayer(entry) && !indexed) {
      this.notify('這件時裝沒有可用的紙娃娃圖層。', true);
      return;
    }
    this.previewEntry = entry;
    const request = ++this.previewRequest;
    this.closeDetail();
    this.renderPreview(entry);
    this.notify(`正在預覽 ${this.nameOf(entry.itemId)}。`);
    if (catalog) {
      this.ensureAppearanceLayers(entry, request);
    }
  }

  private ensureAppearanceLayers(entry?: CashCommodity, request = this.previewRequest) {
    const catalog = this.manifest.appearanceCatalog;
    if (!catalog || !this.player?.appearance) return;
    const ids = [...new Set([
      ...(this.player.equipped ?? []).map(item => item.itemId),
      ...(entry ? [entry.itemId] : []),
    ])];
    const targets = ids.filter(itemId => {
      const key = itemIdKeys(itemId).find(candidate => /^\d{8}$/.test(candidate)) ?? itemId;
      return this.hasAppearanceIndex(catalog, itemId) && !appearanceLayer(catalog, itemId) && !this.loadingAppearanceIds.has(key);
    });
    if (!targets.length) return;
    const keys = targets.map(itemId => itemIdKeys(itemId).find(candidate => /^\d{8}$/.test(candidate)) ?? itemId);
    for (const key of keys) this.loadingAppearanceIds.add(key);
    void loadAppearanceLayers(catalog, targets).then(() => {
      if (this.root) this.renderPreview(this.previewEntry);
    }).catch(error => {
      const current = request === this.previewRequest && (!entry || this.previewEntry?.sn === entry.sn);
      if (this.root && current) {
        this.renderPreview(this.previewEntry);
        this.notify(`時裝預覽載入失敗：${(error as Error).message}`, true);
      }
    }).finally(() => {
      for (const key of keys) this.loadingAppearanceIds.delete(key);
    });
  }

  private hasAppearanceIndex(catalog: AppearanceCatalog, itemId: string): boolean {
    const index = catalog.cashAppearance?.items ?? {};
    return itemIdKeys(itemId).some(key => Boolean(index[key]));
  }

  private previewActions(entry?: CashCommodity) {
    const player = this.player;
    const catalog = this.manifest.appearanceCatalog;
    if (!entry || !this.isFashion(entry)) {
      if (player?.appearance && catalog) {
        const equipment = player.equipped ?? [];
        const loadedItemIds = equipment.map(item => item.itemId);
        const weaponType = appearanceWeaponType(catalog, equipment, player.appearance.weapon);
        // World rendering keeps the authored starter paper-doll when an old
        // save references a face that is not in the layered catalogue yet.
        // Keep the shop preview on that same known-good fallback instead of
        // turning the whole panel into "等待角色外觀資料".
        const actions = composeAppearance(catalog, player.appearance, equipment, { loadedItemIds, weaponType });
        return { actions: actions ?? this.manifest.avatar.actions, trial: false };
      }
      return { actions: this.manifest.avatar.actions, trial: false };
    }
    if (!player?.appearance || !catalog) return { actions: undefined, trial: true };
    const candidate = appearanceLayer(catalog, entry.itemId);
    if (!candidate) return { actions: undefined, trial: true };
    const equipment = (player.equipped ?? []).filter(item => {
      const existing = appearanceLayer(catalog, item.itemId);
      if (!existing) return true;
      const candidateSlots = [...slotTokens(candidate.islot), ...slotTokens(candidate.vslot)];
      const existingSlots = [...slotTokens(existing.islot), ...slotTokens(existing.vslot)];
      return !candidateSlots.some(slot => existingSlots.includes(slot));
    });
    const trialEquipment = [...equipment, { itemId: entry.itemId }];
    const loadedItemIds = trialEquipment.map(item => item.itemId);
    const weaponType = appearanceWeaponType(catalog, trialEquipment, player.appearance.weapon);
    return {
      actions: composeAppearance(catalog, player.appearance, trialEquipment, { loadedItemIds, weaponType }),
      trial: true,
    };
  }

  private renderPreview(entry?: CashCommodity) {
    this.previewEntry = entry;
    if (!this.previewStage) return;
    this.previewStage.replaceChildren();
    const result = this.previewActions(entry);
    const frame = result.actions?.stand?.[0];
    if (!frame?.parts?.length) {
      const note = document.createElement('p');
      note.className = 'cash-preview-empty';
      note.textContent = result.trial
        ? '目前角色没有可用的紙娃娃圖層。'
        : '等待角色外觀資料。';
      this.previewStage.appendChild(note);
      if (this.previewCaption) this.previewCaption.textContent = result.trial ? '此商品暫無可預覽外觀。' : '顯示目前角色外觀。';
      if (this.previewClear) this.previewClear.hidden = !entry;
      return;
    }
    const parts = [...frame.parts].sort((left, right) => right.z - left.z);
    for (const part of parts) {
      const image = this.safeImage(part, 'cash-preview-part', this.previewStage);
      image.style.left = `calc(50% + ${part.x}px)`;
      image.style.top = `calc(100% - var(--cash-preview-foot) + ${part.y}px)`;
      // composeAppearance already orders WZ parts from high z to low z.  The
      // authored order is the paint order; assigning zIndex here reverses it
      // (larger WZ z values belong behind later parts) and makes the preview
      // look like a naked base character.
      this.previewStage.appendChild(image);
    }
    if (this.previewCaption) {
      this.previewCaption.textContent = result.trial
        ? `試穿：${displayText(this.nameOf(entry?.itemId ?? ''))}`
        : '目前角色外觀';
    }
    if (this.previewClear) this.previewClear.hidden = !entry;
  }

  // --------------------------------------------------------------- helpers

  private spriteButton(name: string, onClick: () => void, label: string): HTMLButtonElement {
    const normal = this.ui[`${name}/normal`];
    const over = this.ui[`${name}/mouseOver`] ?? normal;
    const pressed = this.ui[`${name}/pressed`] ?? over;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cash-sprite-btn';
    button.setAttribute('aria-label', label);
    button.title = label;
    if (normal) {
      button.style.width = `${normal.width}px`;
      button.style.height = `${normal.height}px`;
      for (const [asset, className] of [[normal, 'is-normal'], [over, 'is-over'], [pressed, 'is-pressed']] as const) {
        if (!asset) continue;
        button.appendChild(this.safeImage(asset, `cash-sprite-img ${className}`, button));
      }
    } else {
      button.classList.add('is-fallback');
      button.textContent = label;
    }
    button.addEventListener('click', event => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.root) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    if (this.detail) {
      this.closeDetail();
      return;
    }
    this.close();
  };
}
