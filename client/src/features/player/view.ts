import Phaser from 'phaser';
import type { PlayerState } from '../../../../shared/protocol';
import { actorDepthForLayers, assetFrameAlpha } from '../../assets/manifest';
import type { AssetFrame, AvatarActionSet, Manifest } from '../../assets/manifest';
import { frameAt } from './animation';
import { appearanceKey, composeAppearance } from '../entry/appearance';

const supportedEquipment = new Set(['1002067', '1040002', '1052095', '1302000']);
type SkillAction = `skill${number}` | 'skill2221052prepare' | 'skill2221052final';
type SkillFrames = AvatarActionSet['stand'];

export class PlayerView {
  readonly body: Phaser.GameObjects.Container;
  private name: Phaser.GameObjects.Text;
  private signature = '';
  private highestLevel?: number;
  private levelUpStartedAt = 0;
  private levelUpImages: { frames: AssetFrame[]; image: Phaser.GameObjects.Image }[] = [];
  private levelUpSound?: Phaser.Sound.BaseSound;
  private appearanceCache?: { key: string; actions: AvatarActionSet };
  private climbFrame = 0;
  /** Hurt-flash window (scene clock ms). White double-flash while active. */
  private flashStartedAt = 0;
  private flashUntil = 0;
  private flashWhite = false;
  private skillAction?: SkillAction | 'attack';
  private skillActionStartedAt = 0;
  private skillActionUntil = 0;
  /** Feet-to-head offset of the current rendered frame, for damage numbers. */
  private headOffsetY = -40;
  /** Live map-chat bubble above the head. The server only forwards chatMessage
   *  to the same-map members, so bubbles never replay history and never
   *  reposition across a map switch (this view is destroyed with the scene).
   *  Source-backed UI/ChatBalloon.img/0 nine-slice is rendered when the
   *  manifest provides it; otherwise we fall back to the legacy placeholder. */
  private bubble?: { container: Phaser.GameObjects.Container; until: number; width: number; height: number };
  /** Live chat emoticon (表情貼圖) above the head.  One at a time, like the
   *  source: a newer sticker replaces the running one.  The frames, their order
   *  and their delays are the exported `effect` animation, and the whole thing
   *  is anchored to the head exactly like the chat bubble is, so it follows the
   *  character while it plays and dies with the view on a map switch. */
  private emoticon?: { frames: AssetFrame[]; image: Phaser.GameObjects.Image; startedAt: number; durationMs: number };
  /** Gap between the head top and the sticker's authored anchor point. */
  private static readonly EMOTICON_HEAD_GAP = 6;
  /** Server-visible clip for the on-map bubble; the chat log keeps the full
   *  authoritative text. */
  private static readonly BUBBLE_MAX_CHARS = 96;
  private static readonly BUBBLE_MS = 4_000;
  private readonly self: boolean;
  private static readonly BUBBLE_CORNER = 6;
  /** Padding inside the bubble box before the text rows. */
  private static readonly BUBBLE_TEXT_PAD_X = 8;
  private static readonly BUBBLE_TEXT_PAD_Y = 5;
  /** Maximum width of the text area inside the bubble. */
  private static readonly BUBBLE_MAX_TEXT_WIDTH = 260;
  /** Vertical gap between the bubble bottom edge and the arrow tip. */
  private static readonly BUBBLE_ARROW_GAP = 1;
  constructor(private scene: Phaser.Scene, private manifest: Manifest, username: string, self: boolean) {
    // ponytail: one map layer for actors; add explicit actorDepth when a map needs foreground occlusion.
    const depth = actorDepthForLayers(manifest.map.layers);
    this.body = scene.add.container(0, 0).setDepth(depth);
    this.self = self;
    this.name = scene.add.text(0, 0, username, { fontFamily: 'Verdana, sans-serif', fontSize: '12px', color: self ? '#fff3a5' : '#ffffff', backgroundColor: '#25322bd9', padding: { x: 6, y: 3 } }).setOrigin(0.5, 0).setDepth(depth + 1);
  }
  /** Begin the server-driven hurt presentation: white double-flash while the
   *  authoritative knockback slide runs. Positions themselves come from
   *  snapshots, so only the flash needs to be local. */
  hitFeedback(durationMs = 420) {
    const now = this.scene.time.now;
    this.skillAction = undefined;
    this.flashStartedAt = now;
    this.flashUntil = now + durationMs;
  }
  /** Vertical feet→head offset (negative) for anchoring damage numbers. */
  headAnchorYOffset() {
    return this.headOffsetY;
  }
  /** Play a source-exported spell pose for the authoritative server duration. */
  startSkill(skillId: number, durationMs: number, phase?: 'prepare' | 'sustain' | 'final') {
    if ([2221011, 2221052].includes(skillId) && durationMs === 0) {
      if (this.skillAction?.startsWith(`skill${skillId}`)) this.skillAction = undefined;
      return;
    }
    if (![1000, 2001008, 2001011, 2001012, 2201008, 2201005, 2201001, 2211002, 2211007, 2211011, 2211012, 2211014,
      2221000, 2221004, 2221005, 2221006, 2221007, 2221008, 2221011, 2221012, 2221052].includes(skillId)
      || !Number.isFinite(durationMs) || durationMs <= 0) return;
    // Older skillCast envelopes omit phase; CombatView treats that as the
    // held/sustain stage, so the actor and VFX remain on the same timeline.
    const resolvedPhase = phase ?? 'sustain';
    this.skillAction = skillId === 1000 ? 'attack' : skillId === 2221052 && resolvedPhase === 'prepare' ? 'skill2221052prepare'
      : skillId === 2221052 && resolvedPhase === 'final' ? 'skill2221052final' : `skill${skillId}`;
    this.skillActionStartedAt = this.scene.time.now;
    this.skillActionUntil = this.skillActionStartedAt + durationMs;
    this.signature = '';
  }
  update(player: PlayerState, elapsed: number) {
    if (player.hp <= 0 || player.action === 'dead') this.skillAction = undefined;
    let loadout = this.equipmentLoadout(player.equipped);
    if (player.appearance && this.manifest.appearanceCatalog) {
      const key = appearanceKey(player.appearance, player.equipped ?? []);
      if (this.appearanceCache?.key !== key) {
        const actions = composeAppearance(this.manifest.appearanceCatalog, player.appearance, player.equipped ?? []);
        this.appearanceCache = actions ? { key, actions } : undefined;
      }
      if (this.appearanceCache) loadout = this.appearanceCache;
    }
    const actions = loadout.actions as AvatarActionSet & Partial<Record<SkillAction, SkillFrames>>;
    // The server state includes climb/dead. Keep those actions data-driven:
    // use their exported frames when present, otherwise hold the authoritative
    // state while rendering the closest source-backed stand frame.
    const skillActive = this.skillAction !== undefined && this.scene.time.now < this.skillActionUntil;
    if (!skillActive) this.skillAction = undefined;
    const renderAction = skillActive && this.skillAction && actions[this.skillAction]?.length
      ? this.skillAction
      : player.action === 'climb' ? this.climbAsset(player, actions) : player.action;
    const candidate = actions[renderAction];
    const frames = candidate?.length ? candidate : actions.stand;
    let index: number;
    if (player.action === 'climb' && player.vy === 0) {
      index = Math.min(this.climbFrame, frames.length - 1);
    } else {
      const animationElapsed = skillActive ? Math.max(0, this.scene.time.now - this.skillActionStartedAt) : elapsed;
      index = frameAt(frames.map(frame => frame.delay), animationElapsed, skillActive ? false : player.action !== 'attack');
      if (player.action === 'climb') this.climbFrame = index;
    }
    if (player.action !== 'climb') this.climbFrame = 0;
    const signature = `${loadout.key}:${renderAction}:${index}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.body.removeAll(true);
      const parts = [...frames[index].parts].sort((a, b) => b.z - a.z);
      for (const part of parts) {
        const image = this.scene.add.image(part.x, part.y, part.url).setOrigin(0);
        // A rebuild mid-flash must re-apply the white tint to the fresh
        // children; updateFlash() only runs on state changes.
        if (this.flashWhite) image.setTintFill(0xffffff);
        this.body.add(image);
      }
      // Source frames anchor the feet at y=0 and grow upward (negative y),
      // so the sprite top is the smallest part y. Present damage numbers just
      // above the head, mirroring MonsterView.hitAnchor.
      const top = parts.reduce((lowest, part) => Math.min(lowest, part.y), 0);
      this.headOffsetY = Math.round(Math.min(top, -1) - 2);
    }
    this.body.setPosition(Math.round(player.x), Math.round(player.y)).setScale(player.facing === this.manifest.avatar.defaultFacing ? 1 : -1, 1);
    this.name.setPosition(Math.round(player.x), Math.round(player.y + 8));
    this.updateBubble(player);
    this.updateEmoticon(player);
    this.updateFlash();
    this.updateLevelFeedback(player);
  }

  /** Present one incoming same-map chat message above the character head.
   *  Ephemeral, time-boxed and clipped: it never replays and never follows the
   *  body into another map.  When the source-backed nine-slice is available
   *  it forms the bubble background; otherwise we draw the legacy rounded
   *  rectangle so older content versions still render. */
  showBubble(authorName: string, text: string) {
    this.clearBubble();
    if (!authorName && !text) return;
    const balloon = this.manifest.chatBalloon;
    const width = balloon ? this.buildSourceBubble(balloon, authorName, text) : this.buildFallbackBubble(authorName, text);
    if (width === 0) return;
    this.bubble = {
      container: this.pendingBubble!,
      until: this.scene.time.now + PlayerView.BUBBLE_MS,
      width: this.pendingBubbleWidth!,
      height: this.pendingBubbleHeight!,
    };
    this.pendingBubble = undefined;
    this.pendingBubbleWidth = undefined;
    this.pendingBubbleHeight = undefined;
  }
  /** Build the source-backed bubble (nine-slice background + arrow + name/body
   *  text) and stash the resulting container so `showBubble` can record its
   *  bounding box.  Returns the bubble width so the caller can detect success. */
  private buildSourceBubble(balloon: NonNullable<typeof this.manifest.chatBalloon>, authorName: string, text: string): number {
    const scene = this.scene;
    const slices = balloon.slices;
    const corner = PlayerView.BUBBLE_CORNER;
    const padX = PlayerView.BUBBLE_TEXT_PAD_X;
    const padY = PlayerView.BUBBLE_TEXT_PAD_Y;
    const maxTextWidth = PlayerView.BUBBLE_MAX_TEXT_WIDTH;
    const clipped = text.length > PlayerView.BUBBLE_MAX_CHARS
      ? `${text.slice(0, PlayerView.BUBBLE_MAX_CHARS)}…` : text;
    const nameLabel = scene.add.text(0, 0, authorName, {
      fontFamily: 'Verdana, sans-serif', fontSize: '11px',
      color: this.self ? '#fff3a5' : '#5b9bcc',
    });
    const bodyLabel = scene.add.text(0, 0, clipped, {
      fontFamily: 'Verdana, sans-serif', fontSize: '12px', color: '#1d1d1d',
      // Clr -16777216 (0xff000000) is opaque black; use it as the text
      // stroke colour so 273-style dark text stays readable on the light
      // ChatBalloon background regardless of the map backdrop.
      stroke: '#000000', strokeThickness: 1,
      wordWrap: { width: maxTextWidth - padX * 2 }, lineSpacing: 1,
    });
    nameLabel.updateText();
    bodyLabel.updateText();
    const textAreaW = Math.max(corner * 2 + padX * 2, Math.min(maxTextWidth, Math.max(nameLabel.width, bodyLabel.width) + padX * 2));
    const textAreaH = nameLabel.height + bodyLabel.height + padY * 2 + 2;
    const bubbleW = textAreaW + corner * 2;
    const bubbleH = textAreaH + corner * 2;
    const bg = scene.add.container(0, 0);
    const nw = scene.add.image(0, 0, slices.nw.url).setOrigin(0);
    const n = scene.add.image(corner, 0, slices.n.url).setOrigin(0).setDisplaySize(textAreaW, corner);
    const ne = scene.add.image(bubbleW - corner, 0, slices.ne.url).setOrigin(0);
    const w = scene.add.image(0, corner, slices.w.url).setOrigin(0).setDisplaySize(corner, textAreaH);
    const c = scene.add.image(corner, corner, slices.c.url).setOrigin(0).setDisplaySize(textAreaW, textAreaH);
    const e = scene.add.image(bubbleW - corner, corner, slices.e.url).setOrigin(0).setDisplaySize(corner, textAreaH);
    const sw = scene.add.image(0, bubbleH - corner, slices.sw.url).setOrigin(0);
    const s = scene.add.image(corner, bubbleH - corner, slices.s.url).setOrigin(0).setDisplaySize(textAreaW, corner);
    const se = scene.add.image(bubbleW - corner, bubbleH - corner, slices.se.url).setOrigin(0);
    const arrow = scene.add.image(
      Math.round((bubbleW - slices.arrow.width) / 2),
      bubbleH - PlayerView.BUBBLE_ARROW_GAP,
      slices.arrow.url,
    ).setOrigin(0);
    bg.add([nw, n, ne, w, c, e, sw, s, se, arrow]);
    const textLayer = scene.add.container(0, 0);
    nameLabel.setPosition(padX, padY);
    bodyLabel.setPosition(padX, padY + nameLabel.height + 1);
    textLayer.add([nameLabel, bodyLabel]);
    const container = scene.add.container(0, 0).setDepth(this.name.depth + 4);
    container.add([bg, textLayer]);
    this.pendingBubble = container;
    this.pendingBubbleWidth = bubbleW;
    this.pendingBubbleHeight = bubbleH + slices.arrow.height - PlayerView.BUBBLE_ARROW_GAP;
    return bubbleW;
  }
  /** Legacy placeholder used when the content version predates the export of
   *  UI/ChatBalloon.img.  Matches the previous semi-transparent rounded box so
   *  older builds do not regress. */
  private buildFallbackBubble(authorName: string, text: string): number {
    const scene = this.scene;
    const container = scene.add.container(0, 0).setDepth(this.name.depth + 3);
    const clipped = text.length > PlayerView.BUBBLE_MAX_CHARS
      ? `${text.slice(0, PlayerView.BUBBLE_MAX_CHARS)}…` : text;
    const nameLabel = scene.add.text(0, 0, authorName, { fontFamily: 'Verdana, sans-serif', fontSize: '11px', color: '#8fd0ff' });
    const bodyLabel = scene.add.text(0, 0, clipped, {
      fontFamily: 'Verdana, sans-serif', fontSize: '12px', color: '#ffffff',
      wordWrap: { width: 320 }, lineSpacing: 2,
    });
    bodyLabel.updateText();
    const padX = 10;
    const padY = 6;
    const width = Math.max(nameLabel.width, bodyLabel.width) + padX * 2;
    const height = nameLabel.height + bodyLabel.height + padY * 2 + 2;
    const box = scene.add.graphics();
    box.fillStyle(0x0a1420, 0.82).fillRoundedRect(0, 0, width, height, 7);
    box.lineStyle(1, 0x3d556e, 0.9).strokeRoundedRect(0.5, 0.5, width - 1, height - 1, 7);
    container.add(box);
    nameLabel.setPosition(padX, padY);
    bodyLabel.setPosition(padX, padY + nameLabel.height + 2);
    container.add([nameLabel, bodyLabel]);
    this.pendingBubble = container;
    this.pendingBubbleWidth = width;
    this.pendingBubbleHeight = height;
    return width;
  }
  /** Scratch fields that hand the freshly built container and size to showBubble. */
  private pendingBubble?: Phaser.GameObjects.Container;
  private pendingBubbleWidth?: number;
  private pendingBubbleHeight?: number;

  private updateBubble(player: PlayerState) {
    const bubble = this.bubble;
    if (!bubble) return;
    if (this.scene.time.now >= bubble.until || player.hp <= 0 || player.action === 'dead') {
      this.clearBubble();
      return;
    }
    // Anchor the bubble just above the character head so the arrow tip points
    // at the speaker.  headOffsetY is negative (frame top relative to the
    // feet anchor) so player.y + headOffsetY is the world-space head y.
    bubble.container.setPosition(
      Math.round(player.x - bubble.width / 2),
      Math.round(player.y + this.headOffsetY - bubble.height - 4),
    );
  }

  private clearBubble() {
    if (!this.bubble && !this.pendingBubble) return;
    this.bubble?.container.destroy(true);
    this.pendingBubble?.destroy(true);
    this.bubble = undefined;
    this.pendingBubble = undefined;
    this.pendingBubbleWidth = undefined;
    this.pendingBubbleHeight = undefined;
  }
  /** Present one emoticon above the head.  `frames` is the sticker's exported
   *  `effect` animation; an empty list simply clears, which can only happen
   *  with a manifest older than the protocol (the server already checked the id
   *  against the same exported catalogue). */
  showEmoticon(frames: AssetFrame[]) {
    this.clearEmoticon();
    if (!frames.length) return;
    const image = this.scene.add.image(0, 0, frames[0].url).setOrigin(0).setDepth(this.body.depth + 3);
    this.emoticon = {
      frames,
      image,
      startedAt: this.scene.time.now,
      durationMs: frames.reduce((total, frame) => total + frame.delay, 0),
    };
  }

  private clearEmoticon() {
    if (!this.emoticon) return;
    this.emoticon.image.destroy();
    this.emoticon = undefined;
  }

  /** Advance the running sticker animation and keep it anchored above the head. */
  private updateEmoticon(player: PlayerState) {
    const emoticon = this.emoticon;
    if (!emoticon) return;
    const elapsed = this.scene.time.now - emoticon.startedAt;
    if (elapsed >= emoticon.durationMs || player.hp <= 0 || player.action === 'dead') {
      this.clearEmoticon();
      return;
    }
    const index = frameAt(emoticon.frames.map(frame => frame.delay), elapsed, false);
    const frame = emoticon.frames[index];
    // The authored origin is the sticker's own anchor, so anchoring it a fixed
    // gap above the head keeps every frame of the animation in the same place
    // instead of jittering with the transparent padding around each canvas.
    emoticon.image
      .setTexture(frame.url)
      .setPosition(
        Math.round(player.x - frame.origin.x),
        Math.round(player.y + this.headOffsetY - PlayerView.EMOTICON_HEAD_GAP - frame.origin.y),
      )
      .setAlpha(assetFrameAlpha(frame, elapsed - emoticon.frames.slice(0, index).reduce((sum, value) => sum + value.delay, 0)));
  }

  private updateLevelFeedback(player: PlayerState) {
    const level = player.level;
    if (!Number.isSafeInteger(level) || level < 1) return;
    const increased = this.highestLevel !== undefined && level > this.highestLevel;
    this.highestLevel = Math.max(this.highestLevel ?? level, level);
    const now = this.scene.time.now;
    if (increased) {
      this.clearLevelFeedback();
      this.levelUpStartedAt = now;
      for (const frames of this.manifest.levelUp?.layers ?? []) {
        if (!frames.length) continue;
        const image = this.scene.add.image(0, 0, frames[0].url).setOrigin(0).setDepth(this.body.depth + 2);
        this.levelUpImages.push({ frames, image });
      }
      const url = this.manifest.levelUp?.sound?.url;
      if (url && this.scene.cache.audio.exists(url)) {
        const sound = this.scene.sound.add(url);
        this.levelUpSound = sound;
        sound.once('complete', () => { if (this.levelUpSound === sound) this.levelUpSound = undefined; sound.destroy(); });
        if (!sound.play({ volume: 0.35 })) { sound.destroy(); this.levelUpSound = undefined; }
      }
    }
    const elapsed = Math.max(0, now - this.levelUpStartedAt);
    for (let i = this.levelUpImages.length - 1; i >= 0; i--) {
      const { frames, image } = this.levelUpImages[i];
      const duration = frames.reduce((sum, frame) => sum + frame.delay, 0);
      if (elapsed >= duration) { image.destroy(); this.levelUpImages.splice(i, 1); continue; }
      const index = frameAt(frames.map(frame => frame.delay), elapsed, false);
      const frame = frames[index];
      const frameElapsed = elapsed - frames.slice(0, index).reduce((sum, value) => sum + value.delay, 0);
      image.setTexture(frame.url).setPosition(Math.round(player.x - frame.origin.x), Math.round(player.y - frame.origin.y))
        .setAlpha(assetFrameAlpha(frame, frameElapsed));
    }
  }
  private clearLevelFeedback() {
    for (const { image } of this.levelUpImages) image.destroy();
    this.levelUpImages = [];
    this.levelUpSound?.destroy();
    this.levelUpSound = undefined;
  }
  private updateFlash() {
    const now = this.scene.time.now;
    // 90 ms white, 90 ms normal, repeated until the knockback window ends.
    const white = now < this.flashUntil && (now - this.flashStartedAt) % 180 < 90;
    if (white === this.flashWhite) return;
    this.flashWhite = white;
    for (const child of this.body.list) {
      const image = child as Phaser.GameObjects.Image;
      if (white) image.setTintFill(0xffffff);
      else image.clearTint();
    }
  }
  private equipmentLoadout(equipped: PlayerState['equipped']): { key: string; actions: AvatarActionSet } {
    // Old snapshots have no equipped field. Keep the original starter look
    // until the server sends an authoritative list; an explicit empty list
    // selects the exported empty equipment loadout.
    if (equipped === undefined) return { key: 'starter', actions: this.manifest.avatar.actions };
    if (equipped.length === 0) {
      const empty = this.manifest.avatar.equipmentLoadouts?.empty;
      return empty ? { key: 'empty', actions: empty.actions } : { key: 'starter', actions: this.manifest.avatar.actions };
    }
    const ids = new Set(equipped.map(item => item.itemId).filter(itemId => supportedEquipment.has(itemId)));
    // A regular coat and a longcoat occupy the same body slot. The server
    // rejects both at once; prefer the longcoat defensively for stale snapshots.
    if (ids.has('1052095')) ids.delete('1040002');
    if (ids.size === 0) return { key: 'starter', actions: this.manifest.avatar.actions };
    const key = [...ids].sort().join('+');
    const loadout = this.manifest.avatar.equipmentLoadouts?.[key];
    return loadout ? { key, actions: loadout.actions } : { key: 'starter', actions: this.manifest.avatar.actions };
  }
  private climbAsset(player: PlayerState, actions: AvatarActionSet): 'ladder' | 'rope' | 'climb' {
    const link = player.ladderId === null ? undefined : this.manifest.map.ladders?.find(ladder => ladder.id === player.ladderId);
    if (!link) return actions.climb?.length ? 'climb' : 'ladder';
    return link.l === 1 ? 'ladder' : 'rope';
  }
  destroy() { this.clearLevelFeedback(); this.clearEmoticon(); this.skillAction = undefined; this.body.destroy(); this.name.destroy(); }
}
