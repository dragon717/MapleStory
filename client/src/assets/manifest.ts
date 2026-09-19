import type { AppearanceCatalog } from '../features/entry/appearance';
import { CONTENT_VERSION } from '../../../shared/protocol.ts';
import { resolveAssetUrl } from './resource-url';
import { loadAssetIndex } from './asset-index';
import { installWindbellMaps } from '../features/windbell/maps';
import { frameAt } from '../features/player/animation.ts';
export { assetFrameAlpha } from '../features/player/animation.ts';
// 纸娃娃类型叶（计划 §9.1）：帧/部件/动作集迁到 avatar-types.ts，
// 这里 re-export 保持既有 `from '../../assets/manifest'` 导入者不变。
import type { AvatarActionSet, Frame, Part, Point } from './avatar-types';
export type { AvatarActionSet, Frame, Part, Point } from './avatar-types';
export interface Background { x: number; y: number; rx: number; ry: number; cx: number; cy: number; type: number; front: number; ani: number; f: number }
export interface MapBounds { xMin: number; xMax: number; yMin: number; yMax: number }
export interface MapLayer {
  key: string; url: string; x: number; y: number; origin?: Point; depth: number;
  alpha?: number; flip?: boolean; type?: number; background?: Background; frames?: AssetFrame[];
  source?: string; resolvedSource?: string; width?: number; height?: number;
  crop?: { x: number; y: number; width: number; height: number };
  mapObject?: { layer: number; oS: string; l0?: string; l1?: string; l2?: string; x: number; y: number; z?: number; zM?: number };
  mapTile?: { layer: number; x: number; y: number; u: string; no: number; zM?: number };
}
export interface MapLadder { id: number; l: number; uf: number; x: number; y1: number; y2: number; page: number }
export interface MapFoothold {
  id: number; path?: string; x1: number; y1: number; x2: number; y2: number;
  prev?: number; next?: number; forbidFallDown?: number;
}
export interface MapSpawn { id: string; x: number; y: number; foothold?: number; footholdPath?: string; facing?: -1 | 1 }
export interface MapPortal {
  name: string; type: number; x: number; y: number;
  targetMapId: string | null; targetPortalName: string | null;
  script?: string; onlyOnce?: boolean; hideTooltip?: number; delay?: number;
}
export interface MapCatalogEntry {
  id: string; name: string; streetName: string; source: string;
  assetStatus: 'rendered' | 'metadata'; bounds: MapBounds; bgm?: string;
  portals: MapPortal[]; layers?: MapLayer[]; ladders?: MapLadder[]; footholds?: MapFoothold[];
  water?: (MapBounds & { floor?: Point[] })[];
  spawn?: MapSpawn; spawns?: MapSpawn[];
}
export interface MapCatalog {
  birthMapId: string; source: string; maps: MapCatalogEntry[];
  omitted?: { id: string; reason: string }[];
}
export interface ControlGuide { id: string; keys: string[]; separator: '/' | '+'; label: string }
export interface MapDefinition {
  id: string; name: string; bounds: MapBounds; layers: MapLayer[];
  source?: string; portals?: MapPortal[]; ladders?: MapLadder[]; footholds?: MapFoothold[];
  water?: (MapBounds & { floor?: Point[] })[];
  spawn?: MapSpawn; spawns?: MapSpawn[]; bgm?: string;
}
export interface AssetFrame {
  url: string; width: number; height: number; origin: Point; x: number; y: number; delay: number;
  index?: number; alpha?: number; a0?: number; a1?: number;
  source?: string; resolvedSource?: string; map?: Record<string, Point>; lt?: Point | null; rb?: Point | null; head?: Point | null;
}
export interface MonsterAsset {
  templateId: string; source: string; info: Record<string, number | string>;
  actions: Record<'stand' | 'move' | 'hit' | 'die', AssetFrame[]> & { jump?: AssetFrame[]; attack1?: AssetFrame[]; attack2?: AssetFrame[]; skill1?: AssetFrame[] };
  damageSound?: { url: string; source: string };
}
export interface NpcAsset {
  name: string; source: string; stand: AssetFrame[];
}
/** One TMS273 pet (`Item/Pet` + `String/Pet.json`), keyed by item id. */
export interface PetAsset {
  name: string; icon: AssetFrame;
  stand: AssetFrame[]; move: AssetFrame[]; jump: AssetFrame[];
  /** Source `Item/Pet/<id>.img/hungry` frames.  Absent (or empty) when the
   *  source pet has no such node; the view then keeps the stand loop. */
  hungry?: AssetFrame[];
}
/** Source-backed UIWindow2.img/UserInfo/pet chrome and its two entry buttons.
 *  The selected tab is one of the server-owned three pet slots; the client
 *  supplies only names, speeds and modes that already exist in PlayerState. */
