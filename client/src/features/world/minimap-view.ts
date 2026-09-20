import type { NpcState, PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest, MapPortal, MiniMapMapAsset, MiniMapUiData } from '../../assets/manifest';
import { mapText, uiLocale, uiText } from '../../app/i18n';
import { installWindowDrag } from '../ui/window-shell.ts';

/** The three states the original window has: the collapsed strip, the compact
 *  window and the full window (which also carries the street and map name). */
export type MiniMapMode = 'strip' | 'compact' | 'full';
/** The eight `iconDirection` sprites. */
export type MiniMapArrow = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';
/** Which screen corner the window is docked to.  Both dock points are authored
 *  in the source (`vector:left` / `vecotr:right`). */
export type MiniMapDock = 'left' | 'right';

export interface MiniMapInput {
  /** Activity geometry projected into this same source-backed minimap. */
  map?: MiniMapMapAsset;
  names?: { street: string; map: string };
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
/** The bare `Min` strip uses 10 px `w` / `e` ends. */
export const MINIMAP_STRIP_EDGE_X = 10;
/** White body frame -> window edges, measured off the slices: the frame's top
 *  line is the `n` slice's last two rows (MaxMap y68-69, MinMap y28-29) and
 *  its bottom line is `s` rows 0-1 placed 10 px above the window bottom. */
const MAXMAP_FRAME_TOP = 70;
const MINMAP_FRAME_TOP = 30;
const FRAME_BOTTOM = 11;
/** MaxMap corner slices are 76 px tall; MinMap corners are 36 px.  The stretch
 *  edge slices (`w` / `e`) fill the side from that height to the bottom row. */
const MAXMAP_CORNER_Y = 76;
const MINMAP_CORNER_Y = 36;
/** Both authored button groups sit on the top row, 4 px in from the edge. */
const BUTTON_TOP = 4;
const BUTTON_EDGE = 4;
const STRIP_BUTTON_EDGE = 10;
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
 * * The window controls use the four authored window sprites — `button:min`
 *   (the "−" that collapses to the strip), `button:max` (the "+" on the
 *   strip), and `button:small` / `button:big` (the shrink / grow pair that
 *   swap the full and compact plates).  `BtMap` opens the world map;
 *   `BtNpc` opens the authored NPC 目录 window (`MiniMap/npcList`) exactly
 *   like the source tooltip says — picking a row marks that NPC with the
 *   authored `iconNavi` chevron.  The source authors no zoom sprite, so the
 *   plate windows carry only the two size toggles plus `BtNpc` / `BtMap`:
 *   the size pair anchors the top-left row like the authored strip button,
 *   and the feature pair anchors the top-right row (P — the plate windows
 *   author no button vector).  The npcList popup anchors below the window
 *   and its close button sits in the panel's top-right corner (P — neither
 *   position is authored); the `BtFilter` / `BtTown` / `BtNavigation` /
 *   `BtDungeonMap` siblings belong to features that are not implemented.
 */
