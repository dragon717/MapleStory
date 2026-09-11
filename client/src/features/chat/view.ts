import type { AssetFrame, ChatUi, ChatUiFrameStates, ChatUiNineSlice, Manifest } from '../../assets/manifest';
import { installWindowDrag } from '../ui/window-shell.ts';
import { appendChatLogLine } from './scroll';
import './style.css';

type ChatButtonState = 'normal' | 'pressed' | 'disabled' | 'mouseOver' | 'checked';

/**
 * The chat surface pads its panel by 27 px before the log starts
 * (`chat273-surface`); that authored strip is the drag handle — the log itself
 * stays scrollable because it sits below the handle.
 */
const CHAT_TITLE_HEIGHT = 27;

export interface ChatMessageEnvelope {
  requestId?: string;
  authorId: string;
  authorName: string;
  text: string;
}
/** One delivered whisper.  The direction is derived locally from `selfId`,
 *  never from a client-supplied flag, so a forged envelope cannot present an
 *  incoming message as one the player sent. */
export interface WhisperEnvelope {
  requestId?: string;
  replay?: boolean;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  text: string;
}
export interface ChatViewHooks {
  /** Send one map-chat intent; resolves false when the socket is not open. */
  send?: (requestId: string, text: string) => boolean;
  /** Send one whisper intent.  Only the *other* character's display name and
   *  the body travel up; identity, presence and blacklist are server-side. */
  sendWhisper?: (requestId: string, targetName: string, text: string) => boolean;
  /** Modal UI check (skills/inventory/menu/quest/dialogue open). */
  isBlocked?: () => boolean;
  /** Return focus to the game viewport after leaving the input box. */
  focusGame?: () => void;
  /** Current character id (to colour your own lines like the source UI). */
  selfId?: () => string | undefined;
}
interface PendingEntry {
  line: HTMLDivElement;
  text: string;
}

/**
 * Where typed text goes.  `map` is the public map channel; the two whisper
 * steps exist because the 273 input bar has room for one line only, so the
 * target is collected first and the body second instead of inventing a second
 * window the source does not have.
 */
type ChatInputMode = 'map' | 'whisper-target' | 'whisper-body';

/**
 * The 273 StatusBar3 chat surface is source-backed; the input stays native
 * (IME-safe) and talks to the authoritative map-chat protocol (chat.send →
 * chatMessage echo / rejected).  Local pending lines merge by request id so a
 * successful message is never shown twice and a rejection can restore the
 * draft for editing.
 */
export class ChatView {
  private readonly root: HTMLDivElement;
  private panel?: HTMLDivElement;
  private input?: HTMLInputElement;
  private toggle?: HTMLButtonElement;
  private toggleImage?: HTMLImageElement;
  private statusLine?: HTMLSpanElement;
  private systemLog?: HTMLDivElement;
  private readonly systemEventIds = new Set<string>();
  private chat273?: ChatUi;
  private toggleOpenFrames?: ChatUiFrameStates;
  private toggleClosedFrames?: ChatUiFrameStates;
  private available = false;
  private openState = true;
  private composing = false;
  private sendSequence = 0;
  /** Input routing: map channel, or one of the two whisper steps. */
  private mode: ChatInputMode = 'map';
  /** Name typed for the pending whisper; empty unless a body is being written. */
  private whisperTarget = '';
  private readonly pending = new Map<string, PendingEntry>();
  /** Request ids of whisper echoes already rendered.  The server re-sends a
   *  sender echo when a retry replays its request id, so without this a single
   *  whisper could appear twice.  Bounded like `pending`. */
  private readonly whisperEchoes = new Set<string>();
  private readonly whisperEchoOrder: string[] = [];
  /** Drag handle on the `#chat` host, installed per session (spec R2). */
  private dragDispose?: () => void;

