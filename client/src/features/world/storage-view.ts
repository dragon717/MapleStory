import type { ClientMessage, InventoryItem } from '../../../../shared/protocol';
import type { AssetFrame, Manifest, StorageUiData } from '../../assets/manifest';
import { itemName } from '../inventory/names';
import { resolveAssetUrl } from '../../assets/resource-url';
import { protocolText, uiLocale } from '../../app/i18n';

type SendClientMessage = (message: ClientMessage) => boolean;

/** Server-owned warehouse view, mirrored from a `storageState` message. */
export interface StorageSnapshot {
  items: InventoryItem[];
  mesos: number;
  slotLimit: number;
  npcId: string;
}

/** The slice of `shared/items.json` this window needs. */
interface ItemCatalogEntry {
  inventoryType?: number;
  info?: { cash?: number; tradeBlock?: number; dropBlock?: number; only?: number; quest?: number };
}

/** Localized labels for the window chrome, which the source art does not carry. */
const TEXT = {
  title: { zh: '倉庫', en: 'Storage' },
  bag: { zh: '背包', en: 'Bag' },
  put: { zh: '存入', en: 'Store' },
  get: { zh: '取出', en: 'Take out' },
  putAll: { zh: '全部存入', en: 'Store all' },
  sort: { zh: '整理', en: 'Sort' },
  inCoin: { zh: '存入楓幣', en: 'Deposit mesos' },
  outCoin: { zh: '取出楓幣', en: 'Withdraw mesos' },
  close: { zh: '關閉', en: 'Close' },
  mesos: { zh: '楓幣', en: 'Mesos' },
  amount: { zh: '楓幣數量', en: 'Mesos amount' },
  empty: { zh: '倉庫是空的。', en: 'The storage is empty.' },
  bagEmpty: { zh: '背包裡沒有可存入的道具。', en: 'Nothing in the bag can be stored.' },
  storeAllDone: { zh: '已存入全部道具。', en: 'Everything storable was moved in.' },
  needAmount: { zh: '請輸入要搬運的楓幣數量。', en: 'Enter the mesos amount first.' },
  done: { zh: '完成。', en: 'Done.' },
} as const;

function text(key: keyof typeof TEXT): string {
  return TEXT[key][uiLocale() === 'en' ? 'en' : 'zh'];
}

/**
 * Account-warehouse window, built from the TMS273 `UI/UIWindow.img/Trunk`
 * source art (background, row highlight, 9 action buttons and the 5 tabs).
 *
 * The window is a thin view: every mutation is an intent (`storageTransfer` /
 * `storageMesos`) and the contents are only ever redrawn from an authoritative
 * `storageState` message, so the client cannot invent a stack, a quantity or a
 * balance.  Nothing here decides whether a move is legal — the server answers
 * with `storageResult` / `storageMesos` and re-pushes the full view.
 */
export class StorageView {
  private root?: HTMLDivElement;
  private listRoot?: HTMLDivElement;
  private bagRoot?: HTMLDivElement;
  private statusLine?: HTMLDivElement;
  private mesosLine?: HTMLSpanElement;
  private storeCount?: HTMLElement;
  private catalog: Record<string, ItemCatalogEntry> = {};
  private requestSequence = 0;
  private current?: StorageSnapshot;
  /** Latest authoritative bag, mirrored from the player snapshot. */
  private bag: InventoryItem[] = [];
  private purseMesos = 0;
  private amount = 1;
  private selectedBagSlot?: number;
  private selectedStoreSlot?: number;

  constructor(
    private readonly host: HTMLElement,
    private readonly manifest: Manifest,
    private readonly status: (message: string, error?: boolean) => void,
    private readonly send: SendClientMessage = () => false,
  ) {
    window.addEventListener('keydown', this.onKeyDown, true);
    void this.loadCatalog();
  }

  /** Item tab / trade rules come from the same catalog the inventory uses. */
  private async loadCatalog() {
    try {
      const response = await fetch(resolveAssetUrl('/assets/items.json'));
      this.catalog = (await response.json()) as Record<string, ItemCatalogEntry>;
      if (this.root) this.render();
    } catch {
      // The server re-validates every move, so a missing catalog only costs
      // the local "already known to be refused" hint, never correctness.
      this.catalog = {};
    }
  }

