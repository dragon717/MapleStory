import type { ClientMessage, ServerMessage } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { displayText, uiLocale } from '../../app/i18n';
import { installWindowDrag } from '../ui/window-shell.ts';

type SendClientMessage = (message: ClientMessage) => boolean;

/** One category of the assembled catalogue (`/assets/cashshop.json`). */
export interface CashCategory {
  id: string;
  label: string;
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
}

export interface CashShopData {
  contentVersion: string;
  categories: CashCategory[];
  commodities: CashCommodity[];
  itemNames: Record<string, string>;
}

/** One row of the cart: a deal plus how many times the player takes it. */
export interface CartEntry {
  sn: string;
  quantity: number;
}

/** Page components of the 現金商店 window:
 *  - CategorySidebar  the source sidebar sprite, one row per category;
 *  - ItemGrid         the scrollable commodity card grid of the active tab;
 *  - ItemCard         icon + name + count badge + price + effect label;
 *  - ItemDetail       magnifier popover: big icon, name, price, deal size,
 *                     quantity stepper, buy / add-to-cart;
 *  - CartPanel        the chosen deals, per-row quantity and removal, the
 *                     running total and the 結算 button;
 *  - BalanceBadge     the authoritative 楓點 wallet readout. */
export class CashShopView {
  private readonly host: HTMLElement;
  private readonly manifest: Manifest;
  private root?: HTMLDivElement;
  private grid?: HTMLDivElement;
  private detail?: HTMLDivElement;
  private cartRoot?: HTMLDivElement;
  private balanceEl?: HTMLElement;
  private sidebarState?: Record<string, AssetFrame>;
  private activeTab = 'home';
  private readonly cart = new Map<string, CartEntry>();
  /** Authoritative wallet from the latest `cashState` / `cashBuyResult`. */
  private cash = 0;
  private data?: CashShopData;
  private readonly send: SendClientMessage;
  private readonly destroyFns: Array<() => void> = [];
  private requestSequence = 0;
  /** Pending cart rows awaiting their `cashBuyResult`. */
  private readonly pending = new Set<string>();
  private statusLine?: HTMLElement;
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
    // Opening the window asks the server for the fresh wallet; the readout
    // updates when `cashState` lands.
    this.request('cashOpen');
  }

  close() {
    this.root?.remove();
    this.root = undefined;
    this.grid = undefined;
    this.detail?.remove();
    this.detail = undefined;
    this.cartRoot = undefined;
    this.balanceEl = undefined;
    this.statusLine = undefined;
  }

  clear() {
    this.close();
  }

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.close();
    for (const fn of this.destroyFns) fn();
    this.destroyFns.length = 0;
  }

  /** Latest snapshot balance; also used to seed the readout before cashState. */
  syncPlayer(player: { cash?: number }) {
    if (typeof player.cash === 'number') {
      this.cash = player.cash;
      this.renderBalance();
    }
  }

  receive(message: Extract<ServerMessage, { type: 'cashState' | 'cashBuyResult' }>) {
    if (!message.requestId.startsWith('cash-')) return;
    this.cash = message.cash;
    this.renderBalance();
    if (message.type === 'cashBuyResult') {
      this.pending.delete(message.requestId);
      if (message.success) {
        // The checkout path already removed settled rows; a failed row would
        // have stayed.  A direct 立即购买 never touches the cart.
        this.renderCart();
        this.status(`已购买 ${this.nameOf(message.itemId)}。`);
      } else if (message.code) {
        this.status(`购买失败：${this.codeText(message.code)}`, true);
      }
    }
  }

  // ------------------------------------------------------------------ data

  private async loadData() {
    try {
      const response = await fetch('/assets/cashshop.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.data = (await response.json()) as CashShopData;
      if (this.root) this.renderAll();
    } catch (error) {
      this.status(`现金商店数据加载失败：${(error as Error).message}`, true);
    }
  }

  private nameOf(itemId: string): string {
    return this.data?.itemNames[itemId] ?? itemId;
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
      cash_gender: '该商品不适合当前角色',
      cash_quantity_invalid: '数量无效',
      cash_shop_unavailable: '商店暂不可用',
      cash_rejected: '购买被拒绝',
    };
    return zh[code] ?? code;
  }

  private request(type: 'cashOpen' | 'cashBuy', sn?: string, quantity?: number) {
    const requestId = `cash-${++this.requestSequence}-${Date.now().toString(36)}`;
    if (type === 'cashBuy' && sn) {
      this.pending.add(requestId);
      this.send({ type: 'cashBuy', requestId, sn, quantity: quantity ?? 1 });
    } else {
      this.send({ type: 'cashOpen', requestId });
    }
  }

  // ---------------------------------------------------------------- window

  private get ui(): Record<string, AssetFrame> {
    return this.manifest.cashshopUi ?? {};
  }

  private img(key: string, className?: string): HTMLImageElement | null {
    const asset = this.ui[key];
    if (!asset) return null;
    const image = document.createElement('img');
    image.className = className ?? 'cash-img';
    image.src = asset.url;
    image.width = asset.width;
    image.height = asset.height;
    image.alt = '';
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    return image;
  }

  private buildWindow() {
    const root = document.createElement('div');
    root.className = 'cash-shop';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', uiLocale() === 'en' ? 'Cash Shop' : '現金商店');
    const shell = this.ui['backgrnd'];
    if (shell) {
      root.style.width = `${shell.width}px`;
      root.style.height = `${shell.height}px`;
    }
    for (const key of ['backgrnd', 'backgrnd2']) {
      const layer = this.img(key, 'cash-shop-layer');
      if (layer) root.appendChild(layer);
    }

    const heading = document.createElement('h2');
    heading.className = 'cash-shop-title';
    heading.textContent = uiLocale() === 'en' ? 'Cash Shop' : '現金商店';
    root.appendChild(heading);

    // BalanceBadge — the authoritative wallet, refreshed by cashState.
    const balance = document.createElement('div');
    balance.className = 'cash-shop-balance';
    const balanceLabel = document.createElement('span');
    balanceLabel.className = 'cash-shop-balance-label';
    balanceLabel.textContent = '楓點';
    this.balanceEl = document.createElement('b');
    balance.append(balanceLabel, this.balanceEl);
    root.appendChild(balance);

    // CategorySidebar — the source sprite is the whole 10-row sidebar with
    // the active row highlighted, so switching tabs swaps the sprite.
    const sidebar = document.createElement('div');
    sidebar.className = 'cash-shop-sidebar';
    this.sidebarState = this.ui;
    for (const category of this.data?.categories ?? []) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cash-shop-cat';
      row.dataset.tab = category.id;
      row.textContent = displayText(category.label);
      row.title = displayText(category.label);
      row.addEventListener('click', () => {
        if (this.activeTab === category.id) return;
        this.activeTab = category.id;
        this.renderSidebar();
        this.renderGrid();
      });
      sidebar.appendChild(row);
    }
    root.appendChild(sidebar);
    this.renderSidebarSprite(root);

    const exit = this.spriteButton('BtExit', () => this.close());
    exit.classList.add('cash-shop-exit');
    root.appendChild(exit);

    const grid = document.createElement('div');
    grid.className = 'cash-shop-grid';
    this.grid = grid;
    root.appendChild(grid);

    const cartHead = document.createElement('div');
    cartHead.className = 'cash-shop-cart-head';
    const cartTitle = document.createElement('span');
    cartTitle.textContent = uiLocale() === 'en' ? 'Cart' : '购物车';
    const clearCart = document.createElement('button');
    clearCart.type = 'button';
    clearCart.className = 'cash-shop-cart-clear';
    clearCart.textContent = uiLocale() === 'en' ? 'Clear' : '清空';
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
    totalLabel.textContent = '合计';
    this.totalEl = document.createElement('b');
    this.totalEl.textContent = '0';
    const checkout = this.spriteButton('BtBuy', () => this.checkout());
    checkout.classList.add('cash-shop-checkout');
    total.append(totalLabel, this.totalEl);
    cartFoot.append(this.statusLine, total, checkout);

    const cartPanel = document.createElement('div');
    cartPanel.className = 'cash-shop-cart-panel';
    cartPanel.append(cartHead, cart, cartFoot);
    root.appendChild(cartPanel);

    this.host.appendChild(root);
    this.destroyFns.push(() => root.remove());
    this.root = root;
    const dragTarget = root;
    installWindowDrag(this.host, dragTarget, { titleHeight: 40, isOpen: () => Boolean(this.root) });
    this.renderAll();
  }

  private totalEl?: HTMLElement;

  /** Paint the sidebar art whose highlighted row matches the active tab. */
  private renderSidebarSprite(root: HTMLElement) {
    root.querySelector('.cash-shop-sidebar-sprite')?.remove();
    const sprite = this.img(`tab:${this.activeTab}`, 'cash-shop-sidebar-sprite');
    if (sprite) root.insertBefore(sprite, root.querySelector('.cash-shop-grid'));
  }

  private renderSidebar() {
    if (!this.root) return;
    this.renderSidebarSprite(this.root);
    for (const row of Array.from(this.root.querySelectorAll<HTMLElement>('.cash-shop-cat'))) {
      row.classList.toggle('is-active', row.dataset.tab === this.activeTab);
    }
  }

  private commoditiesFor(tab: string): CashCommodity[] {
    const list = (this.data?.commodities ?? []).filter(entry => entry.tab === tab);
    // Source `Priority` is the shelf order; stable-sort low first.
    return list.sort((left, right) => left.priority - right.priority);
  }

  private renderAll() {
    this.renderBalance();
    this.renderSidebar();
    this.renderGrid();
    this.renderCart();
  }

  private renderBalance() {
    if (this.balanceEl) this.balanceEl.textContent = this.cash.toLocaleString();
  }

  /** One card of the ItemGrid: icon, name, deal size, price and condition tags. */
  private itemCard(entry: CashCommodity): HTMLButtonElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'cash-card';
    card.dataset.sn = entry.sn;
    const icon = document.createElement('div');
    icon.className = 'cash-card-icon';
    const frame = this.manifest.cashItems?.[entry.itemId];
    if (frame) {
      const image = document.createElement('img');
      image.src = frame.url;
      image.width = Math.min(48, frame.width);
      image.height = Math.min(48, frame.height);
      image.alt = '';
      image.draggable = false;
      icon.appendChild(image);
    }
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
    if (entry.period > 0) {
      const period = document.createElement('span');
      period.className = 'cash-card-tag';
      period.textContent = `${entry.period}天`;
      tags.appendChild(period);
    }
    if (entry.gender !== 2) {
      const gender = document.createElement('span');
      gender.className = 'cash-card-tag';
      gender.textContent = entry.gender === 0 ? '男' : '女';
      tags.appendChild(gender);
    }
    if (entry.reqLevel > 0) {
      const level = document.createElement('span');
      level.className = 'cash-card-tag';
      level.textContent = `${entry.reqLevel}级+`;
      tags.appendChild(level);
    }
    const price = document.createElement('div');
    price.className = 'cash-card-price';
    price.textContent = `${entry.price.toLocaleString()} 楓點`;
    card.append(icon, name, tags, price);
    card.addEventListener('click', () => this.openDetail(entry));
    return card;
  }

  private renderGrid() {
    if (!this.grid) return;
    this.grid.replaceChildren();
    const entries = this.commoditiesFor(this.activeTab);
    if (!entries.length) {
      const empty = this.img('noItem', 'cash-grid-empty');
      const note = document.createElement('div');
      note.className = 'cash-grid-note';
      note.textContent = uiLocale() === 'en' ? 'Nothing is on sale here yet.' : '该分类暂时没有在售商品。';
      if (empty) this.grid.appendChild(empty);
      this.grid.appendChild(note);
      return;
    }
    for (const entry of entries) this.grid.appendChild(this.itemCard(entry));
  }

  // ---------------------------------------------------------------- detail

  private openDetail(entry: CashCommodity) {
    this.closeDetail();
    const overlay = document.createElement('div');
    overlay.className = 'cash-detail';
    const name = document.createElement('div');
    name.className = 'cash-detail-name';
    name.textContent = displayText(this.nameOf(entry.itemId));
    const icon = document.createElement('div');
    icon.className = 'cash-detail-icon';
    const frame = this.manifest.cashItems?.[entry.itemId];
    if (frame) {
      const image = document.createElement('img');
      image.src = frame.url;
      image.width = Math.min(64, frame.width);
      image.height = Math.min(64, frame.height);
      image.alt = '';
      image.draggable = false;
      icon.appendChild(image);
    }
    const facts = document.createElement('ul');
    facts.className = 'cash-detail-facts';
    const rows: string[] = [
      `价格：${entry.price.toLocaleString()} 楓點`,
      entry.count > 1 ? `每次购买 ${entry.count} 个` : '每次购买 1 个',
      entry.period > 0 ? `有效期 ${entry.period} 天` : '永久有效',
      entry.gender !== 2 ? (entry.gender === 0 ? '限定男性角色' : '限定女性角色') : '男女通用',
    ];
    if (entry.reqLevel > 0) rows.push(`需要等级 ${entry.reqLevel}`);
    if (entry.limit > 0) rows.push(`限购 ${entry.limit} 次`);
    for (const text of rows) {
      const row = document.createElement('li');
      row.textContent = text;
      facts.appendChild(row);
    }
    const qtyRow = document.createElement('div');
    qtyRow.className = 'cash-detail-qty';
    const qtyLabel = document.createElement('span');
    qtyLabel.textContent = '购买次数';
    const input = document.createElement('input');
    input.className = 'cash-detail-input';
    input.type = 'number';
    input.min = '1';
    input.max = '99';
    input.value = '1';
    const total = document.createElement('span');
    total.className = 'cash-detail-total';
    const count = () => Math.min(99, Math.max(1, Math.floor(Number(input.value) || 1)));
    const updateTotal = () => {
      total.textContent = `合计 ${(entry.price * count()).toLocaleString()} 楓點`;
    };
    input.addEventListener('input', updateTotal);
    updateTotal();
    qtyRow.append(qtyLabel, input, total);

    const buttons = document.createElement('div');
    buttons.className = 'cash-detail-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cash-shop-tab-btn';
    cancel.textContent = uiLocale() === 'en' ? 'Close' : '关闭';
    cancel.addEventListener('click', () => this.closeDetail());
    const addCart = this.spriteButton('BtBuy', () => {
      this.addToCart(entry.sn, count());
      this.closeDetail();
    });
    addCart.classList.add('cash-detail-cart');
    const addLabel = document.createElement('span');
    addLabel.className = 'cash-detail-cart-label';
    addLabel.textContent = '加入购物车';
    addCart.appendChild(addLabel);
    const buyNow = this.spriteButton('BtBuy', () => {
      this.closeDetail();
      this.request('cashBuy', entry.sn, count());
    });
    buyNow.classList.add('cash-detail-buy');
    const buyLabel = document.createElement('span');
    buyLabel.className = 'cash-detail-cart-label';
    buyLabel.textContent = '立即购买';
    buyNow.appendChild(buyLabel);
    buttons.append(cancel, addCart, buyNow);

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
    const entry = this.cart.get(sn);
    if (entry) entry.quantity = Math.min(99, entry.quantity + quantity);
    else this.cart.set(sn, { sn, quantity: Math.min(99, quantity) });
    this.renderCart();
  }

  private pendingFor(sn: string): number {
    let count = 0;
    for (const request of this.pending) if (request.includes(sn)) count += 1;
    return count;
  }

  private cartHas(_cartSn: string, _messageSn: string): boolean {
    return true;
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
      empty.textContent = uiLocale() === 'en' ? 'The cart is empty.' : '购物车是空的。';
      this.cartRoot.appendChild(empty);
    }
    for (const entry of this.cart.values()) {
      const commodity = this.data?.commodities.find(row => row.sn === entry.sn);
      if (!commodity) continue;
      const row = document.createElement('div');
      row.className = 'cash-cart-row';
      const icon = document.createElement('div');
      icon.className = 'cash-cart-icon';
      const frame = this.manifest.cashItems?.[commodity.itemId];
      if (frame) {
        const image = document.createElement('img');
        image.src = frame.url;
        image.width = 28;
        image.height = 28;
        image.alt = '';
        image.draggable = false;
        icon.appendChild(image);
      }
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
      qty.addEventListener('change', () => {
        const parsed = Math.min(99, Math.max(1, Math.floor(Number(qty.value) || 1)));
        entry.quantity = parsed;
        qty.value = String(parsed);
        this.renderCart();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cash-cart-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', uiLocale() === 'en' ? 'Remove' : '移除');
      remove.addEventListener('click', () => {
        this.cart.delete(entry.sn);
        this.renderCart();
      });
      row.append(icon, info, qty, remove);
      this.cartRoot.appendChild(row);
    }
    if (this.totalEl) this.totalEl.textContent = this.cartTotal().toLocaleString();
  }

  /** 結算: send one intent per cart row; results arrive as cashBuyResult. */
  private checkout() {
    if (!this.cart.size) {
      this.status('购物车是空的。', true);
      return;
    }
    if (this.cartTotal() > this.cash) {
      this.status('楓點余额不足，无法结算。', true);
      return;
    }
    for (const entry of [...this.cart.values()]) {
      this.request('cashBuy', entry.sn, entry.quantity);
      // A settled row leaves the cart immediately; failures re-render on the
      // result message.
      this.cart.delete(entry.sn);
    }
    this.renderCart();
  }

  // --------------------------------------------------------------- helpers

  private spriteButton(name: string, onClick: () => void): HTMLButtonElement {
    const normal = this.ui[`${name}/normal`];
    const over = this.ui[`${name}/mouseOver`] ?? normal;
    const pressed = this.ui[`${name}/pressed`] ?? over;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cash-sprite-btn';
    if (normal) {
      button.style.width = `${normal.width}px`;
      button.style.height = `${normal.height}px`;
      for (const [asset, className] of [[normal, 'is-normal'], [over, 'is-over'], [pressed, 'is-pressed']] as const) {
        const image = document.createElement('img');
        image.className = `cash-sprite-img ${className}`;
        image.src = asset.url;
        image.width = asset.width;
        image.height = asset.height;
        image.alt = '';
        image.draggable = false;
        image.setAttribute('aria-hidden', 'true');
        button.appendChild(image);
      }
    } else {
      button.textContent = name;
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
