import type { Manifest } from './manifest';

/** 一条音频预加载项；`skipIfCached` 保留原实现的 BGM 缓存短路。 */
export interface PreloadAudio {
  key: string;
  url: string;
  skipIfCached?: boolean;
}

/** 从 manifest 收集的完整预加载计划（纯数据，无 Phaser 依赖）。 */
export interface PreloadPlan {
  /** 保序去重的图片清单；key 与 url 相同（与原实现一致）。 */
  images: Array<{ key: string; url: string }>;
  /** 有序音频清单（levelUp → 技能 → BGM → 普攻 → 受击 → 怪物受击）。 */
  audio: PreloadAudio[];
}

/**
 * 全量预加载计划（计划 §10.3：`assets/preload-plan.ts`）。
 *
 * 从 `World.preload`（R8 前为 `scenes/world.ts` 的收集段）逐行搬出：
 * 策略仍是**全量预加载**——不懒加载、不改顺序、不去重语义。所有帧的
 * url 先进一个保序 Map 去重，音频按原顺序排列；BGM 的
 * `cache.audio.exists` 短路依赖 Phaser 运行时缓存，由 Scene 执行。
 */
export function buildPreloadPlan(manifest: Manifest): PreloadPlan {
  const images = new Map<string, string>();
  const maps = [manifest.map, ...(manifest.mapCatalog?.maps ?? [])];
  for (const map of maps) for (const layer of map.layers ?? []) {
    images.set(layer.url, layer.url);
    for (const frame of layer.frames ?? []) images.set(frame.url, frame.url);
  }
  const avatarActions = [manifest.avatar.actions, ...Object.values(manifest.avatar.equipmentLoadouts ?? {}).map(loadout => loadout.actions)];
  for (const actions of avatarActions) for (const frames of Object.values(actions)) for (const frame of frames) for (const part of frame.parts) images.set(part.url, part.url);
  const appearances = manifest.appearanceCatalog;
  const appearanceActions = appearances ? [
    ...Object.values(appearances.base).map(layer => layer.actions),
    ...Object.values(appearances.layers).flatMap(layer => [layer.actions, ...Object.values(layer.actionsByGender ?? {})]),
  ] : [];
  for (const actions of appearanceActions) for (const frames of Object.values(actions)) for (const frame of frames) for (const part of frame.parts) images.set(part.url, part.url);
  for (const monster of Object.values(manifest.monsters ?? {})) for (const frames of Object.values(monster.actions)) for (const frame of frames) images.set(frame.url, frame.url);
  for (const frame of Object.values(manifest.items ?? {})) images.set(frame.url, frame.url);
  for (const npc of Object.values(manifest.npcs ?? {})) for (const frame of npc.stand) images.set(frame.url, frame.url);
  for (const pet of Object.values(manifest.pets ?? {})) {
    for (const frame of [pet.icon, ...pet.stand, ...pet.move, ...pet.jump]) images.set(frame.url, frame.url);
  }
  for (const frame of manifest.npcQuestAvailable?.frames ?? []) images.set(frame.url, frame.url);
  for (const portal of Object.values(manifest.portals ?? {})) {
    for (const frame of portal.frames ?? []) images.set(frame.url, frame.url);
  }
  for (const template of Object.values(manifest.reactors?.templates ?? {})) {
    for (const state of Object.values(template.states)) {
      for (const frame of [...state.frames, ...state.hitFrames]) images.set(frame.url, frame.url);
    }
  }
  // The account-warehouse shell and buttons are DOM-rendered, but preloading
  // them here keeps them on the same cache as the rest of the UI art and
  // lets the window open without a flash of missing sprites.
  for (const frame of Object.values(manifest.storageUi?.ui ?? {})) images.set(frame.url, frame.url);
  // The party window's shell, row markers and buttons are DOM-rendered too.
  for (const frame of Object.values(manifest.partyUi?.ui ?? {})) images.set(frame.url, frame.url);
  // Same for the friend & blacklist window, which shares the UserList shell.
  for (const frame of Object.values(manifest.friendUi?.ui ?? {})) images.set(frame.url, frame.url);
  // And the world map: its pages are large authored canvases, so warming them
  // here is what keeps the WORLD button from flashing empty art.
  for (const page of Object.values(manifest.worldMap?.pages ?? {})) {
    images.set(page.baseImg.url, page.baseImg.url);
    for (const link of page.mapLinks) images.set(link.image.url, link.image.url);
  }
  for (const frame of Object.values(manifest.worldMap?.ui.plate ? { plate: manifest.worldMap.ui.plate, border: manifest.worldMap.ui.border } : {})) images.set(frame.url, frame.url);
  for (const states of Object.values(manifest.worldMap?.ui.nav ?? {})) {
    for (const frame of Object.values(states)) images.set(frame.url, frame.url);
  }
  for (const frame of Object.values(manifest.worldMap?.ui.close ?? {})) images.set(frame.url, frame.url);
  const afterimage = manifest.combat?.attack?.afterimage;
  for (const frame of afterimage?.frames ?? []) images.set(frame.url, frame.url);
  for (const set of [manifest.combat?.damageNumbers?.normal, manifest.combat?.damageNumbers?.critical]) {
    for (const frame of [...Object.values(set?.first ?? {}), ...Object.values(set?.rest ?? {})]) images.set(frame.url, frame.url);
  }
  for (const set of Object.values(manifest.skillEffects ?? {})) {
    for (const frames of Object.values(set)) for (const frame of frames ?? []) images.set(frame.url, frame.url);
  }
  for (const groups of Object.values(manifest.bossEffects ?? {})) {
    for (const frames of Object.values(groups)) for (const frame of frames) images.set(frame.url, frame.url);
  }
  for (const frames of manifest.levelUp?.layers ?? []) for (const frame of frames) images.set(frame.url, frame.url);
  // Source-backed nine-slice + arrow for the map-chat bubble.  Each slice
  // is registered under its own URL key (matching the texture used by
  // PlayerView.showBubble), so loading is shared across all characters.
  if (manifest.chatBalloon) {
    for (const slice of Object.values(manifest.chatBalloon.slices)) images.set(slice.url, slice.url);
  }
  // Chat emoticons: the window shell is DOM-rendered, but the *head*
  // animation plays inside the scene, so every sticker's frames have to be on
  // the Phaser texture cache before the first `emoticonMessage` arrives —
  // otherwise the first sticker anybody shows would render with no texture.
  for (const frame of Object.values(manifest.emoticon?.ui ?? {})) images.set(frame.url, frame.url);
  for (const group of manifest.emoticon?.groups ?? []) images.set(group.icon.url, group.icon.url);
  for (const sticker of manifest.emoticon?.stickers ?? []) {
    images.set(sticker.icon.url, sticker.icon.url);
    for (const frame of sticker.frames) images.set(frame.url, frame.url);
  }

  const audio: PreloadAudio[] = [];
  if (manifest.levelUp?.sound) audio.push({ key: manifest.levelUp.sound.url, url: manifest.levelUp.sound.url });
  for (const url of new Set(Object.values(manifest.skillSounds ?? {}).flatMap(set => [set.use?.url, set.hit?.url, set.loop?.url, set.end?.url, set.special?.url, set.summonAttack?.url]).filter((url): url is string => Boolean(url)))) {
    audio.push({ key: url, url });
  }
  for (const url of new Set(maps.map(map => map.bgm).filter((url): url is string => Boolean(url)))) {
    audio.push({ key: url, url, skipIfCached: true });
  }
  if (manifest.avatar.attackSound) audio.push({ key: 'attack', url: manifest.avatar.attackSound });
  if (manifest.combat?.hit?.sound) audio.push({ key: 'combat-hit', url: manifest.combat.hit.sound });
  for (const monster of Object.values(manifest.monsters ?? {})) {
    if (monster.damageSound) audio.push({ key: `mob-hit-${monster.templateId}`, url: monster.damageSound.url });
  }
  return { images: [...images].map(([key, url]) => ({ key, url })), audio };
}
