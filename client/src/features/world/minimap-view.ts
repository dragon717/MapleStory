import type { NpcState, PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest, MapPortal, MiniMapMapAsset, MiniMapUiData } from '../../assets/manifest';
import { mapText, uiLocale, uiText } from '../../app/i18n';

/** The three states the original window has: the collapsed strip, the compact
 *  window and the full window (which also carries the street and map name). */
export type MiniMapMode = 'strip' | 'compact' | 'full';
/** The eight `iconDirection` sprites. */
export type MiniMapArrow = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';
/** Which screen corner the window is docked to.  Both dock points are authored
 *  in the source (`vector:left` / `vecotr:right`). */
export type MiniMapDock = 'left' | 'right';

export interface MiniMapInput {
  mapId: string;
  /** Authoritative self state: the arrow, and the "is this me" test. */
  self?: PlayerState;
  /** Every character on this map, self included. */
  players?: PlayerState[];
  npcs?: NpcState[];
  portals?: MapPortal[];
  /** Character ids that share this character's party, for the party tint. */
  partyIds?: string[];
}

/**
 * World point -> canvas pixel.
 *
 * The authored `miniMap` node describes a world rectangle
 * `[xMin, xMin + width] x [yMin, yMin + height]`, and canvas pixel (0,0) is that
 * rectangle's top-left corner, so the mapping is a plain affine scale.  Measured
 * against 16 142 samples taken along authored footholds across every assembled
 * map, this puts 90.5% of them on a drawn pixel and 93.0% on one within a pixel
 * — the residual is what a 1/16 downscale plus an anti-aliased terrain edge cost.
 */
export function miniMapPixel(map: MiniMapMapAsset, x: number, y: number): { x: number; y: number } {
  const { world } = map;
  if (!(world.width > 0) || !(world.height > 0)) return { x: 0, y: 0 };
  return {
    x: (x - world.xMin) * (map.width / world.width),
    y: (y - world.yMin) * (map.height / world.height),
  };
}

/** True when a world point falls inside the authored rectangle. */
export function miniMapContains(map: MiniMapMapAsset, x: number, y: number): boolean {
  const { world } = map;
  return x >= world.xMin && x <= world.xMin + world.width && y >= world.yMin && y <= world.yMin + world.height;
}

/**
 * Pick the arrow sprite for a character.
 *
 * The source ships eight facings.  The original points the arrow the way the
 * body travels, so the vertical states win over walking: a climbing or airborne
 * body gets a diagonal or cardinal vertical, and a grounded one keeps its
 * facing — including while standing, because the original never parks the arrow
 * sideways without a facing behind it.
 */
export function miniMapArrow(state: Pick<PlayerState, 'facing' | 'grounded' | 'vy' | 'action'>): MiniMapArrow {
  const horizontal = state.facing < 0 ? 'w' : 'e';
  if (state.action === 'climb' || state.action === 'ladder' || state.action === 'rope') {
    // `vy` is the only up/down signal a climbing body carries.
    return state.vy < 0 ? 'n' : 's';
  }
  if (!state.grounded && state.action !== 'dead') {
    return ((state.vy < 0 ? 'n' : 's') + horizontal) as MiniMapArrow;
  }
  return horizontal;
}

/**
 * Fit scale for the map thumbnail and the authored window box around it.
 *
 * The source authors no window height, only `minWidth`, so the box is derived
 * from the measured slice chrome: the thumbnail is drawn at 1:1 when it fits
 * the maximum interior and scaled down uniformly when it does not, and the
 * window keeps the authored minimum width even for a very narrow map.
 */
export function miniMapBox(map: Pick<MiniMapMapAsset, 'width' | 'height'>, minWidth: number, maxInterior = { width: 230, height: 200 }) {
  const fit = Math.min(1, maxInterior.width / map.width, maxInterior.height / map.height);
  const interior = { width: Math.round(map.width * fit), height: Math.round(map.height * fit) };
  const width = Math.max(minWidth, interior.width + MINIMAP_EDGE_X * 2);
  return { fit, interior, width, interiorLeft: Math.round((width - interior.width) / 2) };
}

