import type { AssetFrame, Manifest, WorldMapPage, WorldMapUiData } from '../../assets/manifest';
import { installWindowDrag, clampIntoHost, bringToFront } from '../ui/window-shell';
import { mapText, uiLocale, uiText } from '../../app/i18n';

/**
 * Where the authored page art sits inside the 654x537 window plate.
 *
 * Every number here is measured off `UI/UIWindow2.img/WorldMap/Border/0`, not
 * guessed: the plate's white interior runs x9..646 / y21..529, the 21 px title
 * strip is the top bevel, and the page controls sit on y510..526 (their own
 * authored origins).  The authored `BaseImg` is 640x470, i.e. 654 - 640 = 14
 * and 537 - 470 = 67 less than the plate, and centring it in the interior
 * lands it at (7, 40) — which is also the only placement that puts its top
 * edge exactly under the authored `BtAll` row (y24..39) and its bottom edge
 * exactly on the control row (y510).
 */
export const WORLD_MAP_WIDTH = 654;
export const WORLD_MAP_HEIGHT = 537;
export const WORLD_MAP_PAGE_X = 7;
export const WORLD_MAP_PAGE_Y = 40;
/** Breathing room the fitted plate keeps against the viewport edge, so the
 *  window never sits flush against the screen it is scaling down for. */
export const WORLD_MAP_MARGIN = 24;

/** What the window is showing.  `mapId` is the only authoritative input: the
 *  page, the location plate and every click target are derived from it. */
export interface WorldMapInput {
  mapId: string;
}

/** One authored sprite control: the element plus its enabled state, so a
 *  control that becomes unavailable shows the authored `disabled` sprite
 *  instead of keeping the live one. */
interface SpriteControl {
  element: HTMLButtonElement;
  setEnabled(enabled: boolean): void;
}

/** One clickable world-map spot: the page's MapList entry resolved to the
 *  assembled map a click would jump to (undefined for the spot the character
 *  currently stands on, which only carries the location plate). */
interface SpotTarget {
  spot: { x: number; y: number };
  mapId: string;
  label: string;
}

/**
 * The world-map window, built from the TMS273 `Map.wz/WorldMap` page art and
 * the `UI/UIWindow2.img/WorldMap` window shell.
 *
 * This is a pure view.  It never decides where a character is, whether a
 * region is reachable, or which page a plate leads to — the page graph, the
 * plate positions and the location spot all come from the exported WZ nodes.
 * The only local state is display state: which authored page is open.
 *
 * Coordinate model (verified against the exported art)
 * ---------------------------------------------------
 * `BaseImg` is authored with origin (320, 235), so the page's reference point
 * is pixel (320, 235) of the page canvas:
 *   * a `MapList` spot at (x, y)  ->  canvas pixel (320 + x, 235 + y)
 *   * a `MapLink` plate with origin (ox, oy)  ->  canvas top-left (320 - ox, 235 - oy)
 *   * the `#mapImage` plate at a spot  ->  canvas top-left (320 + x - 7, 235 + y - 7)
 *
 * Known boundaries
 * ----------------
 * * Only the pages that can show an assembled map (plus their ancestors) are
 *   exported, so the root page's plates for regions this catalog cannot reach
 *   are drawn but inert — clicking one reports why instead of faking a page.
 * * The authored search / bookmark / hyper-teleport controls
 *   (`WorldMapSearch`, `combo:worldSearch`, `HyperTeleport`, `BtbookMark`, …)
 *   belong to a feature this round does not implement, so only `BtAll`,
 *   `BtBefore`, `BtNext` and `btClose` are wired.
 * * The source authors one frame for `#mapImage`, so the location plate is
 *   static art; the gentle CSS blink is a display affordance (the original
 *   blinks it), not a second source frame.
 */
