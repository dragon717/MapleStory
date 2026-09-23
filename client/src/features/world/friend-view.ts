import type { ClientMessage, FriendEntry } from '../../../../shared/protocol';
import type { AssetFrame, FriendUiData, Manifest } from '../../assets/manifest';
import { characterJobName } from '../character/view';
import { mapText, protocolText, uiLocale } from '../../app/i18n';
import { resolveAssetUrl } from '../../assets/resource-url';

type SendClientMessage = (message: ClientMessage) => boolean;

/** The two authored `UserList` tabs this window drives: 好友, 黑名單. */
export const FRIEND_TAB = { friend: 0, blacklist: 1 } as const;
export type FriendTab = 0 | 1;

/** Localized labels.  The authored tab plates and buttons carry no text — the
 *  original draws these strings over the art — so they live here. */
const TEXT = {
  title: { zh: '好友&黑名單', en: 'Friends & Blacklist' },
  friends: { zh: '好友', en: 'Friends' },
  blacklist: { zh: '黑名單', en: 'Blacklist' },
  close: { zh: '關閉', en: 'Close' },
  name: { zh: '角色名稱', en: 'Character name' },
  addFriend: { zh: '新增好友', en: 'Add friend' },
  deleteFriend: { zh: '刪除好友', en: 'Delete friend' },
  block: { zh: '加入黑名單', en: 'Block' },
  addBlock: { zh: '加入黑名單', en: 'Block' },
  unblock: { zh: '解除封鎖', en: 'Unblock' },
  empty: { zh: '還沒有好友。輸入角色名稱即可新增。', en: 'No friends yet. Enter a character name to add one.' },
  emptyBlocked: { zh: '黑名單是空的。', en: 'The blacklist is empty.' },
  needName: { zh: '請先輸入角色名稱。', en: 'Enter a character name first.' },
  pickRow: { zh: '請先選擇一個角色。', en: 'Pick a character first.' },
  online: { zh: '線上', en: 'Online' },
  offline: { zh: '離線', en: 'Offline' },
  added: { zh: '已送出好友邀請。', en: 'Friend request sent.' },
  blocked: { zh: '已加入黑名單。', en: 'Blocked.' },
  done: { zh: '完成。', en: 'Done.' },
  count: { zh: '人', en: 'chars' },
} as const;

function text(key: keyof typeof TEXT): string {
  return TEXT[key][uiLocale() === 'en' ? 'en' : 'zh'];
}

/**
 * Friend & blacklist window, built from the TMS273 `UI/UIWindow.img/UserList`
 * (Friend + BlackList tabs) source art.
 *
 * This window is the mirror image of the party window, and the difference is
 * worth stating because it drives every line below:
 *
 *   * A party is a **session** fact — it dies with the world, so the party
 *     window can be optimistic about being pushed a roster.
 *   * A friend row is an **account** fact — it survives a restart — so this
 *     window must *ask* for its contents (`friendOpen`) instead of waiting,
 *     and it must render `friendState` rows the server derived from SQLite.
 *
 * Everything the window shows is therefore server-owned: the caps, the
 * symmetry of the relation (a friend row is written in both directions), and
 * the online flag, which the world recomputes from the live roster on every
 * push.  The client only ever says "open", "add this name", "remove this row",
 * "block this name" or "unblock this row" — never an id it guessed, never a
 * membership list, never an online flag.
 */
