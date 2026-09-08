import Phaser from 'phaser';
import type { AssetFrame, CombatAssets, Manifest } from '../../assets/manifest';
import { assetFrameAlpha } from '../../assets/manifest';
import { damageNumberAdvances } from './damage-number';
import { frameAt } from '../player/animation';

export type Facing = -1 | 1;

/** The server accepted an attack. It starts presentation only; it never implies a hit. */
export interface CombatActionStartedEvent {
  type: 'actionStarted';
  eventId?: string;
  playerId: string;
  actionId: string;
  serverTick: number;
  x: number;
  y: number;
  facing: Facing;
  /** Local receive time for deterministic late-event handling. */
  startedAtMs?: number;
}

/**
 * A damage result produced by the authoritative server.
 * The client only validates, deduplicates, and presents this value.
 */
export interface AuthoritativeDamageEvent {
  type: 'damageEvent';
  eventId: string;
  serverTick: number;
  attackerId?: string;
  targetId: string;
  x: number;
  y: number;
  damage: number;
  killed?: boolean;
  critical?: boolean;
  skillId?: number;
  segment?: number;
  targetCount?: number;
}

export interface SkillCastEvent {
  type: 'skillCast';
  eventId: string;
  serverTick: number;
  playerId: string;
  skillId: number;
  requestId: string;
  x: number;
  y: number;
  facing: Facing;
  durationMs: number;
  targetId?: string;
  targetX?: number;
  targetY?: number;
}

export type CombatEvent = CombatActionStartedEvent | AuthoritativeDamageEvent | SkillCastEvent;

type Slash = {
  event: CombatActionStartedEvent;
  startedAtMs: number;
  sprite: Phaser.GameObjects.Image;
};

type SkillVisual = {
  event: SkillCastEvent | AuthoritativeDamageEvent;
  frames: AssetFrame[];
  startedAtMs: number;
  sprite: Phaser.GameObjects.Image;
  loopMs?: number;
  travel?: { fromX: number; fromY: number; toX: number; toY: number };
};

function nowMs() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function validFacing(facing: number): facing is Facing {
  return facing === -1 || facing === 1;
}

function validPoint(x: number, y: number) {
  return Number.isFinite(x) && Number.isFinite(y);
}

function validFrame(frame: AssetFrame | undefined) {
  return Boolean(frame?.url && frame.width > 0 && frame.height > 0 && frame.delay > 0);
}

/** Renders source-backed combat presentation driven by server events. */
export class CombatView {
  private readonly slashes: Slash[] = [];
  private readonly skillVisuals: SkillVisual[] = [];
  private readonly damageNumbers = new Set<Phaser.GameObjects.Container>();
  private readonly seen = new Set<string>();
  private readonly skillAudio = new Map<Phaser.Sound.BaseSound, string>();

  /** `hitSoundKey` must be the key used by World.preload for manifest.combat.hit.sound. */
  constructor(
    private readonly scene: Phaser.Scene,
    private readonly assets: CombatAssets | undefined,
    private readonly depth: number,
    private readonly clock: () => number = nowMs,
    private readonly hitSoundKey = 'combat-hit',
    private readonly skillEffects: Manifest['skillEffects'],
    private readonly skillSounds?: Manifest['skillSounds'],
  ) {}

  /** Feed an already accepted action from the server's actionStarted message. */
  receiveActionStarted(event: CombatActionStartedEvent) {
    if (!event.playerId || !event.actionId || !Number.isFinite(event.serverTick) || !validPoint(event.x, event.y) || !validFacing(event.facing)) return;
    const id = `action:${event.eventId ?? `${event.playerId}:${event.actionId}:${event.serverTick}`}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);

    const afterimage = this.assets?.attack?.afterimage;
    if (!afterimage?.frames.length || !afterimage.frames.every(validFrame)) return;
    const first = afterimage.frames[0];
    if (!first) return;
    const sprite = this.scene.add.image(0, 0, first.url).setOrigin(0).setDepth(this.depth).setVisible(false);
    this.slashes.push({ event, startedAtMs: event.startedAtMs ?? this.clock(), sprite });
  }

  /**
   * Feed one authoritative damage result. `damage` is displayed verbatim;
   * this class never chooses a target or derives a damage amount.
   */
  receiveDamageEvent(event: AuthoritativeDamageEvent, hitSoundKey: string | null = this.hitSoundKey) {
    if (!event.eventId || !event.targetId || !Number.isFinite(event.serverTick) || !validPoint(event.x, event.y) || !Number.isFinite(event.damage) || event.damage <= 0) return;
    const id = `damage:${event.eventId}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.spawnSkillHit(event);
    // A null hitSoundKey silences the cue: players taking monster contact
    // damage have no source-backed hit cue, so do not reuse the mob-hit cue.
    if (hitSoundKey && this.scene.sound && this.scene.cache.audio.exists(hitSoundKey)) this.scene.sound.play(hitSoundKey, { volume: 0.28 });
    // P: one source Hit cue per target's first authoritative damage segment.
    if ((event.segment ?? 1) === 1 && event.skillId !== undefined) this.playSkillSound(event.attackerId, this.skillSounds?.[String(event.skillId)]?.hit?.url);
    this.spawnDamageNumber(event);
  }

