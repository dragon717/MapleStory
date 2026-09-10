import type { ClientMessage, PartyMember, PartyState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest, PartyUiData } from '../../assets/manifest';
import { characterJobName } from '../character/view';
import { protocolText, uiLocale } from '../../app/i18n';

type SendClientMessage = (message: ClientMessage) => boolean;

/** The prompt shown when another character invites this one. */
export interface PartyInvitePrompt {
  invitationId: string;
  fromId: string;
  fromName: string;
}

/** Localized labels for window chrome the source art does not carry. */
const TEXT = {
  title: { zh: '隊伍', en: 'Party' },
  create: { zh: '創建隊伍', en: 'Create party' },
  invite: { zh: '邀請', en: 'Invite' },
  kick: { zh: '踢出', en: 'Kick' },
  leave: { zh: '退出隊伍', en: 'Leave party' },
  changeLeader: { zh: '移交隊長', en: 'Change leader' },
  close: { zh: '關閉', en: 'Close' },
  name: { zh: '角色名稱', en: 'Character name' },
  empty: { zh: '隊伍裡還沒有其他成員。', en: 'Nobody else is in the party yet.' },
  solo: {
    zh: '你還沒有隊伍。輸入角色名稱即可建立。',
    en: 'You are not in a party. Enter a character name to create one.',
  },
  waiting: { zh: '等待對方回應…', en: 'Waiting for an answer…' },
  accept: { zh: '接受', en: 'Accept' },
  decline: { zh: '拒絕', en: 'Decline' },
  inviteFrom: { zh: '邀請你加入隊伍', en: 'invites you to a party' },
  pickMember: { zh: '請先選擇一名成員。', en: 'Pick a member first.' },
  needName: { zh: '請先輸入角色名稱。', en: 'Enter a character name first.' },
  done: { zh: '完成。', en: 'Done.' },
  disbanded: { zh: '隊伍已解散。', en: 'The party has ended.' },
  leader: { zh: '隊長', en: 'Leader' },
} as const;

function text(key: keyof typeof TEXT): string {
  return TEXT[key][uiLocale() === 'en' ? 'en' : 'zh'];
}

/**
 * Party window, built from the TMS273 `UI/UIWindow.img/UserList` (Party tab)
 * source art.
 *
 * The window is a thin view, exactly like the warehouse window: every action is
 * an intent (`partyInvite` / `partyRespond` / `partyLeave` / `partyKick` /
 * `partyLeader`) and the roster is only ever redrawn from an authoritative
 * `partyState` message.  Nothing here decides who leads a party, who is on the
 * same map, or whether an invitation is still valid — the server answers with
 * `partyResult` and re-pushes the whole roster.
 *
 * A single-member party is deliberately not shown: the server dissolves a party
 * the moment it drops below two members (unless an invitation it just sent is
 * still pending), so "no roster yet" is the same as "no party yet".
 */
export class PartyView {
  private root?: HTMLDivElement;
  private rosterRoot?: HTMLDivElement;
  private invitePanel?: HTMLDivElement;
  private promptRoot?: HTMLDivElement;
  private statusLine?: HTMLDivElement;
  private nameInput?: HTMLInputElement;
  private actionsRoot?: HTMLDivElement;
  private buttons: HTMLButtonElement[] = [];
  /** Latest authoritative roster; undefined until the server sends one. */
  private roster?: PartyState;
  /** Latest unanswered invitation, if any. */
  private prompt?: PartyInvitePrompt;
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

  private data(): PartyUiData | undefined {
    return this.manifest.partyUi;
  }

  private frame(name: string): AssetFrame | undefined {
    return this.data()?.ui?.[name];
  }

  /** The server's roster cap, cross-checked against the authored slot count. */
  private memberSlots(): number {
    return Math.max(2, this.data()?.memberSlots ?? 6);
  }

  private mine(): string | undefined {
    return this.selfId() ?? this.roster?.members.find(member => member.leader)?.id;
  }

  private isLeader(): boolean {
    const self = this.selfId();
    return Boolean(self && this.roster && this.roster.leaderId === self);
  }

