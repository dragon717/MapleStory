import type { ClientMessage } from '../../../../shared/protocol';
import type { AssetFrame, EmoticonData, EmoticonSticker, Manifest } from '../../assets/manifest';
import { protocolText, uiLocale } from '../../app/i18n';
import './emoticon.css';

type SendClientMessage = (message: ClientMessage) => boolean;

/** Window copy.  The source bakes "EMOTICON" into `backgrnd` and the sticker
 *  names into the catalogue, so these are only the control tooltips and the
 *  refusals the art cannot carry. */
const TEXT = {
  title: { zh: '表情', en: 'Emoticon' },
  close: { zh: '關閉', en: 'Close' },
  pageUp: { zh: '上一組表情', en: 'Previous groups' },
  pageDown: { zh: '下一組表情', en: 'Next groups' },
  groups: { zh: '表情分組', en: 'Emoticon groups' },
  pages: { zh: '分組頁面', en: 'Group pages' },
  page: { zh: '第', en: 'Page' },
  pick: { zh: '點選一個表情即可發送。', en: 'Pick a sticker to show it.' },
  missing: { zh: '表情貼圖素材尚未匯出。', en: 'Emoticon art has not been exported.' },
} as const;

function text(key: keyof typeof TEXT): string {
  return TEXT[key][uiLocale() === 'en' ? 'en' : 'zh'];
}

/** Shown on a group that is wider than one 3x3 sheet.  Only group 1000 of the
 *  shipped catalogue needs it (10 stickers), and the source art has no control
 *  for it, so the sheet is reachable from the arrow keys and the bar says so. */
function sheetHint(index: number, total: number): string {
  return uiLocale() === 'en' ? `Sheet ${index + 1}/${total} · ↑↓ to switch` : `第 ${index + 1}/${total} 頁 · ↑↓ 切換`;
}

/** Fallback for a manifest built before `dotCapacity` was exported. */
const DEFAULT_PAGE_DOTS = 11;

/** WZ colours are authored as AARRGGBB; CSS wants `#rrggbb`. */
function argbToCss(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, '');
  return hex.length === 8 ? `#${hex.slice(2)}` : '#ffffff';
}

/**
 * The 表情 (chat emoticon) window, built from the TMS273
 * `UI/ChatEmoticon.img` source art.
 *
 * The window is a *picker*: it owns no game state at all.  Picking a sticker
 * sends one `emoticonSend` intent carrying nothing but the catalogue id — the
 * server checks the id against the same exported table, applies the source's
 * own send budget (`ChatLimit`) and decides who in the map room sees it.  So
 * this view can be wrong about nothing except which slot a sticker sits in.
 *
 * Every coordinate comes from the export rather than from a guess:
 *
 *   * the grid is a `columns` x `rows` walk of `slotOffset` stepping by
 *     `slotSpace`, with `slotBase` as the authored cell plate;
 *   * a sticker's icon is centred on the cell's authored `emoticon` point and
 *     its name is drawn into the cell's own bottom strip using the authored
 *     `name` offset/width/font/colour;
 *   * a group chip sits at `groupOffset` stepping by `groupSpace`, is drawn with
 *     `groupBase` and wears `groupSelect` 8px up and left when it is selected;
 *   * the nav and close buttons take their position straight from the authored
 *     canvas origin, so they land where the source put them;
 *   * the dots start at `pageOffset` and are spaced `pageIconSpace` apart.
 *
 * The *navigation model* comes from the same art, and is worth stating because
 * it is not the obvious one:
 *
 *   * `pageUp` (x=80) and `pageDown` (x=321) are drawn at y=50, which is the
 *     chip row — the chips run 113..309, so the buttons flank the strip.  The
 *     3x3 grid (y=115..417) has no button of its own.  So the buttons page the
 *     **group strip**, not the grid;
 *   * `pageIcon` is drawn 5px under the chips, so the dots belong to the strip
 *     row too, and `EmoticonData.pageCount` counts *strip* pages — 51 groups at
 *     five chips each is exactly the 11 pages the shipped catalogue needs;
 *   * the grid is therefore scoped to the **selected group**.  50 of the 51
 *     groups hold nine stickers or fewer — one group is one 3x3 sheet — and the
 *     authored `layer:emptySlot` panel ("在本頁籤沒有可以使用的表情符號。") is a
 *     whole-grid empty state, which is what an empty group looks like;
 *   * the one group that overflows, group 1000 with 10 stickers, gets a second
 *     sheet, reachable with ↑/↓ because the art offers no control for it.
 */
