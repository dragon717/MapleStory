import type { Frame, Part, AvatarActionSet } from '../../assets/avatar-types';
import type { Appearance } from './api';

type AppearancePart = Part & { part: string; zName: string; itemId?: string };
interface AppearanceFrame extends Frame { parts: AppearancePart[] }
export interface AppearanceLayer {
  id: number;
  itemId?: string;
  part: string;
  islot: string;
  vslot: string;
  actions: Record<string, AppearanceFrame[]>;
  actionsByGender?: Record<string, Record<string, AppearanceFrame[]>>;
  /** Cash weapons carry one authored action tree per weapon type. */
  actionsByWeaponType?: Record<string, Record<string, AppearanceFrame[]>>;
  actionsByWeaponTypeByGender?: Record<string, Record<string, Record<string, AppearanceFrame[]>>>;
  weaponType?: string;
  weaponGroups?: string[];
  /** Cash layers are registered by the caller when their URLs are loaded. */
  lazy?: boolean;
  cash?: boolean;
}
export interface CashAppearanceIndexEntry {
  itemId: string;
  id: number;
  part: string;
  islot: string;
  vslot: string;
  source: string;
  url: string;
  cash: true;
  lazy: true;
  weaponGroups?: string[];
  sourceWeaponGroups?: string[];
  weaponType?: string;
}
export interface CashAppearanceIndex {
  contentVersion: string;
  sourceVersion: string;
  source: string;
  weaponTypes?: string[];
  items: Record<string, CashAppearanceIndexEntry>;
  skipped?: { itemId: string; reason: string; supportedWeaponTypes?: string[] }[];
}
export interface AppearanceCatalog {
  sourceVersion: string;
  smap: Record<string, string>;
  base: Record<string, { actions: Record<string, AppearanceFrame[]> }>;
  layers: Record<string, AppearanceLayer>;
  /** Source-backed cash equipment, intentionally excluded from first preload. */
  cashLayers?: Record<string, AppearanceLayer>;
  /** Lightweight index for the per-item cash appearance files. */
  cashAppearance?: CashAppearanceIndex;
}
const slots = (value: string) => value.match(/.{2}/g) ?? [];
/** Canonical item spelling shared by new cash rows and legacy 7-digit saves. */
export function normalizeAppearanceItemId(itemId: string | number) {
  const raw = String(itemId).trim();
  return /^\d+$/.test(raw) ? raw.padStart(8, '0') : raw;
}

/**
 * Resolve the source weapon branch for an ordinary equipment id.  Cash ids
 * are deliberately excluded by the caller because their numeric family is a
 * catalogue id, not a WZ weapon branch (for example 01702087 is not branch
 * 20).  The 130–159 families are the weapon families present in the local
 * TMS273 item source; the optional index narrows that to branches exported by
 * the current cash appearance catalogue.
 */
export function appearanceWeaponTypeForItemId(
  itemId: string | number,
  supportedWeaponTypes?: readonly (string | number)[],
) {
  const numeric = Number(String(itemId).trim());
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return undefined;
  const family = Math.floor(numeric / 10_000);
  if (family < 130 || family > 159) return undefined;
  const branch = String(family % 100);
  if (supportedWeaponTypes && !supportedWeaponTypes.map(String).includes(branch)) return undefined;
  return branch;
}

function layerCandidates(itemId: string | number) {
  const raw = String(itemId).trim();
  const canonical = normalizeAppearanceItemId(raw);
  const legacy = /^\d+$/.test(raw) ? String(Number(raw)) : raw;
  return [...new Set([raw, canonical, legacy])];
}

