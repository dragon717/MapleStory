import type { AppearanceCatalog } from '../features/entry/appearance';
import { CONTENT_VERSION } from '../../../shared/protocol.ts';
import { frameAt } from '../features/player/animation.ts';
export interface Point { x: number; y: number }
export interface Part {
  key: string;
  url: string;
  x: number;
  y: number;
  origin: Point;
  z: number;
  width?: number;
  height?: number;
  map?: Record<string, Point>;
  source?: string;
  resolvedSource?: string;
  anchor?: string;
}
export interface Frame { delay: number; parts: Part[] }
export interface Background { x: number; y: number; rx: number; ry: number; cx: number; cy: number; type: number; front: number; ani: number; f: number }
export interface MapBounds { xMin: number; xMax: number; yMin: number; yMax: number }
export interface MapLayer {
  key: string; url: string; x: number; y: number; origin?: Point; depth: number;
  alpha?: number; flip?: boolean; type?: number; background?: Background; frames?: AssetFrame[];
  source?: string; resolvedSource?: string; width?: number; height?: number;
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
  spawn?: MapSpawn; spawns?: MapSpawn[]; bgm?: string;
}
export interface AssetFrame {
  url: string; width: number; height: number; origin: Point; x: number; y: number; delay: number;
  index?: number; alpha?: number; a0?: number; a1?: number;
  source?: string; resolvedSource?: string; map?: Record<string, Point>; lt?: Point | null; rb?: Point | null; head?: Point | null;
}
export interface MonsterAsset {
  templateId: string; source: string; info: Record<string, number | string>;
  actions: Record<'stand' | 'move' | 'hit' | 'die', AssetFrame[]> & { jump?: AssetFrame[] };
  damageSound?: { url: string; source: string };
}
export interface NpcAsset {
  name: string; source: string; stand: AssetFrame[];
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
export interface ChatUiFrameStates {
  normal?: AssetFrame;
  pressed?: AssetFrame;
  disabled?: AssetFrame;
  mouseOver?: AssetFrame;
  checked?: AssetFrame;
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
  damageNumbers?: { normal: DamageNumberSet; critical?: DamageNumberSet };
}
export type AvatarActionSet = Record<'stand' | 'walk' | 'jump' | 'attack', Frame[]> & Partial<Record<'climb' | 'ladder' | 'rope' | 'dead' | 'skill2001008' | 'skill2001011' | 'skill2001012', Frame[]>>;
export interface AvatarEquipmentLoadout {
  itemIds: string[];
  actions: AvatarActionSet;
}
export type SkillArt = Pick<AssetFrame, 'url' | 'x' | 'y' | 'width' | 'height'>;
export interface SkillCatalogEntry {
  id: string; bookId: string; name: string; description: string;
  maxLevel: number; prerequisites: Record<string, number>;
  hidden: boolean;
  icons: { normal?: SkillArt; disabled?: SkillArt; mouseOver?: SkillArt };
  levelDescriptions?: string[];
  levelValues?: { level: number; mpCon: number; damage: number; mobCount: number; attackCount: number }[];
}
export interface SkillWindowData {
  width: number; height: number;
  backgrounds: Record<string, SkillArt>;
  cells: Record<string, SkillArt>;
  skillPoint: SkillArt;
  tabs: Record<'enabled' | 'disabled' | 'selected', SkillArt[]>;
  buttons: Record<string, Record<string, SkillArt>>;
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
  skillEffects?: Record<string, { effect?: AssetFrame[]; hit?: AssetFrame[]; ball?: AssetFrame[]; tile?: AssetFrame[]; mob?: AssetFrame[] }>;
  skillSounds?: Record<string, { use?: { url: string; source: string }; hit?: { url: string; source: string } }>;
  characterUi?: Record<string, SkillArt>;
  characterLayout?: Record<string, { x: number; y: number }>;
  npcQuestAvailable?: { frames: AssetFrame[] };
  chatUi?: ChatUi;
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
  /** Source-backed UIWindow.img/GameMenu entries. */
  gameMenuUi?: Record<string, AssetFrame>;
  /** Source-backed UIWindow.img/ShortCut entries. */
  shortcutUi?: Record<string, AssetFrame>;
  totalMenuUi?: Record<string, AssetFrame>;
  totalMenuEntries?: { key: string; label: string; type: number; x: number; y: number }[];
  questUi?: Record<string, AssetFrame>;
  questLayout?: { listLT: Point; listRB: Point };
  /** Source-backed Npc.wz stand frames, keyed by template id. */
  npcs?: Record<string, NpcAsset>;
  /** Source-backed UIWindow.img/Shop entries used by the buy/sell window. */
  shopUi?: Record<string, AssetFrame>;
  /** Source-backed UtilDlgEx dialog pieces used by npc conversation boxes. */
  dialogUi?: Record<string, AssetFrame>;
  /** Source-backed Map.wz/MapHelper.img/portal/editor sprites per portal entry. */
  portals?: Record<string, PortalAsset>;
}
export function mapFrameAt(frames: readonly Pick<AssetFrame, 'delay'>[], elapsed: number): number {
  const delays = frames.map(frame => frame.delay);
  if (!delays.length || delays.some(delay => !Number.isFinite(delay) || delay <= 0)) {
    throw new Error('地图动画帧 delay 必须为正数');
  }
  return frameAt(delays, elapsed, true);
}
export function assetFrameAlpha(frame: Pick<AssetFrame,'a0'|'a1'|'alpha'|'delay'>, elapsed: number): number {
  const start = frame.a0 ?? frame.alpha ?? 255, end = frame.a1 ?? start;
  const progress = Math.max(0, Math.min(1, elapsed / frame.delay));
  return Math.max(0, Math.min(1, (start + (end - start) * progress) / 255));
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
  const response = await fetch('/assets/manifest.json');
  if (!response.ok) throw new Error(`资源清单加载失败 /assets/manifest.json (${response.status})`);
  const manifest = await response.json() as Manifest;
  if (manifest.contentVersion !== CONTENT_VERSION) throw new Error(`资源版本不一致，需要 ${CONTENT_VERSION}`);
  for (const action of ['stand', 'walk', 'jump', 'attack'] as const) {
    if (!manifest.avatar.actions[action]?.length || manifest.avatar.actions[action].some(frame => !(frame.delay > 0) || !frame.parts.length)) throw new Error(`动作资源缺失或时长无效：${action}`);
  }
  for (const map of [manifest.map, ...(manifest.mapCatalog?.maps ?? [])]) {
    for (const layer of map.layers ?? []) if (layer.frames?.length) mapFrameAt(layer.frames, 0);
  }
  const appearances = await fetch('/assets/entry/appearance.json');
  if (!appearances.ok) throw new Error('角色外观资源加载失败，请刷新重试。');
  manifest.appearanceCatalog = await appearances.json();
  return manifest;
}