  /**
   * The character ids currently in the roster, for views that tint party
   * members differently (the minimap).  Read-only: the roster itself is only
   * ever replaced by an authoritative `partyState` message.
   */
  memberIds(): string[] {
    return (this.roster?.members ?? []).map(member => member.id);
  }

  // ---------------------------------------------------------------- lifecycle

  isOpen(): boolean {
    return Boolean(this.root);
  }

  /** Open the window.  Called by the menu; the roster may not have arrived yet. */
  open() {
    if (!this.root) this.root = this.build();
    this.render();
  }

  /** Menu shortcut behaviour: open when closed, close when already open. */
  toggle(): boolean {
    if (this.isOpen()) this.close();
    else this.open();
    return true;
  }

  /**
   * Render an authoritative roster.  `closed` means the server no longer has a
   * party for this character — the window disappears, which is also how a
   * kicked member learns the party is over.
   */
  receiveState(state: { closed?: boolean } & Partial<PartyState>) {
    if (state.closed) {
      // The server no longer has a party for this character.  Closing the
      // window is also how a kicked member learns the party is over.
      const wasOpen = this.isOpen();
      const hadParty = Boolean(this.roster);
      this.roster = undefined;
      this.selectedId = undefined;
      if (wasOpen) this.close();
      if (hadParty) this.status(text('disbanded'));
      return;
    }
    if (!state.partyId || !state.leaderId || !state.members) return;
    this.roster = { partyId: state.partyId, leaderId: state.leaderId, members: state.members };
    // A selected member that left cannot stay selected.
    if (this.selectedId && !state.members.some(member => member.id === this.selectedId)) {
      this.selectedId = undefined;
    }
    this.open();
  }

  /** Show (or refresh) the invitation prompt and make sure the window is up. */
  receiveInvite(prompt: PartyInvitePrompt) {
    this.prompt = prompt;
    this.open();
  }

  /** A refusal or acceptance answered by the server. */
  receiveResult(code: string, success: boolean) {
    if (success) {
      this.setStatus(text('done'), false);
      return;
    }
    this.setStatus(protocolText(code, code), true);
  }

  /**
   * A party event this character did not cause — a declined invitation, or a
   * kick.  Display only: the authoritative roster still arrives separately.
   */
  receiveNotice(code: string, playerName: string) {
    const detail = protocolText(code, code);
    this.setStatus(playerName ? `${playerName} · ${detail}` : detail, true);
  }

