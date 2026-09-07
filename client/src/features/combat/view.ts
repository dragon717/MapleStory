import Phaser from 'phaser';
import type { AssetFrame, CombatAssets } from '../../assets/manifest';
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
}

export type CombatEvent = CombatActionStartedEvent | AuthoritativeDamageEvent;

type Slash = {
  event: CombatActionStartedEvent;
  startedAtMs: number;
  sprite: Phaser.GameObjects.Image;
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
  private readonly damageNumbers = new Set<Phaser.GameObjects.Container>();
  private readonly seen = new Set<string>();

  /** `hitSoundKey` must be the key used by World.preload for manifest.combat.hit.sound. */
  constructor(
    private readonly scene: Phaser.Scene,
    private readonly assets: CombatAssets | undefined,
    private readonly depth: number,
    private readonly clock: () => number = nowMs,
    private readonly hitSoundKey = 'combat-hit',
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
    // A null hitSoundKey silences the cue: players taking monster contact
    // damage have no source-backed hit cue, so do not reuse the mob-hit cue.
    if (hitSoundKey && this.scene.sound && this.scene.cache.audio.exists(hitSoundKey)) this.scene.sound.play(hitSoundKey, { volume: 0.28 });
    this.spawnDamageNumber(event);
  }

  receive(event: CombatEvent) {
    if (event.type === 'actionStarted') this.receiveActionStarted(event);
    else this.receiveDamageEvent(event);
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
  }

  clear() {
    for (const slash of this.slashes) slash.sprite.destroy();
    this.slashes.length = 0;
    for (const number of this.damageNumbers) {
      this.scene.tweens.killTweensOf(number);
      number.destroy();
    }
    this.damageNumbers.clear();
    this.seen.clear();
  }

  destroy() { this.clear(); }

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
}