export class FriendView {
  private root?: HTMLDivElement;
  private shell?: HTMLDivElement;
  private tabRoot?: HTMLDivElement;
  private rosterRoot?: HTMLDivElement;
  private inputRoot?: HTMLDivElement;
  private nameInput?: HTMLInputElement;
  private actionsRoot?: HTMLDivElement;
  private statusLine?: HTMLDivElement;
  private buttons: HTMLButtonElement[] = [];
  /** Latest authoritative rows; undefined until the server answers `friendOpen`. */
  private friends?: FriendEntry[];
  private blocked?: FriendEntry[];
  private tab: FriendTab = FRIEND_TAB.friend;
  private selectedId?: string;
  private requestSequence = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly manifest: Manifest,
    private readonly status: (message: string, error?: boolean) => void,
    private readonly send: SendClientMessage = () => false,
    private readonly selfId: () => string | undefined = () => undefined,
  ) {
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  // ---------------------------------------------------------------- assets

  private data(): FriendUiData | undefined {
    return this.manifest.friendUi;
  }

  private frame(name: string): AssetFrame | undefined {
    return this.data()?.ui?.[name];
  }

  /** How many authored tab plates the source strip carries. */
  private tabCount(): number {
    return Math.max(2, this.data()?.tabCount ?? 2);
  }

  private rows(): FriendEntry[] {
    const list = this.tab === FRIEND_TAB.friend ? this.friends : this.blocked;
    return list ?? [];
  }

  private self(): string | undefined {
    return this.selfId();
  }

  // ---------------------------------------------------------------- lifecycle

  isOpen(): boolean {
    return Boolean(this.root);
  }

  /**
   * Open the window.  Unlike the party window this one has to ask: the rows
   * are persisted per account, so the server is the only thing that can read
   * them, and it answers with a `friendState` push.  The last known rows are
   * drawn immediately so the window never opens empty-looking and then jumps.
   */
  open() {
    if (!this.root) this.root = this.build();
    this.render();
    this.send({ type: 'friendOpen', requestId: this.nextRequest('open') });
  }

  /** Menu shortcut behaviour: open when closed, close when already open. */
  toggle(): boolean {
    if (this.isOpen()) this.close();
    else this.open();
    return true;
  }

  /**
   * Render an authoritative window view.  Both lists always arrive together —
   * a friendship and a block are the same relation seen from two tabs, so a
   * half-window would let the client show a row the account does not have.
   */
  receiveState(state: { friends?: FriendEntry[]; blocked?: FriendEntry[] }) {
    if (!state.friends || !state.blocked) return;
    this.friends = state.friends;
    this.blocked = state.blocked;
    // A selected row that disappeared (removed, or dissolved by a block)
    // cannot stay selected.
    if (this.selectedId && !this.rows().some(row => row.id === this.selectedId)) {
      this.selectedId = undefined;
    }
    if (this.root) this.render();
  }

  /** A refusal or acceptance answered by the server. */
  receiveResult(code: string, success: boolean) {
    if (!this.root) return;
    this.setStatus(success ? text('done') : protocolText(code, code), !success);
  }

  close() {
    this.root?.remove();
    this.root = undefined;
    this.shell = undefined;
    this.tabRoot = undefined;
    this.rosterRoot = undefined;
    this.inputRoot = undefined;
    this.nameInput = undefined;
    this.actionsRoot = undefined;
    this.statusLine = undefined;
    this.buttons = [];
    this.selectedId = undefined;
  }

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.close();
    this.friends = undefined;
    this.blocked = undefined;
    this.tab = FRIEND_TAB.friend;
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
    return `friend-${prefix}-${++this.requestSequence}-${Date.now().toString(36)}`;
  }

  private typedName(): string {
    return this.nameInput?.value.trim() ?? '';
  }

  /** Add one friend.  Only a typed name goes out — the server resolves it,
   *  owns the cap, and writes the pair in both directions. */
  private addFriend() {
    const name = this.typedName();
    if (!name) {
      this.setStatus(text('needName'), true);
      return;
    }
    this.send({ type: 'friendAdd', requestId: this.nextRequest('add'), playerName: name });
    if (this.nameInput) this.nameInput.value = '';
    this.setStatus(text('added'), false);
  }

  /** Drop the selected friend.  The server re-checks the friendship exists. */
  private removeFriend() {
    if (!this.selectedId) {
      this.setStatus(text('pickRow'), true);
      return;
    }
    this.send({ type: 'friendRemove', requestId: this.nextRequest('remove'), playerId: this.selectedId });
  }

  /** Block a typed name.  Blocking also dissolves a live friendship both ways
   *  and stops that character's map chat — both are server-side effects. */
  private block() {
    const name = this.typedName();
    if (!name) {
      this.setStatus(text('needName'), true);
      return;
    }
    this.send({ type: 'friendBlock', requestId: this.nextRequest('block'), playerName: name });
    if (this.nameInput) this.nameInput.value = '';
    this.setStatus(text('blocked'), false);
  }

  /** Take the selected row off the blacklist. */
  private unblock() {
    if (!this.selectedId) {
      this.setStatus(text('pickRow'), true);
      return;
    }
    this.send({ type: 'friendUnblock', requestId: this.nextRequest('unblock'), playerId: this.selectedId });
  }

  // ---------------------------------------------------------------- rendering

  private build(): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'friend-window';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', text('title'));

    const shell = document.createElement('div');
    shell.className = 'friend-shell';
    const background = this.frame('backgrnd');
    if (background) {
      const image = document.createElement('img');
      image.className = 'friend-backgrnd';
      image.src = resolveAssetUrl(background.url);
      image.width = background.width;
      image.height = background.height;
      image.draggable = false;
      image.alt = '';
      shell.append(image);
      shell.style.setProperty('--friend-width', `${background.width}px`);
      shell.style.setProperty('--friend-height', `${background.height}px`);
    }
    this.shell = shell;

    const heading = document.createElement('div');
    heading.className = 'friend-heading';
    const title = document.createElement('strong');
    title.textContent = text('title');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'friend-close';
    close.textContent = '×';
    close.title = text('close');
    close.setAttribute('aria-label', text('close'));
    close.onclick = () => this.close();
    heading.append(title, close);

    // The authored tab strip: plate art plus the label the original draws on
    // top of it.  Only the two tabs this window drives are rendered.
    this.tabRoot = document.createElement('div');
    this.tabRoot.className = 'friend-tabs';
    this.tabRoot.setAttribute('role', 'tablist');

    this.rosterRoot = document.createElement('div');
    this.rosterRoot.className = 'friend-roster';
    this.rosterRoot.setAttribute('role', 'list');

    this.inputRoot = document.createElement('div');
    this.inputRoot.className = 'friend-input';
    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.className = 'friend-name';
    this.nameInput.maxLength = 24;
    this.nameInput.placeholder = text('name');
    this.nameInput.setAttribute('aria-label', text('name'));
    this.nameInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (this.tab === FRIEND_TAB.friend) this.addFriend();
      else this.block();
    });
    this.inputRoot.append(this.nameInput);

    this.actionsRoot = document.createElement('div');
    this.actionsRoot.className = 'friend-actions';

    this.statusLine = document.createElement('div');
    this.statusLine.className = 'friend-status';
    this.statusLine.setAttribute('role', 'status');

    shell.append(heading, this.tabRoot, this.rosterRoot, this.inputRoot, this.actionsRoot, this.statusLine);
    root.append(shell);
    this.host.append(root);
    return root;
  }

  /** One authored button: the source sprite states, with a text fallback so
   *  the window stays usable if the export is ever missing. */
  private button(sprite: string, label: string, onClick: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'friend-button';
    element.title = label;
    element.setAttribute('aria-label', label);
    const normal = this.frame(`${sprite}/normal`);
    if (normal) {
      const hover = this.frame(`${sprite}/mouseOver`) ?? normal;
      const pressed = this.frame(`${sprite}/pressed`) ?? normal;
      const image = document.createElement('img');
      const show = (frame: AssetFrame) => { image.src = resolveAssetUrl(frame.url); };
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
    }
    const caption = document.createElement('span');
    caption.className = 'friend-button-caption';
    caption.textContent = label;
    element.append(caption);
    element.onclick = onClick;
    return element;
  }

  private setStatus(message: string, error = false) {
    if (!this.statusLine) return;
    this.statusLine.textContent = message;
    this.statusLine.classList.toggle('is-error', error);
  }

  private render() {
    if (!this.root) return;
    this.renderTabs();
    this.renderRoster();

    const actions = this.actionsRoot;
    if (!actions) return;
    actions.replaceChildren();
    this.buttons = [];
    const add = (sprite: string, label: string, handler: () => void) => {
      const element = this.button(sprite, label, handler);
      this.buttons.push(element);
      actions.append(element);
    };
    // The action row is rebuilt every render so it always matches the tab the
    // server's rows belong to: a friend tab cannot offer "unblock".
    if (this.tab === FRIEND_TAB.friend) {
      add('BtAddFriend', text('addFriend'), () => this.addFriend());
      add('BtDelete', text('deleteFriend'), () => this.removeFriend());
      add('BtBlock', text('block'), () => this.block());
    } else {
      add('BlackList/BtAdd', text('addBlock'), () => this.block());
      add('BlackList/BtDelete', text('unblock'), () => this.unblock());
    }
    if (this.nameInput) this.nameInput.placeholder = text('name');
  }

  private renderTabs() {
    const root = this.tabRoot;
    if (!root) return;
    root.replaceChildren();
    const tabs: { tab: FriendTab; label: string; sprite: string }[] = [
      { tab: FRIEND_TAB.friend, label: text('friends'), sprite: 'Tab' },
      { tab: FRIEND_TAB.blacklist, label: text('blacklist'), sprite: 'Tab' },
    ];
    tabs.forEach((entry, index) => {
      if (index >= this.tabCount()) return;
      const active = this.tab === entry.tab;
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'friend-tab';
      element.classList.toggle('is-active', active);
      element.setAttribute('role', 'tab');
      element.setAttribute('aria-selected', String(active));
      const plate = this.frame(`${entry.sprite}/${active ? 'enabled' : 'disabled'}/${index}`);
      if (plate) {
        const image = document.createElement('img');
        image.className = 'friend-tab-image';
        image.src = resolveAssetUrl(plate.url);
        image.width = plate.width;
        image.height = plate.height;
        image.draggable = false;
        image.alt = '';
        element.append(image);
      }
      const label = document.createElement('span');
      label.className = 'friend-tab-label';
      label.textContent = entry.label;
      element.append(label);
      element.onclick = () => {
        if (this.tab === entry.tab) return;
        this.tab = entry.tab;
        // The selection belongs to the list it was made in.
        this.selectedId = undefined;
        this.render();
      };
      root.append(element);
    });
  }

  private renderRoster() {
    const root = this.rosterRoot;
    if (!root) return;
    root.replaceChildren();
    const rows = this.rows();
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'friend-empty';
      empty.textContent = this.tab === FRIEND_TAB.friend ? text('empty') : text('emptyBlocked');
      root.append(empty);
      return;
    }
    for (const row of rows) root.append(this.row(row));
  }

  /**
   * One row: online flag, name, job, level and — only for a character that is
   * in the world right now — the map it stands on.  An offline row carries an
   * empty `mapId`, so no location is ever invented for it.
   */
  private row(entry: FriendEntry): HTMLElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'friend-row';
    element.dataset.playerId = entry.id;
    element.setAttribute('role', 'listitem');
    element.classList.toggle('is-online', entry.online);
    element.classList.toggle('is-offline', !entry.online);
    if (this.selectedId === entry.id) element.classList.add('is-selected');
    if (entry.id === this.self()) element.classList.add('is-self');

    const flag = document.createElement('span');
    flag.className = 'friend-row-flag';
    flag.textContent = entry.online ? text('online') : text('offline');

    const name = document.createElement('span');
    name.className = 'friend-row-name';
    name.textContent = entry.name;
    const job = document.createElement('span');
    job.className = 'friend-row-job';
    job.textContent = characterJobName(entry.job);
    const level = document.createElement('span');
    level.className = 'friend-row-level';
    level.textContent = String(entry.level);
    const place = document.createElement('span');
    place.className = 'friend-row-place';
    // `mapText` falls back to the authored source name; an empty mapId means
    // the character is offline, so the cell stays empty rather than guessing.
    place.textContent = entry.online && entry.mapId ? mapText(entry.mapId, entry.mapId) : '';

    element.append(flag, name, job, level, place);
    element.onclick = () => {
      this.selectedId = this.selectedId === entry.id ? undefined : entry.id;
      this.render();
    };
    return element;
  }
}