/** Resolve an appearance layer across the padded cash and legacy keys. */
export function appearanceLayer(catalog: AppearanceCatalog, itemId: string | number) {
  const keys = layerCandidates(itemId);
  // A padded id in the cash index identifies a cosmetic item even when its
  // unpadded spelling happens to collide with a gameplay layer key.
  const cashKeys = keys.filter(key => catalog.cashAppearance?.items[key] || catalog.cashLayers?.[key]);
  for (const key of cashKeys) {
    const layer = catalog.cashLayers?.[key];
    if (layer) return layer;
  }
  // An indexed cash id is intentionally absent until its JSON is loaded. Do
  // not fall through to a coincidentally equal gameplay id and show the wrong
  // outfit while the request is in flight.
  if (cashKeys.length) return undefined;
  for (const layers of [catalog.layers, catalog.cashLayers ?? {}]) {
    for (const key of keys) {
      const layer = layers[key];
      if (layer) return layer;
    }
  }
  return undefined;
}

/** Resolve a lazy cash index row across padded and legacy item spellings. */
export function cashAppearanceEntry(catalog: AppearanceCatalog, itemId: string | number) {
  const items = catalog.cashAppearance?.items ?? {};
  for (const key of layerCandidates(itemId)) {
    const entry = items[key];
    if (entry) return entry;
  }
  return undefined;
}

/**
 * Infer the actor's actual weapon branch before composing a cash weapon.
 * Equipped cash ids never participate in this calculation; the ordinary
 * weapon in slot 11 wins, then the persisted creation/look weapon is used.
 * This prevents a single-branch cash item from silently changing a mage's
 * wand/staff (or another class's weapon) during preview or world rendering.
 */
export function appearanceWeaponType(
  catalog: AppearanceCatalog,
  equipped: readonly { itemId: string; slot?: number }[],
  lookWeapon?: string | number,
) {
  const supported = catalog.cashAppearance?.weaponTypes;
  const candidates = [
    ...equipped.filter(item => item.slot === 11 || item.slot === -11).map(item => item.itemId),
    ...(lookWeapon === undefined ? [] : [lookWeapon]),
  ];
  for (const itemId of candidates) {
    if (cashAppearanceEntry(catalog, itemId)) continue;
    const branch = appearanceWeaponTypeForItemId(itemId, supported);
    if (branch) return branch;
  }
  return undefined;
}

export function appearanceKey(look: Appearance, equipped: readonly { itemId: string }[]) {
  return `${look.gender}:${look.skin}:${look.face}:${look.hair}:${equipped.map(item => normalizeAppearanceItemId(item.itemId)).sort().join('+')}`;
}
export function initialEquipment(look: Appearance) {
  return [look.coat, look.pants, look.shoes, look.weapon].filter(Boolean).map(itemId => ({ itemId: String(itemId) }));
}
export interface AppearanceComposeOptions {
  /** IDs whose lazy cash textures have been loaded into the scene cache. */
  loadedItemIds?: readonly (string | number)[];
  /** The player's actual source-backed TMS273 weapon branch (for example 30, 31, 32, 37, or 38). */
  weaponType?: string | number;
}

function layerActions(layer: AppearanceLayer, gender: number, weaponType?: string | number) {
  const genderKey = String(gender);
  const byGender = layer.actionsByWeaponTypeByGender?.[genderKey];
  const byType = byGender ?? layer.actionsByWeaponType;
  if (byType) {
    const requested = weaponType === undefined ? layer.weaponType : String(weaponType);
    if (requested !== undefined) return byType[String(requested)] ?? {};
    return {};
  }
  return layer.actionsByGender?.[genderKey] ?? layer.actions;
}

function layerIsLoaded(layer: AppearanceLayer, options: AppearanceComposeOptions) {
  if (!layer.lazy) return true;
  // `loadAppearanceLayer` installs a complete layer in this cache.  Treating
  // cache presence as loaded keeps callers from having to maintain a second
  // list of ids; loadedItemIds remains available for immutable catalog users.
  if (options.loadedItemIds === undefined && layer.cash) return true;
  if (!options.loadedItemIds) return false;
  const ids = new Set(options.loadedItemIds.map(normalizeAppearanceItemId));
  return ids.has(normalizeAppearanceItemId(layer.itemId ?? layer.id));
}

