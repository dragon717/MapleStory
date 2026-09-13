import Phaser from 'phaser';
import type { PetAsset } from '../../assets/manifest';
import { frameAt } from '../player/animation';
import type { PetState } from '../../../../shared/protocol';

/** Renders one summoned pet (TMS273 `Item/Pet`) from `manifest.pets` frames.
 *  The server owns the follow movement; this view only animates the
 *  `stand`/`move`/`jump` loops at the authoritative foot position. */
export class PetView {
  private readonly sprite?: Phaser.GameObjects.Image;
  private signature = '';

  constructor(private scene: Phaser.Scene, private asset: PetAsset, depth: number) {
    const first = asset.stand[0] ?? asset.move[0] ?? asset.icon;
    if (!first) return;
    this.sprite = scene.add.image(0, 0, first.url).setOrigin(0).setDepth(depth);
  }

  update(pet: PetState, elapsed: number) {
    const sprite = this.sprite;
    if (!sprite) return;
    // A weak (starving) pet shows its source `hungry` animation instead of
    // the ordinary loop; pets whose export lacks the node keep the stand loop.
    const hungry = pet.weak === true && this.asset.hungry?.length
      ? this.asset.hungry
      : null;
    const frames = hungry ?? (pet.action === 'jump' && this.asset.jump.length ? this.asset.jump
      : pet.action === 'move' && this.asset.move.length ? this.asset.move : this.asset.stand);
    if (!frames.length) {
      sprite.setVisible(false);
      return;
    }
    const index = frameAt(frames.map(frame => frame.delay), elapsed, true);
    const frame = frames[index];
    const signature = `${pet.action}:${index}:${frame.url}`;
    if (signature !== this.signature) {
      this.signature = signature;
      sprite.setTexture(frame.url);
    }
    // Pet canvases share the mob export orientation (source faces left), so
    // the sprite flips when the server reports a right-facing pet.
    const flipped = pet.facing === 1;
    const left = Math.round(flipped ? pet.x - frame.x - frame.width : pet.x + frame.x);
    const top = Math.round(pet.y + frame.y);
    sprite.setVisible(true)
      .setPosition(left, top)
      .setFlipX(flipped);
  }

  destroy() {
    this.sprite?.destroy();
  }
}
