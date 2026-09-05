import { CONTENT_VERSION } from '../../../shared/protocol';
export interface Point { x: number; y: number }
export interface Part { key: string; url: string; x: number; y: number; origin: Point; z: number; map?: Record<string, Point> }
export interface Frame { delay: number; parts: Part[] }
export interface Background { x: number; y: number; rx: number; ry: number; cx: number; cy: number; type: number; front: number; ani: number; f: number }
export interface AssetFrame {
  url: string; width: number; height: number; origin: Point; x: number; y: number; delay: number;
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
export interface Manifest {
  contentVersion: string;
  map: { id: string; name: string; bounds: { xMin: number; xMax: number; yMin: number; yMax: number }; layers: { key: string; url: string; x: number; y: number; origin?: Point; depth: number; alpha?: number; flip?: boolean; type?: number; background?: Background }[]; ladders?: { id: number; l: number; uf: number; x: number; y1: number; y2: number; page: number }[]; bgm?: string };
  avatar: { defaultFacing: -1 | 1; actions: Record<'stand' | 'walk' | 'jump' | 'attack', Frame[]> & Partial<Record<'climb' | 'ladder' | 'rope' | 'dead', Frame[]>>; attackSound?: string };
  monsters?: GameplayAssets['monsters']; items?: GameplayAssets['items']; hud?: GameplayAssets['hud']; drops?: GameplayAssets['drops'];
  /** Source-backed UIWindow.img/Item subtree, keyed relative to Item. */
  inventoryUi?: Record<string, AssetFrame>;
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
