import Phaser from 'phaser';
import type { AssetFrame, NpcAsset } from '../../assets/manifest';
import { frameAt } from '../player/animation';

export interface NpcSnapshot {
  id: string;
  templateId: string;
  name: string;
  x: number;
  y: number;
  facing: -1 | 1;
  shopId?: string;
  /** World tick when the npc last changed pose; npcs only play `stand`. */
  actionStartedTick?: number;
}

/** Renders a server-owned npc using the Npc.wz `stand` action. */
export class NpcView {
  private readonly sprite?: Phaser.GameObjects.Image;
  private signature = '';

  constructor(private scene: Phaser.Scene, private asset: NpcAsset, depth: number) {
    const first = asset.stand[0];
    if (!first) return;
    this.sprite = scene.add.image(0, 0, first.url).setOrigin(0).setDepth(depth);
  }

  update(npc: NpcSnapshot, elapsed: number) {
    const sprite = this.sprite;
    if (!sprite) return;
    const frames = this.asset.stand;
    if (!frames.length) {
      sprite.setVisible(false);
      return;
    }
    const index = frameAt(frames.map(frame => frame.delay), elapsed, true);
    const frame = frames[index];
    const signature = `${index}:${frame.url}`;
    if (signature !== this.signature) {
      this.signature = signature;
      sprite.setTexture(frame.url);
    }
    const flipped = npc.facing === 1;
    sprite.setVisible(true)
      .setPosition(Math.round(flipped ? npc.x - frame.x - frame.width : npc.x + frame.x), Math.round(npc.y + frame.y))
      .setFlipX(flipped);
  }

  destroy() { this.sprite?.destroy(); }
}

export function assetFrameUrl(frame: AssetFrame | undefined): string | undefined {
  return frame?.url;
}