import Phaser from 'phaser';
import type { AssetFrame } from '../../assets/manifest';

/**
 * 神聖之水 `2321015` 摆在地上的一只圣杯。
 *
 * 源把杯子画成 `tile` 下的**三层**（`tile/0` / `tile/1` / `tile/2`），三层同时叠在
 * 同一个锚点上渲染 —— 不是三个状态、也不是三段动画。所以这里就是三张精灵一起挂在
 * `(x, y)`，各按自己的帧序列循环。**哪层是杯身、哪层是液面这类语义源里没有写**，
 * 本视图不替它编一套状态机（源自己用 `_outlink` 把 `tile/1/0` 指到 `tile/0/8` 等，
 * 那是源写死的复用，不是待解释的规律）。
 *
 * 存在与否**只由权威快照决定**：快照里没有这只杯子就销毁，本视图从不自行判它到期
 * ——与 `ReactorView` 同一条口径，两个客户端因此不会对「杯子还在不在」产生分歧。
 */
export class HolyWaterView {
  private readonly layers: Phaser.GameObjects.Image[] = [];
  private readonly sets: AssetFrame[][] = [];
  private readonly cursors: number[] = [];
  private elapsed = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    groups: Array<AssetFrame[] | undefined>,
    private readonly x: number,
    private readonly y: number,
    depth: number,
  ) {
    for (const group of groups) {
      const frames = group ?? [];
      if (!frames.length) continue;
      this.sets.push(frames);
      this.cursors.push(0);
      this.layers.push(
        scene.add.image(x, y, frames[0].url)
          .setOrigin(...originOf(frames[0]))
          .setDepth(depth),
      );
    }
  }

  update(delta: number) {
    this.elapsed += delta;
    for (let index = 0; index < this.sets.length; index += 1) {
      const frames = this.sets[index];
      if (frames.length < 2) continue;
      const total = frames.reduce((sum, frame) => sum + frame.delay, 0);
      if (total <= 0) continue;
      const next = Math.floor((this.elapsed % total) / (total / frames.length));
      if (next === this.cursors[index]) continue;
      this.cursors[index] = next;
      const frame = frames[next];
      this.layers[index]
        .setTexture(frame.url)
        .setOrigin(...originOf(frame))
        .setPosition(this.x, this.y);
    }
  }

  destroy() {
    for (const layer of this.layers) layer.destroy();
  }
}

/** `AssetFrame.origin` 是源像素，Phaser 的 `setOrigin` 要 0..1（同 `ReactorView`）。 */
function originOf(frame: AssetFrame): [number, number] {
  return [
    (frame.origin?.x ?? 0) / (frame.width || 1),
    (frame.origin?.y ?? frame.height) / (frame.height || 1),
  ];
}