export class WorldMapView {
  hotkeysEnabled = true;
  private root?: HTMLDivElement;
  private shell?: HTMLDivElement;
  private pageLayer?: HTMLDivElement;
  private base?: HTMLImageElement;
  private plate?: HTMLDivElement;
  private closeButton?: SpriteControl;
  private beforeButton?: SpriteControl;
  private nextButton?: SpriteControl;
  private allButton?: SpriteControl;
  private emptyLine?: HTMLParagraphElement;
  private links: HTMLButtonElement[] = [];
  private spots: HTMLButtonElement[] = [];
  /** The authored page currently shown. */
  private page?: string;
  /** The authoritative map id the location plate is drawn for. */
  private mapId = '';
  /** Set by the app so a spot click can ask the server for the jump; the
   *  view never decides reachability itself. */
  onJump?: (mapId: string) => void;
  /** Set by the app so the window can report "not browsable" without owning copy. */
  onStatus?: (message: string, error?: boolean) => void;
  private destroyed = false;
  private disposeDrag?: () => void;
  onClose?: () => void;
  /** The source keybind default for 世界地圖 is `M`, so the hotkey lives here
   *  with the window rather than in the app shell (same convention as the
   *  character window owning `C`).  Registered for the view's lifetime and
   *  released in `destroy()`. */
  private readonly handleHotKey = (event: KeyboardEvent) => {
    if (this.destroyed || event.defaultPrevented || event.repeat || event.isComposing) return;
    if (event.metaKey || event.altKey || event.ctrlKey) return;
    const target = event.target as (HTMLElement & { matches?: (selector: string) => boolean }) | null;
    if (target?.matches?.('input,textarea,select,[contenteditable="true"]') || target?.isContentEditable) return;
    if (!this.hotkeysEnabled || event.code !== 'KeyM') return;
    event.preventDefault();
    if (this.isOpen()) this.close();
    else this.open(this.mapId || undefined);
  };
  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.isOpen()) {
      event.preventDefault();
      this.close();
    }
  };
  private onResize = () => this.fit();

  constructor(private readonly host: HTMLElement, private readonly manifest: Manifest) {
    document.addEventListener('keydown', this.handleHotKey, true);
  }

  private activityData?: WorldMapUiData;
  setActivityData(data?: WorldMapUiData) {
    if (this.activityData === data) return;
    this.activityData = data;
    this.page = this.pageForMap(this.mapId) ?? this.data()?.root;
    if (this.isOpen()) this.render();
  }

  private data(): WorldMapUiData | undefined {
    return this.activityData ?? this.manifest.worldMap;
  }

  // -------------------------------------------------------------- lifecycle

  isOpen(): boolean {
    return Boolean(this.root && !this.root.hidden);
  }

  /**
   * Show the window on the page that holds the character's current map.
   *
   * The authored shell only makes sense this way round: `BtBefore`/`BtNext`
   * step between *sibling* pages, so a window that always opened on the root
   * would show those two permanently disabled and leave the player with no
   * "you are here" mark to look at.  Opening on the region page puts the
   * location plate on screen immediately, and `BtAll` walks back out to the
   * world overview — which is exactly the authored control set.
   */
  open(mapId?: string) {
    if (mapId !== undefined) this.mapId = mapId;
    const data = this.data();
    if (!data) {
      this.onStatus?.(uiText('worldMapNoSource'), true);
      return;
    }
    if (!this.root) this.build();
    // Always re-target on open: the player expects to see where they are now,
    // not the region they happened to be browsing when they last closed it.
    this.page = this.pageForMap(this.mapId) ?? data.root;
    if (!this.root) return;
    this.root.hidden = false;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onResize);
    this.fit();
    this.render();
    this.shell?.focus();
  }

  /**
   * The page a map is drawn on, preferring the most specific one.
   *
   * A map can be listed twice — the root page groups whole continents while the
   * region page lists the maps one by one — so the deepest page that carries
   * the id wins.  Returns undefined when no exported page authors a spot for
   * it, which is the case for a map the original world map simply omits.
   */
  private pageForMap(mapId: string): string | undefined {
    const data = this.data();
    if (!data || !mapId) return undefined;
    let best: string | undefined;
    let bestDepth = -1;
    for (const entry of Object.values(data.pages)) {
      if (!entry.mapList.some(spot => spot.mapIds.includes(mapId))) continue;
      let depth = 0;
      for (let parent = entry.parent; parent; parent = data.pages[parent]?.parent ?? null) depth += 1;
      if (depth > bestDepth) {
        bestDepth = depth;
        best = entry.page;
      }
    }
    return best;
  }

  /**
   * Keep the whole plate on screen.
   *
   * The window is authored as a fixed 654x537 pixel plate whose contents are
   * absolutely positioned source sprites, so it cannot reflow the way a HUD
   * panel can.  On a viewport too small to hold it — a landscape phone, or a
   * narrow portrait one — the only way to keep every authored control on
   * screen without clipping or overflowing is to shrink the plate uniformly,
   * which is what `--worldmap-scale` drives in the stylesheet.
   */
  private fit() {
    const root = this.root;
    if (!root) return;
    const scale = Math.min(
      1,
      (window.innerWidth - WORLD_MAP_MARGIN) / WORLD_MAP_WIDTH,
      (window.innerHeight - WORLD_MAP_MARGIN) / WORLD_MAP_HEIGHT,
    );
    root.style.setProperty('--worldmap-scale', String(Math.max(scale, 0.2)));
    clampIntoHost(this.host, root);
  }

  close() {
    if (!this.root) return;
    this.root.hidden = true;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.onClose?.();
  }

  toggle(mapId?: string) {
    if (this.isOpen()) this.close();
    else this.open(mapId);
  }

  /** Follow the authoritative map id.  Called once per snapshot. */
  setMap(mapId: string) {
    if (mapId === this.mapId) return;
    this.mapId = mapId;
    if (this.activityData) this.page = this.pageForMap(mapId) ?? this.activityData.root;
    if (this.isOpen()) this.render();
  }

  destroy() {
    this.destroyed = true;
    this.disposeDrag?.();
    document.removeEventListener('keydown', this.handleHotKey, true);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    this.root?.remove();
    this.root = undefined;
    this.shell = undefined;
    this.pageLayer = undefined;
    this.base = undefined;
    this.plate = undefined;
    this.links = [];
    this.spots = [];
  }

  // --------------------------------------------------------------- rendering

  private build() {
    const root = document.createElement('div');
    root.className = 'worldmap-window';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.setAttribute('aria-label', uiLocale() === 'en' ? 'World map' : '世界地图');

    const shell = document.createElement('div');
    shell.className = 'worldmap-shell';
    shell.tabIndex = -1;

    this.pageLayer = document.createElement('div');
    this.pageLayer.className = 'worldmap-page';
    this.base = document.createElement('img');
    this.base.className = 'worldmap-base';
    this.base.alt = '';
    this.base.draggable = false;
    this.plate = document.createElement('div');
    this.plate.className = 'worldmap-plate';
    this.plate.title = uiText('worldMapYou');
    this.pageLayer.append(this.base, this.plate);

    this.emptyLine = document.createElement('p');
    this.emptyLine.className = 'worldmap-empty';
    this.emptyLine.hidden = true;

    shell.append(this.pageLayer, this.emptyLine);
    root.append(shell);
    this.host.append(root);

    this.root = root;
    this.shell = shell;
    this.disposeDrag = installWindowDrag(this.host, root, { titleHeight: () => 21 * (Number(root.style.getPropertyValue('--worldmap-scale')) || 1), isOpen: () => this.isOpen(), onActivate: () => bringToFront(this.host, root) });
    root.addEventListener('pointerdown', () => bringToFront(this.host, root));
    const ui = this.data()?.ui;
    if (ui) {
      this.shell.style.backgroundImage = `url("${ui.border.url}")`;
      this.plate.style.backgroundImage = `url("${ui.plate.url}")`;
      this.plate.style.width = `${ui.plate.width}px`;
      this.plate.style.height = `${ui.plate.height}px`;
      this.closeButton = this.control(root, 'worldmap-close', ui.close, uiText('worldMapClose'), () => this.close());
      const nav = ui.nav;
      this.beforeButton = this.control(root, 'worldmap-before', nav.before, uiText('worldMapBefore'), () => this.step(-1));
      this.nextButton = this.control(root, 'worldmap-next', nav.next, uiText('worldMapNext'), () => this.step(1));
      this.allButton = this.control(root, 'worldmap-all', nav.all, uiText('worldMapAll'), () => this.goTo(this.data()?.root));
    }
  }

  /**
   * One authored sprite button.
   *
   * Every state is placed by its own `origin` — the point that lands on the
   * window's top-left corner — so a state that changes size (the close button
   * is 13x13 at rest and 17x17 on hover) grows around its own centre without
   * any hand-tuned offset.  A disabled control keeps the authored `disabled`
   * sprite, so "上一頁" on the first page reads as unavailable rather than live.
   */
  private control(
    parent: HTMLElement,
    className: string,
    states: Record<string, AssetFrame> | undefined,
    label: string,
    onClick: () => void,
  ): SpriteControl | undefined {
    const normal = states?.normal;
    if (!normal) return undefined;
    const hover = states?.mouseOver ?? normal;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `worldmap-control ${className}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    let enabled = true;
    const apply = (frame: AssetFrame) => {
      button.style.left = `${-frame.origin.x}px`;
      button.style.top = `${-frame.origin.y}px`;
      button.style.width = `${frame.width}px`;
      button.style.height = `${frame.height}px`;
      button.style.backgroundImage = `url("${frame.url}")`;
    };
    const paint = (state: 'normal' | 'hover' | 'pressed') => {
      if (!enabled) { apply(states?.disabled ?? normal); return; }
      apply(state === 'normal' ? normal : state === 'hover' ? hover : (states?.pressed ?? hover));
    };
    paint('normal');
    button.addEventListener('pointerenter', () => paint('hover'));
    button.addEventListener('pointerleave', () => paint('normal'));
    button.addEventListener('pointerdown', () => paint('pressed'));
    button.addEventListener('pointerup', () => paint('normal'));
    button.addEventListener('pointercancel', () => paint('normal'));
    button.addEventListener('focus', () => paint('hover'));
    button.addEventListener('blur', () => paint('normal'));
    button.addEventListener('click', onClick);
    parent.append(button);
    return {
      element: button,
      setEnabled(next: boolean) {
        if (next === enabled) return;
        enabled = next;
        button.disabled = !next;
        paint('normal');
      },
    };
  }

  /** The exported pages that share this page's parent, in archive order. */
  private siblings(): string[] {
    const data = this.data();
    const page = this.page ? data?.pages[this.page] : undefined;
    if (!data || !page) return [];
    const parent = page.parent ?? null;
    return Object.values(data.pages).filter(entry => (entry.parent ?? null) === parent).map(entry => entry.page);
  }

  /** Walk the authored sibling order; the ends are clamped, not wrapped. */
  private step(delta: number) {
    const list = this.siblings();
    const index = this.page ? list.indexOf(this.page) : -1;
    if (index < 0) return;
    const next = list[index + delta];
    if (!next) return;
    this.goTo(next);
  }

  private goTo(page: string | undefined) {
    const data = this.data();
    if (!page) return;
    if (!data?.pages[page]) {
      this.onStatus?.(uiText('worldMapUnreachable'), true);
      return;
    }
    if (page === this.page) return;
    this.page = page;
    this.render();
  }

  private render() {
    const data = this.data();
    const page = this.page ? data?.pages[this.page] : undefined;
    if (!data || !page) {
      if (this.emptyLine) {
        this.emptyLine.hidden = false;
        this.emptyLine.textContent = uiText('worldMapNoSource');
      }
      this.pageLayer?.replaceChildren();
      this.links = [];
      return;
    }
    if (this.emptyLine) this.emptyLine.hidden = true;
    this.renderPage(page);
    this.renderControls(page);
  }

  private renderPage(page: WorldMapPage) {
    const layer = this.pageLayer;
    const plate = this.plate;
    if (!layer || !plate) return;
    const reference = page.baseImg.origin;
    if (this.base) {
      this.base.src = page.baseImg.url;
      this.base.width = page.baseImg.width;
      this.base.height = page.baseImg.height;
    }
    // Rebuild the click targets: a page has at most a few dozen plates, and
    // rebuilding keeps the DOM exactly as long as the authored `MapLink` list.
    for (const button of this.links) button.remove();
    this.links = [];    for (const link of page.mapLinks) {
      const image = link.image;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'worldmap-link';
      button.style.left = `${reference.x - image.origin.x}px`;
      button.style.top = `${reference.y - image.origin.y}px`;
      button.style.width = `${image.width}px`;
      button.style.height = `${image.height}px`;
      button.style.backgroundImage = `url("${image.url}")`;
      const name = mapText(link.toolTip || (link.page ?? ''), link.toolTip);
      const reachable = Boolean(link.page && this.data()?.pages[link.page!]);
      if (reachable) {
        button.title = name;
        button.setAttribute('aria-label', name);
        button.addEventListener('click', () => this.goTo(link.page ?? undefined));
      } else {
        // The authored plate is still drawn — it is part of the page art — but
        // it leads nowhere in this catalog, so it is marked inert and says so.
        button.dataset.inert = 'true';
        button.disabled = true;
        button.title = `${name} · ${uiText('worldMapMissing')}`;
        button.setAttribute('aria-label', name);
      }
      layer.append(button);
      this.links.push(button);
    }
    // Jump spots: every authored MapList entry that names an assembled map
    // the character is not standing on becomes a click target.  The view only
    // resolves *which* map a click asks for; whether the jump happens stays
    // with the server (`worldMapMove` → `worldMapMoveResult`).
    for (const button of this.spots) button.remove();
    this.spots = [];
    for (const target of this.spotTargets(page)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'worldmap-spot';
      button.style.left = `${reference.x + target.spot.x - 12}px`;
      button.style.top = `${reference.y + target.spot.y - 12}px`;
      button.title = target.label;
      button.setAttribute('aria-label', target.label);
      button.addEventListener('click', () => this.onJump?.(target.mapId));
      layer.append(button);
      this.spots.push(button);
    }
    const spot = page.mapList.find(entry => entry.mapIds.includes(this.mapId));
    if (spot) {
      plate.hidden = false;
      plate.style.left = `${reference.x + spot.spot.x - (this.data()?.ui.plate.origin.x ?? 0)}px`;
      plate.style.top = `${reference.y + spot.spot.y - (this.data()?.ui.plate.origin.y ?? 0)}px`;
      plate.title = `${uiText('worldMapYou')} · ${this.mapId}`;
    } else {
      plate.hidden = true;
    }
  }

  /**
   * The jump targets of one page, in authored MapList order.
   *
   * A spot may list several map ids (the root page groups whole towns under
   * one icon), so a click asks for the *first assembled* id of the spot —
   * the authored order is the source's own priority.  The spot the character
   * currently stands on is excluded: it already carries the location plate,
   * and re-jumping to where you stand would only confuse the arrival point.
   */
  private spotTargets(page: WorldMapPage): SpotTarget[] {
    const assembled = new Set((this.manifest.mapCatalog?.maps ?? []).map(map => map.id));
    const targets: SpotTarget[] = [];
    for (const entry of page.mapList) {
      if (entry.mapIds.includes(this.mapId)) continue;
      const mapId = entry.mapIds.find(id => assembled.has(id));
      if (!mapId) continue;
      const names = entry.mapIds
        .filter(id => assembled.has(id))
        .map(id => {
          const map = this.manifest.mapCatalog?.maps.find(entry => entry.id === id);
          return mapText(id, map?.name ?? id);
        });
      targets.push({ spot: entry.spot, mapId, label: [...new Set(names)].join(' / ') });
    }
    return targets;
  }

  private renderControls(page: WorldMapPage) {
    const data = this.data();
    const list = this.siblings();
    const index = list.indexOf(page.page);
    this.beforeButton?.setEnabled(index > 0);
    this.nextButton?.setEnabled(index >= 0 && index < list.length - 1);
    this.allButton?.setEnabled(Boolean(data) && page.page !== data?.root);
    this.closeButton?.setEnabled(true);
  }
}
