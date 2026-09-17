import type {
  ClientMessage, InventoryItem, NpcState, PlayerState, ServerMessage, ShopRebuyEntry,
} from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { itemCategoryTab } from '../inventory/names';
import { inventoryTypeForTab } from '../inventory/view-model';
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

type ShopTab = 'buy' | 'rebuy';

/** Fraction of an item's catalog price an NPC shop pays. Mirrors the server's
 *  SHOP_SELL_PRICE_PERCENT; the server remains authoritative and this is only
 *  used to preview the payout before the player confirms. */
const SHOP_SELL_PERCENT = 50;

/** Flat per-unit payout for the arrow family (206xxxx 箭矢/弩箭矢).  The
 *  catalog authors `price: 0` for arrows, but the shop still pays a flat
 *  1 meso apiece — mirrors the server's `flat_sell_payout` override. */
const ARROW_SELL_PAYOUT = 1;

/** Per-unit sell payout preview for one inventory row.  The arrow family is
 *  paid flat; every other priced item earns the catalog price's sell share
 *  floored at one meso (a shop never pays zero for a priced item — mirrors
 *  the server).  An item with no price at all means the server will refuse
 *  the sale. */
function unitSellPayout(itemId: string, price?: number): number {
  const group = Number.isFinite(Number(itemId)) ? Math.floor(Number(itemId) / 10000) : NaN;
  if (group === 206) return ARROW_SELL_PAYOUT;
  return price ? Math.max(1, Math.floor((price * SHOP_SELL_PERCENT) / 100)) : 0;
}

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
 *  - Shop backgrnd + BtBuy/BtSell/BtExit/meso sprites for the merchant window.
 *
 * The merchant window is the source's two-panel layout (its背景 art carries the
 * centre divider): the left panel buys — the shop's goods and, behind the
 * second tab, the stacks this character has sold back at their sale price — and
 * the right panel sells the character's own inventory.  The dialogue data is
 * produced server-side from the active script catalog, then the client drives
 * the renderer from those `npcResult` messages.  The shop item list itself
 * comes from `shared/gameplay.json`; the buy-back list only ever comes from the
 * server's `shopRebuyState` and is never derived client-side.
 */
export class NpcDialogueView {
  private readonly host: HTMLElement;
  private readonly manifest: Manifest;
  private dialogueRoot?: HTMLDivElement;
  private dialogueText?: HTMLDivElement;
  private dialogueOptions?: HTMLDivElement;
  private dialogueCurrent?: DialogueState;
  private shopRoot?: HTMLDivElement;
  /** Left panel list: the shop's goods, or the buy-back rows. */
  private shopItemsRoot?: HTMLDivElement;
  /** Right panel list: the character's own sellable stacks. */
  private shopSellRoot?: HTMLDivElement;
  /** Row signature already rendered in the sell panel; skips no-op rebuilds. */
  private sellSignature = '';
  /** Second-step quantity dialog for selling part of a stack. */
  private sellConfirmRoot?: HTMLDivElement;
  private sellConfirmEntry?: SellEntry;
  private shopMesos?: HTMLSpanElement;
  private shopCurrent?: ShopOpenState;
  private shopTab: ShopTab = 'buy';
  private shopTabsRoot?: HTMLDivElement;
  /** Authoritative buy-back list from the latest `shopRebuyState`.  Every row
   *  is server-owned: the client only renders it and names one back. */
  private rebuyEntries: ShopRebuyEntry[] = [];
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