function layerFrames(layer: AppearanceLayer, action: string, index: number, gender: number, weaponType?: string | number) {
  const actions = layerActions(layer, gender, weaponType);
  // Every action must use its own authored body anchors.  Falling back to
  // stand here would place an outfit on the wrong hand/neck during a skill.
  const frames = actions[action];
  if (!frames?.length) return [];
  return frames[Math.min(index, frames.length - 1)]?.parts ?? [];
}

/** Fetch and register one complete cash appearance layer on demand. */
export async function loadAppearanceLayer(
  catalog: AppearanceCatalog,
  itemId: string | number,
  fetcher: typeof fetch = fetch,
): Promise<AppearanceLayer | undefined> {
  const existing = catalog.cashLayers && appearanceLayer(catalog, itemId);
  if (existing?.cash) return existing;
  const entry = cashAppearanceEntry(catalog, itemId);
  if (!entry) return undefined;
  const response = await fetcher(entry.url);
  if (!response.ok) throw new Error(`角色外观资源加载失败 ${entry.itemId} (${response.status})`);
  const layer = await response.json() as AppearanceLayer;
  if (!layer.cash || normalizeAppearanceItemId(layer.itemId ?? layer.id) !== normalizeAppearanceItemId(entry.itemId)) {
    throw new Error(`角色外观资源校验失败 ${entry.itemId}`);
  }
  catalog.cashLayers ??= {};
  catalog.cashLayers[entry.itemId] = layer;
  return layer;
}

/** Load several equipped/preview items concurrently, preserving input order. */
export async function loadAppearanceLayers(
  catalog: AppearanceCatalog,
  itemIds: readonly (string | number)[],
  fetcher: typeof fetch = fetch,
) {
  return Promise.all(itemIds.map(itemId => loadAppearanceLayer(catalog, itemId, fetcher)));
}

/** URLs needed before composing a selected lazy cash layer. */
export function appearanceAssetUrls(
  catalog: AppearanceCatalog,
  look: Appearance,
  equipped: readonly { itemId: string }[],
  options: Pick<AppearanceComposeOptions, 'weaponType'> = {},
) {
  const urls = new Set<string>();
  for (const item of equipped) {
    const layer = appearanceLayer(catalog, item.itemId);
    if (!layer?.lazy) continue;
    const actions = layerActions(layer, look.gender, options.weaponType);
    for (const frames of Object.values(actions)) for (const frame of frames) {
      for (const part of frame.parts) urls.add(part.url);
    }
  }
  return [...urls];
}

/** Compose exported pieces once per look/loadout; WZ already resolved every foot anchor. */
export function composeAppearance(
  catalog: AppearanceCatalog,
  look: Appearance,
  equipped: readonly { itemId: string }[],
  options: AppearanceComposeOptions = {},
): AvatarActionSet | undefined {
  const base = catalog.base[String(look.gender)];
  const face = catalog.layers[`face:${look.face}`];
  const hair = catalog.layers[`hair:${look.hair}`];
  // Legacy characters retain the previous complete paper-doll when their look predates this catalogue.
  if (!base || !face || !hair) return;
  const gear = equipped.map(item => appearanceLayer(catalog, item.itemId))
    .filter((layer): layer is AppearanceLayer => {
      if (!layer) return false;
      return layerIsLoaded(layer, options);
    });
  const hiddenSlots = new Set(gear.flatMap(layer => slots(layer.vslot)));
  const visible = (part: AppearancePart) => !slots(catalog.smap[part.zName] ?? '').some(slot => hiddenSlots.has(slot));
  const actions: Record<string, AppearanceFrame[]> = {};
  for (const [action, frames] of Object.entries(base.actions)) {
    actions[action] = frames.map((frame, index) => {
      const layerParts = (layer: AppearanceLayer) => {
        return layerFrames(layer, action, index, look.gender, options.weaponType);
      };
      const parts = [...frame.parts.filter(visible), ...layerParts(face).filter(visible), ...layerParts(hair).filter(visible), ...gear.flatMap(layerParts)];
      return { ...frame, parts: parts.sort((a, b) => b.z - a.z) };
    });
  }
  actions.climb = actions.ladder;
  actions.dead = actions.stand;
  return actions as unknown as AvatarActionSet;
}
