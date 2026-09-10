import Phaser from 'phaser';
import type { AssetFrame, ReactorStateAsset } from '../../assets/manifest';
import type { ReactorState } from '../../../../shared/protocol';

/**
 * Renders one placed map reactor (Reactor.wz) at its authored anchor.
 *
 * A reactor is the original interactive map prop — a flower you shake for an
 * item, a herb patch, a quest container.  It has two animations per state:
 *
 *  - `frames`     the idle animation, looped only when the source sets `repeat`
 *  - `hitFrames`  a one-shot impact animation, played when the prop is struck
 *
 * State itself is authoritative: the server decides which state a prop is in
 * and broadcasts the change, so this view never advances a state on its own.
 * That keeps two clients from disagreeing about whether the flower is still
 * there.
 */
export class ReactorView {
  private readonly sprite: Phaser.GameObjects.Image;
  private readonly frames: AssetFrame[];
  private readonly hitFrames: AssetFrame[];
  private readonly loops: boolean;
  private frame = 0;
  private elapsed = 0;
  private hitElapsed: number | null = null;
  private state: number;
  private spent = false;
  private readonly x: number;
  private readonly y: number;

  constructor(
    private readonly scene: Phaser.Scene,
    asset: ReactorStateAsset,
    x: number,
    y: number,
    flip: boolean,
    depth: number,
  ) {
    this.frames = asset.frames;
    this.hitFrames = asset.hitFrames;
    this.loops = asset.repeat && this.frames.length > 1;
    this.x = x;
    this.y = y;
    this.state = 0;
    const first = this.frames[0];
    if (!first) {
      // The "used up" state has no art at all — that is the source's way of
      // saying the prop is gone, so render nothing rather than a blank sprite.
      this.sprite = scene.add.image(x, y, '__missing').setVisible(false).setDepth(depth);
      this.spent = true;
      return;
    }
    this.sprite = scene.add.image(x, y, first.url)
      .setOrigin(...this.origin(first))
      .setDepth(depth)
      .setFlipX(flip);
    this.apply(first);
  }

  /** `AssetFrame.origin` is in source pixels; Phaser's `setOrigin` is 0..1. */
  private origin(frame: AssetFrame): [number, number] {
    return [
      (frame.origin?.x ?? 0) / (frame.width || 1),
      (frame.origin?.y ?? frame.height) / (frame.height || 1),
    ];
  }

  private apply(frame: AssetFrame) {
    this.sprite.setTexture(frame.url).setOrigin(...this.origin(frame)).setPosition(this.x, this.y);
  }

  /**
   * Swap to a different authored state (or to a new template's art) and replay
   * it from the top.  Called when the authoritative snapshot changes, so the
   * local frame cursor is reset rather than continued.
   */
  setState(asset: ReactorStateAsset, state: number, spent: boolean) {
    this.state = state;
    this.spent = spent;
    this.frame = 0;
    this.elapsed = 0;
    this.hitElapsed = null;
    this.sprite.setVisible(!spent);
    const first = asset.frames[0];
    if (!first || spent) {
      this.sprite.setVisible(false);
      return;
    }
    this.apply(first);
  }

  /** Play the one-shot impact animation.  Idle frames resume when it ends. */
  playHit(durationMs: number) {
    if (!this.hitFrames.length || this.spent) return;
    this.hitElapsed = 0;
    this.hitDuration = Math.max(1, durationMs);
    this.frame = 0;
    this.apply(this.hitFrames[0]);
  }

  private hitDuration = 1;

  update(delta: number) {
    if (this.spent) return;
    if (this.hitElapsed !== null) {
      this.hitElapsed += delta;
      // Spread the authored frames over the server's hit window so the impact
      // animation finishes exactly when the prop becomes interactive again.
      const total = this.hitFrames.reduce((sum, frame) => sum + frame.delay, 0) || this.hitDuration;
      const index = Math.min(this.hitFrames.length - 1, Math.floor((this.hitElapsed / total) * this.hitFrames.length));
      if (index !== this.frame) {
        this.frame = index;
        this.apply(this.hitFrames[index]);
      }
      if (this.hitElapsed >= total) {
        this.hitElapsed = null;
        this.frame = 0;
        this.elapsed = 0;
        const first = this.frames[0];
        if (first) this.apply(first);
      }
      return;
    }
    if (!this.loops || this.frames.length < 2) return;
    this.elapsed += delta;
    const total = this.frames.reduce((sum, frame) => sum + frame.delay, 0);
    if (total <= 0) return;
    const index = Math.floor((this.elapsed % total) / (total / this.frames.length));
    if (index !== this.frame) {
      this.frame = index;
      this.apply(this.frames[index]);
    }
  }

  get currentState() { return this.state; }
  get isSpent() { return this.spent; }

  destroy() {
    this.sprite.destroy();
  }
}

/** Pick the authored state asset for a template, falling back to the last one. */
export function reactorStateAsset(
  templates: Record<string, { states: Record<string, ReactorStateAsset> }> | undefined,
  templateId: string,
  state: number,
): ReactorStateAsset | undefined {
  const template = templates?.[templateId];
  if (!template) return undefined;
  return template.states[String(state)] ?? template.states['0'];
}

export type { ReactorState };
