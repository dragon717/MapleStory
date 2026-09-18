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
 * 首屏预加载计划（计划 §10.3：`assets/preload-plan.ts`）。
 *
 * **2026-09-18：从「全量预加载」改成「首屏必需集」。** 原先本函数把整份 manifest
 * 入队（实测 22,594 张图 / 387MB），其中**当前地图只占 92 张（0.4%）**，而宠物
 * 7,850 张、其余 198 张地图 4,461 张、表情贴纸 3,727 张、物品图标 2,454 张在
 * 进图那一刻基本用不到。「开始游戏 → 100%」实测 26.1s，瓶颈是客户端逐张建纹理
 * （服务端同批文件实测 6,000 req/s，不是它慢）。
 *
 * 现在只入队**当场就要画**的东西，其余类别改由 `assets/lazy-texture.ts` 在第一次
 * 真正要画它时装载（见 `DEFERRED_CATEGORIES`）。判断标准是「这一帧没有它会不会
 * 画错」：地图图层、自己的角色、战斗数字、已经打开或随时会弹的界面窗口 ⇒ 入队；
 * 「出现得晚一两帧完全看不出来」的（怪物、NPC、宠物、掉落物、表情贴纸、别的地图）
 * ⇒ 按需。
 *
 * 保持不变的两条语义：
 *   - 所有帧的 url 先进一个保序 Map 去重，音频按原顺序排列；
 *   - 尺寸/顺序不参与判据，重复 url 只入队一次（与原实现一致）。
 *   BGM 的 `cache.audio.exists` 短路依赖 Phaser 运行时缓存，由 Scene 执行。
 */

/**
 * 首屏**不**装载、改由 `lazy-texture.ts` 按需装载的类别（键名对应 manifest 字段）。
 *
 * 这张表是给检查与后来者看的：往这里加类别，就必须在绘制点补上
 * `ensureTextures(...)`；反过来，删掉某个类别的按需装载也要在这里删掉，
 * 否则门禁会失败（`preload-plan.check.mjs` 双向盯着）。
 */
export const DEFERRED_CATEGORIES = [
  'mapCatalog.maps（只装载当前地图，其余地图在切图时由 scene.restart 重新 preload）',
  'skillEffects（施法事件到达时由 features/combat/view.ts 装载；占首屏字节的 90%）',
  'pets（宠物被召唤时才画）',
  'monsters（怪物进快照时才画）',
  'npcs（NPC 进快照时才画）',
  'items（掉落物落地时才画；界面里的图标是 DOM <img>，不走 Phaser 纹理）',
  'emoticon（贴纸在有人发这条表情时才画）',
] as const;

export function buildPreloadPlan(manifest: Manifest): PreloadPlan {
  const images = new Map<string, string>();
  // 只入队**当前地图**：切图走 `switchMap` → `scene.restart()` → 本函数用新的
  // `manifest.map` 再跑一遍，所以别的地图在真正成为「当前地图」时才装载。
  const maps = [manifest.map];
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
  // 以下类别改成按需装载（见 DEFERRED_CATEGORIES）：
  //   manifest.mapCatalog.maps   → 切图时随新的 manifest.map 装载
  //   manifest.monsters          → 怪物进快照时（world.ts 的 updateGameplayEntities）
  //   manifest.items             → 掉落物落地时（同上；界面图标走 DOM）
  //   manifest.npcs              → NPC 进快照时（world.ts 的 updateNpcs）
  //   manifest.pets              → 宠物被召唤时（同上）
  //   manifest.emoticon          → 有人发这条贴纸时（world.ts 的 emoticonMessage）
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
  // 技能特效（`manifest.skillEffects`）改成按需装载：实测整本 1,327 张 / 115.6MB，
  // 占首屏集字节的 90%，而一次施法只用到其中一条技能。装载点在
  // `features/combat/view.ts` 的事件入口（receive）+ 绘制前兜底（spawnSkillVisual）。
  // `bossEffects`（26 张 / 0.1MB）留在首屏：BOSS 练习场是随时可能进的状态。
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
  // 表情：窗口外壳是 DOM 渲染的，贴纸的「头」动效才在场景里播，而且只有有人
  // *真的发*这条贴纸时才播 —— 所以整类改成按需（world.ts 的 emoticonMessage）。

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