export interface PetUiData {
  contentVersion: string;
  source: string;
  window: {
    width: number; height: number;
    ui: Record<string, AssetFrame>;
    tabs: { enabled: AssetFrame[]; disabled: AssetFrame[] };
    actions: AssetFrame[];
    dialog: { backgrnd: AssetFrame };
  };
  buttons: { character: Record<string, AssetFrame>; inventory: Record<string, AssetFrame> };
  layout: {
    panel: Point; panelInner: Point; panelOverlay: Point; action: Point; tabCount: number;
  };
  researchReference?: Record<string, string>;
  unverified?: string[];
}
export interface InventorySlotLayout {
  columns: number; rows: number; slotWidth: number; slotHeight: number;
  spacingX: number; spacingY: number; origin: Point; itemOffset: Point;
  itemCount: number; itemCountOffset?: Point;
}
export interface InventoryTabLayout {
  left: number; top: number; stepX: number; width: number; height: number;
  viewportWidth: number; viewportHeight: number; count: number;
}
export interface InventoryButtonPosition { x: number; y: number }
export interface InventoryModeLayout {
  width: number; height: number; slots: InventorySlotLayout; tabs: InventoryTabLayout;
  buttons: Record<'close' | 'size' | 'sort' | 'coin', InventoryButtonPosition>;
  mesos: { x: number; y: number; width: number; height: number };
}
export interface InventoryLayout {
  source: string; categoryCount: number; backendSlotLimit: number;
  small: InventoryModeLayout; full: InventoryModeLayout;
}
export interface EquipmentSlotLayout { x: number; y: number; width: number; height: number }
export interface EquipmentLayout {
  source: string; width: number; height: number; tabOrigin: Point; slotSize: number;
  close: InventoryButtonPosition; slots: Record<string, EquipmentSlotLayout>; itemOffset?: Point;
}
export interface PortalAsset {
  mapId: string; portalName: string; spriteKey: string;
  /** First-frame cache for callers that only need a static fallback. */
  url: string; width: number; height: number;
  origin: Point; x: number; y: number; delay: number;
  /** Source-backed animation frames, ordered. Each carries its own origin/box
   *  so the client must swap texture and origin together when cycling. */
  frames: AssetFrame[];
  /** Per-frame delay in milliseconds when `frames.length > 1`. */
  frameDelay: number;
  source?: string; resolvedSource?: string;
  type: number;
}
export interface GameplayAssets {
  contentVersion: string;
  monsters: Record<string, MonsterAsset>;
  items: Record<string, AssetFrame>;
  hud: Record<string, AssetFrame>;
  drops?: { source?: string; officialParity?: string; entries?: { itemId: string; minimum: number; maximum: number; questId: number; chance: number }[] };
}
export interface AfterimageAsset {
  source: string;
  firstFrame: number;
  startMs: number;
  frames: AssetFrame[];
}
/** One authored state of a Reactor.wz template: the looping idle animation and
 *  the one-shot impact animation played when the prop is struck. `repeat`
 *  mirrors the source flag; without it the idle animation holds its last frame. */
export interface ReactorStateAsset {
  frames: AssetFrame[];
  hitFrames: AssetFrame[];
  events: { type: number; nextState: number; lt?: Point; rb?: Point }[];
  repeat: boolean;
}
/** Source-backed Reactor.wz templates plus their per-map placements. */
export interface ReactorData {
  contentVersion: string;
  source: string;
  templates: Record<string, {
    templateId: string;
    artId?: string;
    /** Source script name; retained for tracing only — no reactor script runs. */
    action: string | null;
    states: Record<string, ReactorStateAsset>;
  }>;
  placements: {
    id: string; mapId: string; templateId: string;
    x: number; y: number; flip: boolean; reactorTime: number;
  }[];
  /** Placements the source authors outside the map's own bounds (unreachable). */
  omitted?: { id: string; mapId: string; reason: string }[];
}
export interface ChatUiFrameStates {
  normal?: AssetFrame;
  pressed?: AssetFrame;
  disabled?: AssetFrame;
  mouseOver?: AssetFrame;
  checked?: AssetFrame;
}
/** Source-backed UI/ChatBalloon.img style (nine-slice + arrow) used by the
 *  PlayerView to render a map-chat bubble above a speaking character. Each
 *  slice is an independent texture (corner pieces keep their natural size,
 *  edges and the center stretch to fit the bubble width/height). */
