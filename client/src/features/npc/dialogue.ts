import type {
  ClientMessage, NpcState, PlayerState, ServerMessage,
} from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { uiLocale, uiText } from '../../app/i18n';

type SendClientMessage = (message: ClientMessage) => boolean;

interface DialogueState {
  requestId: string;
  npcId: string;
  npcTemplateId?: string;
  name: string;
  dialog: Extract<ServerMessage, { type: 'npcResult' }>['dialog'];
}

interface ShopOpenState {
  npcId: string;
  shopId: string;
  name: string;
  items: { itemId: string; price: number; name: string; icon?: string; source?: string }[];
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
 * Npc conversation + shop window, rebuilt on the source v83 art:
 *  - UtilDlgEx t/c/s frame with the speaker portrait + `bar` nameplate,
 *  - UtilDlgEx Bt* sprites for the answers,
 *  - Shop backgrnd + BtBuy/BtExit/meso sprites for the merchant window.
 *
 * The dialogue data is produced server-side from the Cosmic scripts, then the
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
      if (this.shopCurrent) this.renderShop();
    } catch (error) {
      this.status(`NPC 资源加载失败：${(error as Error).message}`, true);
    }
  }

  /** Refresh the mesos display inside the shop window from a player update. */
  syncPlayer(player: Pick<PlayerState, 'mesos'>) {
    if (this.shopMesos) this.shopMesos.textContent = this.formatMesos(player.mesos);
  }

  receive(message: Extract<ServerMessage, { type: 'npcResult' }>) {
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
      this.openShop({ npcId: message.npcId, shopId: message.shop.shopId, name: message.name });
      return;
    }
    this.currentRequestId = message.requestId;
    this.dialogueCurrent = {
      requestId: message.requestId,
      npcId: message.npcId,
      npcTemplateId: this.npcTemplates.get(message.npcId),
      name: message.name,
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

  destroy() {
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
    if (plateName) plateName.textContent = state.name;

    const dialog = state.dialog;
    if (!dialog) {
      text.textContent = '';
      options.replaceChildren();
      return;
    }
    root.classList.toggle('npc-dlg-pageable', dialog.kind === 'next' || dialog.kind === 'nextPrev' || dialog.kind === 'prev');
    text.textContent = sanitize(dialog.text);
    options.replaceChildren();
    const optHint = document.createElement('div');
    optHint.className = 'npc-dlg-opt-hint';
    if (dialog.kind === 'simple') {
      for (const option of dialog.options ?? []) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'npc-dlg-opt';
        btn.textContent = option.text;
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

    const top = this.uiFrame('dialogUi', 't');
    const bottom = this.uiFrame('dialogUi', 's');
    const bar = this.uiFrame('dialogUi', 'bar');
    if (top) root.appendChild(frame(top.url, 'npc-dlg-img npc-dlg-top', 529, 28));

    const mid = document.createElement('div');
    mid.className = 'npc-dlg-mid';

    const aside = document.createElement('div');
    aside.className = 'npc-dlg-aside';
    aside.appendChild(frame(undefined, 'npc-dlg-speaker'));
    const plate = document.createElement('div');
    plate.className = 'npc-dlg-plate';
    if (bar) plate.appendChild(frame(bar.url, 'npc-dlg-plate-img', 121, 19));
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
    if (bottom) root.appendChild(frame(bottom.url, 'npc-dlg-img npc-dlg-bottom', 529, 58));

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

    // Click anywhere on the frame advances simple page turns (v83 behaviour).
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

  private openShop(state: { npcId: string; shopId: string; name: string }) {
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
      const backgrnd = this.uiFrame('shopUi', 'backgrnd');
      if (backgrnd) root.appendChild(frame(backgrnd.url, 'npc-shop-backgrnd', 463, 339));

      const title = document.createElement('div');
      title.className = 'npc-shop-title';
      root.appendChild(title);

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
    if (title) title.textContent = `${current.name}`;
    if (!this.shopItemsRoot) return;
    this.shopItemsRoot.replaceChildren();
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
      name.textContent = entry.name;
      name.title = entry.name;
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

  private buy(itemId: string, quantity: number) {
    if (!this.shopCurrent) return;
    const requestId = `shop-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.send({ type: 'shopBuy', requestId, shopId: this.shopCurrent.shopId, itemId, quantity });
  }

  private formatMesos(mesos: number): string {
    return `${mesos.toLocaleString()}`;
  }
}
