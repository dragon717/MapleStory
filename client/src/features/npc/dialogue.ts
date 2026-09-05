import type {
  ClientMessage, NpcState, PlayerState, ServerMessage,
} from '../../../../shared/protocol';
import type { DialogueAsset, Manifest, ShopAsset } from '../../assets/manifest';
import { protocolText, uiLocale, uiText } from '../../app/i18n';

const DIALOG_WIDTH = 360;
const DIALOG_HEIGHT = 160;
const DIALOG_BTN_WIDTH = 56;
const DIALOG_BTN_HEIGHT = 18;
const SHOP_WINDOW_WIDTH = 380;
const SHOP_WINDOW_HEIGHT = 320;

type SendClientMessage = (message: ClientMessage) => boolean;

interface DialogueState {
  requestId: string;
  npcId: string;
  name: string;
  dialog: Extract<ServerMessage, { type: 'npcResult' }>['dialog'];
}

interface ShopOpenState {
  npcId: string;
  shopId: string;
  name: string;
  items: { itemId: string; price: number; name: string; icon?: string; source?: string }[];
}

function sanitize(text: string): string {
  // Strip common GMS colour/style markers (#b, #B, #k...) and squeeze repeats.
  return text
    .replace(/#([a-zA-Z])/g, '')
    .replace(/#l/gi, '')
    .replace(/\\\"/g, '"')
    .replace(/\s+#n/g, '\n')
    .trim();
}

/**
 * Npc conversation + shop window.
 *
 * The dialogue data is produced server-side from the Cosmic scripts, then the
 * client drives the renderer from those `npcResult` messages.  The shop
 * window consumes a `shopResult` callback only for confirmation; the item
 * list itself comes from `shared/gameplay.json` (which `loadManifest` already
 * pulled into the JS bundle via `manifest.shopCatalog`).
 */
export class NpcDialogueView {
  private readonly host: HTMLElement;
  private readonly manifest: Manifest;
  private dialogueRoot?: HTMLDivElement;
  private dialogueText?: HTMLDivElement;
  private dialogueButtons?: HTMLDivElement;
  private dialogueHead?: HTMLDivElement;
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

  /**
   * Notify the renderer that a server snapshot updated the player state.
   * Used to refresh the mesos display inside the shop window.
   */
  syncPlayer(player: Pick<PlayerState, 'mesos'>) {
    if (this.shopMesos) {
      this.shopMesos.textContent = this.formatMesos(player.mesos);
    }
  }

  /**
   * Update the visible label above the npc head with the floating
   * conversation name; called once after a `npcResult` arrives.
   */
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
      name: message.name,
      dialog: message.dialog,
    };
    this.renderDialogue();
  }

  private currentRequestId = '';
  private currentNpcId = '';

  /**
   * Begin a conversation from a player-initiated request (the user pressed
   * ↑ while standing in front of an npc).
   */
  startTalk(npc: NpcState) {
    const requestId = `npc-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.currentRequestId = requestId;
    this.currentNpcId = npc.id;
    this.send({ type: 'npcTalk', requestId, npcId: npc.id, step: 'start' });
  }

  /**
   * Find the nearest npc the player is standing next to.  Used by the ↑ key
   * to decide who to greet.
   */
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
  }

  private closeShop() {
    this.shopRoot?.remove();
    this.shopRoot = undefined;
    this.shopCurrent = undefined;
  }

  private renderDialogue() {
    const state = this.dialogueCurrent;
    if (!state) {
      this.closeDialogue();
      return;
    }
    if (!this.dialogueRoot) {
      this.dialogueRoot = document.createElement('div');
      this.dialogueRoot.className = 'npc-dialogue';
      this.dialogueRoot.style.cssText = `position:absolute;left:50%;top:64px;transform:translateX(-50%);width:${DIALOG_WIDTH}px;padding:8px;background:rgba(0,0,0,0.55);color:#fff;font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-size:13px;border:1px solid #334;z-index:30;`;
      this.host.appendChild(this.dialogueRoot);
      this.dialogueHead = document.createElement('div');
      this.dialogueHead.style.cssText = 'font-weight:600;margin-bottom:6px;color:#ffd966';
      this.dialogueRoot.appendChild(this.dialogueHead);
      this.dialogueText = document.createElement('div');
      this.dialogueText.style.cssText = 'min-height:64px;line-height:1.5;white-space:pre-wrap;';
      this.dialogueRoot.appendChild(this.dialogueText);
      this.dialogueButtons = document.createElement('div');
      this.dialogueButtons.style.cssText = 'margin-top:8px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
      this.dialogueRoot.appendChild(this.dialogueButtons);
    }
    if (!this.dialogueHead || !this.dialogueText || !this.dialogueButtons) return;
    this.dialogueHead.textContent = state.name;
    const dialog = state.dialog;
    if (!dialog) {
      this.dialogueText.textContent = '';
      this.dialogueButtons.replaceChildren();
      return;
    }
    this.dialogueText.textContent = sanitize(dialog.text);
    this.dialogueButtons.replaceChildren();
    const buttons = this.buttonsForDialog(dialog.kind, dialog.options);
    for (const button of buttons) this.dialogueButtons.appendChild(button);
  }

  private buttonsForDialog(kind: NonNullable<Extract<ServerMessage, { type: 'npcResult' }>['dialog']>['kind'], options: NonNullable<Extract<ServerMessage, { type: 'npcResult' }>['dialog']>['options']): HTMLButtonElement[] {
    const state = this.dialogueCurrent;
    if (!state) return [];
    const make = (label: string, onClick: () => void) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = `padding:4px 12px;background:#1c1c2c;color:#ffd966;border:1px solid #555;border-radius:2px;cursor:pointer;font-size:12px;`;
      btn.onclick = onClick;
      return btn;
    };
    switch (kind) {
      case 'next':
      case 'nextPrev':
        return [make(uiLocale() === 'en' ? 'Next' : '下一步', () => this.step({ step: 'next' }))];
      case 'prev':
        return [make(uiLocale() === 'en' ? 'Prev' : '上一步', () => this.step({ step: 'prev' }))];
      case 'ok':
        return [make(uiLocale() === 'en' ? 'OK' : '确认', () => this.step({ step: 'end' }))];
      case 'yesNo':
        return [
          make(uiLocale() === 'en' ? 'Yes' : '是', () => this.step({ step: 'yes' })),
          make(uiLocale() === 'en' ? 'No' : '否', () => this.step({ step: 'no' })),
        ];
      case 'simple':
        return (options ?? []).map(option => make(option.text, () => this.step({ step: 'select', selection: option.index })));
      default:
        return [];
    }
  }

  private step(payload: { step: 'next' | 'prev' | 'yes' | 'no' | 'select' | 'end'; selection?: number }) {
    if (!this.dialogueCurrent) return;
    const requestId = `npc-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.currentRequestId = requestId;
    this.send({ type: 'npcTalk', requestId, npcId: this.dialogueCurrent.npcId, ...payload });
  }

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
      this.shopRoot = document.createElement('div');
      this.shopRoot.className = 'npc-shop';
      this.shopRoot.style.cssText = `position:absolute;left:50%;top:96px;transform:translateX(-50%);width:${SHOP_WINDOW_WIDTH}px;height:${SHOP_WINDOW_HEIGHT}px;background:rgba(0,0,0,0.78);color:#fff;border:1px solid #445;display:flex;flex-direction:column;font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-size:12px;z-index:30;`;
      const header = document.createElement('div');
      header.style.cssText = 'padding:6px 10px;background:#222;font-weight:600;color:#ffd966;display:flex;justify-content:space-between;align-items:center;';
      header.appendChild(Object.assign(document.createElement('span'), { id: 'shop-title', textContent: '' }));
      const exit = document.createElement('button');
      exit.textContent = uiLocale() === 'en' ? 'Close' : '关闭';
      exit.style.cssText = 'background:#1c1c2c;color:#ffd966;border:1px solid #555;cursor:pointer;padding:2px 10px;';
      exit.onclick = () => this.closeShop();
      header.appendChild(exit);
      this.shopRoot.appendChild(header);
      const footer = document.createElement('div');
      footer.style.cssText = 'padding:6px 10px;border-top:1px solid #334;display:flex;justify-content:space-between;';
      const mesosLabel = document.createElement('span');
      mesosLabel.textContent = uiLocale() === 'en' ? 'Your mesos: ' : '我的金币：';
      this.shopMesos = document.createElement('span');
      this.shopMesos.style.color = '#ffd966';
      footer.append(mesosLabel, this.shopMesos);
      this.shopRoot.appendChild(footer);
      const list = document.createElement('div');
      list.style.cssText = 'flex:1;overflow-y:auto;padding:6px 10px;display:flex;flex-direction:column;gap:4px;';
      this.shopItemsRoot = list;
      this.shopRoot.appendChild(list);
      this.host.appendChild(this.shopRoot);
      this.destroyFns.push(() => this.shopRoot?.remove());
    }
    const title = this.shopRoot.querySelector<HTMLSpanElement>('#shop-title');
    if (title) title.textContent = `${current.name} · ${uiLocale() === 'en' ? 'Shop' : '商店'}`;
    if (!this.shopItemsRoot) return;
    this.shopItemsRoot.replaceChildren();
    if (!current.items.length) {
      const empty = document.createElement('div');
      empty.textContent = uiLocale() === 'en' ? 'The shop has nothing for sale.' : '这家商店目前没有可购买的商品。';
      this.shopItemsRoot.appendChild(empty);
      return;
    }
    for (const entry of current.items) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:4px 6px;border-bottom:1px dashed #334;';
      const icon = document.createElement('img');
      icon.alt = entry.itemId;
      const itemAsset = this.manifest.items?.[entry.itemId];
      icon.src = itemAsset?.url ?? '';
      icon.style.cssText = 'width:32px;height:32px;background:#000;object-fit:contain;';
      const label = document.createElement('span');
      label.textContent = this.itemNames[entry.itemId] ?? entry.itemId;
      label.style.cssText = 'flex:1;color:#fff';
      const price = document.createElement('span');
      price.textContent = `${entry.price.toLocaleString()} ${uiText('meso')}`;
      price.style.cssText = 'color:#ffd966';
      const buy = document.createElement('button');
      buy.textContent = uiLocale() === 'en' ? 'Buy' : '购买';
      buy.style.cssText = 'background:#1c1c2c;color:#ffd966;border:1px solid #555;cursor:pointer;padding:2px 10px;';
      buy.onclick = () => this.buy(entry.itemId, 1);
      row.append(icon, label, price, buy);
      this.shopItemsRoot.appendChild(row);
    }
  }

  private buy(itemId: string, quantity: number) {
    if (!this.shopCurrent) return;
    const requestId = `shop-${++this.requestSequence}-${Date.now().toString(36)}`;
    this.send({ type: 'shopBuy', requestId, shopId: this.shopCurrent.shopId, itemId, quantity });
  }

  private formatMesos(mesos: number): string {
    return `${mesos.toLocaleString()} ${uiText('meso')}`;
  }
}