import type { AssetFrame, Manifest } from '../../assets/manifest';
import { appendChatLogLine } from './scroll';

const CHAT_TARGET = 'base/chatTarget';
const CHAT_BOX = 'base/box';
const CHAT_LINE = 'base/chat';
const WHISPER_NORMAL = 'BtWhisper/normal/0';

/**
 * The v83 StatusBar chat surface is kept as a small, responsive shell.
 * Source art supplies the target, box, divider and whisper affordance; the
 * native input is intentionally local until the chat protocol is available.
 */
export class ChatView {
  private readonly root: HTMLDivElement;
  private readonly panel?: HTMLDivElement;
  private readonly input?: HTMLInputElement;
  private readonly toggle?: HTMLButtonElement;
  private readonly statusLine?: HTMLSpanElement;
  private readonly systemLog?: HTMLDivElement;
  private readonly systemEventIds = new Set<string>();
  private available = false;
  private openState = true;

  constructor(private host: HTMLElement, manifest: Manifest, private status: (message: string) => void) {
    this.root = document.createElement('div');
    this.root.className = 'maple-chat';
    this.root.hidden = true;
    this.root.dataset.available = 'false';
    host.replaceChildren(this.root);
    const hud = manifest.hud;
    const target = hud?.[CHAT_TARGET];
    const box = hud?.[CHAT_BOX];
    const line = hud?.[CHAT_LINE];
    if (!target || !box || !line) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'chat-toolbar';

    const targetButton = document.createElement('button');
    targetButton.type = 'button';
    targetButton.className = 'chat-target';
    targetButton.setAttribute('aria-label', '聊天频道');
    targetButton.title = '聊天频道';
    targetButton.append(this.createImage(target, 'chat-target-image'));
    const targetLabel = document.createElement('span');
    targetLabel.textContent = '全部';
    targetLabel.setAttribute('aria-hidden', 'true');
    targetButton.append(targetLabel);
    targetButton.addEventListener('click', () => this.status('聊天暂未开放。'));
    toolbar.append(targetButton);

    const boxButton = document.createElement('button');
    boxButton.type = 'button';
    boxButton.className = 'chat-box-toggle';
    boxButton.setAttribute('aria-label', '关闭聊天框');
    boxButton.title = '关闭聊天框';
    boxButton.append(this.createImage(box, 'chat-box-image'));
    boxButton.addEventListener('click', () => this.setOpen(!this.openState));
    toolbar.append(boxButton);
    this.toggle = boxButton;

    const whisper = hud?.[WHISPER_NORMAL];
    if (whisper) {
      const whisperButton = document.createElement('button');
      whisperButton.type = 'button';
      whisperButton.className = 'chat-whisper';
      whisperButton.setAttribute('aria-label', '私聊入口');
      whisperButton.title = '私聊入口';
      const image = this.createImage(whisper, 'chat-whisper-image');
      whisperButton.append(image);
      this.bindSourceButton(whisperButton, image, hud, 'BtWhisper');
      whisperButton.addEventListener('click', () => {
        this.setOpen(true);
        this.input?.focus({ preventScroll: true });
        this.status('私聊暂未开放。');
      });
      toolbar.append(whisperButton);
    }

    const form = document.createElement('form');
    form.className = 'chat-form';
    form.setAttribute('aria-label', '聊天输入');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-input';
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
    this.panel = document.createElement('div');
    this.panel.className = 'chat-panel';
    this.panel.append(toolbar);
    const divider = this.createImage(line, 'chat-source-line');
    this.panel.append(divider);
    const systemLog = document.createElement('div');
    systemLog.className = 'chat-log';
    systemLog.setAttribute('role', 'log');
    systemLog.setAttribute('aria-label', '系统消息');
    systemLog.setAttribute('aria-live', 'polite');
    this.panel.append(systemLog);
    this.systemLog = systemLog;
    const note = document.createElement('span');
    note.className = 'chat-availability';
    note.textContent = '聊天发送功能暂未接入';
    note.setAttribute('aria-live', 'polite');
    this.panel.append(note);
    this.statusLine = note;
    this.root.append(this.panel);
    this.setOpen(true);
    this.host.hidden = false;
    this.root.hidden = false;
  }

  setAvailable(available: boolean) {
    this.available = available;
    this.root.dataset.available = String(available);
    if (this.input) this.input.disabled = !available;
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
    line.className = 'chat-system-line';
    line.textContent = `系统：${message}`;
    appendChatLogLine(this.systemLog, line);
    return true;
  }

  destroy() {
    this.root.remove();
    this.host.replaceChildren();
    this.host.hidden = true;
  }

  private setOpen(open: boolean) {
    this.openState = open;
    this.root.dataset.state = open ? 'open' : 'closed';
    if (this.panel) this.panel.classList.toggle('chat-panel-closed', !open);
    if (this.input) this.input.disabled = !open || !this.available;
    if (this.toggle) {
      this.toggle.setAttribute('aria-label', open ? '关闭聊天框' : '打开聊天框');
      this.toggle.title = open ? '关闭聊天框' : '打开聊天框';
      this.toggle.setAttribute('aria-expanded', String(open));
    }
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

  private bindSourceButton(button: HTMLButtonElement, image: HTMLImageElement, hud: Manifest['hud'], key: string) {
    const setState = (state: 'normal' | 'pressed' | 'mouseOver') => {
      const frame = hud?.[`${key}/${state}/0`];
      if (frame) image.src = frame.url;
    };
    button.addEventListener('pointerover', () => setState('mouseOver'));
    button.addEventListener('pointerout', () => setState('normal'));
    button.addEventListener('pointerdown', () => setState('pressed'));
    button.addEventListener('pointerup', () => setState('normal'));
  }
}