  // ---------------------------------------------------------------- assets

  private data(): StorageUiData | undefined {
    return this.manifest.storageUi;
  }

  private frame(name: string): AssetFrame | undefined {
    return this.data()?.ui?.[name];
  }

  private slotLimit(): number {
    return this.current?.slotLimit ?? this.data()?.slotLimit ?? 24;
  }

  // ---------------------------------------------------------------- lifecycle

  isOpen(): boolean {
    return Boolean(this.root);
  }

  /** Open (or refresh) the window for a `storageState` message. */
  open(snapshot: StorageSnapshot) {
    this.current = snapshot;
    if (!this.root) this.root = this.build();
    this.render();
  }

  close() {
    this.root?.remove();
    this.root = undefined;
    this.current = undefined;
    this.selectedBagSlot = undefined;
    this.selectedStoreSlot = undefined;
  }

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.close();
  }

  /** Mirror the live bag + purse so the deposit side stays truthful. */
  syncPlayer(player: { mesos: number; inventory?: InventoryItem[] }) {
    this.purseMesos = player.mesos;
    if (player.inventory) this.bag = player.inventory;
    if (this.root) this.render();
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.root) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    this.close();
  };

  // ---------------------------------------------------------------- intents

  private nextRequest(prefix: string): string {
    return `storage-${prefix}-${++this.requestSequence}-${Date.now().toString(36)}`;
  }

  /**
   * Move a whole stack between the bag and the warehouse.  Only the direction,
   * the tab and the slot are sent; the server resolves the item and the amount.
   */
  private transfer(operation: 'deposit' | 'withdraw', slot: number, quantity: number) {
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const itemId = operation === 'deposit'
      ? this.bag.find(item => item.slot === slot)?.itemId
      : this.current?.items.find(item => item.slot === slot)?.itemId;
    this.send({
      type: 'storageTransfer',
      requestId: this.nextRequest(operation),
      operation,
      inventoryType: this.tabOf(itemId),
      slot,
      quantity,
    });
  }

  /**
   * Inventory tab for an item id, mirroring the server's `inventory_type`:
   * the catalog entry when it is known, otherwise the source's million-group
   * (1=Equip, 2=Use, 3=Setup, 4=Etc, 5=Cash).  The server re-derives the tab
   * from the slot it actually holds, so this only has to agree with it.
   */
  private tabOf(itemId: string | undefined): number {
    if (!itemId) return 0;
    const known = this.catalog[itemId]?.inventoryType;
    if (known) return known;
    if (!/^\d+$/.test(itemId)) return 0;
    const group = Math.floor(Number(itemId) / 1_000_000);
    return group >= 1 && group <= 5 ? group : 0;
  }

  private moveMesos(operation: 'deposit' | 'withdraw') {
    const quantity = Math.floor(Number(this.amount));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      this.status(text('needAmount'), true);
      return;
    }
    this.send({
      type: 'storageMesos',
      requestId: this.nextRequest(`${operation}-mesos`),
      operation,
      quantity,
    });
  }

  /** Store every storable bag stack, one intent per stack. */
  private storeAll() {
    let moved = 0;
    for (const item of this.bag) {
      if (item.quantity <= 0 || this.isRestricted(item.itemId)) continue;
      this.transfer('deposit', item.slot, item.quantity);
      moved += 1;
    }
    this.status(moved ? text('storeAllDone') : text('bagEmpty'), !moved);
  }

  /**
   * Items the original never lets leave the inventory (quest, cash, one of a
   * kind).  The server re-checks this; the UI only avoids offering moves that
   * are guaranteed to be refused.
   */
  private isRestricted(itemId: string): boolean {
    const info = this.catalog[itemId]?.info;
    if (!info) return false;
    return Boolean(info.tradeBlock || info.dropBlock || info.only || info.quest || info.cash);
  }

  // ---------------------------------------------------------------- rendering

  private build(): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'storage-window';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', text('title'));

    const background = this.frame('backgrnd');
    const shell = document.createElement('div');
    shell.className = 'storage-shell';
    if (background) {
      const image = document.createElement('img');
      image.className = 'storage-backgrnd';
      image.src = background.url;
      image.width = background.width;
      image.height = background.height;
      image.draggable = false;
      image.alt = '';
      shell.append(image);
      shell.style.setProperty('--storage-width', `${background.width}px`);
    }

    const heading = document.createElement('div');
    heading.className = 'storage-heading';
    const title = document.createElement('strong');
    title.textContent = text('title');
    const close = this.button('BtExit', text('close'), () => this.close());
    close.classList.add('storage-close');
    heading.append(title, close);

    // Two panes: the warehouse on the left, the character's bag on the right.
    const panes = document.createElement('div');
    panes.className = 'storage-panes';
    const storePane = document.createElement('section');
    storePane.className = 'storage-pane';
    const storeLabel = document.createElement('span');
    storeLabel.className = 'storage-pane-label';
    this.storeCount = storeLabel;
    this.listRoot = document.createElement('div');
    this.listRoot.className = 'storage-list';
    storePane.append(storeLabel, this.listRoot);

    const bagPane = document.createElement('section');
    bagPane.className = 'storage-pane';
    const bagLabel = document.createElement('span');
    bagLabel.className = 'storage-pane-label';
    bagLabel.textContent = text('bag');
    this.bagRoot = document.createElement('div');
    this.bagRoot.className = 'storage-list';
    bagPane.append(bagLabel, this.bagRoot);
    panes.append(storePane, bagPane);

    // Action row: the authored Trunk buttons, in source order.
    const actions = document.createElement('div');
    actions.className = 'storage-actions';
    actions.append(
      this.button('BtPut', text('put'), () => this.storeSelected()),
      this.button('BtGet', text('get'), () => this.takeSelected()),
      this.button('BtGetAll', text('putAll'), () => this.storeAll()),
      this.button('BtSort', text('sort'), () => this.sortBag()),
    );

    // Mesos row: amount, in/out, and both balances.
    const coin = document.createElement('div');
    coin.className = 'storage-coin';
    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '1';
    amount.value = String(this.amount);
    amount.className = 'storage-amount';
    amount.setAttribute('aria-label', text('amount'));
    amount.oninput = () => { this.amount = Math.max(1, Math.floor(Number(amount.value) || 1)); };
    this.mesosLine = document.createElement('span');
    this.mesosLine.className = 'storage-mesos';
    coin.append(
      amount,
      this.button('BtInCoin', text('inCoin'), () => this.moveMesos('deposit')),
      this.button('BtOutCoin', text('outCoin'), () => this.moveMesos('withdraw')),
      this.mesosLine,
    );

    this.statusLine = document.createElement('div');
    this.statusLine.className = 'storage-status';
    this.statusLine.setAttribute('role', 'status');

    shell.append(heading, panes, actions, coin, this.statusLine);
    root.append(shell);
    this.host.append(root);
    return root;
  }

  /** One authored button: use the source sprite, fall back to a text button. */
  private button(sprite: string, label: string, onClick: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'storage-button';
    element.title = label;
    element.setAttribute('aria-label', label);
    const normal = this.frame(`${sprite}/normal`);
    if (normal) {
      const hover = this.frame(`${sprite}/mouseOver`) ?? normal;
      const pressed = this.frame(`${sprite}/pressed`) ?? normal;
      const image = document.createElement('img');
      const show = (frame: AssetFrame) => { image.src = frame.url; };
      show(normal);
      image.width = normal.width;
      image.height = normal.height;
      image.draggable = false;
      image.alt = '';
      element.append(image);
      element.classList.add('is-sprite');
      element.onmouseenter = () => show(hover);
      element.onmouseleave = () => show(normal);
      element.onmousedown = () => show(pressed);
      element.onmouseup = () => show(hover);
      // The sprite carries no glyph, so keep the label readable on hover.
      const caption = document.createElement('span');
      caption.className = 'storage-button-caption';
      caption.textContent = label;
      element.append(caption);
    } else {
      element.textContent = label;
    }
    element.onclick = onClick;
    return element;
  }

  private render() {
    const snapshot = this.current;
    if (!this.root || !snapshot) return;
    const used = snapshot.items.filter(item => item.quantity > 0).length;
    if (this.storeCount) this.storeCount.textContent = `${text('title')} (${used}/${this.slotLimit()})`;
    if (this.mesosLine) this.mesosLine.textContent = `${text('mesos')} ${this.purseMesos} / ${snapshot.mesos}`;
    this.renderList();
    this.renderBag();
  }

  private renderList() {
    const root = this.listRoot;
    const snapshot = this.current;
    if (!root || !snapshot) return;
    root.replaceChildren();
    const rows = [...snapshot.items].filter(item => item.quantity > 0).sort((a, b) => a.slot - b.slot);
    if (!rows.length) {
      root.append(this.empty(text('empty')));
      return;
    }
    for (const item of rows) root.append(this.row(item, 'store'));
  }

  private renderBag() {
    const root = this.bagRoot;
    if (!root) return;
    root.replaceChildren();
    const rows = [...this.bag].filter(item => item.quantity > 0).sort((a, b) => a.slot - b.slot);
    if (!rows.length) {
      root.append(this.empty(text('bagEmpty')));
      return;
    }
    for (const item of rows) root.append(this.row(item, 'bag'));
  }

  private empty(message: string): HTMLElement {
    const element = document.createElement('div');
    element.className = 'storage-empty';
    element.textContent = message;
    return element;
  }

  /** One clickable stack row, shared by both panes. */
  private row(item: InventoryItem, side: 'store' | 'bag'): HTMLElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'storage-row';
    const selected = side === 'store' ? this.selectedStoreSlot === item.slot : this.selectedBagSlot === item.slot;
    if (selected) element.classList.add('is-selected');

    const icon = document.createElement('img');
    icon.className = 'storage-row-icon';
    const frame = this.manifest.items?.[item.itemId];
    if (frame?.url) icon.src = frame.url;
    icon.alt = '';
    icon.draggable = false;

    const label = document.createElement('span');
    label.className = 'storage-row-name';
    label.textContent = item.quantity > 1 ? `${itemName(item.itemId)} ×${item.quantity}` : itemName(item.itemId);
    element.append(icon, label);

    if (this.isRestricted(item.itemId)) {
      element.classList.add('is-restricted');
      element.disabled = true;
      element.title = protocolText(
        'item_untradeable',
        uiLocale() === 'en' ? 'This item is untradeable' : '這個道具不可交易',
      );
      return element;
    }
    // A click picks the row; a second click on the picked row moves it, which
    // keeps the window usable with the mouse alone.
    element.onclick = () => {
      const same = side === 'store' ? this.selectedStoreSlot === item.slot : this.selectedBagSlot === item.slot;
      if (side === 'store') {
        this.selectedStoreSlot = same ? undefined : item.slot;
        if (same) this.transfer('withdraw', item.slot, item.quantity);
      } else {
        this.selectedBagSlot = same ? undefined : item.slot;
        if (same) this.transfer('deposit', item.slot, item.quantity);
      }
      this.render();
    };
    return element;
  }

  private storeSelected() {
    const item = this.bag.find(candidate => candidate.slot === this.selectedBagSlot);
    if (!item || item.quantity <= 0) {
      this.status(text('bagEmpty'), true);
      return;
    }
    this.transfer('deposit', item.slot, item.quantity);
  }

  private takeSelected() {
    const item = this.current?.items.find(candidate => candidate.slot === this.selectedStoreSlot);
    if (!item || item.quantity <= 0) {
      this.status(text('empty'), true);
      return;
    }
    this.transfer('withdraw', item.slot, item.quantity);
  }

  /** Ask the server to re-order the bag the way the inventory window does. */
  private sortBag() {
    const tab = this.tabOf(this.bag.find(item => item.quantity > 0)?.itemId);
    if (!tab) return;
    this.send({ type: 'inventorySort', requestId: this.nextRequest('sort'), inventoryType: tab });
  }

  /** Show a localized line in the window's own status area. */
  showResult(code: string, success: boolean) {
    if (!this.statusLine) return;
    this.statusLine.textContent = success ? text('done') : protocolText(code, code);
    this.statusLine.classList.toggle('is-error', !success);
  }
}
