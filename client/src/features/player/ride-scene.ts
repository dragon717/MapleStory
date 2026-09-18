import type { PlayerState } from '../../../../shared/protocol';
import type { Frame, Part, Point } from '../../assets/avatar-types';
import { assetFrameAlpha, frameAt } from './animation';

export type RidePart = Part & { alpha?: number; a0?: number; a1?: number; opacity?: number; flipX?: boolean };

export interface RideFrame extends Frame {
  parts: RidePart[];
  anchors?: Record<string, Point>;
  action?: string;
  forceCharacterActionFrameIndex?: number;
  forceCharacterFlip?: boolean | number;
  forceCharacterFaceHide?: boolean | number;
}
export interface RideScene {
  kind: 'mount-scene' | 'chair-scene';
  itemId: string;
  actions: Record<string, RideFrame[]>;
  variants?: Record<string, { actions: Record<string, RideFrame[]> }>;
  effects?: { frames: RideFrame[]; z: number; pos: number; source: string }[];
  bodyRelMove?: Point;
  sitAction?: string;
  forceCharacterAction?: string;
  hideBody?: boolean;
  flip?: boolean | number;
}

export function rideFrames(scene: Pick<RideScene, 'actions'> | undefined, player: Pick<PlayerState, 'action' | 'grounded' | 'vy'>) {
  if (!scene) return undefined;
  const action = player.action === 'sit' ? ['sit', 'stand1', 'stand2']
    : player.action === 'walk' ? ['walk1', 'walk2', 'move']
    : !player.grounded ? (player.vy > 0 ? ['fall', 'jump', 'fly'] : ['jump', 'fly'])
    : ['stand1', 'stand2', 'stand', 'sit'];
  const name = [...action, 'stand1', 'stand2', 'stand', 'sit'].find(key => scene.actions[key]?.length);
  return name ? scene.actions[name] : undefined;
}

export function rideFrame(scene: Pick<RideScene, 'actions'> | undefined, player: Pick<PlayerState, 'action' | 'grounded' | 'vy'>, elapsed: number) {
  const frames = rideFrames(scene, player);
  return sampleRideFrame(frames, elapsed);
}

function sampleRideFrame(frames: RideFrame[] | undefined, elapsed: number) {
  if (!frames?.length) return undefined;
  const index = frameAt(frames.map(frame => frame.delay), elapsed, true);
  const frame = frames[index];
  const duration = frames.reduce((sum, entry) => sum + entry.delay, 0);
  const localTime = (duration > 0 ? elapsed % duration : 0) - frames.slice(0, index).reduce((sum, entry) => sum + entry.delay, 0);
  return { ...frame, parts: frame.parts.map(part => part.alpha === undefined && part.a0 === undefined && part.a1 === undefined ? part
    : { ...part, opacity: assetFrameAlpha({ ...part, delay: frame.delay }, localTime) }) };
}

/** Keep every sprite in the same foot-relative, left-facing coordinate space. */
export function composeRideFrame(scene: RideScene | undefined, mount: RideFrame | undefined, avatar: Frame, elapsed: number, saddle?: RideFrame): RidePart[] {
  if (!scene) return avatar.parts;
  const navel = mount?.anchors?.navel ?? mount?.parts.find(part => part.map?.navel)?.map?.navel;
  const anchor = avatar.anchors?.navel;
  const flip = Boolean(mount?.forceCharacterFlip || scene.flip);
  // R: kaentake src/avatar.cpp applies bodyRelMove even to tamingMob chairs.
  const move = {
    x: (navel && anchor ? navel.x - (flip ? -anchor.x : anchor.x) : 0) + (scene.bodyRelMove?.x ?? 0),
    y: (navel && anchor ? navel.y - anchor.y : 0) + (scene.bodyRelMove?.y ?? 0),
  };
  const parts: RidePart[] = scene.hideBody || scene.sitAction === 'hideBody' ? [] : avatar.parts
    .filter(part => !mount?.forceCharacterFaceHide || (part as Part & { part?: string }).part !== 'face')
    .map(part => ({ ...part, x: (flip ? -part.x - (part.width ?? 0) : part.x) + move.x, y: part.y + move.y, ...(flip ? { flipX: true } : {}) }));
  parts.push(...(mount?.parts ?? []));
  for (const part of saddle?.parts ?? []) {
    const from = part.map?.navel ?? saddle?.anchors?.navel;
    parts.push({ ...part, x: part.x + (navel && from ? navel.x - from.x : 0), y: part.y + (navel && from ? navel.y - from.y : 0) });
  }
  for (const effect of scene.effects ?? []) {
    const frame = sampleRideFrame(effect.frames, elapsed);
    if (!frame) continue;
    // R: WzComparerR2 Avatar/Entry.cs CreateChair anchors pos=1 to brow;
    // T: the actual brow, origin and bodyRelMove come from TMS273 frames.
    const offset = effect.pos === 1 ? avatar.anchors?.brow : undefined;
    for (const part of frame.parts) parts.push({
      ...part, x: part.x + (offset?.x ?? 0), y: part.y + (offset?.y ?? 0),
      // Chair effect z is relative to the entire avatar, unlike Base/zmap.
      z: effect.z < 0 ? 10000 - effect.z : -10000 - effect.z,
    });
  }
  return parts.sort((a, b) => b.z - a.z);
}