export interface ChatBalloonAsset {
  url: string;
  width: number;
  height: number;
  origin: Point;
  x: number;
  y: number;
  source?: string;
}
export interface ChatBalloonData {
  contentVersion: string;
  source: string;
  style: string;
  /** ARGB int from the source WZ clr field; used as the text-stroke colour
   *  (MapleStory ChatBalloon text is rendered with a dark stroke on top of
   *  the light fill so it stays readable against any map background). */
  clr: number;
  slices: {
    nw: ChatBalloonAsset;
    n: ChatBalloonAsset;
    ne: ChatBalloonAsset;
    w: ChatBalloonAsset;
    c: ChatBalloonAsset;
    e: ChatBalloonAsset;
    sw: ChatBalloonAsset;
    s: ChatBalloonAsset;
    se: ChatBalloonAsset;
    arrow: ChatBalloonAsset;
  };
}
/** Source-backed UIWindow.img/Trunk window used by the account warehouse.
 *  `slotLimit` mirrors the server's row cap so the UI can draw the same number
 *  of slots the server will actually accept. */
export interface StorageUiData {
  contentVersion: string;
  source: string;
  slotLimit: number;
  ui: Record<string, AssetFrame>;
}
/** Source-backed UIWindow.img/UserList (Party tab) window used by the party
 *  window.  `memberSlots` mirrors the server's roster cap (and the six authored
 *  `partyN` chrome pieces), so the window cannot draw a row the server would
 *  never accept. */
export interface PartyUiData {
  contentVersion: string;
  source: string;
  memberSlots: number;
  /** Flat keys mirroring the WZ layout: `backgrnd`, `icon0`, `icon1`,
   *  `party0`..`party5` and `BtInvite/normal`-style button states. */
  ui: Record<string, AssetFrame>;
}
/** Source-backed UIWindow.img/UserList (Friend + BlackList tabs) used by the
 *  friend window.  `tabCount` mirrors the authored tab-strip length so the
 *  client can index `Tab/enabled/0` and `Tab/enabled/1` (好友, 黑名單) without
 *  hard-coding plate numbers.  Flat keys match the WZ layout: `backgrnd`,
 *  `Tab/enabled/0`, `Tab/disabled/0`, `BtAddFriend/normal`,
 *  `BlackList/BtAdd/normal` etc. */
export interface FriendUiData {
  contentVersion: string;
  source: string;
  tabCount: number;
  ui: Record<string, AssetFrame>;
}
/** One sticker in the chat-emoticon catalogue.  `id` is `<groupId>:<sourceName>`
 *  — the exact string the wire carries — because the authored node name is only
 *  unique *inside* its group: group 1043 re-releases group 1036's six stickers
 *  under the same node names (byte-identical canvases, different captions). */
export interface EmoticonSticker {
  id: string;
  groupId: string;
  sourceName: string;
  name: string;
  /** The 32x32 list icon, resolved per sticker (some outlink to the group icon). */
  icon: AssetFrame;
  /** Head animation frames, played above the character that used the sticker. */
  frames: AssetFrame[];
  durationMs: number;
}
export interface EmoticonGroup {
  id: string;
  name: string;
  icon: AssetFrame;
  /** Stickers this group owns, and where its slice starts in the flat
   *  `EmoticonData.stickers` catalogue (each group's stickers are contiguous). */
  stickerCount: number;
  firstSticker: number;
  /** `slotCount`-cell sheets this group needs.  A group is one 3x3 sheet
   *  unless it overflows, which only group 1000 does (10 stickers). */
  sheetCount: number;
}
/** The authored UI/ChatEmoticon window geometry, copied verbatim so the client
 *  places the grid, the group strip and the page dots exactly where the source
 *  does instead of hard-coding numbers. */
export interface EmoticonLayout {
  columns: number;
  rows: number;
  slotCount: number;
  slotOffset: Point;
  slotSpace: Point;
  slotSize: { width: number; height: number };
  /** Offset and size of a sticker drawn inside one slot. */
  emoticon: Point;
  pageOffset: Point;
  pageIconSpace: number;
  groupOffset: Point;
  groupSpace: Point;
  /** How many group chips one strip page carries. */
  groupCount: number;
  name: { offset: Point; width: number; font: string; size: number; color: string; bold: boolean };
}
/** Source-backed UI/ChatEmoticon.img: the 表情 sticker catalogue plus the 表情
 *  window shell used by the emoticon window.  PNGs are exported by
 *  `export_tms273_emoticon.cjs`. */