  receive(event: CombatEvent) {
    if (event.type === 'actionStarted') this.receiveActionStarted(event);
    else if (event.type === 'skillCast') this.receiveSkillCast(event);
    else this.receiveDamageEvent(event);
  }

  /** Start source-backed skill VFX only after the server accepts the cast. */
  receiveSkillCast(event: SkillCastEvent): boolean {
    if (!event.eventId || !event.playerId || !Number.isFinite(event.serverTick) || !Number.isFinite(event.skillId)
      || !validPoint(event.x, event.y) || !validFacing(event.facing) || !Number.isFinite(event.durationMs) || event.durationMs < 0) return false;
    const id = `skill:${event.eventId}`;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    // A generated ice field reuses skillCast but is not another player cast.
    if (!(event.skillId === 2201009 && event.targetX !== undefined)) this.playSkillSound(event.playerId, this.skillSounds?.[String(event.skillId)]?.use?.url);
    const set = this.skillEffects?.[String(event.skillId)];
    if (event.skillId === 2201009 && set?.tile?.length && event.durationMs > 0
      && validPoint(event.targetX ?? NaN, event.targetY ?? NaN)) {
      const frames = set.tile.filter(frame => frame.source?.includes('/tile/1/'));
      if (frames.length && frames.every(validFrame)) {
        // P: repeat source tiles along the server's temporary field segment.
        const count = Math.min(64, Math.max(1, Math.ceil(Math.hypot(event.targetX! - event.x, event.targetY! - event.y) / frames[0].width)));
        for (let i = 0; i <= count; i++) this.spawnSkillVisual({ ...event,
          x: event.x + (event.targetX! - event.x) * i / count,
          y: event.y + (event.targetY! - event.y) * i / count,
        }, frames, undefined, event.durationMs);
      }
    }
    if (set?.effect?.length && set.effect.every(validFrame)) this.spawnSkillVisual(event, set.effect);
    // The server may provide the authoritative destination for a projectile.
    // Without it, keep the source cast aura and do not invent a hit location.
    if (set?.ball?.length && set.ball.every(validFrame) && validPoint(event.targetX ?? NaN, event.targetY ?? NaN)) {
      this.spawnSkillVisual(event, set.ball, {
        fromX: event.x, fromY: event.y, toX: event.targetX!, toY: event.targetY!,
      });
    }
    return true;
  }

  /** Advance source afterimage timing, opacity and per-frame origins. */
  update(time = this.clock()) {
    const afterimage = this.assets?.attack?.afterimage;
    if (afterimage) {
      for (let i = this.slashes.length - 1; i >= 0; i--) {
        const slash = this.slashes[i];
        const elapsed = time - slash.startedAtMs - afterimage.startMs;
        if (elapsed < 0) {
          slash.sprite.setVisible(false);
          continue;
        }
        const duration = afterimage.frames.reduce((sum, frame) => sum + frame.delay, 0);
        if (elapsed >= duration) {
          slash.sprite.destroy();
          this.slashes.splice(i, 1);
          continue;
        }
        const index = frameAt(afterimage.frames.map(frame => frame.delay), elapsed, false);
        const frame = afterimage.frames[index];
        if (!frame) continue;
        slash.sprite.setTexture(frame.url);
        const frameElapsed = elapsed - afterimage.frames.slice(0,index).reduce((sum,frame)=>sum+frame.delay,0);
        slash.sprite.setAlpha(assetFrameAlpha(frame, frameElapsed));
        const left = slash.event.facing === 1 ? slash.event.x - frame.x - frame.width : slash.event.x + frame.x;
        slash.sprite.setVisible(true)
          .setPosition(Math.round(left), Math.round(slash.event.y + frame.y))
          .setFlipX(slash.event.facing === 1);
      }
    }
    for (let i = this.skillVisuals.length - 1; i >= 0; i--) {
      const visual = this.skillVisuals[i];
      const elapsed = time - visual.startedAtMs;
      const duration = visual.frames.reduce((sum, frame) => sum + frame.delay, 0);
      if (elapsed >= (visual.loopMs ?? duration)) {
        visual.sprite.destroy();
        this.skillVisuals.splice(i, 1);
        continue;
      }
      const frameTime = visual.loopMs ? Math.max(0, elapsed) % duration : Math.max(0, elapsed);
      const index = frameAt(visual.frames.map(frame => frame.delay), frameTime, false);
      const frame = visual.frames[index];
      if (!frame) continue;
      const frameElapsed = frameTime - visual.frames.slice(0, index).reduce((sum, current) => sum + current.delay, 0);
      const base = visual.travel
        ? {
          x: visual.travel.fromX + (visual.travel.toX - visual.travel.fromX) * Math.min(1, elapsed / duration),
          y: visual.travel.fromY + (visual.travel.toY - visual.travel.fromY) * Math.min(1, elapsed / duration),
        }
        : { x: visual.event.x, y: visual.event.y };
      const facing = 'facing' in visual.event && validFacing(visual.event.facing) ? visual.event.facing : 1;
      const left = facing === 1 ? base.x - frame.x - frame.width : base.x + frame.x;
      visual.sprite.setTexture(frame.url).setAlpha(assetFrameAlpha(frame, frameElapsed)).setVisible(true)
        .setPosition(Math.round(left), Math.round(base.y + frame.y))
        .setFlipX(facing === 1);
    }
  }