/** Side chrome beside the thumbnail: one 9 px edge slice (`w` / `e`) per side,
 *  measured off the exported MaxMap/MinMap slices. */
export const MINIMAP_EDGE_X = 9;
/** Bottom chrome under the thumbnail: one 16 px corner row (`sw` / `se`). */
export const MINIMAP_BOTTOM_Y = 16;
/** Every authored button sprite is 21 x 21. */
const BUTTON_SIZE = 21;
/** Narrow viewports drop to the authored compact / strip windows. */
const BREAKPOINTS: { query: string; mode: MiniMapMode }[] = [
  { query: '(max-width: 620px)', mode: 'strip' },
  { query: '(max-width: 900px)', mode: 'compact' },
];

/**
 * The minimap window, built from the TMS273 `UI/UIMap.img/MiniMap` art.
 *
 * This is a pure view.  Every position it draws comes from the authoritative
 * snapshot the server just sent, or from the map's own authored portal list;
 * nothing here decides where anybody is, whether a portal is usable, or whether
 * a marker is still alive.  The only local state is display state: which of the
 * three authored window modes is showing, which corner it is docked to, one
 * zoom step and three marker filters — none of which touch gameplay.
 *
 * Known boundaries
 * ----------------
 * * Maps whose source authors no `miniMap` node (the three Victoria shops,
 *   楓葉村武器店, …) show the authored "no minimap" line instead of a window.
 *   The original shows nothing at all for them.
 * * Every character — self and others — travels on the authored
 *   `iconDirection` arrows; party members are only tinted by opacity, since
 *   the source authors no separate party sprite.  Monsters and drops are deliberately *not*
 *   plotted: the source filter only carries `npc*` and `pc*` categories.
 * * Only `iconNpc/0` and `iconPortal/0` are drawn.  The other three sibling
 *   sprites are the source's per-type variants, but which type is which is not
 *   established by the local client (U), so no mapping is guessed here.
 * * The button row sits inside the top strip.  The collapsed strip places its
 *   buttons left of the street name, which is authored; the plate windows
 *   author no button vector, so the row is right-aligned inside the same strip
 *   (P — derived from the strip's authored layout, not proven).
 */
export class MiniMapView {
  private root?: HTMLDivElement;
  private window?: HTMLDivElement;
  private body?: HTMLDivElement;
  private canvas?: HTMLImageElement;
  private markerLayer?: HTMLDivElement;
  private streetLine?: HTMLSpanElement;
  private nameLine?: HTMLSpanElement;
  private emptyLine?: HTMLParagraphElement;
  private buttons?: HTMLDivElement;
  private mode: MiniMapMode = 'full';
  private dock: MiniMapDock = 'left';
  /** `false` fits the thumbnail to the window; `true` zooms one step in and
   *  keeps the player centred, like the original's magnified view. */
  private zoomed = false;
  private showNpc = true;
  private showPortal = true;
  private showParty = true;
  private input?: MiniMapInput;
  /** Live marker elements, keyed `<kind>:<id>`. */
  private markers = new Map<string, HTMLElement>();
  private media: MediaQueryList[] = [];
  private onMediaChange = () => {
    const next = MiniMapView.preferredMode();
    if (next === this.mode) return;
    this.mode = next;
    this.zoomed = false;
    this.render();
  };
  /** Set by the app.  The WORLD button is a separate feature this round. */
  onWorldMap?: () => void;
  /** Set by the app so the window can report "not wired" without owning copy. */
  onStatus?: (message: string) => void;

  constructor(private readonly host: HTMLElement, private readonly manifest: Manifest) {
    for (const { query } of BREAKPOINTS) {
      const list = window.matchMedia(query);
      list.addEventListener('change', this.onMediaChange);
      this.media.push(list);
    }
  }

  private static preferredMode(): MiniMapMode {
    return BREAKPOINTS.find(entry => window.matchMedia(entry.query).matches)?.mode ?? 'full';
  }

