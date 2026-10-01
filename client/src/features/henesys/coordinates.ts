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
