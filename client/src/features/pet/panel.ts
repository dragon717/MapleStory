import type { ClientMessage, InventoryItem, PetState, PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest, PetUiData } from '../../assets/manifest';
import { itemCategoryTab, itemName } from '../inventory/names';
import { bringToFront, installWindowDrag } from '../ui/window-shell.ts';
import './style.css';

type SendClientMessage = (message: ClientMessage) => boolean;
const PET_TAB_COUNT = 3;
const CASH_TAB_TYPE = 5;
const PET_TITLE_HEIGHT = 28;

/** The three source tabs are a selected slot view, not three invented pet
 *  attributes.  Everything in the live rows comes from PlayerState.pets. */
export class PetPanel {
  private readonly root: HTMLDivElement;
  private readonly window: HTMLDivElement;
  private readonly sourcePanel: HTMLElement;
  private actionArt!: HTMLImageElement;
  private selectedPetArt!: HTMLImageElement;
  private selectedPetName!: HTMLSpanElement;
  private selectedPetType!: HTMLSpanElement;
  private selectedPetHunger!: HTMLSpanElement;
  private selectedPetLevel!: HTMLSpanElement;
  private selectedPetIntimacy!: HTMLSpanElement;
  private selectedIcon!: HTMLImageElement;
  private selectedName!: HTMLSpanElement;
  private selectedState!: HTMLSpanElement;
  private selectedSpeed!: HTMLSpanElement;
  private selectedUnknown!: HTMLSpanElement;
  private readonly slots!: HTMLDivElement;
  private readonly owned!: HTMLDivElement;
  private readonly tabs: HTMLButtonElement[] = [];
  private readonly tabStatus: HTMLSpanElement[] = [];
  private readonly slotRows: Array<{ card: HTMLDivElement; name: HTMLElement; mode: HTMLElement; speed: HTMLElement }> = [];
  private slotIdentity = '\0';
  private ownedIdentity = '\0';
  private readonly send: SendClientMessage;
  private readonly status: (message: string) => void;
  private readonly petUi?: PetUiData;
  private readonly petCatalog: NonNullable<Manifest['pets']> | undefined;
  private player?: PlayerState;
  private selectedSlot = 0;
  private openState = false;
  private destroyed = false;
  private requestSequence = 0;
  private dragDispose: () => void;
  private readonly resizeObserver: ResizeObserver;

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (this.destroyed || !this.openState || event.defaultPrevented || event.repeat || event.isComposing) return;
    const target = event.target;
    if (target instanceof Element && target.matches('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key === 'Escape' || event.code === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key >= '1' && event.key <= '3') {
      event.preventDefault();
      this.selectSlot(Number(event.key) - 1);
    }
  };

