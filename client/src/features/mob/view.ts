import Phaser from 'phaser';
import type { AssetFrame, MonsterAsset, Point } from '../../assets/manifest';
import { frameAt } from '../player/animation';
import type { BossPracticeState } from '../../../../shared/protocol';
import { pickupMotion } from './pickup-motion';

export interface MonsterSnapshot {
  id: string;
  templateId: string;
  x: number;
  y: number;
  facing: -1 | 1;
  hp: number;
  maxHp: number;
  action: 'stand' | 'move' | 'hit' | 'freeze' | 'die' | 'attack1' | 'attack2' | 'skill1';
  freezeStacks?: number;
  actionStartedTick: number;
}

/** Renders one server-owned mob without keeping a second gameplay state. */
export class MonsterView {
  private readonly sprite: Phaser.GameObjects.Image;
  private readonly freezeSprite?: Phaser.GameObjects.Image;
  private signature = '';
  private freezeSignature = '';
  private currentFrame?: AssetFrame;
  private bossSprites = new Map<string, Phaser.GameObjects.Image>();

  constructor(private scene: Phaser.Scene, private asset: MonsterAsset, depth: number, private freezeFrames: AssetFrame[] = [], private bossFrames: Record<string, Record<string, AssetFrame[]>> = {}) {
    const first = asset.actions.stand[0];
    this.sprite = scene.add.image(0, 0, first.url).setOrigin(0).setDepth(depth);
    const freezeFirst = freezeFrames[0];
    if (freezeFirst) this.freezeSprite = scene.add.image(0, 0, freezeFirst.url).setOrigin(0).setDepth(depth + 1).setVisible(false);
  }

