import * as T from 'three';
import config from '../../../../shared/colossus.json';
import type { ColossusBody, ColossusState } from '../../../../shared/protocol';
export type TrackName = keyof typeof config.tracks;
export const vector = (p: readonly number[]) => new T.Vector3(p[0], p[1], p[2]);
export function trackPoint(name: string, s: number) {
    const points = config.tracks[name as TrackName].points;
    for (let i = 1; i < points.length; i++) {
        const a = vector(points[i - 1]), b = vector(points[i]), d = a.distanceTo(b);
        if (s <= d || i === points.length - 1) return a.lerp(b, T.MathUtils.clamp(s / d, 0, 1));
        s -= d;
    }
    return vector(points[0]);
}
export function worldPoint(body: Pick<ColossusBody, 'track' | 's'> & {height?: number}, frame: ColossusState['frame']) {
    const p = trackPoint(body.track, body.s); p.y += body.height ?? 0;
    const track = config.tracks[body.track as TrackName];
    if ('anchor' in track) { const zone = frame.zones[track.anchor]; p.applyQuaternion(new T.Quaternion().fromArray(zone.rotation)).add(vector(zone.position)); }
    return track.frame !== 'world' ? p.applyQuaternion(new T.Quaternion().fromArray(frame.rotation)).add(vector(frame.position)) : p;
}
export function worldTangent(body: Pick<ColossusBody, 'track' | 's'>, frame: ColossusState['frame']) {
    return worldPoint({...body,s:body.s + .1},frame).sub(worldPoint({...body,s:Math.max(0,body.s - .1)},frame)).normalize();
}
export const angleDelta = (from: number, to: number) => Math.atan2(Math.sin(to-from), Math.cos(to-from));
// Near an end-on view retain the last sign; a tiny camera wobble must not reverse input.
export function screenDirection(tangent: T.Vector3, camera: T.Camera, previous: -1 | 1): -1 | 1 {
    const dot = tangent.dot(new T.Vector3(1,0,0).applyQuaternion(camera.quaternion));
    return Math.abs(dot) < .15 ? previous : dot < 0 ? -1 : 1;
}