  constructor(host: HTMLElement, manifest: Manifest, status: (message: string) => void, send: SendClientMessage = () => false) {
    this.status = status;
    this.send = send;
    this.petUi = manifest.petUi;
    this.petCatalog = manifest.pets;
    this.root = document.createElement('div');
    this.root.className = 'ui-windows tms273-pet-host';
    this.root.hidden = true;
    this.root.dataset.open = 'false';

    this.window = document.createElement('div');
    this.window.className = 'pet-window';
    this.window.setAttribute('role', 'dialog');
    this.window.setAttribute('aria-modal', 'false');
    this.window.setAttribute('aria-label', '宠物管理');
    this.window.tabIndex = -1;

    const titlebar = document.createElement('div');
    titlebar.className = 'pet-titlebar';
    titlebar.setAttribute('aria-hidden', 'true');
    this.window.append(titlebar);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pet-window-close';
    close.textContent = '×';
    close.title = '关闭';
    close.setAttribute('aria-label', '关闭宠物管理');
    close.addEventListener('click', () => this.close());

    const layout = document.createElement('div');
    layout.className = 'pet-layout';
    this.sourcePanel = document.createElement('section');
    this.sourcePanel.className = 'pet-source-panel';
    this.sourcePanel.setAttribute('aria-label', 'TMS273 宠物详情');
    this.buildSourcePanel();
    layout.append(this.sourcePanel);

    const side = document.createElement('aside');
    side.className = 'pet-side-panel';
    const sideTitle = document.createElement('h2');
    sideTitle.textContent = '常驻宠物';
    side.append(sideTitle);
    const sideHint = document.createElement('p');
    sideHint.className = 'pet-side-hint';
    sideHint.textContent = '最多同时召唤 3 只宠物。';
    side.append(sideHint);
    const selected = document.createElement('div');
    selected.className = 'pet-selected-summary';
    this.selectedIcon = document.createElement('img');
    this.selectedIcon.className = 'pet-selected-icon';
    this.selectedIcon.alt = '';
    this.selectedIcon.width = 32;
    this.selectedIcon.height = 32;
    const selectedText = document.createElement('div');
    selectedText.className = 'pet-selected-text';
    this.selectedName = document.createElement('strong');
    this.selectedState = document.createElement('span');
    this.selectedSpeed = document.createElement('span');
    this.selectedUnknown = document.createElement('span');
    selectedText.append(this.selectedName, this.selectedState, this.selectedSpeed, this.selectedUnknown);
    selected.append(this.selectedIcon, selectedText);
    side.append(selected);
    this.slots = document.createElement('div');
    this.slots.className = 'pet-slots';
    side.append(this.slots);
    const ownedTitle = document.createElement('h3');
    ownedTitle.textContent = '拥有宠物';
    side.append(ownedTitle);
    this.owned = document.createElement('div');
    this.owned.className = 'pet-owned-list';
    this.owned.setAttribute('aria-live', 'polite');
    side.append(this.owned);
    layout.append(side);

    this.window.append(layout, close);
    this.root.append(this.window);
    host.append(this.root);

    this.dragDispose = installWindowDrag(this.root, this.window, {
      titleHeight: PET_TITLE_HEIGHT,
      isOpen: () => this.openState,
      onActivate: () => bringToFront(this.root, this.window),
    });
    this.resizeObserver = new ResizeObserver(() => {
      this.window.style.removeProperty('left');
      this.window.style.removeProperty('top');
      this.window.style.removeProperty('transform');
      delete this.window.dataset.windowPositioned;
    });
    this.resizeObserver.observe(this.root);
    document.addEventListener('keydown', this.handleKeyDown, true);
    this.update(undefined);
  }

  isOpen() { return this.openState; }

  toggle(): boolean {
    if (this.destroyed) return false;
    if (this.openState) { this.close(); return true; }
    if (!this.player) return false;
    this.open();
    return true;
  }

  open() {
    if (this.destroyed || !this.player) return;
    this.openState = true;
    this.root.hidden = false;
    this.root.dataset.open = 'true';
    this.window.hidden = false;
    bringToFront(this.root, this.window);
    this.renderCurrent();
    this.tabs[this.selectedSlot]?.focus({ preventScroll: true });
  }

  close() {
    const wasOpen = this.openState;
    this.openState = false;
    this.root.hidden = true;
    this.root.dataset.open = 'false';
    this.window.hidden = true;
    if (wasOpen) document.querySelector<HTMLElement>('#game')?.focus({ preventScroll: true });
  }

  update(player?: PlayerState) {
    if (this.destroyed) return;
    this.player = player;
    if (!player) {
      this.close();
      return;
    }
    // Hidden windows keep the latest snapshot in memory.  Rebuilding their
    // buttons on every 50 ms snapshot steals focus and can cancel a click.
    if (!this.openState) return;
    this.renderCurrent();
  }

  private renderCurrent() {
    const player = this.player;
    if (!player) return;
    const active = (player.pets ?? []).slice(0, PET_TAB_COUNT);
    if (this.selectedSlot >= PET_TAB_COUNT) this.selectedSlot = 0;
    this.renderSlots(active);
    this.renderOwned(this.ownedPetItems(player.inventory));
    this.renderSelected(active[this.selectedSlot]);
  }

  clear() {
    this.player = undefined;
    this.slotIdentity = '\0';
    this.ownedIdentity = '\0';
    this.close();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dragDispose();
    this.resizeObserver.disconnect();
    document.removeEventListener('keydown', this.handleKeyDown, true);
    this.root.remove();
  }