  close() {
    this.root?.remove();
    this.root = undefined;
    this.rosterRoot = undefined;
    this.invitePanel = undefined;
    this.promptRoot = undefined;
    this.statusLine = undefined;
    this.nameInput = undefined;
    this.actionsRoot = undefined;
    this.buttons = [];
    this.selectedId = undefined;
  }

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.close();
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
    return `party-${prefix}-${++this.requestSequence}-${Date.now().toString(36)}`;
  }

  /** Answer the pending invitation.  The server owns which invitation that is. */
  private respond(accept: boolean) {
    if (!this.prompt) return;
    this.send({ type: 'partyRespond', requestId: this.nextRequest('respond'), accept });
    if (!accept) this.setStatus(protocolText('party_declined', text('done')), false);
    this.prompt = undefined;
    this.render();
  }

  /**
   * Ask the server to invite one character.  Only the name is sent: the server
   * resolves it, decides whether a party has to be created, and owns the
   * pending invitation window.
   */
  private invite() {
    const name = this.nameInput?.value.trim() ?? '';
    if (!name) {
      this.setStatus(text('needName'), true);
      return;
    }
    this.send({ type: 'partyInvite', requestId: this.nextRequest('invite'), playerName: name });
    if (this.nameInput) this.nameInput.value = '';
    this.setStatus(`${text('invite')} ${name} · ${text('waiting')}`, false);
  }

  private kick() {
    if (!this.selectedId) {
      this.setStatus(text('pickMember'), true);
      return;
    }
    this.send({ type: 'partyKick', requestId: this.nextRequest('kick'), playerId: this.selectedId });
  }

  private leave() {
    this.send({ type: 'partyLeave', requestId: this.nextRequest('leave') });
  }

  private handOver() {
    if (!this.selectedId) {
      this.setStatus(text('pickMember'), true);
      return;
    }
    this.send({ type: 'partyLeader', requestId: this.nextRequest('leader'), playerId: this.selectedId });
  }

  // ---------------------------------------------------------------- rendering

  private build(): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'party-window';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', text('title'));

    const shell = document.createElement('div');
    shell.className = 'party-shell';
    const background = this.frame('backgrnd');
    if (background) {
      const image = document.createElement('img');
      image.className = 'party-backgrnd';
      image.src = background.url;
      image.width = background.width;
      image.height = background.height;
      image.draggable = false;
      image.alt = '';
      shell.append(image);
      shell.style.setProperty('--party-width', `${background.width}px`);
      shell.style.setProperty('--party-height', `${background.height}px`);
    }

    const heading = document.createElement('div');
    heading.className = 'party-heading';
    const title = document.createElement('strong');
    title.textContent = text('title');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'party-close';
    close.textContent = '×';
    close.title = text('close');
    close.setAttribute('aria-label', text('close'));
    close.onclick = () => this.close();
    heading.append(title, close);

    // Column header: the authored 名稱 / 職業 / 等級 strip.
    const header = document.createElement('div');
    header.className = 'party-columns';
    const headerFrame = this.frame('party5');
    if (headerFrame) {
      const image = document.createElement('img');
      image.className = 'party-columns-image';
      image.src = headerFrame.url;
      image.width = headerFrame.width;
      image.height = headerFrame.height;
      image.draggable = false;
      image.alt = '';
      header.append(image);
    }

    this.rosterRoot = document.createElement('div');
    this.rosterRoot.className = 'party-roster';
    this.rosterRoot.setAttribute('role', 'list');

    // Invitation prompt: a second card in the same shell, shown only while an
    // invitation is unanswered.
    this.promptRoot = document.createElement('div');
    this.promptRoot.className = 'party-prompt';
    this.promptRoot.hidden = true;
    this.promptRoot.setAttribute('role', 'alertdialog');

    // Intents: the authored buttons that have a server intent behind them.
    this.invitePanel = document.createElement('div');
    this.invitePanel.className = 'party-invite';
    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.className = 'party-name';
    this.nameInput.maxLength = 24;
    this.nameInput.placeholder = text('name');
    this.nameInput.setAttribute('aria-label', text('name'));
    this.nameInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.invite();
      }
    });
    this.invitePanel.append(this.nameInput);

    const actions = document.createElement('div');
    actions.className = 'party-actions';

    this.statusLine = document.createElement('div');
    this.statusLine.className = 'party-status';
    this.statusLine.setAttribute('role', 'status');

    this.actionsRoot = actions;
    shell.append(heading, header, this.rosterRoot, this.invitePanel, actions, this.statusLine, this.promptRoot);
    root.append(shell);
    this.host.append(root);
    return root;
  }

  /**
   * One authored button: use the source sprite states, fall back to a text
   * button when the export is missing (the window still has to be usable).
   */
  private button(sprite: string, label: string, onClick: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'party-button';
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
      const caption = document.createElement('span');
      caption.className = 'party-button-caption';
      caption.textContent = label;
      element.append(caption);
    } else {
      element.textContent = label;
    }
    element.onclick = onClick;
    return element;
  }

  private setStatus(message: string, error: boolean) {
    if (!this.statusLine) return;
    this.statusLine.textContent = message;
    this.statusLine.classList.toggle('is-error', error);
  }

  private render() {
    if (!this.root) return;
    const solo = !this.roster;
    if (this.invitePanel) this.invitePanel.hidden = false;
    if (this.nameInput) this.nameInput.placeholder = text('name');

    this.renderRoster(solo);
    this.renderPrompt();

    // The action row is rebuilt every render so it always matches the roster
    // the server last sent: a leader sees kick / hand-over, a member sees leave.
    const actions = this.actionsRoot;
    if (!actions) return;
    actions.replaceChildren();
    this.buttons = [];
    const leader = this.isLeader();
    const add = (sprite: string, label: string, handler: () => void, disabled = false) => {
      const element = this.button(sprite, label, handler);
      element.disabled = disabled;
      this.buttons.push(element);
      actions.append(element);
    };
    if (solo) {
      add('BtCreate', text('create'), () => this.invite());
    } else {
      add('BtInvite', text('invite'), () => this.invite(), !leader);
      add('BtKick', text('kick'), () => this.kick(), !leader);
      add('BtChangeBoss', text('changeLeader'), () => this.handOver(), !leader);
      add('BtWithdraw', text('leave'), () => this.leave());
    }

    // The invite field is pointless when a member cannot invite.
    if (this.invitePanel) {
      this.invitePanel.hidden = !solo && !leader;
      // A pending invitation blocks a second one, so hide the field too.
      if (this.prompt) this.invitePanel.hidden = true;
    }
  }

  private renderRoster(solo: boolean) {
    const root = this.rosterRoot;
    if (!root) return;
    root.replaceChildren();
    if (solo) {
      const empty = document.createElement('p');
      empty.className = 'party-empty';
      empty.textContent = text('solo');
      root.append(empty);
      return;
    }
    const members = this.roster?.members ?? [];
    if (!members.length) {
      const empty = document.createElement('p');
      empty.className = 'party-empty';
      empty.textContent = text('empty');
      root.append(empty);
      return;
    }
    const separator = this.frame('party2');
    members.slice(0, this.memberSlots()).forEach((member, index) => {
      if (index > 0 && separator) {
        const line = document.createElement('img');
        line.className = 'party-separator';
        line.src = separator.url;
        line.width = separator.width;
        line.height = separator.height;
        line.draggable = false;
        line.alt = '';
        root.append(line);
      }
      root.append(this.row(member));
    });
  }

  /** One roster row: the leader marker, the name, the job and the level. */
  private row(member: PartyMember): HTMLElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'party-row';
    element.dataset.memberId = member.id;
    element.setAttribute('role', 'listitem');
    if (this.selectedId === member.id) element.classList.add('is-selected');
    if (member.id === this.mine()) element.classList.add('is-self');

    const marker = document.createElement('img');
    marker.className = 'party-row-marker';
    const markerFrame = this.frame(member.leader ? 'icon1' : 'icon0');
    if (markerFrame) {
      marker.src = markerFrame.url;
      marker.width = markerFrame.width;
      marker.height = markerFrame.height;
    }
    marker.draggable = false;
    marker.alt = member.leader ? text('leader') : '';

    const name = document.createElement('span');
    name.className = 'party-row-name';
    name.textContent = member.name;
    const job = document.createElement('span');
    job.className = 'party-row-job';
    job.textContent = characterJobName(member.job);
    const level = document.createElement('span');
    level.className = 'party-row-level';
    level.textContent = String(member.level);

    element.append(marker, name, job, level);
    element.onclick = () => {
      this.selectedId = this.selectedId === member.id ? undefined : member.id;
      this.render();
    };
    return element;
  }

  private renderPrompt() {
    const root = this.promptRoot;
    if (!root) return;
    root.replaceChildren();
    if (!this.prompt) {
      root.hidden = true;
      return;
    }
    root.hidden = false;

    const heading = document.createElement('p');
    heading.className = 'party-prompt-text';
    const from = document.createElement('strong');
    from.textContent = this.prompt.fromName;
    heading.append(from, document.createTextNode(` ${text('inviteFrom')}`));

    const actions = document.createElement('div');
    actions.className = 'party-prompt-actions';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'party-prompt-accept';
    accept.textContent = text('accept');
    accept.onclick = () => this.respond(true);
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'party-prompt-decline';
    decline.textContent = text('decline');
    decline.onclick = () => this.respond(false);
    actions.append(accept, decline);

    root.append(heading, actions);
  }
}
