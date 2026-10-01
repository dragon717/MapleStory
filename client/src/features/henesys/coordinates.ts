import type { MovementView } from '../../../../shared/protocol';
import east from '../../../../shared/chuxian-east.json';
export const HENESYS_MAP_ID = east.mapId;
export const PIXELS_PER_METRE = east.pixelsPerMetre;
export const platformThickness = (_id: number) => 20;
export function segmentAt(x: number) {
  const route=east.routes.find(r=>x>=r.start-200&&x<=r.end+200)??east.routes[0];
  let i=route.nodes.findIndex((n,j)=>j>0&&x<=n.x);if(i<1)i=route.nodes.length-1;
  return {route,a:route.nodes[i-1],b:route.nodes[i]};
}
export function point3d(x: number,y: number): [number,number,number] {
  const {a,b}=segmentAt(x),t=(x-a.x)/(b.x-a.x);
  return [a.position[0]+(b.position[0]-a.position[0])*t,-y/PIXELS_PER_METRE,a.position[2]+(b.position[2]-a.position[2])*t];
}
export function miniPoint(x:number,y:number){const p=point3d(x,y);return {x:p[0],y:p[2]};}
export type JunctionDirection = 'up' | 'down' | 'left' | 'right' | 'upLeft' | 'upRight' | 'downLeft' | 'downRight';
/** Display-only mirror of server/src/henesys.rs::turn: same range, score and tie order. */
export function junctionDirections(x:number,view?:MovementView): JunctionDirection[] {
  // Rust JSON decoding and snapshot serialization can differ by one ULP at a road end.
  const epsilon=1e-7,route=east.routes.findIndex(r=>x>=r.start-epsilon&&x<=r.end+epsilon);
  if(route<0)return [];
  const hinted=new Set<number>();
  return (['up','down','left','right','upLeft','upRight','downLeft','downRight'] as const).filter(direction=>{
    const horizontal=direction==='left'||direction.endsWith('Left')?-1:direction==='right'||direction.endsWith('Right')?1:0;
    const vertical=direction.startsWith('up')?-1:direction.startsWith('down')?1:0;
    let best:number|undefined,score=.25;
    for(const junction of east.junctions){
      if(!junction.entries.some(e=>e.route===route&&Math.abs(e.x-x)<=55+epsilon))continue;
      for(const entry of junction.entries){
        const nodes=east.routes[entry.route].nodes;
        nodes.forEach((node,i)=>{
          if(Math.abs(node.x-entry.x)>=.01)return;
          for(const side of [-1,1]){
            const other=nodes[i+side];if(!other)continue;
            const dx=other.position[0]-node.position[0],dz=other.position[2]-node.position[2];
            const dy=other.position[1]-node.position[1];
            const right=view?dx*Math.cos(view.yaw)-dz*Math.sin(view.yaw):dx;
            const down=view?(dx*Math.sin(view.yaw)+dz*Math.cos(view.yaw))*Math.sin(view.pitch)-dy*Math.cos(view.pitch):dz;
            const alignment=(right*horizontal+down*vertical)/Math.max(1e-9,Math.hypot(right,down));
            if(alignment>score+.001){score=alignment;best=entry.route;}
          }
        });
      }
    }
    if(best===undefined||best===route)return false;
    const fresh=!hinted.has(best);hinted.add(best);
    // Show a diagonal only when this road cannot be selected by a single arrow key.
    return direction.length<=5||fresh;
  });
}

// A junction changes the authority's arc-distance chart, not the physical location.
type Foot = {x:number;y:number};
type Road = typeof east.routes[number];
type ArcPath = {exit:number;before:number;after:number;fromRoad:Road;toRoad:Road};
function arcDelta(road:Road,from:number,to:number){
  let delta=to-from;
  if(road.loop&&Math.abs(delta)>(road.end-road.start)/2)delta-=Math.sign(delta)*(road.end-road.start);
  return delta;
}
function junctionPath(a:Foot,b:Foot){
  const from=east.routes.findIndex(r=>a.x>=r.start-1e-7&&a.x<=r.end+1e-7);
  const to=east.routes.findIndex(r=>b.x>=r.start-1e-7&&b.x<=r.end+1e-7);
  if(from<0||to<0)return;
  if(from===to)return {exit:0,before:arcDelta(east.routes[from],a.x,b.x),after:0,fromRoad:east.routes[from],toRoad:east.routes[to]};
  let best:ArcPath|undefined;
  for(const junction of east.junctions)for(const entry of junction.entries.filter(e=>e.route===from))for(const exit of junction.entries.filter(e=>e.route===to)){
    const before=arcDelta(east.routes[from],a.x,entry.x),after=arcDelta(east.routes[to],exit.x,b.x);
    if(!best||Math.abs(before)+Math.abs(after)<Math.abs(best.before)+Math.abs(best.after))best={exit:exit.x,before,after,fromRoad:east.routes[from],toRoad:east.routes[to]};
  }
  return best;
}
export function eastMotionDistance(a:Foot,b:Foot){
  const path=junctionPath(a,b);
  return path?Math.hypot(Math.abs(path.before)+Math.abs(path.after),b.y-a.y):Infinity;
}
export function eastMotionBlend(a:Foot,b:Foot,f:number):Foot{
  const path=junctionPath(a,b);if(!path)return b;
  const before=Math.abs(path.before),length=before+Math.abs(path.after),travel=length*f;
  const sameRoad=path.fromRoad===path.toRoad,onOld=sameRoad||travel<before,road=onOld?path.fromRoad:path.toRoad;
  let x=sameRoad?a.x+path.before*f:onOld?a.x+Math.sign(path.before)*travel:path.exit+Math.sign(path.after)*(travel-before);
  if(road.loop)x=road.start+((x-road.start)%(road.end-road.start)+(road.end-road.start))%(road.end-road.start);
  const ground=(x:number)=>{const {a,b}=segmentAt(x);return a.y+(b.y-a.y)*(x-a.x)/(b.x-a.x);};
  // Preserve the road foot height and interpolate only the height of an existing hop.
  return {x,y:ground(x)+(a.y-ground(a.x))*(1-f)+(b.y-ground(b.x))*f};
}