  private buildSourcePanel() {
    const windowData = this.petUi?.window;
    const ui = windowData?.ui;
    if (windowData) {
      this.sourcePanel.style.width = `${windowData.width}px`;
      this.sourcePanel.style.height = `${windowData.height}px`;
    }
    this.appendArt(this.sourcePanel, ui?.['panel/backgrnd'], 'pet-source-background', this.petUi?.layout.panel);
    this.appendArt(this.sourcePanel, ui?.['panel/backgrnd2'], 'pet-source-background', this.petUi?.layout.panelInner);
    this.appendArt(this.sourcePanel, ui?.['panel/backgrnd3'], 'pet-source-background', this.petUi?.layout.panelOverlay);

    this.actionArt = document.createElement('img');
    this.actionArt.className = 'pet-source-action';
    this.actionArt.alt = '';
    this.actionArt.draggable = false;
    // ActionPet is an authored ability/type plate.  No current player
    // contract carries that ability, so showing its default flame would be a
    // false claim for every pet.  Keep the export for later verified wiring,
    // but let the real Item/Pet stand frame own the preview.
    this.actionArt.hidden = true;
    const action = windowData?.actions[0];
    if (action) this.setArt(this.actionArt, action, this.petUi?.layout.action);
    this.sourcePanel.append(this.actionArt);

    this.selectedPetArt = document.createElement('img');
    this.selectedPetArt.className = 'pet-source-preview';
    this.selectedPetArt.alt = '';
    this.selectedPetArt.draggable = false;
    this.selectedPetArt.hidden = true;
    this.sourcePanel.append(this.selectedPetArt);
    this.selectedPetName = document.createElement('span');
    this.selectedPetName.className = 'pet-source-name';
    this.sourcePanel.append(this.selectedPetName);
    this.selectedPetType = this.sourceField('pet-source-type');
    this.selectedPetHunger = this.sourceField('pet-source-hunger');
    this.selectedPetLevel = this.sourceField('pet-source-level');
    this.selectedPetIntimacy = this.sourceField('pet-source-intimacy');

    const tabs = document.createElement('nav');
    tabs.className = 'pet-tabs';
    tabs.setAttribute('aria-label', '宠物槽位');
    for (let index = 0; index < PET_TAB_COUNT; index += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pet-tab';
      button.setAttribute('aria-label', `宠物槽位 ${index + 1}`);
      button.dataset.slot = String(index);
      button.addEventListener('click', () => this.selectSlot(index));
      const enabled = windowData?.tabs.enabled[index];
      const disabled = windowData?.tabs.disabled[index];
      if (enabled) {
        const image = document.createElement('img');
        image.alt = '';
        image.draggable = false;
        this.setArt(image, disabled ?? enabled, { x: 0, y: 0 });
        button.append(image);
        Object.assign(button.style, {
          left: `${enabled.x}px`,
          top: `${enabled.y}px`,
          width: `${enabled.width}px`,
          height: `${enabled.height}px`,
        });
        button.dataset.enabledUrl = enabled.url;
        button.dataset.disabledUrl = (disabled ?? enabled).url;
      }
      this.tabs.push(button);
      const status = document.createElement('span');
      status.className = 'pet-tab-status';
      status.setAttribute('aria-hidden', 'true');
      button.append(status);
      this.tabStatus.push(status);
      tabs.append(button);
    }
    this.sourcePanel.append(tabs);

  }