export class MiniMapView {
  private root?: HTMLDivElement;
  private window?: HTMLDivElement;
  private body?: HTMLDivElement;
  private canvas?: HTMLImageElement;
  private markerLayer?: HTMLDivElement;
  private streetLine?: HTMLSpanElement;
  private nameLine?: HTMLSpanElement;
  private buttons?: HTMLDivElement;
  private buttonsLeft?: HTMLDivElement;
  private buttonsRight?: HTMLDivElement;
  /** The control set currently drawn (`mode|npcListOpen|locale`).  A snapshot
   *  only rebuilds the strip when this changes — see `buildButtons`. */
  private buttonsSignature = '';
  /** The MaxMap corner plate badge (`MapHelper.img/mark/<info/mapMark>`). */
  private markIcon?: HTMLImageElement;
  /** The authored NPC 目录 window, opened by `BtNpc`. */
  private npcListWindow?: HTMLDivElement;
  private npcListRows?: HTMLDivElement;
  private npcListOpen = false;
  private npcListSignature = '';
  /** The NPC the player picked in the 目录; the window draws `iconNavi`
   *  over that NPC's marker until the pick is toggled off. */
  private selectedNpcId?: string;
  private mode: MiniMapMode = 'full';
  /** The plate mode to restore to from the strip (`button:max`). */
  private modeBeforeStrip: MiniMapMode = 'full';
  private dock: MiniMapDock = 'left';
  private showPortal = true;
  private showParty = true;
  private input?: MiniMapInput;
  /** Live marker elements, keyed `<kind>:<id>`. */
  private markers = new Map<string, HTMLElement>();
  private media: MediaQueryList[] = [];
  private dragDispose?: () => void;
  private escapeDispose?: () => void;
  private onMediaChange = () => {
    const next = MiniMapView.preferredMode();
    if (next === this.mode) return;
    this.mode = next;
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
    // The window drags by its authored header (76 px in MaxMap, 36 px in
    // MinMap; the bare Min strip has no header and stays docked).  Dragging
    // writes plain left/top on the `#minimap` host, which overrides the dock
    // variables; `right` is cleared on the first drag so a right-docked window
    // is not squeezed between both edges.
    const shell = this.host.parentElement;
    if (shell) {
      this.dragDispose = installWindowDrag(shell, this.host, {
        titleHeight: () => this.titleBarHeight(),
        isOpen: () => Boolean(this.root) && this.mode !== 'strip',
        onActivate: () => { this.host.style.right = 'auto'; },
      });
    }
    // The NPC 目录 closes itself on Escape, before the menu router can claim
    // the key (main.ts keeps `npcListShown()` in its blocked chain).
    this.escapeDispose = this.installEscapeClose();
  }