  private data(): MiniMapUiData | undefined {
    return this.manifest.miniMap;
  }

  private frame(key: string): AssetFrame | undefined {
    return this.data()?.ui[key];
  }

  private mapAsset(mapId: string): MiniMapMapAsset | undefined {
    return this.data()?.maps[mapId];
  }

  /** The authored street and map names for a map. */
  private names(mapId: string): { street: string; map: string } {
    const catalog = this.manifest.mapCatalog?.maps.find(entry => entry.id === mapId);
    const entry = catalog ?? (this.manifest.map.id === mapId ? this.manifest.map : undefined);
    return {
      street: catalog?.streetName ? mapText(mapId, catalog.streetName) : '',
      map: mapText(mapId, entry?.name ?? mapId),
    };
  }

  // -------------------------------------------------------------- lifecycle

  mount() {
    this.mode = MiniMapView.preferredMode();
    this.render();
  }

  destroy() {
    for (const list of this.media) list.removeEventListener('change', this.onMediaChange);
    this.media = [];
    this.root?.remove();
    this.root = undefined;
    this.markers.clear();
  }

  /** Replace the displayed state.  Called once per authoritative snapshot. */
  update(input: MiniMapInput) {
    this.input = input;
    if (!this.root) this.render();
    else this.paint();
  }

  clear() {
    this.input = undefined;
    this.root?.remove();
    this.root = undefined;
    this.markers.clear();
  }

  isOpen(): boolean {
    return Boolean(this.root);
  }

  /** Narrow viewports drop to the authored compact / strip windows. */
  applyResponsiveMode() {
    this.onMediaChange();
  }

  // ------------------------------------------------------------ display state

  private setMode(mode: MiniMapMode) {
    this.mode = mode;
    if (mode !== 'full') this.zoomed = false;
    this.render();
  }

  // --------------------------------------------------------------- rendering

  private render() {
    if (!this.root) this.root = this.build();
    this.paint();
  }

  private build(): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'tms-minimap';
    root.dataset.dock = this.dock;
    root.setAttribute('role', 'complementary');
    root.setAttribute('aria-label', uiLocale() === 'en' ? 'Minimap' : '小地图');

    const windowBox = document.createElement('div');
    windowBox.className = 'tms-minimap-window';

    this.body = document.createElement('div');
    this.body.className = 'tms-minimap-body';
    this.canvas = document.createElement('img');
    this.canvas.className = 'tms-minimap-canvas';
    this.canvas.alt = '';
    this.canvas.draggable = false;
    this.markerLayer = document.createElement('div');
    this.markerLayer.className = 'tms-minimap-markers';
    this.body.append(this.canvas, this.markerLayer);

    this.streetLine = document.createElement('span');
    this.streetLine.className = 'tms-minimap-street';
    this.nameLine = document.createElement('span');
    this.nameLine.className = 'tms-minimap-name';

    this.emptyLine = document.createElement('p');
    this.emptyLine.className = 'tms-minimap-empty';
    this.emptyLine.textContent = uiText('minimapNoSource');

    this.buttons = document.createElement('div');
    this.buttons.className = 'tms-minimap-buttons';

