import type { Frame, Part, AvatarActionSet } from '../../assets/avatar-types';
import type { Appearance } from './api';

type AppearancePart = Part & { part: string; zName: string; itemId?: string };
interface AppearanceFrame extends Frame { parts: AppearancePart[] }
interface AppearanceLayer { id: number; part: string; islot: string; vslot: string; actions: Record<string, AppearanceFrame[]>; actionsByGender?: Record<string, Record<string, AppearanceFrame[]>> }
export interface AppearanceCatalog {
  sourceVersion: string;
  smap: Record<string, string>;
  base: Record<string, { actions: Record<string, AppearanceFrame[]> }>;
  layers: Record<string, AppearanceLayer>;
}
const slots = (value: string) => value.match(/.{2}/g) ?? [];
export function appearanceKey(look: Appearance, equipped: readonly { itemId: string }[]) {
  return `${look.gender}:${look.skin}:${look.face}:${look.hair}:${equipped.map(item => item.itemId).sort().join('+')}`;
}
export function initialEquipment(look: Appearance) {
  return [look.coat, look.pants, look.shoes, look.weapon].filter(Boolean).map(itemId => ({ itemId: String(itemId) }));
}
/** Compose exported pieces once per look/loadout; WZ already resolved every foot anchor. */
export function composeAppearance(catalog: AppearanceCatalog, look: Appearance, equipped: readonly { itemId: string }[]): AvatarActionSet | undefined {
  const base = catalog.base[String(look.gender)];
  const face = catalog.layers[`face:${look.face}`];
  const hair = catalog.layers[`hair:${look.hair}`];
  // Legacy characters retain the previous complete paper-doll when their look predates this catalogue.
  if (!base || !face || !hair) return;
  const gear = equipped.map(item => catalog.layers[item.itemId]).filter((layer): layer is AppearanceLayer => Boolean(layer));
  const hiddenSlots = new Set(gear.flatMap(layer => slots(layer.vslot)));
  const visible = (part: AppearancePart) => !slots(catalog.smap[part.zName] ?? '').some(slot => hiddenSlots.has(slot));
  const actions: Record<string, AppearanceFrame[]> = {};
  for (const [action, frames] of Object.entries(base.actions)) {
    actions[action] = frames.map((frame, index) => {
      const layerParts = (layer: AppearanceLayer) => {
        const source = (layer.actionsByGender?.[String(look.gender)] ?? layer.actions)[action];
        return source?.[index]?.parts ?? [];
      };
      const parts = [...frame.parts.filter(visible), ...layerParts(face).filter(visible), ...layerParts(hair).filter(visible), ...gear.flatMap(layerParts)];
      return { ...frame, parts: parts.sort((a, b) => b.z - a.z) };
    });
  }
  actions.climb = actions.ladder;
  actions.dead = actions.stand;
  return actions as unknown as AvatarActionSet;
}