export interface EmoticonData {
  contentVersion: string;
  source: string;
  /** The source's own send budget (`ChatLimit`).  Mirrored from the server's
   *  copy merely so the window can explain a refusal; the server is the only
   *  thing that enforces it. */
  limit: { count: number; timeMs: number; source: string };
  /** Pages of the group strip (`groupCount` chips each).  The authored
   *  `pageUp`/`pageDown` buttons and the `pageIcon` dots drive this. */
  pageCount: number;
  /** Sticker sheets in the whole catalogue, summed over the groups: the grid is
   *  scoped to one group, so this is not `ceil(stickers / slotCount)`. */
  sheetCount: number;
  /** Dots the authored strip holds before running under `pageDown`. */
  dotCapacity: number;
  groups: EmoticonGroup[];
  stickers: EmoticonSticker[];
  layout: EmoticonLayout;
  /** Flat keys mirroring the WZ layout: `backgrnd`, `slotBase`,
   *  `layer:emptySlot`, `groupBase`, `groupSelect`, `pageIcon/on`,
   *  `pageIcon/off` and `button:close/normal`-style button states. */
  ui: Record<string, AssetFrame>;
}
export interface ChatUiNineSlice {
  nw?: AssetFrame; n?: AssetFrame; ne?: AssetFrame;
  w?: AssetFrame; c?: AssetFrame; e?: AssetFrame;
  sw?: AssetFrame; s?: AssetFrame; se?: AssetFrame;
}
export type ChatUiScalar = number | string | Point;
export interface ChatUi {
  source: string;
  panel?: {
    background?: ChatUiNineSlice;
    collapsedBackground?: ChatUiNineSlice;
    collapseButton?: ChatUiFrameStates;
    expandButton?: ChatUiFrameStates;
    outsideButton?: ChatUiFrameStates;
  };
  input?: {
    background?: { w?: AssetFrame; c?: AssetFrame; e?: AssetFrame };
    target?: ChatUiFrameStates;
    whisper?: ChatUiFrameStates;
    buttons?: Record<string, ChatUiFrameStates>;
  };
  scroll?: {
    enabled?: Record<string, AssetFrame>;
    disabled?: Record<string, AssetFrame>;
  };
  layout?: {
    panel?: Record<string, ChatUiScalar>;
    input?: Record<string, ChatUiScalar | Record<string, ChatUiScalar>>;
    outside?: Record<string, ChatUiScalar | Record<string, ChatUiScalar>>;
  };
  /** Original StatusBar3.img/chat section names retained for source tracing. */
  common?: Record<string, unknown>;
  outside?: Record<string, unknown>;
  ingame?: Record<string, unknown>;
  'combo:emoticon'?: Record<string, ChatUiScalar>;
}
export interface DamageNumberSet {
  first: Record<string, AssetFrame>;
  rest: Record<string, AssetFrame>;
}
export interface CombatAssets {
  attack?: { afterimage?: AfterimageAsset };
  /** Mob.wz hit1 already contains the source-backed impact slash; this sound is its matching Sound.wz cue. */
  hit?: { sound?: string; soundSource?: string };
  damageNumbers?: {
    normal: DamageNumberSet;
    critical?: DamageNumberSet;
    /** HP 恢复用的绿色数字集（源 `Effect/BasicEff.img/NoProduction*`）。
     *  源里 `NoProduction` 的 `0`/`1` 是同一批字节（只有一个字号），
     *  所以拼多位数时首位与后续会取到同一帧，这是照实呈现而不是丢了一半。 */
    recoverHp?: DamageNumberSet;
    /** MP 恢复与魔心防禦扣魔用的蓝色数字集（源 `Effect/BasicEff.img/NoBlue*`）。 */
    recoverMp?: DamageNumberSet;
  };
}
// AvatarActionSet 定义在 ./avatar-types（见文件头 re-export）。
export interface AvatarEquipmentLoadout {
  itemIds: string[];
  actions: AvatarActionSet;
}
export type SkillArt = Pick<AssetFrame, 'url' | 'x' | 'y' | 'width' | 'height'>;
export interface SkillCatalogEntry {
  id: string; bookId: string; name: string; description: string;
  maxLevel: number; prerequisites: Record<string, number>;
  hidden: boolean;
  hyper?: number; requiredLevel?: number;
  icons: { normal?: SkillArt; disabled?: SkillArt; mouseOver?: SkillArt };
  levelDescriptions?: string[];
  levelValues?: { level: number; mpCon: number; damage: number; mobCount: number; attackCount: number }[];
}
/**
 * Source-backed buff plate and the quick-slot fold keys.
 *
 * `ui` is flat and keyed exactly like the WZ tree (`favoriteBuff/nw`,
 * `quickSlot/button:Fold/pressed/0`).  `layout.spaceX` / `layout.spaceY` are the
 * authored icon spacings from `BuffSetting/favoriteBuff` (5 px in TMS273.7) —
 * they are read from the source rather than chosen by the client.
 */