    windowBox.append(this.body, this.streetLine, this.nameLine, this.emptyLine, this.buttons);
    root.append(windowBox);
    this.host.append(root);
    return root;
  }

  /**
   * Push the authored geometry and the shell slice URLs onto the element as
   * CSS variables.
   *
   * The three modes use the three shells the source authors: `Min` (the bare
   * 30 px bar), `MinMap` (36 px strip over the same plate) and `MaxMap` (76 px
   * header with the MINI MAP label, the mark plate and both names).  Header
   * heights are the measured corner-slice heights; the plate edges are the
   * 9 px `w`/`e` slices and the bottom corners are 16 px, all measured off the
   * exported art.
   */
  private applyChrome(map: MiniMapMapAsset | undefined) {
    const root = this.root;
    const layout = this.data()?.layout;
    if (!root || !layout) return;
    const full = this.mode === 'full';
    const strip = this.mode === 'strip';
    const shell = full ? 'MaxMap' : this.mode === 'compact' ? 'MinMap' : 'Min';
    const set = (name: string, value: string) => root.style.setProperty(name, value);
    const shellUrl = (part: string, fallbackShell?: string): string => {
      const frame = this.frame(`${shell}/${part}`) ?? (fallbackShell ? this.frame(`${fallbackShell}/${part}`) : undefined);
      return frame ? `url("${frame.url}")` : 'none';
    };
    for (const part of ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se', 'c']) {
      set(`--minimap-${part}`, shellUrl(part, strip ? undefined : 'MaxMap'));
    }
    if (full) {
      set('--minimap-nw2', shellUrl('nw2'));
      set('--minimap-nw2-x', `${this.frame('MaxMap/nw')?.width ?? 44}px`);
    }
    const corner = (part: string) => this.frame(`${shell}/${part}`) ?? this.frame(`MinMap/${part}`);
    const header = full
      ? Math.max(this.frame('MaxMap/nw')?.height ?? 0, this.frame('MaxMap/nw2')?.height ?? 0, this.frame('MaxMap/ne')?.height ?? 0)
      : this.mode === 'compact' ? Math.max(corner('nw')?.height ?? 0, corner('ne')?.height ?? 0) : 0;
    const barHeight = this.frame('Min/w')?.height ?? 30;
    set('--minimap-header', `${header}px`);
    set('--minimap-bar-height', `${barHeight}px`);
    set('--minimap-min-width', `${layout.minWidth}px`);
    set('--minimap-edge-x', `${MINIMAP_EDGE_X}px`);
    set('--minimap-bottom-y', `${MINIMAP_BOTTOM_Y}px`);
    set('--minimap-button-interval', `${layout.buttonInterval}px`);
    set('--minimap-mark-x', `${layout.mapMark.x}px`);
    set('--minimap-mark-y', `${layout.mapMark.y}px`);
    set('--minimap-font-size', `${layout.fonts.mapName.size}px`);
    set('--minimap-street-color', layout.fonts.streetName.color);
    set('--minimap-name-color', layout.fonts.mapName.color);
    set('--minimap-dock-left-x', `${layout.docks.left.x}px`);
    set('--minimap-dock-left-y', `${layout.docks.left.y}px`);
    set('--minimap-dock-right-x', `${-layout.docks.right.x}px`);
    set('--minimap-dock-right-y', `${layout.docks.right.y}px`);
    if (!map) return;
    const box = miniMapBox(map, layout.minWidth);
    // Strip mode is the authored `Min` bar: no plate, street name at the
    // authored `Min/vector:streetName`.  Full mode shows both names at the
    // authored `MaxMap` vectors; compact borrows the Min position because
    // MinMap authors no name vector of its own.
    const streetPos = full ? layout.streetName : layout.minStreetName;
    set('--minimap-street-x', `${streetPos.x}px`);
    set('--minimap-street-y', `${streetPos.y}px`);
    set('--minimap-name-x', `${layout.mapName.x}px`);
    set('--minimap-name-y', `${layout.mapName.y}px`);
    // P: the source authors button sprites and `buttonInterval` but no button
    // vector for the plate windows.  The collapsed strip does place its
    // buttons left of the street name; the plate windows follow the same
    // reading with the row right-aligned inside the strip so it never covers
    // the names.
    const buttonTop = strip || this.mode === 'compact'
      ? Math.max(0, Math.round(((strip ? barHeight : header) - BUTTON_SIZE) / 2))
      : Math.max(0, header - BUTTON_SIZE - 4);
    set('--minimap-buttons-x', `${strip ? MINIMAP_EDGE_X : 0}px`);
    set('--minimap-buttons-y', `${buttonTop}px`);
    set('--minimap-window-width', `${strip ? layout.minWidth : box.width}px`);
    set('--minimap-body-left', `${strip ? 0 : box.interiorLeft}px`);
    set('--minimap-body-top', `${strip ? 0 : header}px`);
    set('--minimap-body-width', `${strip ? layout.minWidth - MINIMAP_EDGE_X * 2 : box.interior.width}px`);
    set('--minimap-body-height', `${strip ? barHeight : box.interior.height}px`);
    set('--minimap-fit', String(box.fit));
  }

  /**
   * Place the thumbnail and the marker layer.
   *
   * Both layers share one transform so a dot can never drift off the terrain it
   * is plotted on.  In the fitted view that is a plain scale about the top-left
   * corner of the authored rectangle; the magnified view scales one step
   * further and translates the player's own pixel to the centre of the window,
   * which is how the original follows the player when zoomed in.
   */
  private applyTransform(map: MiniMapMapAsset) {
    const root = this.root;
    if (!root) return;
    const self = this.input?.self;
    const magnified = this.zoomed && this.mode === 'full';
    const fit = Number(root.style.getPropertyValue('--minimap-fit')) || 1;
    const scale = fit * (magnified ? 2 : 1);
    if (!magnified || !self) {
      root.style.setProperty('--minimap-map-transform', `scale(${scale})`);
      return;
    }
    const bodyWidth = Number.parseFloat(root.style.getPropertyValue('--minimap-body-width')) || 0;
    const bodyHeight = Number.parseFloat(root.style.getPropertyValue('--minimap-body-height')) || 0;
    const pixel = miniMapPixel(map, self.x, self.y);
    const offsetX = Math.round(bodyWidth / 2 - pixel.x * scale);
    const offsetY = Math.round(bodyHeight / 2 - pixel.y * scale);
    root.style.setProperty('--minimap-map-transform', `translate(${offsetX}px, ${offsetY}px) scale(${scale})`);
  }

  private buildButtons() {
    const root = this.buttons;
    if (!root) return;
    root.replaceChildren();
    // One authored sprite set per control, in the order the window uses them.
    const add = (key: string, label: string, onClick: () => void, pressed?: boolean) => {
      const normal = this.frame(`${key}/normal`);
      if (!normal) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tms-minimap-button';
      button.title = label;
      button.setAttribute('aria-label', label);
      if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
      const image = document.createElement('img');
      const show = (state: string) => { image.src = (this.frame(`${key}/${state}`) ?? normal).url; };
      image.src = normal.url;
      image.width = normal.width;
      image.height = normal.height;
      image.alt = '';
      image.draggable = false;
      button.append(image);
      button.addEventListener('pointerenter', () => show('mouseOver'));
      button.addEventListener('pointerleave', () => show('normal'));
      button.addEventListener('pointerdown', () => show('pressed'));
      button.addEventListener('pointerup', () => show('mouseOver'));
      button.addEventListener('click', onClick);
      root.append(button);
    };
    if (this.mode === 'strip') {
      add('button:max', uiText('minimapShow'), () => this.setMode('full'));
    } else {
      add('button:min', uiText('minimapHide'), () => this.setMode('strip'));
      add(this.mode === 'compact' ? 'button:max' : 'button:small',
        this.mode === 'compact' ? uiText('minimapFull') : uiText('minimapCompact'),
        () => this.setMode(this.mode === 'compact' ? 'full' : 'compact'));
      add('button:big', this.zoomed ? uiText('minimapZoomOut') : uiText('minimapZoomIn'),
        () => { this.zoomed = !this.zoomed; this.render(); }, this.zoomed);
      add('BtNpc', uiText('minimapNpc'), () => { this.showNpc = !this.showNpc; this.render(); }, this.showNpc);
      add('BtMap', uiText('minimapWorld'), () => this.onWorldMap?.());
    }
  }

  private paint() {
    const root = this.root;
    if (!root) return;
    const data = this.data();
    const map = this.input ? this.mapAsset(this.input.mapId) : undefined;
    this.applyChrome(map);
    this.buildButtons();
    root.dataset.mode = this.mode;
    root.dataset.zoomed = String(this.zoomed && this.mode === 'full');

    if (!this.input || !map || !data) {
      root.dataset.unavailable = 'true';
      if (this.canvas) this.canvas.removeAttribute('src');
      this.markerLayer?.replaceChildren();
      this.markers.clear();
      return;
    }
    delete root.dataset.unavailable;
    if (this.streetLine) this.streetLine.textContent = this.names(this.input.mapId).street;
    if (this.nameLine) this.nameLine.textContent = this.names(this.input.mapId).map;
    if (this.canvas && this.canvas.getAttribute('src') !== map.url) {
      this.canvas.src = map.url;
      this.canvas.width = map.width;
      this.canvas.height = map.height;
    }
    this.applyTransform(map);
    this.paintMarkers(map, this.input);
  }

  /**
   * Draw one marker per authoritative entity.  Positions go through
   * `miniMapPixel`; the CSS transform then applies the fit scale, so the
   * markers cannot drift away from the thumbnail they are plotted on.
   */
  private paintMarkers(map: MiniMapMapAsset, input: MiniMapInput) {
    const layer = this.markerLayer;
    const data = this.data();
    if (!layer || !data) return;
    const keep = new Set<string>();
    const place = (element: HTMLElement, x: number, y: number) => {
      const pixel = miniMapPixel(map, x, y);
      element.style.left = `${pixel.x}px`;
      element.style.top = `${pixel.y}px`;
      // Markers outside the authored rectangle are still drawn: the original
      // keeps them so a player standing on a stray foothold is never invisible.
      element.classList.toggle('is-outside', !miniMapContains(map, x, y));
    };
    const ensure = (key: string, className: string) => {
      keep.add(key);
      let element = this.markers.get(key);
      if (!element) {
        element = document.createElement('i');
        element.className = className;
        this.markers.set(key, element);
        layer.append(element);
      }
      return element;
    };
    const decorate = (element: HTMLElement, frame: AssetFrame) => {
      if (element.dataset.frame === frame.url) return;
      element.dataset.frame = frame.url;
      element.style.backgroundImage = `url("${frame.url}")`;
      element.style.width = `${frame.width}px`;
      element.style.height = `${frame.height}px`;
      element.style.marginLeft = `${-frame.width / 2}px`;
      element.style.marginTop = `${-frame.height / 2}px`;
    };

    if (this.showPortal) {
      for (const portal of input.portals ?? []) {
        const element = ensure(`portal:${portal.name}`, 'tms-minimap-marker is-portal');
        decorate(element, data.icons.portal);
        element.title = portal.targetMapId ? `${portal.name} → ${portal.targetMapId}` : portal.name;
        place(element, portal.x, portal.y);
      }
    }
    if (this.showNpc) {
      for (const npc of input.npcs ?? []) {
        const element = ensure(`npc:${npc.id}`, 'tms-minimap-marker is-npc');
        decorate(element, data.icons.npc);
        element.title = npc.nameZh || npc.name;
        place(element, npc.x, npc.y);
      }
    }
    const party = new Set(input.partyIds ?? []);
    const selfId = input.self?.id;
    if (this.showParty) {
      for (const player of input.players ?? []) {
        if (player.id === selfId) continue;
        const inParty = party.has(player.id);
        const element = ensure(`player:${player.id}`, `tms-minimap-marker is-player${inParty ? ' is-party' : ''}`);
        // Every character travels on the same authored arrow sprites; the
        // party tint is opacity only (the source authors no separate sprite).
        decorate(element, data.icons.direction[miniMapArrow(player)] ?? data.icons.direction.e);
        element.title = player.username;
        place(element, player.x, player.y);
      }
    }
    if (input.self) {
      const element = ensure('self', 'tms-minimap-marker is-self');
      decorate(element, data.icons.direction[miniMapArrow(input.self)] ?? data.icons.direction.e);
      element.title = uiText('minimapSelf');
      place(element, input.self.x, input.self.y);
    }
    for (const [key, element] of this.markers) {
      if (keep.has(key)) continue;
      element.remove();
      this.markers.delete(key);
    }
  }
}