  private renderSlots(active: PetState[]) {
    const identity = active.map(pet => `${pet.id}:${pet.itemId}:${pet.inventorySlot}`).join('|');
    if (identity !== this.slotIdentity) {
      this.slotIdentity = identity;
      this.slotRows.splice(0);
      this.slots.replaceChildren();
      for (let index = 0; index < PET_TAB_COUNT; index += 1) {
        const card = document.createElement('div');
        card.className = 'pet-slot-card';
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.addEventListener('click', () => this.selectSlot(index));
        card.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.selectSlot(index); }
        });
        const label = document.createElement('span');
        label.className = 'pet-slot-number';
        label.textContent = `槽 ${index + 1}`;
        const name = document.createElement('strong');
        const mode = document.createElement('span');
        const speed = document.createElement('span');
        card.append(label, name, mode, speed);
        this.slotRows.push({ card, name, mode, speed });
        this.slots.append(card);
      }
    }
    for (let index = 0; index < PET_TAB_COUNT; index += 1) {
      const pet = active[index];
      const row = this.slotRows[index];
      row.card.classList.toggle('is-selected', index === this.selectedSlot);
      row.card.setAttribute('aria-label', `宠物槽位 ${index + 1}${pet ? `：${pet.name}` : '：空'}`);
      row.name.textContent = pet?.name ?? '未召唤';
      row.mode.textContent = pet
        ? `${this.modeLabel(pet.mode)} · ${this.actionLabel(pet.action)}${pet.weak ? ' · 肚子餓了' : ''}`
        : '从下方现金道具召唤';
      row.speed.textContent = pet
        ? `Lv${pet.level ?? 1} · 饱足感 ${pet.fullness ?? '—'}`
        : '';
    }
    this.tabs.forEach((tab, index) => {
      tab.classList.toggle('is-selected', index === this.selectedSlot);
      const pet = active[index];
      this.tabStatus[index].textContent = pet ? '●' : '';
      const selectedUrl = tab.dataset.enabledUrl;
      const idleUrl = tab.dataset.disabledUrl;
      const image = tab.querySelector('img');
      const desiredUrl = index === this.selectedSlot ? (selectedUrl ?? idleUrl) : (idleUrl ?? selectedUrl);
      if (image && desiredUrl && image.getAttribute('src') !== desiredUrl) image.src = desiredUrl;
    });
  }

  private renderSelected(pet: PetState | undefined) {
    const action = this.petUi?.window.actions[this.selectedSlot];
    if (action) this.setArt(this.actionArt, action, this.petUi?.layout.action);
    this.actionArt.hidden = true;
    this.selectedName.textContent = pet?.name ?? `槽位 ${this.selectedSlot + 1} 未召唤`;
    this.selectedState.textContent = pet ? `${this.modeLabel(pet.mode)} · ${this.actionLabel(pet.action)}` : '可从现金道具召唤';
    this.selectedSpeed.textContent = pet ? `基础速度 ${this.number(pet.baseSpeed)} · 当前速度 ${this.number(pet.moveSpeed)}` : '—';
    // Growth summary line: hunger callout plus the source lifespan countdown.
    this.selectedUnknown.textContent = pet
      ? `${pet.weak ? '肚子餓了 · ' : ''}壽命剩餘 ${this.lifeDays(pet)} 天`
      : '等级 — · 饱足感 — · 亲密度 —';
    const stand = pet && this.petAsset(pet.itemId)?.stand[0];
    if (stand) {
      this.setArt(this.selectedPetArt, stand, { x: 55 + stand.x, y: 120 + stand.y });
      this.selectedPetArt.hidden = false;
    } else {
      this.selectedPetArt.removeAttribute('src');
      this.selectedPetArt.hidden = true;
    }
    this.selectedPetName.textContent = pet?.name ?? '—';
    this.selectedPetType.textContent = pet ? '宠物' : '—';
    this.selectedPetHunger.textContent = pet && pet.fullness !== undefined
      ? `饱足感 ${pet.fullness}`
      : '—';
    this.selectedPetLevel.textContent = pet && pet.level !== undefined
      ? `等级 ${pet.level}`
      : '—';
    this.selectedPetIntimacy.textContent = pet && pet.closeness !== undefined
      ? `亲密度 ${pet.closeness}${pet.closenessToNext ? `（差 ${pet.closenessToNext}）` : '（已满）'}`
      : '—';
    const icon = pet && this.petAsset(pet.itemId)?.icon;
    if (icon) {
      this.setArt(this.selectedIcon, icon, { x: 0, y: 0 });
      this.selectedIcon.hidden = false;
    } else {
      this.selectedIcon.removeAttribute('src');
      this.selectedIcon.hidden = true;
    }
  }

  private renderOwned(items: InventoryItem[]) {
    const active = this.player?.pets ?? [];
    const identity = items.map(item => {
      const pet = active.find(candidate => candidate.inventorySlot === item.slot && candidate.itemId === item.itemId);
      return `${item.slot}:${item.itemId}:${item.quantity}:${pet?.id ?? ''}`;
    }).join('|');
    if (identity === this.ownedIdentity) return;
    this.ownedIdentity = identity;
    this.owned.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'pet-owned-empty';
      empty.textContent = '现金栏没有可用宠物。';
      this.owned.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'pet-owned-row';
      const icon = document.createElement('img');
      const asset = this.petAsset(item.itemId)?.icon;
      if (asset) this.setArt(icon, asset);
      else { icon.width = 26; icon.height = 26; icon.alt = ''; }
      icon.className = 'pet-owned-icon';
      icon.alt = '';
      const details = document.createElement('div');
      details.className = 'pet-owned-details';
      const name = document.createElement('strong');
      name.textContent = itemName(item.itemId);
      const sub = document.createElement('span');
      sub.textContent = `现金槽 ${item.slot}${item.quantity > 1 ? ` · ×${item.quantity}` : ''}`;
      details.append(name, sub);
      const activePet = active.find(pet => pet.inventorySlot === item.slot && pet.itemId === item.itemId);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pet-owned-action';
      button.textContent = activePet ? '收回' : '召唤';
      button.setAttribute('aria-label', `${activePet ? '收回' : '召唤'}${itemName(item.itemId)}`);
      button.addEventListener('click', () => this.usePetItem(item, Boolean(activePet)));
      row.append(icon, details, button);
      this.owned.append(row);
    }
  }

  private selectSlot(index: number) {
    if (index < 0 || index >= PET_TAB_COUNT) return;
    this.selectedSlot = index;
    const active = this.player?.pets ?? [];
    this.renderSlots(active);
    this.renderSelected(active[index]);
    this.tabs[index]?.focus({ preventScroll: true });
  }

  private usePetItem(item: InventoryItem, recall: boolean) {
    const requestId = this.requestId(recall ? 'pet-recall' : 'pet-summon');
    if (!this.send({ type: 'useItem', requestId, inventoryType: CASH_TAB_TYPE, sourceSlot: item.slot, itemId: item.itemId })) {
      this.status('宠物操作需要保持在线。');
      return;
    }
    this.status(`${recall ? '正在收回' : '正在召唤'} ${itemName(item.itemId)}…`);
  }

  private ownedPetItems(items: InventoryItem[]) {
    return items
      .filter(item => itemCategoryTab(item.itemId) === 4 && Boolean(this.petAsset(item.itemId)))
      .sort((left, right) => left.slot - right.slot);
  }

  private petAsset(itemId: string) {
    return this.manifestPets?.[itemId];
  }

  private get manifestPets() { return this.petCatalog; }

  private appendArt(parent: HTMLElement, frame: AssetFrame | undefined, className: string, position?: { x: number; y: number }) {
    if (!frame) return undefined;
    const image = document.createElement('img');
    image.className = className;
    this.setArt(image, frame, position);
    parent.append(image);
    return image;
  }

  private sourceField(className: string) {
    const field = document.createElement('span');
    field.className = `pet-source-field ${className}`;
    field.textContent = '—';
    this.sourcePanel.append(field);
    return field;
  }

  private setArt(element: HTMLElement & { src?: string; width?: number; height?: number }, frame: AssetFrame, position?: { x: number; y: number }) {
    if (element.getAttribute('src') !== frame.url) element.setAttribute('src', frame.url);
    element.setAttribute('width', String(frame.width));
    element.setAttribute('height', String(frame.height));
    Object.assign((element as HTMLElement).style, {
      left: `${position?.x ?? frame.x}px`,
      top: `${position?.y ?? frame.y}px`,
      width: `${frame.width}px`,
      height: `${frame.height}px`,
    });
  }

  private number(value: number) { return Number.isFinite(value) ? String(Math.round(value)) : '—'; }

  /** Remaining source lifespan in whole days, minimum 0. */
  private lifeDays(pet: PetState) {
    if (pet.lifeRemainingMs === undefined) return '—';
    return String(Math.max(0, Math.ceil(pet.lifeRemainingMs / 86_400_000)));
  }

  private modeLabel(mode: PetState['mode']) {
    return mode === 'loot' ? '寻物' : mode === 'follow' ? '跟随' : '待机';
  }

  private actionLabel(action: PetState['action']) {
    return action === 'move' ? '移动' : action === 'jump' ? '跳跃' : '站立';
  }

  private requestId(prefix: string) {
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${++this.requestSequence}`;
    return `${prefix}-${random}`.slice(0, 64);
  }
}
