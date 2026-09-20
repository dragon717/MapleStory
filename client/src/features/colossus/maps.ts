import config from '../../../../shared/colossus.json';
import type { ColossusBody, ColossusState, PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest, MiniMapMapAsset, WorldMapUiData } from '../../assets/manifest';
import type { MiniMapInput } from '../world/minimap-view';

type Region = keyof typeof config.regions;
type Track = keyof typeof config.tracks;
const mapId = (region: string) => `colossus:${region}`;
const svg = (width: number, height: number, body: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`)}`;
const text = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const frame = (url: string, width: number, height: number, x = 0, y = 0) => ({ url, width, height, x: 0, y: 0, origin: { x, y } }) as AssetFrame;
const mapPoint = (track: string,p:number[]) => track==='climb' ? p.map((n,i)=>n+config.scale.bodyOrigin[i]) : p;
function point(track: string, s: number) {
  const points = config.tracks[track as Track].points;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], d = Math.hypot(...b.map((n, j) => n - a[j]));
    if (s <= d || i === points.length - 1) return a.map((n, j) => n + (b[j] - n) * Math.max(0, Math.min(1, s / d)));
    s -= d;
  }
  return points[0];
}

/** P: route geometry is original activity content; all window chrome and controls stay TMS273. */
export class ColossusMaps {
  readonly world?: WorldMapUiData;
  private maps = new Map<string, MiniMapMapAsset>();
  constructor(manifest: Manifest) {
    const pages: WorldMapUiData['pages'] = {};
    for (const [id, region] of Object.entries(config.regions)) {
      const tracks = Object.entries(config.tracks).filter(([,t]) => t.region === id).map(([key,t])=>({...t,points:t.points.map(p=>mapPoint(key,p))}));
      const points = tracks.flatMap(t => t.points);
      const xs = points.map(p => p[0]), zs = points.map(p => p[2]);
      const world = { xMin: Math.min(...xs) - 15, yMin: Math.min(...zs) - 15, width: Math.max(...xs) - Math.min(...xs) + 30, height: Math.max(...zs) - Math.min(...zs) + 30 };
      const scale = Math.min(600 / world.width, 310 / world.height);
      const px = (p: number[]) => ({ x: 320 + (p[0] - world.xMin - world.width / 2) * scale, y: 217 + (p[2] - world.yMin - world.height / 2) * scale });
      const rails = tracks.map(t => `<polyline points="${t.points.map(p => { const q = px(p); return `${q.x},${q.y}`; }).join(' ')}"/>`).join('');
      const routes = `<g fill="none" stroke="#668585" stroke-width="8" stroke-linejoin="round" stroke-linecap="round">${rails}</g><g fill="none" stroke="#ffedb8" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">${rails}</g>`;
      const localRails = tracks.map(t => `<polyline points="${t.points.map(p => `${(p[0] - world.xMin) / world.width * 230},${(p[2] - world.yMin) / world.height * 160}`).join(' ')}"/>`).join('');
      this.maps.set(id, { mapId: mapId(id), url: svg(230, 160, `<rect width="230" height="160" fill="#c5d9db"/><g fill="none" stroke="#637777" stroke-width="5">${localRails}</g><g fill="none" stroke="#fff3c5" stroke-width="2">${localRails}</g>`), width: 230, height: 160, world, centerX: 0, centerY: 0, mag: null, mark: 'None', source: 'P: shared/colossus.json authority tracks, local X/Z projection' });
      const neighbors = [...new Set(config.passages.filter(p => config.tracks[p.track as Track].region === id).map(p => config.tracks[p.toTrack as Track].region).filter(r => r !== id))];
      pages[mapId(id)] = {
        page: mapId(id), parent: 'colossus', name: region.name,
        baseImg: frame(svg(640, 470, `<rect width="640" height="470" fill="#eaf3eb"/><g fill="#314a52" font-family="sans-serif" text-anchor="middle"><text x="320" y="28" font-size="24">${text(region.name)}</text><text x="320" y="49" font-size="18">${text(region.subtitle)}</text>${routes}<text x="320" y="453" font-size="20">路口按 ↑ 通行 · 跑跳与攻击沿用按键设置</text></g>`), 640, 470, 320, 235),
        mapList: [{ type: 0, mapIds: [mapId(id)], spot: { x: px(tracks[0].points[0]).x - 320, y: px(tracks[0].points[0]).y - 235 } }],
        mapLinks: neighbors.map((to, i) => { const name = config.regions[to as Region].name; return { toolTip: `查看${name}`, page: mapId(to), image: frame(svg(150, 26, `<rect x="1" y="1" width="148" height="24" rx="3" fill="#d3e6e8" stroke="#7295a0"/><text x="75" y="18" fill="#314a52" font-family="sans-serif" font-size="20" text-anchor="middle">${text(name)} →</text>`), 150, 26, 300 - i * 154, -167) }; }),
      };
    }
    const regions = Object.entries(config.regions);
    pages.colossus = { page: 'colossus', parent: null, name: '巨石之约', baseImg: frame(svg(640, 470, '<rect width="640" height="470" fill="#eaf3eb"/><g fill="#314a52" font-family="sans-serif" text-anchor="middle"><text x="320" y="40" font-size="22">巨石之约</text><text x="320" y="70" font-size="14">六片相连的天地</text><text x="320" y="442" font-size="20">选择区域查看道路 · 通行仍需走到现场路口</text></g>'), 640, 470, 320, 235), mapList: [], mapLinks: regions.map(([id, region], i) => ({ toolTip: region.name, page: mapId(id), image: frame(svg(260, 70, `<rect x="1" y="1" width="258" height="68" rx="3" fill="#d3e6e8" stroke="#7295a0"/><g fill="#314a52" font-family="sans-serif" text-anchor="middle"><text x="130" y="28" font-size="18">${text(region.name)}</text><text x="130" y="51" font-size="18">查看区域道路</text></g>`), 260, 70, 280 - i % 2 * 300, 115 - Math.floor(i / 2) * 95) })) };
    if (manifest.worldMap) this.world = { ...manifest.worldMap, root: 'colossus', pages, allPages: Object.keys(pages), source: 'P: activity route data; TMS273 source window and controls' };
  }
  input(state: ColossusState, players: PlayerState[], selfId: string): MiniMapInput {
    const project = (body: ColossusBody) => {
      if (body.grounded) { const p = mapPoint(body.track,point(body.track, body.s)); return { x: p[0], y: p[2] }; }
      let [x,y,z] = body.position;
      const track=config.tracks[body.track as Track];
      if (track.frame !== 'world') {
        x -= state.frame.position[0]; y-=state.frame.position[1];z -= state.frame.position[2];
        const c = Math.cos(state.frame.yaw), s = Math.sin(state.frame.yaw);
        [x, z] = [c*x-s*z,s*x+c*z];
        if ('anchor' in track) {
          const zone=state.frame.zones[track.anchor];
          x-=zone.position[0];y-=zone.position[1];z-=zone.position[2];
          const [qx,qy,qz,qw]=zone.rotation.map((n,i)=>i<3?-n:n);
          const tx=2*(qy*z-qz*y),ty=2*(qz*x-qx*z),tz=2*(qx*y-qy*x);
          [x,y,z]=[x+qw*tx+qy*tz-qz*ty,y+qw*ty+qz*tx-qx*tz,z+qw*tz+qx*ty-qy*tx];
        }
        [x,y,z]=mapPoint(body.track,[x,y,z]);
      }
      return { x, y: z };
    };
    const projected = players.flatMap(p => { const body = state.actors.find(a => a.id === p.id)?.body; return body ? [{ ...p, ...project(body), grounded: body.grounded, facing: body.facing < 0 ? -1 as const : 1 as const, vy: -body.velocity[1] }] : []; });
    return { mapId: mapId(state.region), map: this.maps.get(state.region), names: { street: '巨石之约', map: config.regions[state.region as Region].name }, self: projected.find(p => p.id === selfId), players: projected,
      npcs: state.people.filter(p => config.tracks[p.track as Track].region === state.region).map((body, i) => ({ id: `colossus-person-${i}`, templateId: 'colossus-person', name: i === 5 ? '港口孩子' : i === 6 ? '补网人' : '船工', facing: 1, ...project(body) })),
      portals: config.passages.filter(p => config.tracks[p.track as Track].region === state.region).map(p => { const q = mapPoint(p.track,point(p.track, p.s)); return { name: p.label, type: 2, x: q[0], y: q[2], targetMapId: null, targetPortalName: null }; }),
    };
  }
}