export class EmoticonView {
  private root?: HTMLDivElement;
  private gridRoot?: HTMLDivElement;
  private groupRoot?: HTMLDivElement;
  private dotRoot?: HTMLDivElement;
  private caption?: HTMLDivElement;
  private buttons: HTMLButtonElement[] = [];
  /** Selected group; the grid shows this group's stickers. */
  private group = 0;
  /** Sheet inside the selected group — only an overflowing group has two. */
  private sheet = 0;
  private requestSequence = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly manifest: Manifest,
    private readonly status: (message: string, error?: boolean) => void = () => {},
    private readonly send: SendClientMessage = () => false,
  ) {
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  // ---------------------------------------------------------------- assets

  private data(): EmoticonData | undefined {
    return this.manifest.emoticon;
  }

  private frame(name: string): AssetFrame | undefined {
    return this.data()?.ui?.[name];
  }

  /** One authored button: `button:<name>/<state>`, positioned by its canvas
   *  origin exactly as the source drew it. */
  private spriteButton(name: string, label: string, onClick: () => void): HTMLButtonElement | undefined {
    const normal = this.frame(`button:${name}/normal`);
    if (!normal) return undefined;
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `emoticon-button emoticon-button-${name}`;
    element.title = label;
    element.setAttribute('aria-label', label);
    element.style.left = `${normal.x}px`;
    element.style.top = `${normal.y}px`;
    element.style.width = `${normal.width}px`;
    element.style.height = `${normal.height}px`;
    const image = document.createElement('img');
    const show = (frame: AssetFrame) => { image.src = frame.url; };
    show(normal);
    image.width = normal.width;
    image.height = normal.height;
    image.draggable = false;
    image.alt = '';
    element.append(image);
    const hover = this.frame(`button:${name}/mouseOver`) ?? normal;
    const pressed = this.frame(`button:${name}/pressed`) ?? normal;
    element.onmouseenter = () => show(hover);
    element.onmouseleave = () => show(normal);
    element.onmousedown = () => show(pressed);
    element.onmouseup = () => show(hover);
    element.onclick = onClick;
    return element;
  }

  // ---------------------------------------------------------------- lifecycle

  isOpen(): boolean {
    return Boolean(this.root);
  }

  open() {
    if (!this.data()) {
      this.status(text('missing'), true);
      return;
    }
    if (!this.root) this.root = this.build();
    this.render();
  }

  toggle(): boolean {
    if (this.isOpen()) this.close();
    else this.open();
    return true;
  }

  close() {
    this.root?.remove();
    this.root = undefined;
    this.gridRoot = undefined;
    this.groupRoot = undefined;
    this.dotRoot = undefined;
    this.caption = undefined;
    this.buttons = [];
    this.group = 0;
    this.sheet = 0;
  }

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.close();
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (!this.root) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) this.close();
      return;
    }
    // ←/→ follow the two authored buttons into the group strip; ↑/↓ reach the
    // second sheet of a group that is wider than the 3x3 grid, which is the one
    // movement the source art leaves without a control.
    const step: ['page' | 'sheet', number] | undefined = event.key === 'ArrowLeft' ? ['page', -1]
      : event.key === 'ArrowRight' ? ['page', 1]
        : event.key === 'ArrowUp' ? ['sheet', -1]
          : event.key === 'ArrowDown' ? ['sheet', 1]
            : undefined;
    if (!step) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (step[0] === 'page') this.turn(step[1]);
    else this.turnSheet(step[1]);
  };

  // ---------------------------------------------------------------- intents

  /** Show one sticker.  Only the catalogue id goes up; whether it is allowed
   *  and who receives it is entirely the server's decision. */
  private pick(sticker: EmoticonSticker) {
    const requestId = `emoticon-${++this.requestSequence}-${Date.now().toString(36)}`;
    if (!this.send({ type: 'emoticonSend', requestId, emoticonId: sticker.id })) {
      this.setCaption(text('missing'), true);
      return;
    }
    this.setCaption(sticker.name);
  }

  /** Surface a server refusal in the window's own caption bar so the reason is
   *  visible where the player is looking. */
  receiveRejection(code: string, message: string) {
    this.setCaption(protocolText(code, message), true);
  }

  // ---------------------------------------------------------------- paging

  /** Strip pages (`groupCount` chips each) — what the authored nav drives. */
  private pageCount(): number {
    return Math.max(1, this.data()?.pageCount ?? 1);
  }

  private groupCount(): number {
    return Math.max(1, this.data()?.layout.groupCount ?? 1);
  }

  /** Strip page the selected group is shown on. */
  private stripPage(): number {
    return Math.min(Math.max(0, Math.floor(this.group / this.groupCount())), this.pageCount() - 1);
  }

  /** Sheets inside the selected group (one, unless the group overflows). */
  private sheets(): number {
    return Math.max(1, this.data()?.groups[this.group]?.sheetCount ?? 1);
  }

  /** Move the group strip by whole pages and land on the first group of the new
   *  page, so paging the strip always shows stickers rather than an empty grid. */
  private turn(step: number) {
    const next = Math.min(this.pageCount() - 1, Math.max(0, this.stripPage() + step));
    if (next !== this.stripPage()) this.selectPage(next);
  }

  private selectPage(page: number) {
    const data = this.data();
    if (!data) return;
    const first = Math.min(this.pageCount() - 1, Math.max(0, page)) * this.groupCount();
    if (!data.groups[first]) return;
    this.group = first;
    this.sheet = 0;
    this.render();
  }

  private jumpToGroup(index: number) {
    if (!this.data()?.groups[index]) return;
    this.group = index;
    this.sheet = 0;
    this.render();
  }

  private turnSheet(step: number) {
    const next = Math.min(this.sheets() - 1, Math.max(0, this.sheet + step));
    if (next === this.sheet) return;
    this.sheet = next;
    this.render();
  }

  /** Sticker slots on the current sheet, `layout.slotCount` long, `undefined`
   *  for a cell the group does not fill. */
  private slots(): (EmoticonSticker | undefined)[] {
    const data = this.data();
    const group = data?.groups[this.group];
    if (!data || !group) return [];
    const { slotCount } = data.layout;
    const start = group.firstSticker + this.sheet * slotCount;
    const end = group.firstSticker + group.stickerCount;
    return Array.from({ length: slotCount }, (_, index) => (start + index < end ? data.stickers[start + index] : undefined));
  }

  /** Dots the authored strip holds before it would draw under `pageDown`. */
  private dotCapacity(): number {
    return Math.max(1, this.data()?.dotCapacity ?? DEFAULT_PAGE_DOTS);
  }

  // ---------------------------------------------------------------- rendering

  private build(): HTMLDivElement {
    const data = this.data()!;
    const root = document.createElement('div');
    root.className = 'emoticon-window';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', text('title'));

    const shell = document.createElement('div');
    shell.className = 'emoticon-shell';
    const background = this.frame('backgrnd');
    if (background) {
      const image = document.createElement('img');
      image.className = 'emoticon-backgrnd';
      image.src = background.url;
      image.width = background.width;
      image.height = background.height;
      image.draggable = false;
      image.alt = '';
      shell.append(image);
      shell.style.setProperty('--emoticon-width', `${background.width}px`);
      shell.style.setProperty('--emoticon-height', `${background.height}px`);
    }

    this.groupRoot = document.createElement('div');
    this.groupRoot.className = 'emoticon-groups';
    this.groupRoot.setAttribute('role', 'group');
    this.groupRoot.setAttribute('aria-label', text('groups'));

    this.gridRoot = document.createElement('div');
    this.gridRoot.className = 'emoticon-grid';
    this.gridRoot.setAttribute('role', 'list');

    this.dotRoot = document.createElement('div');
    this.dotRoot.className = 'emoticon-pages';
    this.dotRoot.setAttribute('role', 'group');
    this.dotRoot.setAttribute('aria-label', text('pages'));

    this.caption = document.createElement('div');
    this.caption.className = 'emoticon-caption';
    this.caption.setAttribute('role', 'status');
    // The window's own bottom information bar: the shell is 370x530, the grid
    // starts at `slotOffset` and grows by `slotSpace` per row, and the authored
    // bar sits just under the last row, inset the same 8px the grid is.
    if (background) {
      const inset = Math.max(0, data.layout.slotOffset.x - 8);
      this.caption.style.left = `${inset}px`;
      this.caption.style.top = `${data.layout.slotOffset.y + data.layout.rows * data.layout.slotSpace.y + 8}px`;
      this.caption.style.width = `${Math.max(0, background.width - inset * 2)}px`;
    }

    shell.append(this.groupRoot, this.gridRoot, this.dotRoot, this.caption);
    const close = this.spriteButton('close', text('close'), () => this.close());
    const pageUp = this.spriteButton('pageUp', text('pageUp'), () => this.turn(-1));
    const pageDown = this.spriteButton('pageDown', text('pageDown'), () => this.turn(1));
    for (const button of [close, pageUp, pageDown]) if (button) shell.append(button);
    this.buttons = [close, pageUp, pageDown].filter((button): button is HTMLButtonElement => Boolean(button));

    root.append(shell);
    this.host.append(root);
    return root;
  }

  private setCaption(message: string, error = false) {
    if (!this.caption) return;
    this.caption.textContent = message;
    this.caption.classList.toggle('is-error', error);
  }

  private render() {
    const data = this.data();
    if (!data || !this.root) return;
    this.group = Math.min(this.group, Math.max(0, data.groups.length - 1));
    this.sheet = Math.min(this.sheet, this.sheets() - 1);
    this.setCaption(this.sheets() > 1 ? sheetHint(this.sheet, this.sheets()) : text('pick'));
    this.renderGrid(data);
    this.renderGroups(data);
    this.renderDots(data);
    for (const button of this.buttons) {
      const disabled = button.classList.contains('emoticon-button-pageUp')
        ? this.stripPage() === 0
        : button.classList.contains('emoticon-button-pageDown')
          ? this.stripPage() >= this.pageCount() - 1
          : false;
      button.disabled = disabled;
      button.classList.toggle('is-disabled', disabled);
    }
  }

  private renderGrid(data: EmoticonData) {
    const root = this.gridRoot;
    if (!root) return;
    root.replaceChildren();
    const { columns, slotOffset, slotSpace, slotSize, emoticon, name } = data.layout;
    const plate = this.frame('slotBase');
    this.slots().forEach((sticker, index) => {
      const x = slotOffset.x + (index % columns) * slotSpace.x;
      const y = slotOffset.y + Math.floor(index / columns) * slotSpace.y;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'emoticon-slot';
      cell.setAttribute('role', 'listitem');
      cell.style.left = `${x}px`;
      cell.style.top = `${y}px`;
      cell.style.width = `${slotSize.width}px`;
      cell.style.height = `${slotSize.height}px`;
      if (plate) {
        const image = document.createElement('img');
        image.className = 'emoticon-slot-plate';
        image.src = plate.url;
        image.width = plate.width;
        image.height = plate.height;
        image.draggable = false;
        image.alt = '';
        cell.append(image);
      }
      if (!sticker) {
        cell.disabled = true;
        cell.classList.add('is-empty');
        cell.setAttribute('aria-hidden', 'true');
        root.append(cell);
        return;
      }
      // The authored `emoticon` vector is the point inside the cell that the
      // sticker is centred on, and `name` is the cell's own label strip.
      const icon = document.createElement('img');
      icon.className = 'emoticon-slot-icon';
      icon.src = sticker.icon.url;
      icon.width = sticker.icon.width;
      icon.height = sticker.icon.height;
      icon.draggable = false;
      icon.alt = '';
      icon.style.left = `${emoticon.x - sticker.icon.width / 2}px`;
      icon.style.top = `${emoticon.y - sticker.icon.height / 2}px`;
      const label = document.createElement('span');
      label.className = 'emoticon-slot-name';
      label.textContent = sticker.name;
      label.style.left = `${name.offset.x}px`;
      label.style.top = `${name.offset.y}px`;
      label.style.width = `${name.width}px`;
      label.style.fontSize = `${name.size}px`;
      label.style.fontWeight = name.bold ? '700' : '400';
      label.style.color = argbToCss(name.color);
      label.style.fontFamily = `"${name.font}", "Microsoft JhengHei", "PingFang TC", sans-serif`;
      cell.append(icon, label);
      cell.title = sticker.name;
      cell.setAttribute('aria-label', sticker.name);
      cell.onclick = () => this.pick(sticker);
      root.append(cell);
    });
  }

  private renderGroups(data: EmoticonData) {
    const root = this.groupRoot;
    if (!root) return;
    root.replaceChildren();
    const { groupCount, groupOffset, groupSpace } = data.layout;
    const first = this.stripPage() * groupCount;
    root.setAttribute('aria-label', `${text('groups')} ${data.groups[this.group]?.name ?? ''}`.trim());
    const base = this.frame('groupBase');
    const select = this.frame('groupSelect');
    for (let offset = 0; offset < groupCount; offset++) {
      const index = first + offset;
      const group = data.groups[index];
      if (!group) break;
      const x = groupOffset.x + offset * groupSpace.x;
      const y = groupOffset.y + offset * groupSpace.y;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'emoticon-group';
      chip.style.left = `${x}px`;
      chip.style.top = `${y}px`;
      if (base) {
        chip.style.width = `${base.width}px`;
        chip.style.height = `${base.height}px`;
      }
      if (index === this.group) chip.classList.add('is-active');
      if (base) {
        const plate = document.createElement('img');
        plate.className = 'emoticon-group-plate';
        plate.src = base.url;
        plate.width = base.width;
        plate.height = base.height;
        plate.draggable = false;
        plate.alt = '';
        chip.append(plate);
      }
      if (select && index === this.group) {
        const ring = document.createElement('img');
        ring.className = 'emoticon-group-select';
        ring.src = select.url;
        ring.width = select.width;
        ring.height = select.height;
        ring.draggable = false;
        ring.alt = '';
        // The authored selection ring hangs 8px up and left of the chip.
        ring.style.left = `${select.x}px`;
        ring.style.top = `${select.y}px`;
        chip.append(ring);
      }
      const icon = document.createElement('img');
      icon.className = 'emoticon-group-icon';
      icon.src = group.icon.url;
      icon.width = group.icon.width;
      icon.height = group.icon.height;
      icon.draggable = false;
      icon.alt = '';
      chip.append(icon);
      chip.title = group.name;
      chip.setAttribute('aria-label', group.name);
      chip.setAttribute('aria-pressed', String(index === this.group));
      chip.onclick = () => this.jumpToGroup(index);
      root.append(chip);
    }
  }

  private renderDots(data: EmoticonData) {
    const root = this.dotRoot;
    if (!root) return;
    root.replaceChildren();
    const total = this.pageCount();
    const shown = Math.min(total, this.dotCapacity());
    const on = this.frame('pageIcon/on');
    const off = this.frame('pageIcon/off') ?? on;
    if (!on || !off) return;
    const page = this.stripPage();
    // A catalogue with more strip pages than the art holds turns the dots into a
    // window centred on the current page, so the indicator keeps tracking the
    // buttons instead of overflowing the shell.
    const start = shown >= total ? 0 : Math.min(Math.max(0, page - Math.floor(shown / 2)), total - shown);
    const { pageOffset, pageIconSpace } = data.layout;
    for (let index = 0; index < shown; index++) {
      const target = start + index;
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'emoticon-dot';
      dot.style.left = `${pageOffset.x + index * pageIconSpace}px`;
      dot.style.top = `${pageOffset.y}px`;
      dot.style.width = `${on.width}px`;
      dot.style.height = `${on.height}px`;
      dot.title = `${text('page')} ${target + 1}`;
      dot.setAttribute('aria-label', dot.title);
      if (target === page) dot.setAttribute('aria-current', 'true');
      const image = document.createElement('img');
      image.className = 'emoticon-dot-icon';
      image.src = (target === page ? on : off).url;
      image.width = on.width;
      image.height = on.height;
      image.draggable = false;
      image.alt = '';
      dot.append(image);
      dot.onclick = () => this.selectPage(target);
      root.append(dot);
    }
  }
}
