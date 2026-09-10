import type {
  ClientMessage, InventoryItem, NpcState, PlayerState, ServerMessage,
} from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { itemCategoryTab } from '../inventory/names';
import { uiLocale, uiText, displayText } from '../../app/i18n';

type SendClientMessage = (message: ClientMessage) => boolean;

interface DialogueState {
  requestId: string;
  npcId: string;
  npcTemplateId?: string;
  name: string;
  nameZh?: string;
  dialog: Extract<ServerMessage, { type: 'npcResult' }>['dialog'];
}

interface ShopOpenState {
  npcId: string;
  shopId: string;
  name: string;
  nameZh?: string;
  items: { itemId: string; price: number; name: string; icon?: string; source?: string }[];
}

/** One sellable stack taken from the authoritative player snapshot. */
interface SellEntry {
  itemId: string;
  inventoryType: number;
  slot: number;
  quantity: number;
  /** What the shop pays for the whole stack, already rounded by the server's
   *  rules; shown as a preview only and never sent back. */
  preview: number;
  name: string;
  icon?: string;
}

type ShopTab = 'buy' | 'sell';

/** Fraction of an item's catalog price an NPC shop pays. Mirrors the server's
 *  SHOP_SELL_PRICE_PERCENT; the server remains authoritative and this is only
 *  used to preview the payout before the player confirms. */
const SHOP_SELL_PERCENT = 50;

/** Pick the zh/en name the server ships (zh is the product default). */
function displayName(zh?: string, en?: string): string {
  return displayText(uiLocale() === 'en' ? (en ?? zh ?? '') : (zh ?? en ?? ''));
}

/**
 * Strip common GMS colour/style markers (#b, #B, #k...) and squeeze repeats.
 */