  constructor(
    private host: HTMLElement,
    manifest: Manifest,
    private status: (message: string, error?: boolean) => void,
    private hooks: ChatViewHooks = {},
  ) {
    this.root = document.createElement('div');
    this.root.className = 'maple-chat';
    this.root.hidden = true;
    this.root.dataset.available = 'false';
    host.replaceChildren(this.root);

    const chatUi = manifest.chatUi;
    if (chatUi?.panel?.background && chatUi.panel.collapseButton?.normal && chatUi.panel.expandButton?.normal && chatUi.input?.background && chatUi.input.target?.normal) this.init273(chatUi);
    else throw new Error('273 聊天面板资源不完整');
    window.addEventListener('keydown', this.onGlobalKeyDown);
    this.root.addEventListener('pointerdown', this.onRootPointerDown);
    // The chat panel drags by its 27 px top strip.  `#chat` is the absolutely
    // positioned host, so it is the element that moves; `bottom` is released
    // on the first drag so the window is not pinned to the HUD.
    const shell = host.parentElement;
    if (shell) {
      this.dragDispose = installWindowDrag(shell, host, {
        titleHeight: CHAT_TITLE_HEIGHT,
        isOpen: () => !this.root.hidden,
        onActivate: () => { host.style.bottom = 'auto'; },
      });
    }
  }

  setAvailable(available: boolean) {
    this.available = available;
    this.root.dataset.available = String(available);
    this.updateInputState();
    if (this.statusLine) this.statusLine.textContent = available ? '地图聊天：Enter 发言' : '连接断开，聊天暂不可用';
    if (!available) this.updateMode();
  }

  clear() {
    this.setAvailable(false);
    if (this.input) this.input.value = '';
    for (const entry of this.pending.values()) entry.line.remove();
    this.pending.clear();
    this.whisperEchoes.clear();
    this.whisperEchoOrder.length = 0;
    // Leaving the world drops the half-typed whisper too; a stale target must
    // not be pre-filled into the next session's map chat.
    this.mode = 'map';
    this.whisperTarget = '';
    this.updateMode();
  }

  appendSystem(message: string, eventId?: string) {
    if (eventId && this.systemEventIds.has(eventId)) return false;
    if (eventId) this.systemEventIds.add(eventId);
    if (!this.systemLog) return true;
    const line = document.createElement('div');
    line.className = this.chat273 ? 'chat273-system-line' : 'chat-system-line';
    line.textContent = `系统：${message}`;
    appendChatLogLine(this.systemLog, line);
    return true;
  }

  /** Merge one server chatMessage: an own echo upgrades its pending line by
   *  request id; everything else becomes a fresh player line. */
  appendChatMessage(message: ChatMessageEnvelope) {
    if (!this.systemLog) return;
    const own = this.hooks.selfId?.() === message.authorId;
    if (message.requestId) {
      const entry = this.pending.get(message.requestId);
      if (entry) {
        this.pending.delete(message.requestId);
        this.renderPlayerLine(entry.line, message.authorName, message.text, own);
        return;
      }
    }
    const line = document.createElement('div');
    line.className = this.chat273 ? 'chat273-player-line' : 'chat-player-line';
    this.renderPlayerLine(line, message.authorName, message.text, own);
    appendChatLogLine(this.systemLog, line);
  }

  /** Merge one server whisperMessage: an own echo (or a replayed echo) upgrades
   *  its pending line by request id; everything else is an incoming whisper. */
  appendWhisperMessage(message: WhisperEnvelope) {
    if (!this.systemLog) return;
    const own = this.hooks.selfId?.() === message.fromId;
    if (message.requestId) {
      // A replayed echo re-delivers the same request id; rendering it twice
      // would show one whisper as two.
      if (this.whisperEchoes.has(message.requestId)) return;
      const entry = this.pending.get(message.requestId);
      if (entry) {
        this.pending.delete(message.requestId);
        this.rememberWhisperEcho(message.requestId);
        this.renderWhisperLine(entry.line, message, own);
        return;
      }
      this.rememberWhisperEcho(message.requestId);
    }
    const line = document.createElement('div');
    line.className = this.chat273 ? 'chat273-player-line chat273-whisper-line' : 'chat-player-line';
    this.renderWhisperLine(line, message, own);
    appendChatLogLine(this.systemLog, line);
  }

