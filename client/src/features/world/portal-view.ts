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
 * Renders a portal effect at the source-backed portal coordinates.
 *
 * `Map.wz/MapHelper.img/portal/game/{pv,ph,psh}` ships as an animated sequence;
 * each canvas carries its own origin/box so we cannot use Phaser's spritesheet
 * animation.  We swap the texture and re-anchor on a `TimerEvent` to mirror
 * the source's per-frame origin (the WZ editor sprite under `portal/editor/`
 * is a red rectangle + yellow arrow used by the map editor and is intentionally
 * not used here).
 */
export class PortalView {
  private readonly sprite: Phaser.GameObjects.Image;
  private readonly depth: number;
  private readonly frames: AssetFrame[];
  private readonly frameDelay: number;
  private currentFrame = 0;
  private timer?: Phaser.Time.TimerEvent;
  constructor(scene: Phaser.Scene, frames: AssetFrame[], frameDelay: number, x: number, y: number, depth: number) {
    this.frames = frames.length ? frames : [];
    this.frameDelay = Math.max(1, frameDelay | 0);
    this.depth = depth;
    const first = this.frames[0];
    if (!first) {
      // No usable frames (the map only has a metadata portal); skip rendering.
      this.sprite = scene.add.image(x, y, '__missing').setVisible(false).setDepth(depth);
      return;
    }
    this.sprite = this.makeImage(scene, first, x, y);
    if (this.frames.length > 1) {
      this.timer = scene.time.addEvent({
        delay: this.frameDelay,
        loop: true,
        callback: () => {
          this.currentFrame = (this.currentFrame + 1) % this.frames.length;
          this.applyFrame(this.frames[this.currentFrame], x, y);
        },
      });
    }
  }
  private makeImage(scene: Phaser.Scene, frame: AssetFrame, x: number, y: number) {
    return scene.add.image(x, y, frame.url)
      .setOrigin(...this.normalizedOrigin(frame))
      .setDepth(this.depth);
  }
  private applyFrame(frame: AssetFrame, x: number, y: number) {
    this.sprite.setTexture(frame.url, undefined as unknown as string);
    this.sprite.setOrigin(...this.normalizedOrigin(frame)).setPosition(x, y);
  }
  // `AssetFrame.origin` is in source pixels, while Phaser's `setOrigin` is
  // normalised to 0..1.  Converting here keeps the very first frame anchored
  // exactly like every animated frame, so the beam sits on the portal
  // coordinate instead of ~134 px above it.
  private normalizedOrigin(frame: AssetFrame): [number, number] {
    return [(frame.origin?.x ?? 0) / (frame.width || 1), (frame.origin?.y ?? frame.height) / (frame.height || 1)];
  }
  destroy() {
    this.timer?.remove();
    this.sprite.destroy();
  }
}