function sanitize(text: string): string {
  return text
    .replace(/#([a-zA-Z])/g, '')
    .replace(/#l/gi, '')
    .replace(/\\\"/g, '"')
    .replace(/\s+#n/g, '\n')
    .trim();
}

function frame(url?: string, cls?: string, width?: number, height?: number): HTMLImageElement {
  const img = document.createElement('img');
  img.className = cls ?? '';
  if (url) img.src = url;
  if (width) img.width = width;
  if (height) img.height = height;
  img.draggable = false;
  return img;
}

/**
 * Npc conversation + shop window, using TMS273 UIWindow2 source art:
 *  - UtilDlgEx t/c/s frame with the speaker portrait + `bar` nameplate,
 *  - UtilDlgEx Bt* sprites for the answers,
 *  - Shop backgrnd + BtBuy/BtExit/meso sprites for the merchant window.
 *
 * The dialogue data is produced server-side from the active script catalog, then the
 * client drives the renderer from those `npcResult` messages.  The shop item
 * list itself comes from `shared/gameplay.json`.
 */
export class NpcDialogueView {
  private readonly host: HTMLElement;
  private readonly manifest: Manifest;
  private dialogueRoot?: HTMLDivElement;
  private dialogueText?: HTMLDivElement;
  private dialogueOptions?: HTMLDivElement;
  private dialogueCurrent?: DialogueState;
  private shopRoot?: HTMLDivElement;
  private shopItemsRoot?: HTMLDivElement;
  private shopMesos?: HTMLSpanElement;
  private shopCurrent?: ShopOpenState;
  private shopTab: ShopTab = 'buy';
  private shopTabsRoot?: HTMLDivElement;
  /** Authoritative inventory from the latest snapshot, used by the sell tab. */
  private playerInventory: InventoryItem[] = [];
  private playerMesos = 0;
  /** Catalog price lookup for the sell preview. */
  private itemPrices: Record<string, number> = {};
  private readonly send: SendClientMessage;
  private readonly destroyFns: Array<() => void> = [];
  private requestSequence = 0;
  private shopCatalog: Record<string, { itemId: string; shopId: string; price: number }[]> = {};
  private itemNames: Record<string, string> = {};
  private itemSources: Record<string, string> = {};

  constructor(host: HTMLElement, manifest: Manifest, private status: (message: string, error?: boolean) => void, send: SendClientMessage = () => false) {
    this.host = host;
    this.manifest = manifest;
    this.send = send;
    window.addEventListener('keydown', this.onKeyDown, true);
    void this.loadCatalog();
  }

  /** Asset lookup helpers for the flat dialog/shop manifest subtrees. */
  private dialogUi(): Record<string, AssetFrame> | undefined { return this.manifest.dialogUi; }
  private shopUi(): Record<string, AssetFrame> | undefined { return this.manifest.shopUi; }
  private uiFrame(subtree: 'dialogUi' | 'shopUi', name: string): AssetFrame | undefined {
    return (subtree === 'dialogUi' ? this.dialogUi() : this.shopUi())?.[name];
  }

  private async loadCatalog() {
    try {
      const [gameplay, items] = await Promise.all([
        fetch('/assets/gameplay.json').then(response => response.json()),
        fetch('/assets/items.json').then(response => response.json()),
      ]);
      const shops = (gameplay?.shops ?? []) as { shopId: string; items: { itemId: string; price: number }[] }[];
      const grouped: Record<string, { itemId: string; shopId: string; price: number }[]> = {};
      for (const shop of shops) {
        grouped[shop.shopId] = shop.items.map(entry => ({
          itemId: entry.itemId, shopId: shop.shopId, price: entry.price,
        }));
      }
      this.shopCatalog = grouped;
      const map = items as Record<string, { name?: string; source?: string }>;
      this.itemNames = Object.fromEntries(Object.entries(map).map(([id, entry]) => [id, entry.name ?? id]));
      this.itemSources = Object.fromEntries(Object.entries(map).map(([id, entry]) => [id, entry.source ?? '']));
      // Catalog price drives the sell preview.  It is the same field the shop
      // sale prices are authored in, so an item with no recorded price simply
      // has no preview and the server will refuse it.
      const prices: Record<string, number> = {};
      for (const [id, entry] of Object.entries(map as Record<string, { info?: { price?: number } }>)) {
        const price = entry.info?.price ?? 0;
        if (price > 0) prices[id] = price;
      }
      this.itemPrices = prices;
      if (this.shopCurrent) this.renderShop();
    } catch (error) {
      this.status(`NPC 资源加载失败：${(error as Error).message}`, true);
    }
  }

  /** Refresh the mesos display and the sell tab's inventory from a player update. */
  syncPlayer(player: Pick<PlayerState, 'mesos'> & Partial<Pick<PlayerState, 'inventory'>>) {
    this.playerMesos = player.mesos;
    if (player.inventory) this.playerInventory = player.inventory;
    if (this.shopMesos) this.shopMesos.textContent = this.formatMesos(player.mesos);
    // The sell tab mirrors live inventory, so a purchase or a pickup has to
    // refresh it while the window stays open.
    if (this.shopCurrent && this.shopTab === 'sell') this.renderShopList();
  }

  receive(message: Extract<ServerMessage, { type: 'npcResult' }>) {
    if (message.requestId !== this.currentRequestId) return;
    if (message.ended || (!message.dialog && !message.shop && !message.warp)) {
      this.closeDialogue();
      return;
    }
    if (message.warp) {
      // Warp is purely server-side state; the next snapshot will swap maps.
      this.closeDialogue();
      return;
    }
    if (message.shop) {
      this.openShop({ npcId: message.npcId, shopId: message.shop.shopId, name: message.name, nameZh: message.nameZh });
      return;
    }
    this.currentRequestId = message.requestId;
    this.dialogueCurrent = {
      requestId: message.requestId,
      npcId: message.npcId,
      npcTemplateId: this.npcTemplates.get(message.npcId),
      name: message.name,
      nameZh: message.nameZh,
      dialog: message.dialog,
    };
    this.renderDialogue();
  }

  private currentRequestId = '';
  private currentNpcId = '';
  /** npc instance id -> template id, learned when the player initiates a talk. */
  private readonly npcTemplates = new Map<string, string>();

  /** Begin a conversation from a player-initiated request (↑ key). */
  startTalk(npc: NpcState) {
    if (this.isOpen()) return;
    const requestId = `npc-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.currentRequestId = requestId;
    this.currentNpcId = npc.id;
    this.npcTemplates.set(npc.id, npc.templateId);
    this.send({ type: 'npcTalk', requestId, npcId: npc.id, step: 'start' });
  }

  /** Find the nearest npc the player is standing next to.  Used by the ↑ key. */
  nearestNpc(snapshot: Extract<ServerMessage, { type: 'snapshot' }>, selfId: string): NpcState | null {
    const player = snapshot.players.find(candidate => candidate.id === selfId);
    if (!player || !snapshot.npcs?.length) return null;
    const reachable = snapshot.npcs
      .filter(npc => Math.abs(npc.x - player.x) <= 100 && Math.abs(npc.y - player.y) <= 80)
      .sort((a, b) => {
        const distA = (a.x - player.x) ** 2 + (a.y - player.y) ** 2;
        const distB = (b.x - player.x) ** 2 + (b.y - player.y) ** 2;
        return distA - distB;
      });
    return reachable[0] ?? null;
  }

  isOpen(): boolean {
    return Boolean(this.dialogueCurrent || this.shopCurrent);
  }

  clear() {
    this.currentRequestId = '';
    this.closeDialogue();
    this.closeShop();
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.isOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    if (this.dialogueCurrent) this.step({ step: 'end' });
    this.clear();
  };

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.clear();
    for (const fn of this.destroyFns) fn();
    this.destroyFns.length = 0;
    this.dialogueRoot?.remove();
    this.shopRoot?.remove();
  }

  private closeDialogue() {
    this.dialogueRoot?.remove();
    this.dialogueRoot = undefined;
    this.dialogueCurrent = undefined;
    this.currentNpcId = '';
  }

  private closeShop() {
    this.shopRoot?.remove();
    this.shopRoot = undefined;
    this.shopCurrent = undefined;
  }

  // ------------------------------------------------------------------ dialog

  private renderDialogue() {
    const state = this.dialogueCurrent;
    if (!state) {
      this.closeDialogue();
      return;
    }
    if (!this.dialogueRoot) this.dialogueRoot = this.buildDialogueFrame();
    const root = this.dialogueRoot;
    const text = this.dialogueText;
    const options = this.dialogueOptions;
    if (!text || !options) return;

    // Speaker portrait + nameplate from the npc template asset.
    const portrait = this.dialogueCurrent && this.speakerAsset(this.dialogueCurrent);
    const aside = root.querySelector<HTMLElement>('.npc-dlg-aside');
    const plateName = root.querySelector<HTMLElement>('.npc-dlg-plate span');
    if (aside) {
      const img = root.querySelector<HTMLImageElement>('.npc-dlg-speaker');
      if (img) {
        if (portrait) { img.src = portrait.url; img.hidden = false; }
        else { img.removeAttribute('src'); img.hidden = true; }
      }
      aside.style.visibility = portrait ? 'visible' : 'hidden';
    }
    if (plateName) plateName.textContent = displayName(state.nameZh, state.name);

    const dialog = state.dialog;
    if (!dialog) {
      text.textContent = '';
      options.replaceChildren();
      return;
    }
    root.classList.toggle('npc-dlg-pageable', dialog.kind === 'next' || dialog.kind === 'nextPrev' || dialog.kind === 'prev');
    text.textContent = displayText(sanitize(dialog.text));
    options.replaceChildren();
    const optHint = document.createElement('div');
    optHint.className = 'npc-dlg-opt-hint';
    if (dialog.kind === 'simple') {
      for (const option of dialog.options ?? []) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'npc-dlg-opt';
        btn.textContent = displayText(option.text);
        btn.onclick = event => { event.stopPropagation(); this.step({ step: 'select', selection: option.index }); };
        options.appendChild(btn);
      }
    }
    void optHint;
    this.updateDialogueButtons(state);
  }

  private speakerAsset(state: DialogueState): AssetFrame | undefined {
    const templateId = state.npcTemplateId;
    if (!templateId) return undefined;
    const npc = this.manifest.npcs?.[templateId];
    return npc?.stand?.[0];
  }

  private buildDialogueFrame(): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'npc-dlg';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', uiLocale() === 'en' ? 'NPC conversation' : 'NPC 对话');

    const top = this.uiFrame('dialogUi', 't');
    const bottom = this.uiFrame('dialogUi', 's');
    const bar = this.uiFrame('dialogUi', 'bar');
    if (top) {root.style.width=`min(${top.width}px, calc(100% - 8px))`;root.appendChild(frame(top.url, 'npc-dlg-img npc-dlg-top', top.width, top.height));}

    const mid = document.createElement('div');
    mid.className = 'npc-dlg-mid';
    const center = this.uiFrame('dialogUi','c');
    if(center) {mid.style.backgroundImage=`url("${center.url}")`;mid.style.backgroundSize=`100% ${center.height}px`;}

    const aside = document.createElement('div');
    aside.className = 'npc-dlg-aside';
    aside.appendChild(frame(undefined, 'npc-dlg-speaker'));
    const plate = document.createElement('div');
    plate.className = 'npc-dlg-plate';
    if (bar) {plate.style.width=`${bar.width}px`;plate.appendChild(frame(bar.url, 'npc-dlg-plate-img', bar.width, bar.height));}
    const name = document.createElement('span');
    plate.appendChild(name);
    aside.appendChild(plate);
    mid.appendChild(aside);

    const main = document.createElement('div');
    main.className = 'npc-dlg-main';
    const text = document.createElement('div');
    text.className = 'npc-dlg-msg';
    const options = document.createElement('div');
    options.className = 'npc-dlg-opts';
    main.append(text, options);
    mid.appendChild(main);

    root.appendChild(mid);
    if (bottom) root.appendChild(frame(bottom.url, 'npc-dlg-img npc-dlg-bottom', bottom.width, bottom.height));

    const buttons = document.createElement('div');
    buttons.className = 'npc-dlg-btns';
    const left = document.createElement('div');
    left.className = 'npc-dlg-btns-left';
    const right = document.createElement('div');
    right.className = 'npc-dlg-btns-right';
    buttons.append(left, right);
    root.appendChild(buttons);

    this.dialogueText = text;
    this.dialogueOptions = options;

    // Click the frame to advance simple page turns.
    root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.npc-btn') || target.closest('.npc-dlg-opt')) return;
      const kind = this.dialogueCurrent?.dialog?.kind;
      if (kind === 'next' || kind === 'nextPrev') this.step({ step: 'next' });
      else if (kind === 'prev') this.step({ step: 'prev' });
      else if (kind === 'ok') this.step({ step: 'end' });
    });

    this.host.appendChild(root);
    this.destroyFns.push(() => root.remove());
    return root;
  }

  /** Build an original sprite button with normal/over/pressed states. */
  private spriteButton(subtree: 'dialogUi' | 'shopUi', name: string, onClick: () => void): HTMLButtonElement {
    const normal = this.uiFrame(subtree, `${name}/normal/0`);
    const over = this.uiFrame(subtree, `${name}/mouseOver/0`) ?? normal;
    const pressed = this.uiFrame(subtree, `${name}/pressed/0`) ?? over;
    const width = normal?.width ?? 46;
    const height = normal?.height ?? 18;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'npc-btn';
    btn.style.width = `${width}px`;
    btn.style.height = `${height}px`;
    if (normal) btn.appendChild(frame(normal.url, 'npc-btn-img npc-btn-normal', width, height));
    if (over) btn.appendChild(frame(over.url, 'npc-btn-img npc-btn-over', width, height));
    if (pressed) btn.appendChild(frame(pressed.url, 'npc-btn-img npc-btn-pressed', width, height));
    if (!normal) btn.textContent = name; // no art fallback
    btn.onclick = event => { event.stopPropagation(); onClick(); };
    return btn;
  }

  private updateDialogueButtons(state: DialogueState) {
    const root = this.dialogueRoot;
    if (!root) return;
    const left = root.querySelector<HTMLElement>('.npc-dlg-btns-left');
    const right = root.querySelector<HTMLElement>('.npc-dlg-btns-right');
    if (!left || !right) return;
    left.replaceChildren();
    right.replaceChildren();

    const kind = state.dialog?.kind;
    left.appendChild(this.spriteButton('dialogUi', 'BtClose', () => this.step({ step: 'end' })));
    if (kind === 'yesNo') {
      right.appendChild(this.spriteButton('dialogUi', 'BtNo', () => this.step({ step: 'no' })));
      right.appendChild(this.spriteButton('dialogUi', 'BtYes', () => this.step({ step: 'yes' })));
    } else if (kind === 'ok' || kind === 'simple') {
      if (kind === 'simple') {
        // choices are clickable rows; a confirm is not needed.
        right.replaceChildren();
      } else {
        right.appendChild(this.spriteButton('dialogUi', 'BtOK', () => this.step({ step: 'end' })));
      }
    } else if (kind === 'nextPrev') {
      right.appendChild(this.spriteButton('dialogUi', 'BtPrev', () => this.step({ step: 'prev' })));
      right.appendChild(this.spriteButton('dialogUi', 'BtNext', () => this.step({ step: 'next' })));
    } else if (kind === 'next') {
      right.appendChild(this.spriteButton('dialogUi', 'BtNext', () => this.step({ step: 'next' })));
    } else if (kind === 'prev') {
      right.appendChild(this.spriteButton('dialogUi', 'BtPrev', () => this.step({ step: 'prev' })));
    }
  }

  private step(payload: { step: 'next' | 'prev' | 'yes' | 'no' | 'select' | 'end'; selection?: number }) {
    if (!this.dialogueCurrent) return;
    const requestId = `npc-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.currentRequestId = requestId;
    this.send({ type: 'npcTalk', requestId, npcId: this.dialogueCurrent.npcId, ...payload });
  }

  // ------------------------------------------------------------------- shop

  private openShop(state: { npcId: string; shopId: string; name: string; nameZh?: string }) {
    const items = (this.shopCatalog[state.shopId] ?? []).map(entry => ({
      itemId: entry.itemId,
      price: entry.price,
      name: this.itemNames[entry.itemId] ?? entry.itemId,
      icon: this.manifest.items?.[entry.itemId]?.url,
      source: this.itemSources[entry.itemId],
    }));
    this.shopCurrent = { ...state, items };
    this.renderShop();
  }

  private renderShop() {
    const current = this.shopCurrent;
    if (!current) return;
    if (!this.shopRoot) {
      const root = document.createElement('div');
      root.className = 'npc-shop';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', uiLocale() === 'en' ? 'Shop' : '商店');
      const backgrnd = this.uiFrame('shopUi', 'backgrnd');
      if (backgrnd) {
        root.style.width = `${backgrnd.width}px`;
        root.style.height = `${backgrnd.height}px`;
        for (const key of ['backgrnd','backgrnd2','backgrnd3']) {
          const asset = this.uiFrame('shopUi', key);
          if (!asset) continue;
          const image = frame(asset.url, 'npc-shop-backgrnd', asset.width, asset.height);
          Object.assign(image.style, {left:`${asset.x}px`,top:`${asset.y}px`,width:`${asset.width}px`,height:`${asset.height}px`});
          root.appendChild(image);
        }
      }

      const title = document.createElement('div');
      title.className = 'npc-shop-title';
      root.appendChild(title);

      // Buy/sell tabs.  Both live in the same 273 merchant window; the sell
      // tab lists the player's own inventory instead of the shop catalog.
      const tabs = document.createElement('div');
      tabs.className = 'npc-shop-tabs';
      this.shopTabsRoot = tabs;
      root.appendChild(tabs);

      const list = document.createElement('div');
      list.className = 'npc-shop-list';
      this.shopItemsRoot = list;
      root.appendChild(list);

      const meso = document.createElement('div');
      meso.className = 'npc-shop-meso';
      const mesoImg = this.uiFrame('shopUi', 'meso');
      if (mesoImg) meso.appendChild(frame(mesoImg.url, undefined, 14, 14));
      this.shopMesos = document.createElement('b');
      const label = document.createElement('span');
      label.textContent = uiText('meso');
      meso.append(this.shopMesos, label);
      root.appendChild(meso);

      const exitWrap = document.createElement('div');
      exitWrap.className = 'npc-shop-exit';
      exitWrap.appendChild(this.spriteButton('shopUi', 'BtExit', () => this.closeShop()));
      root.appendChild(exitWrap);

      this.shopRoot = root;
      this.host.appendChild(root);
      this.destroyFns.push(() => root.remove());
    }
    const root = this.shopRoot;
    const title = root.querySelector<HTMLElement>('.npc-shop-title');
    if (title) title.textContent = displayName(current.nameZh, current.name);
    this.renderShopTabs();
    this.renderShopList();
  }

  /** The buy/sell switch at the top of the merchant window. */
  private renderShopTabs() {
    if (!this.shopTabsRoot) return;
    this.shopTabsRoot.replaceChildren();
    for (const tab of ['buy', 'sell'] as ShopTab[]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `npc-shop-tab${this.shopTab === tab ? ' is-active' : ''}`;
      button.textContent = uiText(tab === 'buy' ? 'shopBuyTab' : 'shopSellTab');
      button.addEventListener('click', () => {
        if (this.shopTab === tab) return;
        this.shopTab = tab;
        this.renderShop();
      });
      this.shopTabsRoot.appendChild(button);
    }
  }

  private renderShopList() {
    const current = this.shopCurrent;
    if (!current || !this.shopItemsRoot) return;
    this.shopItemsRoot.replaceChildren();
    if (this.shopTab === 'sell') {
      this.renderSellList();
      return;
    }
    if (!current.items.length) {
      const empty = document.createElement('div');
      empty.className = 'npc-shop-empty';
      empty.textContent = uiLocale() === 'en' ? 'The shop has nothing for sale.' : '这家商店目前没有可购买的商品。';
      this.shopItemsRoot.appendChild(empty);
      return;
    }
    for (const entry of current.items) {
      const row = document.createElement('div');
      row.className = 'npc-shop-row';
      const iconWrap = document.createElement('div');
      iconWrap.className = 'npc-shop-icon';
      if (entry.icon) iconWrap.appendChild(frame(entry.icon));
      const name = document.createElement('span');
      name.className = 'npc-shop-name';
      name.textContent = displayText(entry.name);
      name.title = displayText(entry.name);
      const price = document.createElement('span');
      price.className = 'npc-shop-price';
      price.textContent = `${entry.price.toLocaleString()} ${uiText('meso')}`;
      const buyWrap = document.createElement('div');
      buyWrap.className = 'npc-shop-buy';
      buyWrap.appendChild(this.spriteButton('shopUi', 'BtBuy', () => this.buy(entry.itemId, 1)));
      row.append(iconWrap, name, price, buyWrap);
      this.shopItemsRoot.appendChild(row);
    }
  }

  /**
   * Sell tab: the player's own inventory, one row per stack.
   *
   * Only items with a catalog price are listed.  The payout shown is a
   * preview of the server's own rule — the request itself carries just the
   * shop, tab, slot and count, so a tampered row cannot claim a price.
   */
  private renderSellList() {
    const entries = this.sellEntries();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'npc-shop-empty';
      empty.textContent = uiLocale() === 'en' ? 'You have nothing to sell.' : '背包中没有可以出售的物品。';
      this.shopItemsRoot?.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'npc-shop-row';
      const iconWrap = document.createElement('div');
      iconWrap.className = 'npc-shop-icon';
      if (entry.icon) iconWrap.appendChild(frame(entry.icon));
      const name = document.createElement('span');
      name.className = 'npc-shop-name';
      const label = entry.quantity > 1 ? `${entry.name} × ${entry.quantity}` : entry.name;
      name.textContent = displayText(label);
      name.title = displayText(entry.name);
      const price = document.createElement('span');
      price.className = 'npc-shop-price';
      price.textContent = `${entry.preview.toLocaleString()} ${uiText('meso')}`;
      const sellWrap = document.createElement('div');
      sellWrap.className = 'npc-shop-buy';
      // Reuse the source BtBuy sprite; the 273 merchant window has no
      // separate sell button art in the exported subtree.
      sellWrap.appendChild(this.spriteButton('shopUi', 'BtBuy', () => this.sell(entry)));
      row.append(iconWrap, name, price, sellWrap);
      this.shopItemsRoot?.appendChild(row);
    }
  }

  /** Inventory rows the shop would accept, with the payout preview filled in. */
  private sellEntries(): SellEntry[] {
    const entries: SellEntry[] = [];
    for (const item of this.playerInventory) {
      const price = this.itemPrices[item.itemId];
      if (!price) continue;
      const quantity = item.quantity ?? 0;
      if (quantity <= 0) continue;
      entries.push({
        itemId: item.itemId,
        // `itemCategoryTab` is the 0-based view tab; the protocol's
        // inventoryType is the 1-based WZ category, as used by dropItem.
        inventoryType: itemCategoryTab(item.itemId) + 1,
        slot: item.slot,
        quantity,
        preview: Math.floor((price * SHOP_SELL_PERCENT) / 100) * quantity,
        name: this.itemNames[item.itemId] ?? item.itemId,
        icon: this.manifest.items?.[item.itemId]?.url,
      });
    }
    return entries.sort((left, right) => left.slot - right.slot);
  }

  private sell(entry: SellEntry) {
    if (!this.shopCurrent) return;
    const requestId = `shop-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.send({
      type: 'shopSell',
      requestId,
      shopId: this.shopCurrent.shopId,
      inventoryType: entry.inventoryType,
      sourceSlot: entry.slot,
      quantity: entry.quantity,
    });
  }

  private buy(itemId: string, quantity: number) {
    if (!this.shopCurrent) return;
    const requestId = `shop-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.send({ type: 'shopBuy', requestId, shopId: this.shopCurrent.shopId, itemId, quantity });
  }

  private formatMesos(mesos: number): string {
    return `${mesos.toLocaleString()}`;
  }
}