  private rememberWhisperEcho(requestId: string) {
    this.whisperEchoes.add(requestId);
    this.whisperEchoOrder.push(requestId);
    while (this.whisperEchoOrder.length > 32) {
      const oldest = this.whisperEchoOrder.shift();
      if (oldest !== undefined) this.whisperEchoes.delete(oldest);
    }
  }

  /** Start a whisper from UI (the 273 input bar's whisper button) or from a
   *  `/w <name> …` command: collect the target, then the body. */
  beginWhisper(target = '') {
    const name = target.trim();
    this.setOpen(true);
    if (name) {
      this.whisperTarget = name;
      this.mode = 'whisper-body';
    } else {
      this.whisperTarget = '';
      this.mode = 'whisper-target';
    }
    if (this.input) this.input.value = '';
    this.updateMode();
    this.input?.focus({ preventScroll: true });
  }

  /** Leave whisper input and return to the map channel. */
  cancelWhisper() {
    this.mode = 'map';
    this.whisperTarget = '';
    if (this.input) this.input.value = '';
    this.updateMode();
  }

  /** A rejected chat send: restore the draft and surface the server reason. */
  failPending(requestId: string | undefined, reason: string) {
    if (!requestId) return;
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.line.remove();
    if (this.input) {
      this.input.value = entry.text;
      this.input.focus({ preventScroll: true });
    }
    this.status(reason, true);
  }

  destroy() {
    window.removeEventListener('keydown', this.onGlobalKeyDown);
    this.root.removeEventListener('pointerdown', this.onRootPointerDown);
    this.dragDispose?.();
    this.dragDispose = undefined;
    this.root.remove();
    this.host.replaceChildren();
    this.host.hidden = true;
  }