export interface BuffUiData {
  contentVersion?: string;
  source?: string;
  ui: Record<string, AssetFrame>;
  layout: { spaceX: number; spaceY: number };
}
export interface SkillWindowData {
  width: number; height: number;
  backgrounds: Record<string, SkillArt>;
  cells: Record<string, SkillArt>;
  skillPoint: SkillArt;
  tabs: Record<'enabled' | 'disabled' | 'selected', SkillArt[]>;
  buttons: Record<string, Record<string, SkillArt>>;
}
/** One source-backed miniMap canvas plus the authored world rectangle it
 *  covers.  The rectangle is `[xMin, xMin + width] x [yMin, yMin + height]`,
 *  which is exactly the range the exporter derived from `centerX`/`centerY`:
 *  canvas pixel (0,0) is the rectangle's top-left corner. */
export interface MiniMapMapAsset {
  mapId: string;
  url: string;
  /** Canvas pixels — the natural size the original window draws. */
  width: number;
  height: number;
  world: { xMin: number; yMin: number; width: number; height: number };
  centerX: number;
  centerY: number;
  /** Source magnification hint, kept for tracing: 4 on every assembled map. */
  mag: number | null;
  /** `info/mapMark` — the town badge name (`MapHelper.img/mark/<mark>`) drawn
   *  on the MaxMap corner plate, or `'None'` when the source authors none. */
  mark: string;
  source?: string;
  resolvedSource?: string;
}
export interface MiniMapFont { family: string; size: number; color: string; alpha: number }
/** Authored window layout read straight out of `UI/UIMap.img/MiniMap`. */
export interface MiniMapLayout {
  /** `MinMap/minWidth` — the authored minimum window width. */
  minWidth: number;
  /** `buttonInterval` — the authored button pitch, in pixels. */
  buttonInterval: number;
  /** `vector:left` / `vecotr:right` (the typo is the source's own). */
  docks: { left: Point; right: Point };
  mapName: Point;
  streetName: Point;
  mapMark: Point;
  minStreetName: Point;
  minInterval: number;
  fonts: { mapName: MiniMapFont; streetName: MiniMapFont };
  /** The NPC 目录 window: name text offset inside a row, the 18 px row pitch
   *  and the authored list rectangle (listLT..listRB inside the 184x286 panel). */
  npcList: { namePos: Point; rowHeight: number; listLT: Point; listRB: Point };
}
/** Source-backed UI/UIMap.img/MiniMap window used by the minimap.
 *  `maps` is keyed by map id and only holds maps whose source authors a
 *  `miniMap` node; `missing` records the ones that do not. */
export interface MiniMapUiData {
  contentVersion: string;
  source: string;
  maps: Record<string, MiniMapMapAsset>;
  missing: { mapId: string; name: string; reason: string }[];
  /** Flat keys mirroring the WZ layout: `MaxMap/nw`, `BtMap/normal`,
   *  `button:small/pressed`, `Min/c` … */
  ui: Record<string, AssetFrame>;
  icons: {
    /** `iconNpc/0` — the one NPC marker the local client's semantics establish. */
    npc: AssetFrame;
    /** `iconPortal/0` — same for portals. */
    portal: AssetFrame;
    /** `iconDirection/<compass>` — the player's own arrow, one frame per
     *  facing.  The source authors four frames per facing and all four
     *  `_outlink` to the same PNG, so the arrow does not animate. */
    direction: Record<string, AssetFrame>;
    /** `iconNavi/0` — the chevron the original draws over the NPC a player
     *  picked in the NPC 目录 window. */
    navi?: AssetFrame;
    /** `MapHelper.img/mark/<name>` town badges, keyed by `info/mapMark`. */
    marks?: Record<string, AssetFrame>;
    /** `npcList/icon/<flavour>` — the NPC 目录 row icons.  The local snapshot
     *  does not classify NPCs into the authored flavours (U), so the window
     *  draws every row with `npc`. */
    npcList?: Record<string, AssetFrame>;
  };
  /** The authored button tooltips (`BtMap/toolTip`, `BtNpc/toolTip`), used
   *  verbatim for zh like the source map names. */
  tooltips?: Record<string, string>;
  layout: MiniMapLayout;
}
/** One `MapList` entry: a group of maps plus the page point its marker is drawn
 *  at.  `spot` is authored relative to `BaseImg`'s origin, so a spot at (x, y)
 *  lands at `(origin.x + x, origin.y + y)` inside the page canvas. */
export interface WorldMapSpot {
  spot: Point;
  /** `MapList/<n>/type` — the authored group kind, kept for tracing. */
  type: number;
  /** `MapList/<n>/mapNo/*` — every map id this group covers. */
  mapIds: string[];
}
/** One `MapLink` entry: the clickable region plate and the page it opens. */
export interface WorldMapLink {
  toolTip: string;
  /** `link/linkMap` — the page this plate navigates to, or null when the source
   *  authors no target (the plate is then drawn but inert). */
  page: string | null;
  /** `link/linkImg` — placed so its own `origin` lands on `BaseImg`'s origin. */
  image: AssetFrame;
}
/** One authored page of the world-map tree. */
export interface WorldMapPage {
  page: string;
  /** `info/parentMap` — the page this one is opened from; null on the root. */
  parent: string | null;
  /** `info/WorldMap` — the page's own authored name. */
  name: string;
  baseImg: AssetFrame;
  mapList: WorldMapSpot[];
  mapLinks: WorldMapLink[];
}
/** Source-backed Map.wz WorldMap pages plus the `UI/UIWindow2.img/WorldMap`
 *  window shell used by the world-map window.  Only the pages that can show an
 *  assembled map (and their ancestors) are exported. */
