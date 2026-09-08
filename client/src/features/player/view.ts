import Phaser from 'phaser';
import type { PlayerState } from '../../../../shared/protocol';
import { actorDepthForLayers, assetFrameAlpha } from '../../assets/manifest';
import type { AssetFrame, AvatarActionSet, Manifest } from '../../assets/manifest';
import { frameAt } from './animation';
import { appearanceKey, composeAppearance } from '../entry/appearance';

const supportedEquipment = new Set(['1002067', '1040002', '1052095', '1302000']);
type SkillAction = 'skill2001008' | 'skill2001011' | 'skill2001012' | 'skill2201008' | 'skill2201005' | 'skill2201001';
type SkillFrames = AvatarActionSet['stand'];

export class PlayerView {
  readonly body: Phaser.GameObjects.Container;
  private name: Phaser.GameObjects.Text;
  private signature = '';
  private highestLevel?: number;
  private levelUpStartedAt = 0;
  private levelUpImages: { frames: AssetFrame[]; image: Phaser.GameObjects.Image }[] = [];
  private levelUpSound?: Phaser.Sound.BaseSound;
  private appearanceCache?: { key: string; actions: AvatarActionSet };
  private climbFrame = 0;
  /** Hurt-flash window (scene clock ms). White double-flash while active. */
  private flashStartedAt = 0;
  private flashUntil = 0;
  private flashWhite = false;
  private skillAction?: SkillAction;
  private skillActionStartedAt = 0;
  private skillActionUntil = 0;
  /** Feet-to-head offset of the current rendered frame, for damage numbers. */
  private headOffsetY = -40;
  constructor(private scene: Phaser.Scene, private manifest: Manifest, username: string, self: boolean) {
    // ponytail: one map layer for actors; add explicit actorDepth when a map needs foreground occlusion.
    const depth = actorDepthForLayers(manifest.map.layers);
    this.body = scene.add.container(0, 0).setDepth(depth);
    this.name = scene.add.text(0, 0, username, { fontFamily: 'Verdana, sans-serif', fontSize: '12px', color: self ? '#fff3a5' : '#ffffff', backgroundColor: '#25322bd9', padding: { x: 6, y: 3 } }).setOrigin(0.5, 0).setDepth(depth + 1);
  }
  /** Begin the server-driven hurt presentation: white double-flash while the
   *  authoritative knockback slide runs. Positions themselves come from
   *  snapshots, so only the flash needs to be local. */
  hitFeedback(durationMs = 420) {
    const now = this.scene.time.now;
    this.skillAction = undefined;
    this.flashStartedAt = now;
    this.flashUntil = now + durationMs;
  }
  /** Vertical feet→head offset (negative) for anchoring damage numbers. */
  headAnchorYOffset() {
    return this.headOffsetY;
  }
  /** Play a source-exported spell pose for the authoritative server duration. */
  startSkill(skillId: number, durationMs: number) {
    const action = skillId === 2001008 ? 'skill2001008'
      : skillId === 2001011 ? 'skill2001011'
        : skillId === 2001012 ? 'skill2001012'
          : skillId === 2201008 ? 'skill2201008'
            : skillId === 2201005 ? 'skill2201005'
              : skillId === 2201001 ? 'skill2201001' : undefined;
    if (!action || !Number.isFinite(durationMs) || durationMs <= 0) return;
    this.skillAction = action;
    this.skillActionStartedAt = this.scene.time.now;
    this.skillActionUntil = this.skillActionStartedAt + durationMs;
    this.signature = '';
  }
  update(player: PlayerState, elapsed: number) {
    if (player.hp <= 0 || player.action === 'dead') this.skillAction = undefined;
    let loadout = this.equipmentLoadout(player.equipped);
    if (player.appearance && this.manifest.appearanceCatalog) {
      const key = appearanceKey(player.appearance, player.equipped ?? []);
      if (this.appearanceCache?.key !== key) {
        const actions = composeAppearance(this.manifest.appearanceCatalog, player.appearance, player.equipped ?? []);
        this.appearanceCache = actions ? { key, actions } : undefined;
      }
      if (this.appearanceCache) loadout = this.appearanceCache;
    }
    const actions = loadout.actions as AvatarActionSet & Partial<Record<SkillAction, SkillFrames>>;
    // The server state includes climb/dead. Keep those actions data-driven:
    // use their exported frames when present, otherwise hold the authoritative
    // state while rendering the closest source-backed stand frame.
    const skillActive = this.skillAction !== undefined && this.scene.time.now < this.skillActionUntil;
    if (!skillActive) this.skillAction = undefined;
    const renderAction = skillActive && this.skillAction && actions[this.skillAction]?.length
      ? this.skillAction
      : player.action === 'climb' ? this.climbAsset(player, actions) : player.action;
    const candidate = actions[renderAction];
    const frames = candidate?.length ? candidate : actions.stand;
    let index: number;
    if (player.action === 'climb' && player.vy === 0) {
      index = Math.min(this.climbFrame, frames.length - 1);
    } else {
      const animationElapsed = skillActive ? Math.max(0, this.scene.time.now - this.skillActionStartedAt) : elapsed;
      index = frameAt(frames.map(frame => frame.delay), animationElapsed, skillActive ? false : player.action !== 'attack');
      if (player.action === 'climb') this.climbFrame = index;
    }
    if (player.action !== 'climb') this.climbFrame = 0;
    const signature = `${loadout.key}:${renderAction}:${index}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.body.removeAll(true);
      const parts = [...frames[index].parts].sort((a, b) => b.z - a.z);
      for (const part of parts) {
        const image = this.scene.add.image(part.x, part.y, part.url).setOrigin(0);
        // A rebuild mid-flash must re-apply the white tint to the fresh
        // children; updateFlash() only runs on state changes.
        if (this.flashWhite) image.setTintFill(0xffffff);
        this.body.add(image);
      }
      // Source frames anchor the feet at y=0 and grow upward (negative y),
      // so the sprite top is the smallest part y. Present damage numbers just
      // above the head, mirroring MonsterView.hitAnchor.
      const top = parts.reduce((lowest, part) => Math.min(lowest, part.y), 0);
      this.headOffsetY = Math.round(Math.min(top, -1) - 2);
    }
    this.body.setPosition(Math.round(player.x), Math.round(player.y)).setScale(player.facing === this.manifest.avatar.defaultFacing ? 1 : -1, 1);
    this.name.setPosition(Math.round(player.x), Math.round(player.y + 8));
    this.updateFlash();
    this.updateLevelFeedback(player);
  }
  private updateLevelFeedback(player: PlayerState) {
    const level = player.level;
    if (!Number.isSafeInteger(level) || level < 1) return;
    const increased = this.highestLevel !== undefined && level > this.highestLevel;
    this.highestLevel = Math.max(this.highestLevel ?? level, level);
    const now = this.scene.time.now;
    if (increased) {
      this.clearLevelFeedback();
      this.levelUpStartedAt = now;
      for (const frames of this.manifest.levelUp?.layers ?? []) {
        if (!frames.length) continue;
        const image = this.scene.add.image(0, 0, frames[0].url).setOrigin(0).setDepth(this.body.depth + 2);
        this.levelUpImages.push({ frames, image });
      }
      const url = this.manifest.levelUp?.sound?.url;
      if (url && this.scene.cache.audio.exists(url)) {
        const sound = this.scene.sound.add(url);
        this.levelUpSound = sound;
        sound.once('complete', () => { if (this.levelUpSound === sound) this.levelUpSound = undefined; sound.destroy(); });
        if (!sound.play({ volume: 0.35 })) { sound.destroy(); this.levelUpSound = undefined; }
      }
    }
    const elapsed = Math.max(0, now - this.levelUpStartedAt);
    for (let i = this.levelUpImages.length - 1; i >= 0; i--) {
      const { frames, image } = this.levelUpImages[i];
      const duration = frames.reduce((sum, frame) => sum + frame.delay, 0);
      if (elapsed >= duration) { image.destroy(); this.levelUpImages.splice(i, 1); continue; }
      const index = frameAt(frames.map(frame => frame.delay), elapsed, false);
      const frame = frames[index];
      const frameElapsed = elapsed - frames.slice(0, index).reduce((sum, value) => sum + value.delay, 0);
      image.setTexture(frame.url).setPosition(Math.round(player.x - frame.origin.x), Math.round(player.y - frame.origin.y))
        .setAlpha(assetFrameAlpha(frame, frameElapsed));
    }
  }
  private clearLevelFeedback() {
    for (const { image } of this.levelUpImages) image.destroy();
    this.levelUpImages = [];
    this.levelUpSound?.destroy();
    this.levelUpSound = undefined;
  }
  private updateFlash() {
    const now = this.scene.time.now;
    // 90 ms white, 90 ms normal, repeated until the knockback window ends.
    const white = now < this.flashUntil && (now - this.flashStartedAt) % 180 < 90;
    if (white === this.flashWhite) return;
    this.flashWhite = white;
    for (const child of this.body.list) {
      const image = child as Phaser.GameObjects.Image;
      if (white) image.setTintFill(0xffffff);
      else image.clearTint();
    }
  }
  private equipmentLoadout(equipped: PlayerState['equipped']): { key: string; actions: AvatarActionSet } {
    // Old snapshots have no equipped field. Keep the original starter look
    // until the server sends an authoritative list; an explicit empty list
    // selects the exported empty equipment loadout.
    if (equipped === undefined) return { key: 'starter', actions: this.manifest.avatar.actions };
    if (equipped.length === 0) {
      const empty = this.manifest.avatar.equipmentLoadouts?.empty;
      return empty ? { key: 'empty', actions: empty.actions } : { key: 'starter', actions: this.manifest.avatar.actions };
    }
    const ids = new Set(equipped.map(item => item.itemId).filter(itemId => supportedEquipment.has(itemId)));
    // A regular coat and a longcoat occupy the same body slot. The server
    // rejects both at once; prefer the longcoat defensively for stale snapshots.
    if (ids.has('1052095')) ids.delete('1040002');
    if (ids.size === 0) return { key: 'starter', actions: this.manifest.avatar.actions };
    const key = [...ids].sort().join('+');
    const loadout = this.manifest.avatar.equipmentLoadouts?.[key];
    return loadout ? { key, actions: loadout.actions } : { key: 'starter', actions: this.manifest.avatar.actions };
  }
  private climbAsset(player: PlayerState, actions: AvatarActionSet): 'ladder' | 'rope' | 'climb' {
    const link = player.ladderId === null ? undefined : this.manifest.map.ladders?.find(ladder => ladder.id === player.ladderId);
    if (!link) return actions.climb?.length ? 'climb' : 'ladder';
    return link.l === 1 ? 'ladder' : 'rope';
  }
  destroy() { this.clearLevelFeedback(); this.skillAction = undefined; this.body.destroy(); this.name.destroy(); }
}
