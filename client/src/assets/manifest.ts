import { CONTENT_VERSION } from '../../../shared/protocol';
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
  alpha?: number; flip?: boolean; type?: number; background?: Background;
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
  index?: number;
  source?: string; resolvedSource?: string; map?: Record<string, Point>; lt?: Point | null; rb?: Point | null;
}
export interface MonsterAsset {
  templateId: string; source: string; info: Record<string, number | string>;
  actions: Record<'stand' | 'move' | 'hit' | 'die', AssetFrame[]>;
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
export type AvatarActionSet = Record<'stand' | 'walk' | 'jump' | 'attack', Frame[]> & Partial<Record<'climb' | 'ladder' | 'rope' | 'dead', Frame[]>>;
export interface AvatarEquipmentLoadout {
  itemIds: string[];
  actions: AvatarActionSet;
}
export interface Manifest {
  contentVersion: string;
  map: MapDefinition;
  mapCatalog?: MapCatalog;
  controls?: ControlGuide[];
  avatar: { defaultFacing: -1 | 1; actions: AvatarActionSet; equipmentLoadouts?: Record<string, AvatarEquipmentLoadout>; attackSound?: string };
  monsters?: GameplayAssets['monsters']; items?: GameplayAssets['items']; hud?: GameplayAssets['hud']; drops?: GameplayAssets['drops'];
  combat?: CombatAssets;
  /** Source-backed UIWindow.img/Item subtree, keyed relative to Item. */
  inventoryUi?: Record<string, AssetFrame>;
  equipmentUi?: Record<string, AssetFrame>;
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
}
export async function loadManifest(): Promise<Manifest> {
  const response = await fetch('/assets/manifest.json');
  if (!response.ok) throw new Error(`资源清单加载失败 /assets/manifest.json (${response.status})`);
  const manifest = await response.json() as Manifest;
  if (manifest.contentVersion !== CONTENT_VERSION) throw new Error(`资源版本不一致，需要 ${CONTENT_VERSION}`);
  for (const action of ['stand', 'walk', 'jump', 'attack'] as const) {
    if (!manifest.avatar.actions[action]?.length || manifest.avatar.actions[action].some(frame => !(frame.delay > 0) || !frame.parts.length)) throw new Error(`动作资源缺失或时长无效：${action}`);
  }
  return manifest;
}
