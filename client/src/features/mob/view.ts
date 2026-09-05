import Phaser from 'phaser';
import type { AssetFrame, MonsterAsset, Point } from '../../assets/manifest';
import { frameAt } from '../player/animation';
import { pickupMotion } from './pickup-motion';

export interface MonsterSnapshot {
  id: string;
  templateId: string;
  x: number;
  y: number;
  facing: -1 | 1;
  hp: number;
  maxHp: number;
  action: 'stand' | 'move' | 'hit' | 'die';
  actionStartedTick: number;
}

/** Renders one server-owned mob without keeping a second gameplay state. */
export class MonsterView {
  private readonly sprite: Phaser.GameObjects.Image;
  private signature = '';

  constructor(private scene: Phaser.Scene, private asset: MonsterAsset, depth: number) {
    const first = asset.actions.stand[0];
    this.sprite = scene.add.image(0, 0, first.url).setOrigin(0).setDepth(depth);
  }

  update(monster: MonsterSnapshot, elapsed: number) {
    const frames = this.asset.actions[monster.action] ?? this.asset.actions.stand;
    if (!frames.length) {
      this.sprite.setVisible(false);
      return;
    }
    const index = frameAt(frames.map(frame => frame.delay), elapsed, monster.action !== 'die');
    const frame = frames[index];
    const signature = `${monster.action}:${index}:${frame.url}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.sprite.setTexture(frame.url);
    }
    this.sprite.setVisible(true)
      // GMS83 mob canvases face left in their source orientation. Phaser flips
      // the image box, so reflect the source origin around its right edge.
      .setPosition(Math.round(monster.facing === 1 ? monster.x - frame.x - frame.width : monster.x + frame.x), Math.round(monster.y + frame.y))
      .setFlipX(monster.facing === 1);
  }

  /**
   * Returns the center of the source-backed hit1 canvas in world space.
   * World should pass this point to CombatView for authoritative damage text.
   */
  hitAnchor(monster: Pick<MonsterSnapshot, 'x' | 'y' | 'facing'>): Point {
    const frame = this.asset.actions.hit[0] ?? this.asset.actions.stand[0];
    const left = monster.facing === 1 ? monster.x - frame.x - frame.width : monster.x + frame.x;
    return {
      x: Math.round(left + frame.width / 2),
      y: Math.round(monster.y + frame.y + frame.height / 2),
    };
  }

  destroy() { this.sprite.destroy(); }
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
