import Phaser from 'phaser';
import type { AssetFrame, NpcAsset } from '../../assets/manifest';
import { frameAt } from '../player/animation';
import { uiLocale, displayText } from '../../app/i18n';

export interface NpcSnapshot {
  id: string;
  templateId: string;
  name: string;
  nameZh?: string;
  x: number;
  y: number;
  facing: -1 | 1;
  shopId?: string;
  jobAdvancementAvailable?: boolean;
  questAvailable?: boolean;
  /** World tick when the npc last changed pose; npcs only play `stand`. */
  actionStartedTick?: number;
}

/** Nameplate styling: idle white, gold while the clicked npc owns the window. */
const LABEL_COLOR_IDLE = '#ffffff';
const LABEL_COLOR_SELECTED = '#ffe066';
const LABEL_ALPHA_IDLE = 0.92;

/** Renders a server-owned npc using the Npc.wz `stand` action. */
export class NpcView {
  private readonly sprite?: Phaser.GameObjects.Image;
  private label?: Phaser.GameObjects.Text;
  private signature = '';
  private marker?: Phaser.GameObjects.Image;
  /**
   * Click-selection state (阶段一).  The nameplate is the only NPC-owned element
   * this client draws itself (the sprite is source art), so the selection
   * feedback lands there: the clicked NPC's name turns gold and goes fully
   * opaque while its conversation is open.  A npc without stand frames never
   * gets a nameplate, so the flag is kept and applied whenever one exists.
   */
  private selected = false;

  constructor(private scene: Phaser.Scene, private asset: NpcAsset, depth: number, private markerFrames: AssetFrame[] = []) {
    const first = asset.stand[0];
    if (!first) return;
    this.sprite = scene.add.image(0, 0, first.url).setOrigin(0).setDepth(depth);
  }

  /** Selection feedback for a click.  Idempotent, so the caller may re-assert. */
  setSelected(selected: boolean) {
    if (this.selected === selected) return;
    this.selected = selected;
    this.applyLabelStyle();
  }

  isSelected(): boolean {
    return this.selected;
  }

  private applyLabelStyle() {
    if (!this.label) return;
    this.label
      .setColor(this.selected ? LABEL_COLOR_SELECTED : LABEL_COLOR_IDLE)
      .setAlpha(this.selected ? 1 : LABEL_ALPHA_IDLE);
  }

  /**
   * Nameplate above the head, following the zh/en UI language (the server
   * ships both authoritative names on NpcState and the client only picks).
   * Built lazily so a texture-less npc (no stand frames) never shows a label.
   */
  private ensureLabel(npc: NpcSnapshot, depth: number): Phaser.GameObjects.Text | undefined {
    const display = displayText(uiLocale() === 'en' ? npc.name : (npc.nameZh ?? npc.name));
    if (!display) return undefined;
    if (!this.label) {
      this.label = this.scene.add
        .text(0, 0, display, {
          fontFamily: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
          fontSize: '13px',
          color: LABEL_COLOR_IDLE,
          stroke: '#16202b',
          strokeThickness: 4,
          resolution: 2,
        })
        .setOrigin(0.5, 1)
        .setDepth(depth + 10)
        .setAlpha(LABEL_ALPHA_IDLE);
      this.applyLabelStyle();
    } else if (this.label.text !== display) {
      this.label.setText(display);
    }
    return this.label;
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
    const left = Math.round(flipped ? npc.x - frame.x - frame.width : npc.x + frame.x);
    const top = Math.round(npc.y + frame.y);
    sprite.setVisible(true)
      .setPosition(left, top)
      .setFlipX(flipped);
    // Nameplate floats above the sprite's top edge, centred on the figure.
    const label = this.ensureLabel(npc, sprite.depth);
    if (label) label.setPosition(left + frame.width / 2, top - 6);
    if ((npc.jobAdvancementAvailable || npc.questAvailable) && this.markerFrames.length) {
      const markerFrame = this.markerFrames[this.markerFrames.length === 1 ? 0 : frameAt(this.markerFrames.map(frame => frame.delay), elapsed, true)];
      if (!this.marker) this.marker = this.scene.add.image(0, 0, markerFrame.url).setOrigin(0).setDepth(sprite.depth + 11);
      this.marker.setTexture(markerFrame.url).setVisible(true)
        .setPosition(Math.round(left + frame.width / 2 + markerFrame.x), Math.round(top - 28 + markerFrame.y));
    } else this.marker?.setVisible(false);
  }

  containsMarker(x: number, y: number): boolean {
    return Boolean(this.marker?.visible && this.marker.getBounds().contains(x, y));
  }

  destroy() {
    this.sprite?.destroy();
    this.label?.destroy();
    this.marker?.destroy();
  }
}

export function assetFrameUrl(frame: AssetFrame | undefined): string | undefined {
  return frame?.url;
}