/** Source-backed UI/UIWindow4.img 冒险笔记（图鉴）window art.  Exported by
 *  `scripts/export_tms273_collection.cjs`, assembled by `assemble_tms273.cjs`. */
export interface NotebookUiData {
  contentVersion: string;
  source: string;
  /** The two source panels the window reuses. */
  panels: Record<'monster' | 'item', string>;
  /** The button states the source authors (`notAvailable` is collection-only). */
  states: string[];
  /** The reused UITotalMenu entry — its machine identity, never its label. */
  menu: { key: string; type: number; x: number; y: number; label: string; source: string };
  /** `<panel>/<path>` → frame. */
  frames: Record<'monster' | 'item', Record<string, AssetFrame>>;
  /** The authored scalars of each panel (counters, tooltip boxes, button ids). */
  values: Record<'monster' | 'item', Record<string, unknown>>;
}
export interface WorldMapUiData {
  contentVersion: string;
  source: string;
  /** The authored root page name (`WorldMap`). */
  root: string;
  pages: Record<string, WorldMapPage>;
  ui: {
    /** `UIWindow2.img/WorldMap/Border/0` — the 654x537 window plate. */
    border: AssetFrame;
    /** `UIMExplorer.img/worldMap/#mapImage` — the current-location plate. */
    plate: AssetFrame;
    /** `UIMExplorer.img/worldMap/btClose` — four states. */
    close: Record<string, AssetFrame>;
    /** `UIWindow2.img/WorldMap/BtBefore|BtNext|BtAll` — four states each. */
    nav: {
      before: Record<string, AssetFrame>;
      next: Record<string, AssetFrame>;
      all: Record<string, AssetFrame>;
    };
  };
  /** Every page in the archive, so "not exported" is distinguishable from
   *  "does not exist" without opening the WZ again. */
  allPages: string[];
}
export interface Manifest {
  appearanceCatalog?: AppearanceCatalog;
  contentVersion: string;
  map: MapDefinition;
  mapCatalog?: MapCatalog;
  controls?: ControlGuide[];
  avatar: { defaultFacing: -1 | 1; actions: AvatarActionSet; equipmentLoadouts?: Record<string, AvatarEquipmentLoadout>; attackSound?: string };
  monsters?: GameplayAssets['monsters']; items?: GameplayAssets['items']; hud?: GameplayAssets['hud']; drops?: GameplayAssets['drops'];
  combat?: CombatAssets;
  skillWindow?: SkillWindowData;
  skillBooks?: Record<string, { name: string; tabIndex: number }>;
  skillCatalog?: Record<string, SkillCatalogEntry>;
  levelUp?: { layers: AssetFrame[][]; sound?: { url: string; source: string } };
  skillEffects?: Record<string, { start?: AssetFrame[]; repeat?: AssetFrame[]; end?: AssetFrame[]; tile0?: AssetFrame[]; affected?: AssetFrame[]; effect?: AssetFrame[]; hit?: AssetFrame[]; ball?: AssetFrame[]; tile?: AssetFrame[]; mob?: AssetFrame[]; prepare?: AssetFrame[]; keydown?: AssetFrame[]; keydown0?: AssetFrame[]; keydownend?: AssetFrame[]; special?: AssetFrame[]; special0?: AssetFrame[]; effect0?: AssetFrame[]; summonStand?: AssetFrame[]; summonMove?: AssetFrame[]; summonAttack?: AssetFrame[] }>;
  bossEffects?: Record<string, Record<string, AssetFrame[]>>;
  skillSounds?: Record<string, { special?: { url: string; source: string }; use?: { url: string; source: string }; hit?: { url: string; source: string }; loop?: { url: string; source: string }; end?: { url: string; source: string }; summonAttack?: { url: string; source: string } }>;
  characterUi?: Record<string, SkillArt>;
  characterLayout?: Record<string, { x: number; y: number }>;
  npcQuestAvailable?: { frames: AssetFrame[] };
  chatUi?: ChatUi;
  chatBalloon?: ChatBalloonData;
  /** Source-backed UIWindow.img/Item subtree, keyed relative to Item. */
  inventoryUi?: Record<string, AssetFrame>;
  equipmentUi?: Record<string, AssetFrame>;
  inventoryLayout?: InventoryLayout;
  equipmentLayout?: EquipmentLayout;
  /** Source-backed Basic.img/BtClose states used by item windows. */
  closeButton?: Record<string, AssetFrame>;
  /** Source-backed Basic.img/Tab2 nine-slice pieces used by Item tabs. */
  tabUi?: Record<string, AssetFrame>;
  /** Source-backed Basic.img/Notice/backgrnd used by the death notice. */
  noticeUi?: Record<string, AssetFrame>;
  /** Source-backed Basic.img/BtOK states used by notices. */
  okButton?: Record<string, AssetFrame>;
  /** Source-backed TMS273.7 pet-management window and entry buttons. */
  petUi?: PetUiData;
  /** Source-backed UIWindow.img/GameMenu entries. */
  gameMenuUi?: Record<string, AssetFrame>;
  /** Source-backed UIWindow.img/ShortCut entries. */
  shortcutUi?: Record<string, AssetFrame>;
  totalMenuUi?: Record<string, AssetFrame>;
  totalMenuEntries?: { key: string; label: string; type: number; x: number; y: number }[];
  questUi?: Record<string, AssetFrame>;
  questLayout?: { listLT: Point; listRB: Point };
  /** Source-backed UI/StatusBar3.img/BuffSetting/favoriteBuff plate (behind the
   *  on-screen buff icons) plus the authored quick-slot fold keys.  Flat keys
   *  mirror the WZ layout: `favoriteBuff/{nw,n,ne,w,c,e,sw,s,se}` and
   *  `quickSlot/button:{Extend,Fold}/{normal,mouseOver,pressed,disabled}/0`. */
  keybindingsUi?: {
    source: string;
    background: AssetFrame;
    keyPositions: Record<string, Point>;
    keys: Record<string, AssetFrame>;
    buttons: Record<string, AssetFrame>;
  };
  buffUi?: BuffUiData;
  /** Source-backed Npc.wz stand frames, keyed by template id. */
  npcs?: Record<string, NpcAsset>;
  /** Source-backed TMS273 pets, keyed by pet item id (5000000+). */
  pets?: Record<string, PetAsset>;
  /** Source-backed TMS273 ride pets (`Character/TamingMob/<8位>.img/info/icon`),
   *  keyed by the item id without leading zeros (matching `shared/mounts.json`).
   *  Ride pets are not in `items.json`, so the inventory icon lookup chain is
   *  `items → pets → mounts`.  Exported by export_tms273_mount_icons.cjs. */
  mounts?: Record<string, AssetFrame>;
  /** Per-item scene JSON; textures are loaded only while riding or seated. */
  rideScenes?: {
    mounts: Record<string, { url?: string; status?: string; reason?: string }>;
    chairs: Record<string, { url?: string; status?: string; reason?: string }>;
  };
  /** Source-backed UIWindow.img/Shop entries used by the buy/sell window. */
  shopUi?: Record<string, AssetFrame>;
  /** Source-backed UI/CashShop.img window art used by the 現金商店 window:
   *  the 1024x768 shell (`backgrnd`/`backgrnd2`/`noItem`), one sidebar sprite
   *  per category (`tab:<id>` — each bakes the whole sidebar with a different
   *  row highlighted), `BtExit`/`BtBuy`/`Bt_magnifier` button states and the
   *  `effect:<label>` overlays.  Exported by export_tms273_cashshop.cjs. */
  cashshopUi?: Record<string, AssetFrame>;
  /** Source-backed per-item info/icon frames for every shippable cash-shop
   *  commodity, keyed by the 8-digit item id.  Kept apart from the gameplay
   *  `items` tree so the two catalogs never fight over one id space. */
  cashItems?: Record<string, AssetFrame>;
  /** Source-backed UIWindow.img/Trunk entries used by the account-warehouse
   *  window.  Flat keys (`backgrnd`, `select`, `BtGet/normal`,
   *  `Tab/enabled/0`) mirror the shop convention. */
  storageUi?: StorageUiData;
  /** Source-backed UIWindow.img/UserList (Party tab) entries used by the party
   *  window.  Flat keys mirror the WZ layout (`backgrnd`, `BtKick/normal`). */
  partyUi?: PartyUiData;
  /** Source-backed UIWindow.img/UserList (Friend + BlackList tabs) entries
   *  used by the friend window.  Flat keys mirror the WZ layout
   *  (`backgrnd`, `Tab/enabled/0`, `BlackList/BtAdd/normal`). */
  friendUi?: FriendUiData;
  /** Source-backed UI/UIWindow4.img 怪物收藏 (`monsterCollection`) and 物品圖鑑
   *  (`itemCollection`) window art used by the 冒险笔记（图鉴）window.
   *  `frames` is keyed `<panel>/<path>`, so the monster panel's region tabs are
   *  `monster/Category/Enable/0` and the item panel's 94x94 slot plates are
   *  `item/category/itemComplete` / `item/category/itemIncomplete`.  The
   *  catalogue half is *not* here: it ships as `/assets/notebook.json` with the
   *  quest section deliberately withheld (plan §12.2), and is fetched only when
   *  the window first opens. */
  notebook?: NotebookUiData;
  /** Source-backed UI/ChatEmoticon.img: the 表情 sticker catalogue and the 表情
   *  window shell used by the emoticon window. */
  emoticon?: EmoticonData;
  /** Source-backed UtilDlgEx dialog pieces used by npc conversation boxes. */
  dialogUi?: Record<string, AssetFrame>;
  /** Source-backed Map.wz/MapHelper.img/portal/editor sprites per portal entry. */
  portals?: Record<string, PortalAsset>;
  /** Source-backed interactive map props (Reactor.wz + Map.wz placements). */
  reactors?: ReactorData;
  /** Source-backed UI/UIMap.img/MiniMap window plus one Map.wz miniMap canvas
   *  per assembled map.  PNGs are exported by export_tms273_minimap.cjs. */
  miniMap?: MiniMapUiData;
  /** Source-backed Map.wz WorldMap pages plus the UIWindow2 window shell used
   *  by the world-map window.  PNGs are exported by export_tms273_worldmap.cjs. */
  worldMap?: WorldMapUiData;
}
export function mapFrameAt(frames: readonly Pick<AssetFrame, 'delay'>[], elapsed: number): number {
  const delays = frames.map(frame => frame.delay);
  if (!delays.length || delays.some(delay => !Number.isFinite(delay) || delay <= 0)) {
    throw new Error('地图动画帧 delay 必须为正数');
  }
  return frameAt(delays, elapsed, true);
}
export function mapFramePosition(
  layer: Pick<MapLayer, 'x' | 'y' | 'origin' | 'flip' | 'frames'>,
  frame: Pick<AssetFrame, 'origin' | 'width' | 'height'>,
): Point {
  const firstOrigin = layer.frames?.[0]?.origin ?? layer.origin ?? { x: 0, y: 0 };
  const anchorX = layer.x + firstOrigin.x;
  const anchorY = layer.y + firstOrigin.y;
  return {
    x: layer.flip ? anchorX + frame.origin.x - frame.width : anchorX - frame.origin.x,
    y: anchorY - frame.origin.y,
  };
}
export function actorDepthForLayers(layers: readonly Pick<MapLayer, 'depth' | 'background'>[]): number {
  let maxBackDepth = -Infinity;
  for (const layer of layers) {
    if (layer.background?.front) continue;
    if (Number.isFinite(layer.depth)) maxBackDepth = Math.max(maxBackDepth, layer.depth);
  }
  return Number.isFinite(maxBackDepth) ? maxBackDepth + 1 : 1;
}
export async function loadManifest(): Promise<Manifest> {
  // 清单与外观目录经 resource-url 解析（普通刷新＝恒等；仅修复代数会改传输地址）。
  // 内容寻址索引与清单一并并行取：索引决定后面两万多个资源走不走强缓存
  // （v3 §4.1），而它是**可选增强**——`loadAssetIndex` 自己吞掉全部失败并退回
  // 恒等解析，所以索引缺失不会拖垮登录（v3 §5.3 / §6.1）。
  const [response] = await Promise.all([
    fetch(resolveAssetUrl('/assets/manifest.json')),
    loadAssetIndex(),
  ]);
  if (!response.ok) throw new Error(`资源清单加载失败 /assets/manifest.json (${response.status})`);
  const manifest = await response.json() as Manifest;
  installWindbellMaps(manifest);
  if (manifest.contentVersion !== CONTENT_VERSION) throw new Error(`资源版本不一致，需要 ${CONTENT_VERSION}`);
  for (const action of ['stand', 'walk', 'jump', 'attack'] as const) {
    if (!manifest.avatar.actions[action]?.length || manifest.avatar.actions[action].some(frame => !(frame.delay > 0) || !frame.parts.length)) throw new Error(`动作资源缺失或时长无效：${action}`);
  }
  for (const map of [manifest.map, ...(manifest.mapCatalog?.maps ?? [])]) {
    for (const layer of map.layers ?? []) if (layer.frames?.length) mapFrameAt(layer.frames, 0);
  }
  const appearances = await fetch(resolveAssetUrl('/assets/entry/appearance.json'));
  if (!appearances.ok) throw new Error('角色外观资源加载失败，请刷新重试。');
  manifest.appearanceCatalog = await appearances.json();
  return manifest;
}
