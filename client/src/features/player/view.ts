import Phaser from 'phaser';
import type { PlayerState } from '../../../../shared/protocol';
import type { Manifest } from '../../assets/manifest';
import { frameAt } from './animation';
export class PlayerView {
  readonly body: Phaser.GameObjects.Container;
  private name: Phaser.GameObjects.Text;
  private signature = '';
  private climbFrame = 0;
  constructor(private scene: Phaser.Scene, private manifest: Manifest, username: string, self: boolean) {
    // ponytail: one map layer for actors; add explicit actorDepth when a map needs foreground occlusion.
    const depth = Math.max(...manifest.map.layers.map(layer => layer.depth)) + 1;
    this.body = scene.add.container(0, 0).setDepth(depth);
    this.name = scene.add.text(0, 0, username, { fontFamily: 'Verdana, sans-serif', fontSize: '12px', color: self ? '#fff3a5' : '#ffffff', backgroundColor: '#25322bd9', padding: { x: 6, y: 3 } }).setOrigin(0.5, 0).setDepth(depth + 1);
  }
  update(player: PlayerState, elapsed: number) {
    // GMS83's server state includes climb/dead. Keep those actions data-driven:
    // use their exported frames when present, otherwise hold the authoritative
    // state while rendering the closest source-backed stand frame.
    const renderAction = player.action === 'climb' ? this.climbAsset(player) : player.action;
    const candidate = this.manifest.avatar.actions[renderAction];
    const frames = candidate?.length ? candidate : this.manifest.avatar.actions.stand;
    let index: number;
    if (player.action === 'climb' && player.vy === 0) {
      index = Math.min(this.climbFrame, frames.length - 1);
    } else {
      index = frameAt(frames.map(frame => frame.delay), elapsed, player.action !== 'attack');
      if (player.action === 'climb') this.climbFrame = index;
    }
    if (player.action !== 'climb') this.climbFrame = 0;
    const signature = `${renderAction}:${index}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.body.removeAll(true);
      for (const part of [...frames[index].parts].sort((a, b) => b.z - a.z)) {
        const image = this.scene.add.image(part.x, part.y, part.url).setOrigin(0);
        this.body.add(image);
      }
    }
    this.body.setPosition(Math.round(player.x), Math.round(player.y)).setScale(player.facing === this.manifest.avatar.defaultFacing ? 1 : -1, 1);
    this.name.setPosition(Math.round(player.x), Math.round(player.y + 8));
  }
  private climbAsset(player: PlayerState): 'ladder' | 'rope' | 'climb' {
    const link = player.ladderId === null ? undefined : this.manifest.map.ladders?.find(ladder => ladder.id === player.ladderId);
    if (!link) return this.manifest.avatar.actions.climb?.length ? 'climb' : 'ladder';
    return link.l === 1 ? 'ladder' : 'rope';
  }
  destroy() { this.body.destroy(); this.name.destroy(); }
}
