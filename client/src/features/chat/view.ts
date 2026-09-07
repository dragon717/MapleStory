import type { AssetFrame, ChatUi, ChatUiFrameStates, ChatUiNineSlice, Manifest } from '../../assets/manifest';
import { appendChatLogLine } from './scroll';
import './style.css';

type ChatButtonState = 'normal' | 'pressed' | 'disabled' | 'mouseOver' | 'checked';

/**
 * The 273 StatusBar3 chat surface is source-backed, while the input remains
 * native until the chat protocol is available.
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

  constructor(private host: HTMLElement, manifest: Manifest, private status: (message: string) => void) {
    this.root = document.createElement('div');
    this.root.className = 'maple-chat';
    this.root.hidden = true;
    this.root.dataset.available = 'false';
    host.replaceChildren(this.root);

    const chatUi = manifest.chatUi;
    if (chatUi?.panel?.background && chatUi.panel.collapseButton?.normal && chatUi.panel.expandButton?.normal && chatUi.input?.background && chatUi.input.target?.normal) this.init273(chatUi);
    else throw new Error('273 聊天面板资源不完整');
  }

  setAvailable(available: boolean) {
    this.available = available;
    this.root.dataset.available = String(available);
    this.updateInputState();
    if (this.statusLine) this.statusLine.textContent = available ? '聊天暂未开放' : '聊天暂不可用';
  }

  clear() {
    this.setAvailable(false);
    if (this.input) this.input.value = '';
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

  destroy() {
    this.root.remove();
    this.host.replaceChildren();
    this.host.hidden = true;
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
    systemLog.setAttribute('aria-label', '系统消息');
    systemLog.setAttribute('aria-live', 'polite');
    surface.append(systemLog);
    this.systemLog = systemLog;

    const toolbar = document.createElement('div');
    toolbar.className = 'chat273-toolbar';

    const targetButton = document.createElement('button');
    targetButton.type = 'button';
    targetButton.className = 'chat273-target';
    targetButton.setAttribute('aria-label', '聊天频道：全部');
    targetButton.title = '聊天频道：全部';
    const targetImage = this.createImage(targetFrame, 'chat273-target-image');
    targetButton.append(targetImage);
    this.bindSourceFrames(targetButton, targetImage, inputUi.target);
    targetButton.addEventListener('click', () => this.status('聊天频道暂未开放。'));
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
    input.placeholder = '聊天（暂未开放）';
    input.setAttribute('aria-label', '聊天内容');
    form.append(input);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const message = input.value.trim();
      this.status(message ? '聊天暂未开放，消息未发送。' : '请输入聊天内容。');
    });
    toolbar.append(form);
    this.input = input;

    const whisperFrame = inputUi.whisper?.normal;
    if (whisperFrame) {
      const whisperButton = document.createElement('button');
      whisperButton.type = 'button';
      whisperButton.className = 'chat273-whisper';
      whisperButton.setAttribute('aria-label', '私聊入口');
      whisperButton.title = '私聊入口';
      const image = this.createImage(whisperFrame, 'chat273-whisper-image');
      whisperButton.append(image);
      this.bindSourceFrames(whisperButton, image, inputUi.whisper);
      whisperButton.addEventListener('click', () => {
        this.setOpen(true);
        this.input?.focus({ preventScroll: true });
        this.status('私聊暂未开放。');
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
    note.textContent = '聊天发送功能暂未接入';
    note.setAttribute('aria-live', 'polite');
    surface.append(note);
    this.statusLine = note;
    panel.append(surface);
    this.panel = panel;
    this.root.append(panel);
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