  /** Escape closes the NPC 目录 while it is open.  Installed on the document
   *  capture phase like every other panel listener; disposed with the view. */
  private installEscapeClose(): () => void {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.key !== 'Escape' && event.code !== 'Escape') return;
      if (!this.npcListOpen) return;
      event.preventDefault();
      this.toggleNpcList();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }

  /** True while the authored NPC 目录 window is open (the Escape router asks). */
  npcListShown(): boolean {
    return this.npcListOpen;
  }

  /** Header height of the current authored shell (see `applyChrome`). */
  private titleBarHeight(): number {
    if (this.mode === 'full') return MAXMAP_CORNER_Y;
    if (this.mode === 'compact') return MINMAP_CORNER_Y;
    return 0;
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
    return this.input?.map ?? this.data()?.maps[mapId];
  }

  /** The authored street and map names for a map. */
  private names(mapId: string): { street: string; map: string } {
    if (this.input?.names) return this.input.names;
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
    this.dragDispose?.();
    this.dragDispose = undefined;
    this.escapeDispose?.();
    this.escapeDispose = undefined;
    this.root?.remove();
    this.root = undefined;
    this.buttonsSignature = '';
    this.npcListWindow = undefined;
    this.npcListRows = undefined;
    this.npcListOpen = false;
    this.npcListSignature = '';
    this.selectedNpcId = undefined;
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
    this.buttonsSignature = '';
    this.npcListWindow = undefined;
    this.npcListRows = undefined;
    this.npcListOpen = false;
    this.npcListSignature = '';
    this.selectedNpcId = undefined;
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
    // The plate windows author no BtNpc of their own, so the 目录 follows the
    // full window: leaving it closes the popup (and drops the navi pick).
    if (mode !== 'full' && this.npcListOpen) this.toggleNpcList();
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

    this.buttons = document.createElement('div');
    this.buttons.className = 'tms-minimap-buttons';
    this.buttonsLeft = document.createElement('div');
    this.buttonsLeft.className = 'tms-minimap-buttons-left';
    this.buttonsRight = document.createElement('div');
    this.buttonsRight.className = 'tms-minimap-buttons-right';
    this.buttons.append(this.buttonsLeft, this.buttonsRight);
    // A fresh strip must redraw even when the mode is unchanged (a rebuilt root
    // after `clear()` starts with empty button groups).
    this.buttonsSignature = '';

    // The MaxMap corner plate badge.  Hidden unless the full window is showing
    // a map whose source declares a `mapMark` badge.
    this.markIcon = document.createElement('img');
    this.markIcon.className = 'tms-minimap-mark';
    this.markIcon.alt = '';
    this.markIcon.draggable = false;
    this.markIcon.style.display = 'none';

    // The authored NPC 目录 window, parked closed under the plate window.
    this.npcListWindow = this.buildNpcList();

    windowBox.append(this.body, this.streetLine, this.nameLine, this.buttons, this.markIcon);
    root.append(windowBox, this.npcListWindow);
    this.host.append(root);
    return root;
  }

  /**
   * The authored `MiniMap/npcList` window: the 184x286 panel art with the
   * close button in its top-right corner (P — the source authors the button
   * but no position), the row strip at the authored listLT..listRB rectangle
   * and an empty line for maps without NPCs.  Rows are (re)filled by
   * `paintNpcList` from the authoritative snapshot.
   */
  private buildNpcList(): HTMLDivElement {
    const list = document.createElement('div');
    list.className = 'tms-minimap-list';
    list.setAttribute('role', 'dialog');
    list.setAttribute('aria-label', uiText('minimapNpc'));
    const panel = this.data()?.ui['npcList/backgrnd'];
    if (panel) {
      // Asset URLs live in inline styles, never in CSS (the offline app
      // checks cannot resolve `url('/assets/…')` from a stylesheet).
      list.style.backgroundImage = `url("${panel.url}")`;
      list.style.width = `${panel.width}px`;
      list.style.height = `${panel.height}px`;
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tms-minimap-list-close';
    close.setAttribute('aria-label', uiText('minimapNpcListClose'));
    const closeNormal = this.data()?.ui[`npcList/button:close/normal`];
    const closeImage = document.createElement('img');
    const showClose = (state: string) => {
      const frame = this.data()?.ui[`npcList/button:close/${state}`] ?? closeNormal;
      if (frame) closeImage.src = frame.url;
    };
    if (closeNormal) {
      closeImage.src = closeNormal.url;
      closeImage.width = closeNormal.width;
      closeImage.height = closeNormal.height;
    }
    closeImage.alt = '';
    closeImage.draggable = false;
    close.append(closeImage);
    close.addEventListener('pointerenter', () => showClose('mouseOver'));
    close.addEventListener('pointerleave', () => showClose('normal'));
    close.addEventListener('pointerdown', () => showClose('pressed'));
    close.addEventListener('pointerup', () => showClose('normal'));
    close.addEventListener('click', () => this.toggleNpcList());
    list.append(close);

    this.npcListRows = document.createElement('div');
    this.npcListRows.className = 'tms-minimap-list-rows';
    const rows = this.data()?.layout.npcList;
    if (rows) {
      this.npcListRows.style.left = `${rows.listLT.x}px`;
      this.npcListRows.style.top = `${rows.listLT.y}px`;
      this.npcListRows.style.width = `${rows.listRB.x - rows.listLT.x}px`;
      this.npcListRows.style.height = `${rows.listRB.y - rows.listLT.y}px`;
    }
    const empty = document.createElement('p');
    empty.className = 'tms-minimap-list-empty';
    empty.textContent = uiText('minimapNpcListEmpty');
    this.npcListRows.append(empty);
    list.append(this.npcListRows);
    list.style.display = 'none';
    return list;
  }

  /** Open/close the authored NPC 目录 window (the `BtNpc` button). */
  private toggleNpcList() {
    this.npcListOpen = !this.npcListOpen;
    if (this.npcListOpen && !this.npcListWindow) this.npcListWindow = this.buildNpcList();
    if (this.npcListWindow) this.npcListWindow.style.display = this.npcListOpen ? 'block' : 'none';
    if (!this.npcListOpen) this.selectedNpcId = undefined;
    this.buildButtons();
    this.paint();
  }

  /**
   * Push the authored geometry and the shell slice URLs onto the element as
   * CSS variables.
   *
   * The three modes use the three shells the source authors: `Min` (the bare
   * 30 px bar), `MinMap` (a 28 px header over the white-framed plate) and
   * `MaxMap` (a 76 px corner carrying the mark plate and both names).  The `n`
   * slice stretches between the two top
   * corners and carries the white frame's top line on its last two rows, so
   * the thumbnail top is 70 (MaxMap) / 30 (MinMap); the `w` / `e` slices
   * stretch from the 76 / 36 px corner rows to the 16 px bottom corners.
   * Every number here is measured off the exported art.
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
    const barHeight = this.frame('Min/w')?.height ?? 30;
    const cornerY = full ? MAXMAP_CORNER_Y : MINMAP_CORNER_Y;
    const frameTop = full ? MAXMAP_FRAME_TOP : MINMAP_FRAME_TOP;
    set('--minimap-header', `${strip ? 0 : cornerY}px`);
    set('--minimap-frame-top', `${strip ? 0 : frameTop}px`);
    set('--minimap-frame-bottom', `${FRAME_BOTTOM}px`);
    set('--minimap-bar-height', `${barHeight}px`);
    set('--minimap-min-width', `${layout.minWidth}px`);
    set('--minimap-edge-x', `${MINIMAP_EDGE_X}px`);
    set('--minimap-strip-edge-x', `${MINIMAP_STRIP_EDGE_X}px`);
    set('--minimap-button-interval', `${layout.buttonInterval}px`);
    set('--minimap-buttons-top', `${BUTTON_TOP}px`);
    set('--minimap-buttons-edge', `${strip ? STRIP_BUTTON_EDGE : BUTTON_EDGE}px`);
    set('--minimap-mark-x', `${layout.mapMark.x}px`);
    set('--minimap-mark-y', `${layout.mapMark.y}px`);
    set('--minimap-list-name-x', `${layout.npcList.namePos.x}px`);
    set('--minimap-list-name-y', `${layout.npcList.namePos.y}px`);
    set('--minimap-list-row-height', `${layout.npcList.rowHeight}px`);
    set('--minimap-font-size', `${layout.fonts.mapName.size}px`);
    set('--minimap-street-color', layout.fonts.streetName.color);
    set('--minimap-name-color', layout.fonts.mapName.color);
    set('--minimap-dock-left-x', `${layout.docks.left.x}px`);
    set('--minimap-dock-left-y', `${layout.docks.left.y}px`);
    set('--minimap-dock-right-x', `${-layout.docks.right.x}px`);
    set('--minimap-dock-right-y', `${layout.docks.right.y}px`);
    if (full) {
      // The `n` fill starts right after the 44 px nw corner and runs to ne.
      // `MaxMap/nw2` — the source's 64x67 black "MINI MAP" title card — is
      // deliberately NOT painted: the card would sit across the whole header
      // and the two authored names, and the delivered window reads as the
      // corner's own white mark plate plus the names over the shell (the same
      // arrangement the official cross-region reference screenshot shows).
      // `layout.mapName` / `layout.streetName` are the source's own vectors and
      // are unchanged, so the names keep their authored anchor.
      set('--minimap-n-x', `${this.frame('MaxMap/nw')?.width ?? 44}px`);
      set('--minimap-n-width', `calc(100% - ${(this.frame('MaxMap/nw')?.width ?? 44) + (this.frame('MaxMap/ne')?.width ?? 15)}px)`);
      set('--minimap-n-height', `${this.frame('MaxMap/n')?.height ?? 70}px`);
    } else if (strip) {
      set('--minimap-n-x', '0px');
      set('--minimap-n-width', '100%');
      set('--minimap-n-height', '100%');
    } else {
      set('--minimap-n-x', `${this.frame('MinMap/nw')?.width ?? 15}px`);
      set('--minimap-n-width', `calc(100% - ${(this.frame('MinMap/nw')?.width ?? 15) + (this.frame('MinMap/ne')?.width ?? 15)}px)`);
      set('--minimap-n-height', `${this.frame('MinMap/n')?.height ?? 30}px`);
    }
    if (!map) return;
    const box = miniMapBox(map, layout.minWidth);
    // Strip mode is the authored `Min` bar: no plate, street name at the
    // authored `Min/vector:streetName`.  Full mode shows both names at the
    // authored `MaxMap` vectors, inside the black card; compact borrows the
    // Min position because MinMap authors no name vector of its own.
    const streetPos = full ? layout.streetName : layout.minStreetName;
    set('--minimap-street-x', `${streetPos.x}px`);
    set('--minimap-street-y', `${streetPos.y}px`);
    set('--minimap-name-x', `${layout.mapName.x}px`);
    set('--minimap-name-y', `${layout.mapName.y}px`);
    set('--minimap-window-width', `${strip ? layout.minWidth : box.width}px`);
    set('--minimap-body-left', `${strip ? 0 : box.interiorLeft}px`);
    set('--minimap-body-top', `${strip ? 0 : frameTop}px`);
    set('--minimap-body-width', `${strip ? layout.minWidth - MINIMAP_STRIP_EDGE_X * 2 : box.interior.width}px`);
    set('--minimap-body-height', `${strip ? barHeight : box.interior.height}px`);
    set('--minimap-fit', String(box.fit));
  }

  /**
   * Place the thumbnail and the marker layer.
   *
   * Both layers share one transform so a dot can never drift off the terrain
   * pixel it is plotted on: it is a plain scale about the top-left corner of
   * the authored rectangle, using the fit factor the box was sized with.
   */
  private applyTransform(map: MiniMapMapAsset) {
    const root = this.root;
    if (!root) return;
    const fit = Number(root.style.getPropertyValue('--minimap-fit')) || 1;
    root.style.setProperty('--minimap-map-transform', `scale(${fit})`);
  }

  /**
   * Build the authored window controls.
   *
   * The strip is NOT rebuilt per snapshot, and that is the whole point of the
   * signature below.  `paint()` runs for every authoritative snapshot — the
   * server ticks at 50 ms — so rebuilding these `<button>` elements on each one
   * detaches the element a press started on, and a real click (mousedown …
   * mouseup, well over 50 ms) then has no common ancestor to land on: the
   * button silently never fires.  Measured before the fix at 20 rebuilds per
   * second, with every one of the four controls swallowing a human-speed click
   * (`qa/minimap-buttons-probe.mjs`).  Only a change in the control set — the
   * window mode, or the NPC 目录 opening/closing — redraws the strip; the
   * pressed flag is refreshed in place.
   */
  private buildButtons() {
    if (!this.buttons) return;
    const signature = `${this.mode}|${this.npcListOpen}|${uiLocale()}`;
    if (signature === this.buttonsSignature) {
      for (const button of this.controls()) {
        if (button.dataset.control === 'BtNpc') button.setAttribute('aria-pressed', String(this.npcListOpen));
      }
      return;
    }
    this.buttonsSignature = signature;
    this.buttonsLeft?.replaceChildren();
    this.buttonsRight?.replaceChildren();
    // One authored sprite set per control.  The strip carries the "+" restore
    // button on the left; the plate windows carry the "−" collapse plus the
    // shrink/grow toggle on the left, and the NPC / world-map features on the
    // right — the two rows the source art provides sprites for.  The zh
    // tooltips are the source's own `toolTip` strings; en falls back to the
    // local copy.
    const label = (key: string, textKey: string) => {
      if (uiLocale() !== 'en') {
        const tip = this.data()?.tooltips?.[key];
        if (tip) return tip;
      }
      return uiText(textKey);
    };
    const add = (group: HTMLDivElement | undefined, key: string, textKey: string, onClick: () => void, pressed?: boolean) => {
      const normal = this.frame(`${key}/normal`);
      if (!group || !normal) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tms-minimap-button';
      button.dataset.control = key;
      button.title = label(key, textKey);
      button.setAttribute('aria-label', label(key, textKey));
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
      button.addEventListener('pointerup', () => show('normal'));
      button.addEventListener('pointercancel', () => show('normal'));
      button.addEventListener('click', onClick);
      group.append(button);
    };
    const left = this.buttonsLeft;
    const right = this.buttonsRight;
    if (this.mode === 'strip') {
      // `button:max` restores the plate mode the strip was collapsed from,
      // like the source's own `type += 1` step.
      add(left, 'button:max', 'minimapShow', () => this.setMode(this.modeBeforeStrip));
    } else {
      add(left, 'button:min', 'minimapHide', () => {
        this.modeBeforeStrip = this.mode;
        this.setMode('strip');
      });
      if (this.mode === 'compact') {
        add(left, 'button:big', 'minimapFull', () => this.setMode('full'));
      } else {
        add(left, 'button:small', 'minimapCompact', () => this.setMode('compact'));
      }
      add(right, 'BtNpc', 'minimapNpc', () => this.toggleNpcList(), this.npcListOpen);
      add(right, 'BtMap', 'minimapWorld', () => this.onWorldMap?.());
    }
  }

  /** The controls currently in the strip, in authored order. */
  private controls(): HTMLButtonElement[] {
    return [
      ...Array.from(this.buttonsLeft?.children ?? []) as HTMLButtonElement[],
      ...Array.from(this.buttonsRight?.children ?? []) as HTMLButtonElement[],
    ];
  }

  private paint() {
    const root = this.root;
    if (!root) return;
    const data = this.data();
    const map = this.input ? this.mapAsset(this.input.mapId) : undefined;
    this.applyChrome(map);
    this.buildButtons();
    root.dataset.mode = this.mode;
    this.paintMark(map);

    if (!this.input || !map || !data) {
      // Maps whose source authors no `miniMap` node (the three Victoria shops,
      // 楓葉村武器店, …) show nothing at all, like the original client: the
      // whole window is hidden, not a placeholder shell, and returning to a
      // map that carries a minimap restores it.  `data-unavailable` stays as
      // the state marker the QA probes read.
      root.dataset.unavailable = 'true';
      root.style.display = 'none';
      // The hidden window also drops the NPC 目录 and its pick, so stepping
      // back onto a minimap map never pops a stale roster.
      if (this.npcListOpen) {
        this.npcListOpen = false;
        this.selectedNpcId = undefined;
        this.npcListSignature = '';
        if (this.npcListWindow) this.npcListWindow.style.display = 'none';
        this.buildButtons();
      }
      if (this.canvas) this.canvas.removeAttribute('src');
      this.markerLayer?.replaceChildren();
      this.markers.clear();
      this.paintNpcList();
      return;
    }
    delete root.dataset.unavailable;
    root.style.display = '';
    if (this.streetLine) this.streetLine.textContent = this.names(this.input.mapId).street;
    if (this.nameLine) this.nameLine.textContent = this.names(this.input.mapId).map;
    if (this.canvas && this.canvas.getAttribute('src') !== map.url) {
      this.canvas.src = map.url;
      this.canvas.width = map.width;
      this.canvas.height = map.height;
    }
    this.applyTransform(map);
    this.paintMarkers(map, this.input);
    this.paintNpcList();
  }

  /**
   * The MaxMap corner plate badge: the 38x38 `MapHelper.img/mark/<mark>`
   * shield drawn at the authored `vector:mapMark (6,28)`, square on the white
   * plate the `nw` slice ships.  Only the full window authors the plate (and
   * the vector), and maps declaring `None` draw nothing — like the source.
   */
  private paintMark(map: MiniMapMapAsset | undefined) {
    const icon = this.markIcon;
    const layout = this.data()?.layout;
    if (!icon || !layout) return;
    const badge = this.mode === 'full' && map && map.mark !== 'None'
      ? this.data()?.icons.marks?.[map.mark]
      : undefined;
    if (!badge) {
      icon.style.display = 'none';
      icon.removeAttribute('src');
      return;
    }
    icon.style.display = 'block';
    if (icon.getAttribute('src') !== badge.url) {
      icon.src = badge.url;
      icon.width = badge.width;
      icon.height = badge.height;
    }
    icon.style.left = `${layout.mapMark.x}px`;
    icon.style.top = `${layout.mapMark.y}px`;
  }

  /**
   * Fill the NPC 目录 rows from the authoritative snapshot.  Rows are rebuilt
   * only when the roster actually changes (snapshots arrive far more often
   * than NPC rosters do); a click toggles the `iconNavi` pick on that NPC.
   */
  private paintNpcList() {
    const rows = this.npcListRows;
    const data = this.data();
    if (!rows || !data) return;
    const npcs = this.npcListOpen ? (this.input?.npcs ?? []) : [];
    const signature = npcs.map(npc => `${npc.id}:${npc.nameZh || npc.name}`).join('|');
    if (signature === this.npcListSignature) return;
    this.npcListSignature = signature;
    rows.replaceChildren();
    if (npcs.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'tms-minimap-list-empty';
      empty.textContent = uiText('minimapNpcListEmpty');
      rows.append(empty);
      return;
    }
    const icon = data.icons.npcList?.npc ?? data.icons.npc;
    for (const npc of npcs) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tms-minimap-list-row';
      row.dataset.npcId = npc.id;
      row.setAttribute('aria-pressed', String(this.selectedNpcId === npc.id));
      if (this.selectedNpcId === npc.id) row.classList.add('is-selected');
      const badge = document.createElement('span');
      badge.className = 'tms-minimap-list-icon';
      badge.style.backgroundImage = `url("${icon.url}")`;
      badge.style.width = `${icon.width}px`;
      badge.style.height = `${icon.height}px`;
      const name = document.createElement('span');
      name.className = 'tms-minimap-list-name';
      name.textContent = npc.nameZh || npc.name;
      row.append(badge, name);
      row.addEventListener('click', () => {
        this.selectedNpcId = this.selectedNpcId === npc.id ? undefined : npc.id;
        // Repaint the rows' pressed state and the navi chevron; the roster
        // itself has not changed, so skip the rebuild.
        this.npcListSignature = '';
        this.paintNpcList();
        const map = this.input ? this.mapAsset(this.input.mapId) : undefined;
        if (map && this.input) this.paintMarkers(map, this.input);
      });
      row.title = npc.nameZh || npc.name;
      rows.append(row);
    }
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
    for (const npc of input.npcs ?? []) {
      const element = ensure(`npc:${npc.id}`, 'tms-minimap-marker is-npc');
      decorate(element, data.icons.npc);
      element.title = npc.nameZh || npc.name;
      place(element, npc.x, npc.y);
      // The NPC 目录 pick: the authored `iconNavi` chevron hangs over the
      // chosen NPC, its tail on the marker point.
      if (this.npcListOpen && this.selectedNpcId === npc.id && data.icons.navi) {
        const navi = ensure(`navi:${npc.id}`, 'tms-minimap-marker is-navi');
        decorate(navi, data.icons.navi);
        navi.style.marginTop = `${-data.icons.navi.height}px`;
        navi.title = npc.nameZh || npc.name;
        place(navi, npc.x, npc.y);
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