  constructor(
    host: HTMLElement, manifest: Manifest, private status: (message: string, error?: boolean) => void,
    send: SendClientMessage = () => false, private onClose?: () => void,
  ) {
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
      // has no preview and the server will refuse it.  Quest-flagged items are
      // never sellable server-side (even a data-refreshed price tag does not
      // buy them a slot), so they are left out of the lookup entirely.
      const prices: Record<string, number> = {};
      for (const [id, entry] of Object.entries(map as Record<string, { info?: { price?: number; quest?: number } }>)) {
        if (entry.info?.quest) continue;
        const price = entry.info?.price ?? 0;
        if (price > 0) prices[id] = price;
      }
      this.itemPrices = prices;
      if (this.shopCurrent) this.renderShop();
    } catch (error) {
      this.status(`NPC 资源加载失败：${(error as Error).message}`, true);
    }
  }

  /** Refresh the mesos display and the sell panel's inventory from a player update. */
  syncPlayer(player: Pick<PlayerState, 'mesos'> & Partial<Pick<PlayerState, 'inventory'>>) {
    this.playerMesos = player.mesos;
    if (player.inventory) this.playerInventory = player.inventory;
    if (this.shopMesos) this.shopMesos.textContent = this.formatMesos(player.mesos);
    // The sell panel mirrors live inventory, so a purchase, a sale or a pickup
    // has to refresh it while the window stays open.
    if (this.shopCurrent) this.renderSellList();
  }

  /**
   * Replace the buy-back list with the authoritative one the server pushed.
   *
   * Rows are never computed here: whether a stack is still for sale, how many
   * are left and what they cost are all the server's answer, and a window open
   * on the buy-back tab re-renders as soon as a newer list arrives.
   */
  receiveRebuyState(entries?: ShopRebuyEntry[]) {
    this.rebuyEntries = Array.isArray(entries) ? entries : [];
    if (this.shopCurrent && this.shopTab === 'rebuy') this.renderShopList();
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
    this.syncOpenState();
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
    this.closeSellConfirm();
    this.closeDialogue();
    this.closeShop();
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.isOpen()) return;
    // Escape over the quantity dialog dismisses only the dialog; the shop
    // itself stays open so a mistyped count does not cost the whole window.
    if (this.sellConfirmRoot) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.closeSellConfirm();
      return;
    }
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
    this.syncOpenState();
  }

  private closeShop() {
    this.shopRoot?.remove();
    this.shopRoot = undefined;
    this.shopCurrent = undefined;
    this.syncOpenState();
  }

  /**
   * Keep the host informed of the open → closed edge.
   *
   * Escape, the close buttons, a server-side `ended` and a map change all land
   * in `closeDialogue`/`closeShop`, so the notification has to live there rather
   * than at each call site — the map view uses it to drop the clicked-npc
   * highlight, and a missed path would leave a nameplate lit forever.  Opening a
   * window arms the report and closing fires it once, so `clear()` (which closes
   * both windows) cannot report twice.
   */
  private syncOpenState() {
    const open = this.isOpen();
    if (open === this.reportedOpen) return;
    this.reportedOpen = open;
    if (!open) this.onClose?.();
  }

  /** Last open/closed state the host was told about; nothing is open at boot. */
  private reportedOpen = false;

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
    // 占位提示（`source: 'placeholder'`）按「备注」呈现：它说的是“源里这个 NPC
    // 就没有说话内容”，不是 NPC 本人的台词，所以用灰斜体与真实对白分开。阶段二
    // 接进来的源台词（`shared/npc-dialogue.json`）不带这个标记，因此不会被误标成
    // 备注；真实对白也不会因为切换过占位而残留这个类。
    text.classList.toggle('is-placeholder', dialog?.source === 'placeholder');
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
    this.syncOpenState();
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

      // The source `Shop/backgrnd` is a two-panel window: the left panel buys
      // (its tabs switch between the shop's goods and what this character has
      // sold back), the right panel sells the character's own inventory.  Both
      // panels are on screen at once, so the divider in the art is the seam
      // between the two lists instead of a line under a full-width one.
      const left = document.createElement('div');
      left.className = 'npc-shop-panel npc-shop-panel-left';
      root.appendChild(left);

      const tabs = document.createElement('div');
      tabs.className = 'npc-shop-tabs';
      this.shopTabsRoot = tabs;
      left.appendChild(tabs);

      const list = document.createElement('div');
      list.className = 'npc-shop-list';
      this.shopItemsRoot = list;
      left.appendChild(list);

      const meso = document.createElement('div');
      meso.className = 'npc-shop-meso';
      const mesoImg = this.uiFrame('shopUi', 'meso');
      if (mesoImg) meso.appendChild(frame(mesoImg.url, undefined, 14, 14));
      this.shopMesos = document.createElement('b');
      const label = document.createElement('span');
      label.textContent = uiText('meso');
      meso.append(this.shopMesos, label);
      root.appendChild(meso);

      const right = document.createElement('div');
      right.className = 'npc-shop-panel npc-shop-panel-right';
      root.appendChild(right);

      // The sell side has no switch of its own: it is always the character's
      // own inventory, so its heading is a tab-shaped label rather than a
      // button, matching the two-panel art.
      const sellHead = document.createElement('div');
      sellHead.className = 'npc-shop-tabs';
      const sellLabel = document.createElement('span');
      sellLabel.className = 'npc-shop-tab is-active is-static';
      sellLabel.textContent = uiText('shopSellTab');
      sellHead.appendChild(sellLabel);
      right.appendChild(sellHead);

      const sellList = document.createElement('div');
      sellList.className = 'npc-shop-list';
      this.shopSellRoot = sellList;
      right.appendChild(sellList);

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
    this.renderSellList(true);
  }

  /** The buy / buy-back switch at the top of the left panel. */
  private renderShopTabs() {
    if (!this.shopTabsRoot) return;
    this.shopTabsRoot.replaceChildren();
    for (const tab of ['buy', 'rebuy'] as ShopTab[]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `npc-shop-tab${this.shopTab === tab ? ' is-active' : ''}`;
      button.textContent = uiText(tab === 'buy' ? 'shopBuyTab' : 'shopRebuyTab');
      button.addEventListener('click', () => {
        if (this.shopTab === tab) return;
        this.shopTab = tab;
        this.renderShop();
      });
      this.shopTabsRoot.appendChild(button);
    }
  }

  /**
   * One list row: icon, a name/price column and a source sprite button.  The
   * row has to fit a single panel of the two-panel window, so the name and the
   * price stack instead of sharing one line.
   */
  private shopRow(spec: {
    icon?: string;
    name: string;
    quantity?: number;
    price: string;
    button: string;
    onClick: () => void;
  }): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'npc-shop-row';
    const iconWrap = document.createElement('div');
    iconWrap.className = 'npc-shop-icon';
    if (spec.icon) iconWrap.appendChild(frame(spec.icon));
    const info = document.createElement('div');
    info.className = 'npc-shop-info';
    const name = document.createElement('span');
    name.className = 'npc-shop-name';
    const label = spec.quantity && spec.quantity > 1 ? `${spec.name} × ${spec.quantity}` : spec.name;
    name.textContent = displayText(label);
    name.title = displayText(spec.name);
    const price = document.createElement('span');
    price.className = 'npc-shop-price';
    price.textContent = spec.price;
    info.append(name, price);
    const action = document.createElement('div');
    action.className = 'npc-shop-buy';
    action.appendChild(this.spriteButton('shopUi', spec.button, spec.onClick));
    row.append(iconWrap, info, action);
    return row;
  }

  /** Left panel: the shop's goods, or the buy-back rows. */
  private renderShopList() {
    const current = this.shopCurrent;
    if (!current || !this.shopItemsRoot) return;
    this.shopItemsRoot.replaceChildren();
    if (this.shopTab === 'rebuy') {
      this.renderRebuyList();
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
      this.shopItemsRoot.appendChild(this.shopRow({
        icon: entry.icon,
        name: entry.name,
        price: `${entry.price.toLocaleString()} ${uiText('meso')}`,
        button: 'BtBuy',
        onClick: () => this.buy(entry.itemId, 1),
      }));
    }
  }

  /**
   * Buy-back rows: stacks this character sold to a merchant, priced at exactly
   * what the shop paid.  Every row is the server's, so the list is only ever
   * rendered — buying one back is an intent the server resolves against it.
   */
  private renderRebuyList() {
    const root = this.shopItemsRoot;
    if (!root) return;
    if (!this.rebuyEntries.length) {
      const empty = document.createElement('div');
      empty.className = 'npc-shop-empty';
      empty.textContent = uiLocale() === 'en'
        ? 'Nothing has been sold to a shop yet.'
        : '还没有卖给商店的物品可以赎回。';
      root.appendChild(empty);
      return;
    }
    for (const entry of this.rebuyEntries) {
      root.appendChild(this.shopRow({
        icon: this.manifest.items?.[entry.itemId]?.url,
        name: this.itemNames[entry.itemId] ?? entry.itemId,
        quantity: entry.quantity,
        // The whole row buys back at once, so the price shown is its total.
        price: `${(entry.unitPrice * entry.quantity).toLocaleString()} ${uiText('meso')}`,
        button: 'BtBuy',
        onClick: () => this.rebuy(entry),
      }));
    }
  }

  /**
   * Right panel: the character's own inventory, one row per stack.
   *
   * Only items with a catalog price are listed.  The payout shown is a
   * preview of the server's own rule — the request itself carries just the
   * shop, tab, slot and count, so a tampered row cannot claim a price.
   *
   * Snapshots arrive far faster than anyone clicks, and rebuilding the rows
   * between a press and its release swallows the click, so an unchanged list
   * is left alone unless the caller forces a rebuild (open, tab switch).
   */
  private renderSellList(force = false) {
    const root = this.shopSellRoot;
    if (!root) return;
    const entries = this.sellEntries();
    const signature = entries
      .map(entry => `${entry.itemId}:${entry.slot}:${entry.quantity}:${entry.preview}`)
      .join('|');
    if (!force && signature === this.sellSignature) return;
    this.sellSignature = signature;
    root.replaceChildren();
    // The quantity dialog names a specific stack; if that stack changed or
    // left the bag while the dialog was open, the server would only refuse
    // the count anyway, so close the dialog instead of inviting the refusal.
    if (this.sellConfirmEntry
      && !entries.some(entry => entry.itemId === this.sellConfirmEntry!.itemId
        && entry.slot === this.sellConfirmEntry!.slot
        && entry.quantity === this.sellConfirmEntry!.quantity)) {
      this.closeSellConfirm();
    }
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'npc-shop-empty';
      empty.textContent = uiLocale() === 'en' ? 'You have nothing to sell.' : '背包中没有可以出售的物品。';
      root.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      root.appendChild(this.shopRow({
        icon: entry.icon,
        name: entry.name,
        quantity: entry.quantity,
        price: `${entry.preview.toLocaleString()} ${uiText('meso')}`,
        // The 273 merchant window ships a dedicated 賣出道具 sprite, so the
        // sell side must not borrow the buy art.
        button: 'BtSell',
        onClick: () => this.sell(entry),
      }));
    }
  }

  /**
   * Inventory rows the shop would accept, with the payout preview filled in.
   *
   * Only rows the server can actually pay for are listed: the payout is the
   * arrow family's flat 1 meso or the catalog price times the sell percentage
   * floored at one meso, and an item with no price at all (or a quest-flagged
   * one) is refused server-side, so offering a button for it would only
   * invite a failed sale.
   */
  private sellEntries(): SellEntry[] {
    const entries: SellEntry[] = [];
    for (const item of this.playerInventory) {
      const unitPayout = unitSellPayout(item.itemId, this.itemPrices[item.itemId]);
      if (unitPayout <= 0) continue;
      const quantity = item.quantity ?? 0;
      if (quantity <= 0) continue;
      // The inventory window's tab order is not the WZ category order (Etc
      // sits before Setup), so the tab goes through the shared tab → category
      // table; a plain `+ 1` sends the wrong category for Etc and Setup.
      const tab = itemCategoryTab(item.itemId);
      entries.push({
        itemId: item.itemId,
        inventoryType: inventoryTypeForTab(tab),
        slot: item.slot,
        quantity,
        preview: unitPayout * quantity,
        name: this.itemNames[item.itemId] ?? item.itemId,
        icon: this.manifest.items?.[item.itemId]?.url,
      });
    }
    return entries.sort((left, right) => left.slot - right.slot);
  }

  /** Selling a single item goes straight out; a stack of more than one first
   *  opens the second-step dialog so the player names how many to sell. */
  private sell(entry: SellEntry) {
    if (!this.shopCurrent) return;
    if (entry.quantity > 1) {
      this.openSellConfirm(entry);
      return;
    }
    this.sendSell(entry, 1);
  }

  private sendSell(entry: SellEntry, quantity: number) {
    if (!this.shopCurrent) return;
    const requestId = `shop-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.send({
      type: 'shopSell',
      requestId,
      shopId: this.shopCurrent.shopId,
      inventoryType: entry.inventoryType,
      sourceSlot: entry.slot,
      quantity,
    });
  }

  /**
   * The second-step sell dialog: how many of this stack to sell.
   *
   * The input defaults to the whole stack and clamps to 1..=stack size, and
   * the payout preview updates as the count changes.  The server remains the
   * authority — it re-reads the stack, so a stale or forged count can only be
   * refused, never overpaid.
   */
  private openSellConfirm(entry: SellEntry) {
    this.closeSellConfirm();
    const overlay = document.createElement('div');
    overlay.className = 'npc-sell-confirm';
    const unitPayout = entry.quantity > 0 ? Math.floor(entry.preview / entry.quantity) : 0;

    const title = document.createElement('div');
    title.className = 'npc-sell-confirm-title';
    title.textContent = uiLocale() === 'en' ? 'Sell items' : '售卖道具';

    const name = document.createElement('div');
    name.className = 'npc-sell-confirm-name';
    name.textContent = displayText(entry.name);

    const row = document.createElement('div');
    row.className = 'npc-sell-confirm-row';
    const input = document.createElement('input');
    input.className = 'npc-sell-confirm-input';
    input.type = 'number';
    input.min = '1';
    input.max = String(entry.quantity);
    input.value = String(entry.quantity);
    const total = document.createElement('span');
    total.className = 'npc-sell-confirm-total';
    const updateTotal = () => {
      total.textContent = `${(unitPayout * this.sellConfirmCount(entry, input)).toLocaleString()} ${uiText('meso')}`;
    };
    input.addEventListener('input', updateTotal);
    row.append(input, total);

    const buttons = document.createElement('div');
    buttons.className = 'npc-sell-confirm-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'npc-shop-tab npc-sell-confirm-cancel';
    cancel.textContent = uiLocale() === 'en' ? 'Cancel' : '取消';
    cancel.addEventListener('click', () => this.closeSellConfirm());
    buttons.append(
      this.spriteButton('shopUi', 'BtSell', () => {
        const count = this.sellConfirmCount(entry, input);
        this.closeSellConfirm();
        this.sendSell(entry, count);
      }),
      cancel,
    );

    overlay.append(title, name, row, buttons);
    this.shopRoot?.appendChild(overlay);
    this.sellConfirmRoot = overlay;
    this.sellConfirmEntry = entry;
    input.focus();
    input.select();
  }

  /** Clamp the typed count into 1..=stack size; 0 means "nothing to sell". */
  private sellConfirmCount(entry: SellEntry, input: HTMLInputElement): number {
    const parsed = Math.floor(Number(input.value));
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(entry.quantity, Math.max(1, parsed));
  }

  private closeSellConfirm() {
    this.sellConfirmRoot?.remove();
    this.sellConfirmRoot = undefined;
    this.sellConfirmEntry = undefined;
  }

  private buy(itemId: string, quantity: number) {
    if (!this.shopCurrent) return;
    const requestId = `shop-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.send({ type: 'shopBuy', requestId, shopId: this.shopCurrent.shopId, itemId, quantity });
  }

  /** Name one buy-back row back to the shop.  The row's identity and price are
   *  the server's; the request only says which one to take. */
  private rebuy(entry: ShopRebuyEntry) {
    if (!this.shopCurrent) return;
    const requestId = `shop-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.send({
      type: 'shopRebuy',
      requestId,
      shopId: this.shopCurrent.shopId,
      itemId: entry.itemId,
      unitPrice: entry.unitPrice,
    });
  }

  private formatMesos(mesos: number): string {
    return `${mesos.toLocaleString()}`;
  }
}