  /** Clicking the chat surface outside a control (the source panel art is
   *  larger than the real input) must still route typing into the input box;
   *  otherwise focus falls back to the page and keys hit the game shortcuts.
   *  The scrollable log keeps native events so drag-scrolling still works. */
  private onRootPointerDown = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (!(target instanceof Element)) return;
    if (target.closest?.('input, textarea, select, button, [contenteditable], .chat273-log, .chat-log')) return;
    // The top strip is the window's drag handle, not a "focus the input" area:
    // clicking it must start a move without stealing the keyboard focus.
    if (event.clientY - this.host.getBoundingClientRect().top < CHAT_TITLE_HEIGHT) return;
    if (!this.available) return;
    event.preventDefault();
    this.setOpen(true);
    this.input?.focus({ preventScroll: true });
  };

  private onGlobalKeyDown = (event: KeyboardEvent) => {
    if (!this.available || event.isComposing || event.metaKey || event.altKey) return;
    if (event.code === 'Enter' && !event.repeat) {
      const active = document.activeElement;
      const typing = active instanceof HTMLElement && (active.matches('input, textarea, select, [contenteditable]') || Boolean(active.closest('input, textarea, select, [contenteditable]')));
      if (typing || !this.available || this.hooks.isBlocked?.()) return;
      event.preventDefault();
      // Expand a collapsed panel first; updateInputState re-enables the input
      // so focus() below can land. Without this, Enter on a collapsed chat is
      // ignored and the following keystrokes reach the game shortcuts.
      this.setOpen(true);
      this.input?.focus({ preventScroll: true });
      return;
    }
    if (event.code === 'Escape' && document.activeElement === this.input) {
      event.preventDefault();
      // Esc leaves whisper input first; only the second Esc closes the box.
      if (this.mode !== 'map') {
        this.cancelWhisper();
        return;
      }
      this.input?.blur();
      this.hooks.focusGame?.();
    }
  };

  private renderPlayerLine(line: HTMLDivElement, authorName: string, text: string, own: boolean) {
    line.classList.toggle('self', own);
    line.replaceChildren();
    const name = document.createElement('span');
    name.className = own ? 'chat273-name chat273-name-self' : 'chat273-name chat273-name-other';
    name.textContent = authorName;
    const body = document.createElement('span');
    body.className = 'chat273-body';
    body.textContent = `：${text}`;
    line.append(name, body);
  }

  private renderWhisperLine(line: HTMLDivElement, message: WhisperEnvelope, own: boolean) {
    line.classList.toggle('self', own);
    line.removeAttribute('data-pending');
    line.replaceChildren();
    const tag = document.createElement('span');
    tag.className = 'chat273-whisper-tag';
    // The source's own word for it: the whisper button in the 273 input bar
    // carries `ToolTip = 悄悄話` (UI/StatusBar3.img/chat/ingame/input/button:chat).
    tag.textContent = '悄悄話';
    // Outgoing: "致 名字"; incoming: "名字".  The label follows the source's
    // own distinction between a whisper you sent and one you received.
    const name = document.createElement('span');
    name.className = own ? 'chat273-name chat273-name-self' : 'chat273-name chat273-name-other';
    name.textContent = own ? `致 ${message.toName}` : message.fromName;
    const body = document.createElement('span');
    body.className = 'chat273-body';
    body.textContent = `：${message.text}`;
    line.append(tag, name, body);
  }

  private addPending(requestId: string, text: string, label?: string) {
    if (!this.systemLog) return;
    const line = document.createElement('div');
    line.className = this.chat273 ? 'chat273-player-line chat273-pending-line' : 'chat-player-line';
    line.setAttribute('data-pending', 'true');
    line.textContent = `发送中：${label ?? text}`;
    appendChatLogLine(this.systemLog, line);
    this.pending.set(requestId, { line, text });
    while (this.pending.size > 32) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const entry = this.pending.get(oldest)!;
      entry.line.remove();
      this.pending.delete(oldest);
    }
  }

  /** Route the typed line.  A whisper is collected in two steps (target, then
   *  body) because the 273 input bar only has one line, and `/w <name> <text>`
   *  is accepted in map mode as the same intent in one shot. */
  private submit() {
    if (this.composing || !this.input || !this.available) return;
    const message = this.input.value.trim();
    if (!message) {
      // An empty line leaves whisper input instead of sending a blank message.
      if (this.mode !== 'map') {
        this.cancelWhisper();
        this.status('已取消悄悄話。');
        return;
      }
      this.status('请输入聊天内容。');
      return;
    }
    const command = message.match(/^\/(w|whisper)\s+(\S+)\s+([\s\S]+)$/i);
    if (this.mode === 'map' && command) {
      const [, , target, body] = command;
      this.input.value = body.trim();
      this.sendWhisper(target, body.trim());
      return;
    }
    if (this.mode === 'whisper-target') {
      this.whisperTarget = message;
      this.mode = 'whisper-body';
      this.input.value = '';
      this.updateMode();
      this.input.focus({ preventScroll: true });
      return;
    }
    if (this.mode === 'whisper-body') {
      this.sendWhisper(this.whisperTarget, message);
      return;
    }
    this.input.value = '';
    const requestId = `chat-${Date.now()}-${++this.sendSequence}`;
    if (!this.hooks.send?.(requestId, message)) {
      this.input.value = message;
      this.input.focus({ preventScroll: true });
      this.status('连接不可用，消息未发送，请重连后再试。', true);
      return;
    }
    this.addPending(requestId, message);
  }

  /** One whisper intent.  The target stays sticky so a rejected body is
   *  restored into the same conversation and can simply be re-sent. */
  private sendWhisper(target: string, body: string) {
    if (!this.input) return;
    const requestId = `whisper-${Date.now()}-${++this.sendSequence}`;
    if (!this.hooks.sendWhisper?.(requestId, target, body)) {
      this.status('连接不可用，密语未发送，请重连后再试。', true);
      return;
    }
    this.whisperTarget = target;
    this.mode = 'whisper-body';
    this.input.value = '';
    this.updateMode();
    this.addPending(requestId, body, `致 ${target}：${body}`);
    this.input.focus({ preventScroll: true });
  }

  /** Keep placeholder, aria-label and the availability note in step with the
   *  current input routing. */
  private updateMode() {
    const input = this.input;
    if (!input) return;
    if (this.mode === 'whisper-target') {
      input.placeholder = '悄悄話对象名字';
      input.setAttribute('aria-label', '悄悄話对象名字');
      input.dataset.mode = 'whisper-target';
    } else if (this.mode === 'whisper-body') {
      input.placeholder = `悄悄話 → ${this.whisperTarget}`;
      input.setAttribute('aria-label', `悄悄話内容，对象 ${this.whisperTarget}`);
      input.dataset.mode = 'whisper-body';
    } else {
      input.placeholder = '地图聊天';
      input.setAttribute('aria-label', '聊天内容');
      input.dataset.mode = 'map';
    }
    if (this.statusLine && this.available) {
      this.statusLine.textContent = this.mode === 'map'
        ? '地图聊天：Enter 发言'
        : this.mode === 'whisper-target'
          ? '悄悄話：输入对方角色名（Esc 取消）'
          : `悄悄話 → ${this.whisperTarget}：Enter 发送（Esc 取消）`;
    }
  }

  private init273(chatUi: ChatUi) {
    const panelUi = chatUi.panel;
    const inputUi = chatUi.input;
    const targetFrame = inputUi?.target?.normal;
    const collapseFrame = panelUi?.collapseButton?.normal;
    const expandFrame = panelUi?.expandButton?.normal;
    if (!panelUi?.background || !targetFrame || !collapseFrame || !expandFrame || !inputUi?.background) return;

    this.chat273 = chatUi;
    this.root.className = 'maple-chat chat273-shell';
    const panel = document.createElement('div');
    panel.className = 'chat273-panel';
    const surface = document.createElement('div');
    surface.className = 'chat273-surface';
    const panelLayout = chatUi.layout?.panel;
    if (typeof panelLayout?.minWidth === 'number') surface.style.setProperty('--chat273-min-width', `${panelLayout.minWidth}px`);
    if (typeof panelLayout?.maxWidth === 'number') surface.style.setProperty('--chat273-max-width', `${panelLayout.maxWidth}px`);
    surface.append(
      this.createNineSlice(panelUi.background, 'chat273-background chat273-background-open'),
      this.createNineSlice(panelUi.collapsedBackground || panelUi.background, 'chat273-background chat273-background-closed'),
    );

    const systemLog = document.createElement('div');
    systemLog.className = 'chat273-log';
    systemLog.setAttribute('role', 'log');
    systemLog.setAttribute('aria-label', '聊天消息');
    systemLog.setAttribute('aria-live', 'polite');
    surface.append(systemLog);
    this.systemLog = systemLog;

    const toolbar = document.createElement('div');
    toolbar.className = 'chat273-toolbar';

    const targetButton = document.createElement('button');
    targetButton.type = 'button';
    targetButton.className = 'chat273-target';
    targetButton.setAttribute('aria-label', '聊天频道：地图');
    targetButton.title = '地图聊天';
    const targetImage = this.createImage(targetFrame, 'chat273-target-image');
    targetButton.append(targetImage);
    this.bindSourceFrames(targetButton, targetImage, inputUi.target);
    targetButton.addEventListener('click', () => {
      this.setOpen(true);
      this.input?.focus({ preventScroll: true });
      this.status('当前频道：地图聊天（同地图可见）。');
    });
    toolbar.append(targetButton);

    const form = document.createElement('form');
    form.className = 'chat273-input-shell';
    form.setAttribute('aria-label', '聊天输入');
    form.append(this.createNineSlice(inputUi.background, 'chat273-input-background'));
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat273-input';
    input.name = 'chat';
    input.autocomplete = 'off';
    input.maxLength = 200;
    input.placeholder = '地图聊天';
    input.setAttribute('aria-label', '聊天内容');
    input.addEventListener('compositionstart', () => { this.composing = true; });
    input.addEventListener('compositionend', () => { this.composing = false; });
    form.append(input);
    form.addEventListener('submit', event => {
      event.preventDefault();
      this.submit();
    });
    toolbar.append(form);
    this.input = input;

    const whisperFrame = inputUi.whisper?.normal;
    if (whisperFrame) {
      const whisperButton = document.createElement('button');
      whisperButton.type = 'button';
      whisperButton.className = 'chat273-whisper';
      // The source's tooltip for this very button is 悄悄話
      // (UI/StatusBar3.img/chat/ingame/input/button:chat, id 2).
      whisperButton.setAttribute('aria-label', '悄悄話');
      whisperButton.title = '悄悄話';
      const image = this.createImage(whisperFrame, 'chat273-whisper-image');
      whisperButton.append(image);
      this.bindSourceFrames(whisperButton, image, inputUi.whisper);
      whisperButton.addEventListener('click', () => {
        // The 273 whisper button now really opens a whisper: the target is
        // collected first, the body second, and only the name travels up.
        this.beginWhisper();
      });
      toolbar.append(whisperButton);
    }

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'chat273-toggle';
    toggle.setAttribute('aria-label', '关闭聊天框');
    toggle.title = '关闭聊天框';
    const toggleImage = this.createImage(collapseFrame, 'chat273-toggle-image');
    toggle.append(toggleImage);
    toggle.addEventListener('click', () => this.setOpen(!this.openState));
    toggle.addEventListener('pointerover', () => this.setToggleFrame('mouseOver'));
    toggle.addEventListener('pointerout', () => this.setToggleFrame('normal'));
    toggle.addEventListener('pointerdown', () => this.setToggleFrame('pressed'));
    toggle.addEventListener('pointerup', () => this.setToggleFrame('normal'));
    toolbar.append(toggle);
    this.toggle = toggle;
    this.toggleImage = toggleImage;
    this.toggleOpenFrames = panelUi.collapseButton;
    this.toggleClosedFrames = panelUi.expandButton;

    surface.append(toolbar);
    const note = document.createElement('span');
    note.className = 'chat273-availability';
    note.setAttribute('aria-live', 'polite');
    surface.append(note);
    this.statusLine = note;
    panel.append(surface);
    this.panel = panel;
    this.root.append(panel);
    // `updateMode` writes the note, so it has to run after `statusLine` exists.
    this.updateMode();
    this.setOpen(true);
    this.host.hidden = false;
    this.root.hidden = false;
  }

  private setOpen(open: boolean) {
    this.openState = open;
    this.root.dataset.state = open ? 'open' : 'closed';
    if (this.panel) {
      this.panel.classList.toggle('chat-panel-closed', !open);
      this.panel.classList.toggle('chat273-panel-closed', !open);
    }
    this.updateInputState();
    if (this.toggle) {
      this.toggle.setAttribute('aria-label', open ? '关闭聊天框' : '打开聊天框');
      this.toggle.title = open ? '关闭聊天框' : '打开聊天框';
      this.toggle.setAttribute('aria-expanded', String(open));
    }
    if (this.chat273) this.setToggleFrame('normal');
  }

  private updateInputState() {
    if (this.input) this.input.disabled = !this.openState || !this.available;
  }

  private createImage(frame: AssetFrame, className: string) {
    const image = document.createElement('img');
    image.className = className;
    image.src = frame.url;
    image.width = frame.width;
    image.height = frame.height;
    image.alt = '';
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    return image;
  }

  private createNineSlice(slices: ChatUiNineSlice, className: string) {
    const layer = document.createElement('div');
    layer.className = `chat273-slice-layer ${className}`;
    for (const name of ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'] as const) {
      const frame = slices[name];
      if (!frame) continue;
      layer.append(this.createImage(frame, `chat273-slice chat273-slice-${name}`));
    }
    return layer;
  }

  private applyFrame(image: HTMLImageElement, frame: AssetFrame | undefined) {
    if (!frame) return;
    image.src = frame.url;
    image.width = frame.width;
    image.height = frame.height;
  }

  private bindSourceFrames(button: HTMLButtonElement, image: HTMLImageElement, frames: ChatUiFrameStates | undefined) {
    const setState = (state: ChatButtonState) => this.applyFrame(image, frames?.[state] || frames?.normal);
    button.addEventListener('pointerover', () => setState('mouseOver'));
    button.addEventListener('pointerout', () => setState('normal'));
    button.addEventListener('pointerdown', () => setState('pressed'));
    button.addEventListener('pointerup', () => setState('normal'));
  }

  private setToggleFrame(state: ChatButtonState) {
    const frames = this.openState ? this.toggleOpenFrames : this.toggleClosedFrames;
    this.applyFrame(this.toggleImage!, frames?.[state] || frames?.normal);
  }

}
