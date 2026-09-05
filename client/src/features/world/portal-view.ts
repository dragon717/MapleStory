import Phaser from 'phaser';
import type { AssetFrame } from '../../assets/manifest';

export interface PortalSnapshot {
  mapId: string;
  portalName: string;
  x: number;
  y: number;
  type: number;
}

/**
 * Renders a portal sprite at the source-backed portal coordinates. The pv / sp
 * editor sprites are wide and short, with origin pointing at the centre of the
 * effect; Phaser uses setOrigin(origin.x / width, origin.y / height) so the
 * sprite stays anchored at the portal's world position regardless of size.
 */
export class PortalView {
  private readonly sprite: Phaser.GameObjects.Image;
  private readonly depth: number;
  constructor(scene: Phaser.Scene, frame: AssetFrame, x: number, y: number, depth: number) {
    this.depth = depth;
    // frame.origin is the WZ source-origin offset inside the sprite; frame.x/y
    // on AssetFrame can be the world position (used for portals). Divide origin
    // by the sprite's pixel size to get Phaser's 0..1 anchor fractions.
    const ox = (frame.origin?.x ?? 0) / frame.width;
    const oy = (frame.origin?.y ?? frame.height) / frame.height;
    this.sprite = scene.add.image(x, y, frame.url)
      .setOrigin(ox, oy)
      .setDepth(depth);
    this.sprite.setVisible(true);
  }
  destroy() { this.sprite.destroy(); }
}