  clear() {
    for (const sound of this.skillAudio.keys()) sound.destroy();
    this.skillAudio.clear();
    for (const slash of this.slashes) slash.sprite.destroy();
    this.slashes.length = 0;
    for (const visual of this.skillVisuals) visual.sprite.destroy();
    this.skillVisuals.length = 0;
    for (const number of this.damageNumbers) {
      this.scene.tweens.killTweensOf(number);
      number.destroy();
    }
    this.damageNumbers.clear();
    this.seen.clear();
  }

  /** Remove only one player's pending spell presentation on death/despawn. */
  clearSkillPlayer(playerId: string) {
    if (!playerId) return;
    for (const [sound, owner] of this.skillAudio) if (owner === playerId) { sound.destroy(); this.skillAudio.delete(sound); }
    for (let i = this.skillVisuals.length - 1; i >= 0; i--) {
      const visual = this.skillVisuals[i];
      const owner = 'playerId' in visual.event ? visual.event.playerId : visual.event.attackerId;
      if (owner !== playerId) continue;
      visual.sprite.destroy();
      this.skillVisuals.splice(i, 1);
    }
  }

  destroy() { this.clear(); }

  private playSkillSound(owner: string | undefined, key: string | undefined) {
    if (!owner || !key || !this.scene.cache.audio.exists(key)) return;
    const sound = this.scene.sound.add(key);
    this.skillAudio.set(sound, owner);
    const remove = () => { this.skillAudio.delete(sound); sound.destroy(); };
    sound.once('complete', remove);
    if (!sound.play({ volume: 0.28 })) remove();
  }

  private spawnDamageNumber(event: AuthoritativeDamageEvent) {
    const sets = this.assets?.damageNumbers;
    const critical = Boolean(event.critical && sets?.critical);
    const set = critical ? sets?.critical : sets?.normal;
    if (!set) return;
    const digits = String(event.damage);
    if (!/^\d+$/.test(digits)) return;

    const frames = [...digits].map((digit, index) => set[index === 0 ? 'first' : 'rest'][digit]);
    if (frames.some(frame => !validFrame(frame))) return;
    const advances = damageNumberAdvances(digits, Boolean(event.critical), Boolean(sets?.critical));
    const container = this.scene.add.container(Math.round(event.x), Math.round(event.y - 8)).setDepth(this.depth + 1);
    let cursor = -advances.reduce((sum, advance) => sum + advance, 0) / 2;
    frames.forEach((frame, index) => {
      const image = this.scene.add.image(0, 0, frame.url).setOrigin(0);
      const restIndex = index - 1;
      image.setPosition(Math.round(cursor + frame.x), Math.round(frame.y + (index > 0 ? (restIndex % 2 ? -2 : 2) : 0)));
      container.add(image);
      cursor += advances[index];
    });
    this.damageNumbers.add(container);
    this.scene.tweens.add({
      targets: container,
      y: container.y - 35,
      alpha: 0,
      duration: 650,
      ease: 'Sine.easeOut',
      onComplete: () => {
        this.damageNumbers.delete(container);
        container.destroy();
      },
    });
  }

  private spawnSkillHit(event: AuthoritativeDamageEvent) {
    if (event.skillId === undefined || !validPoint(event.x, event.y)) return;
    const frames = this.skillEffects?.[String(event.skillId)]?.hit;
    if (!frames?.length || !frames.every(validFrame)) return;
    this.spawnSkillVisual(event, frames);
  }

  private spawnSkillVisual(event: SkillCastEvent | AuthoritativeDamageEvent, frames: AssetFrame[], travel?: SkillVisual['travel'], loopMs?: number) {
    const first = frames[0];
    if (!first) return;
    const sprite = this.scene.add.image(0, 0, first.url).setOrigin(0).setDepth(this.depth).setVisible(false);
    this.skillVisuals.push({ event, frames, startedAtMs: this.clock(), sprite, travel, loopMs });
  }
}