  update(monster: MonsterSnapshot, elapsed: number) {
    // The server's freeze action is a state, not a source mob action. Keep
    // the monster's stand pose and layer the source-backed freeze effect over
    // it instead of looking up a fabricated `actions.freeze` animation.
    const frames = monster.action === 'freeze' ? this.asset.actions.stand : this.asset.actions[monster.action] ?? this.asset.actions.stand;
    if (!frames.length) {
      this.sprite.setVisible(false);
      this.freezeSprite?.setVisible(false);
      return;
    }
    const index = frameAt(frames.map(frame => frame.delay), elapsed, monster.action === 'stand' || monster.action === 'move' || monster.action === 'freeze');
    const frame = frames[index];
    this.currentFrame = frame;
    const signature = `${monster.action}:${index}:${frame.url}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.sprite.setTexture(frame.url);
    }
    const flipped = monster.facing === 1 && !Number(this.asset.info.noFlip ?? 0);
    this.sprite.setVisible(true)
      // Exported mob canvases face left in their source orientation. Phaser flips
      // the image box, so reflect the source origin around its right edge.
      .setPosition(Math.round(flipped ? monster.x - frame.x - frame.width : monster.x + frame.x), Math.round(monster.y + frame.y))
      .setFlipX(flipped);

    this.updateFreeze(monster, elapsed);
  }

  private updateFreeze(monster: MonsterSnapshot, elapsed: number) {
    const sprite = this.freezeSprite;
    if (!sprite || monster.action !== 'freeze' || !this.freezeFrames.length) {
      sprite?.setVisible(false);
      return;
    }
    const group = Math.max(0, Math.min(4, Math.max(1, Math.floor(monster.freezeStacks ?? 1)) - 1));
    const grouped = this.freezeFrames.filter(frame => frame.source?.match(/\/mob\/(\d+)\//)?.[1] === String(group));
    const frames = grouped.length ? grouped : this.freezeFrames;
    const index = frameAt(frames.map(frame => frame.delay), elapsed, true);
    const frame = frames[index];
    if (!frame) return;
    const signature = `${group}:${index}:${frame.url}`;
    if (signature !== this.freezeSignature) {
      this.freezeSignature = signature;
      sprite.setTexture(frame.url);
    }
    const flipped = monster.facing === 1 && !Number(this.asset.info.noFlip ?? 0);
    sprite.setVisible(true)
      .setPosition(Math.round(flipped ? monster.x - frame.x - frame.width : monster.x + frame.x), Math.round(monster.y + frame.y))
      .setFlipX(flipped);
  }

  /** Source head anchor of the currently displayed stance, like Mob::get_head_position. */
  hitAnchor(monster: Pick<MonsterSnapshot, 'x' | 'y' | 'facing'>): Point {
    const frame = this.currentFrame ?? this.asset.actions.stand[0];
    const head = frame.head ?? { x: 0, y: 0 };
    const flipped = monster.facing === 1 && !Number(this.asset.info.noFlip ?? 0);
    return { x: Math.round(monster.x + (flipped ? -head.x : head.x)), y: Math.round(monster.y + head.y) };
  }

  updateBossEffects(monster: MonsterSnapshot, effects: BossPracticeState['effects'], sinceSnapshot: number) {
    const visible = new Set<string>();
    for (const effect of monster.hp > 0 ? effects ?? [] : []) {
      const elapsed = effect.elapsedMs + sinceSnapshot;
      if (effect.remainingMs <= sinceSnapshot) continue;
      const groups = this.bossFrames[String(effect.skillId)];
      if (!groups) continue;
      // P anchoring: source offsets follow the mob head. The identical effect/mob0
      // cast art plays once; the source defense icon persists with server status.
      for (const group of ['mob0', 'mob']) {
        const frames = groups[group];
        if (!frames?.length || (group === 'mob' && effect.skillId === 114)) continue;
        const duration = frames.reduce((sum, frame) => sum + frame.delay, 0);
        if (group === 'mob0' && elapsed >= duration) continue;
        const frame = frames[frameAt(frames.map(frame => frame.delay), elapsed, group === 'mob')];
        const key = `${effect.skillId}:${group}`;
        visible.add(key);
        let sprite = this.bossSprites.get(key);
        if (!sprite) {
          sprite = this.scene.add.image(0, 0, frame.url).setOrigin(0).setDepth(this.sprite.depth + 2);
          this.bossSprites.set(key, sprite);
        }
        const anchor = this.hitAnchor(monster);
        // Keep the two simultaneous defense icons readable without altering source art.
        const iconOffset = group === 'mob' ? (effect.skillId === 112 ? -12 : 12) : 0;
        sprite.setTexture(frame.url).setPosition(anchor.x + frame.x + iconOffset, anchor.y + frame.y);
      }
    }
    for (const [key, sprite] of this.bossSprites) {
      if (!visible.has(key)) { sprite.destroy(); this.bossSprites.delete(key); }
    }
  }

  destroy() {
    this.sprite.destroy(); this.freezeSprite?.destroy();
    for (const sprite of this.bossSprites.values()) sprite.destroy();
    this.bossSprites.clear();
  }
}

export interface DropSnapshot {
  id: string;
  itemId: string;
  quantity: number;
  x: number;
  y: number;
}

/** Renders a server-owned item icon at its world position. */
export class DropView {
  private readonly sprite: Phaser.GameObjects.Image;
  private frame: AssetFrame;
  private pickup?: { startedAt: number; start: Point; target: () => Point };

  constructor(scene: Phaser.Scene, frame: AssetFrame, depth: number) {
    this.frame = frame;
    this.sprite = scene.add.image(0, 0, frame.url).setOrigin(0).setDepth(depth);
  }

  update(drop: DropSnapshot) {
    if (this.pickingUp) return;
    this.sprite.setVisible(true)
      .setPosition(Math.round(drop.x + this.frame.x), Math.round(drop.y + this.frame.y));
  }

  get pickingUp() { return this.pickup !== undefined; }

  pickUp(target: () => Point) {
    if (this.pickingUp) return;
    this.pickup = { startedAt: performance.now(), start: { x: this.sprite.x, y: this.sprite.y }, target };
  }

  updatePickup() {
    if (!this.pickup) return false;
    const target = this.pickup.target();
    const pose = pickupMotion(this.pickup.start, {
      x: target.x - this.frame.width / 2,
      y: target.y - 24 - this.frame.height / 2,
    }, performance.now() - this.pickup.startedAt);
    this.sprite.setPosition(pose.x, pose.y).setAlpha(pose.alpha);
    return pose.done;
  }

  destroy() { this.sprite.destroy(); }
}
