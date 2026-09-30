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
