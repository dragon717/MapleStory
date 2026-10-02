// Remove the out-and-back landing spurs; the existing side-room exits remain connected.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),file=path.join(root,'resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-layout.json');
const layout=JSON.parse(fs.readFileSync(file,'utf8'));
for(const node of layout.nodes.filter(n=>/^G-(\d+|B[12])$/.test(n.id))){
 node.position[0]=layout.tower.center[0]+10;
 const landing=layout.landings.find(l=>l.node===node.id);if(landing)landing.position=node.position.slice();
}
const named=new Map(layout.nodes.map(n=>[n.id,n]));
for(const edge of layout.edges){
 if(edge.interior&&edge.kind==='stairs'&&/^G-(\d+|B[12])$/.test(edge.start)&&/^G-(\d+|B[12])$/.test(edge.end)){
  if(!edge.continuous)edge.points=edge.points.slice(1,-1);
  edge.continuous='tower-spiral';
 }
 edge.points[0]=named.get(edge.start).position.slice();edge.points[edge.points.length-1]=named.get(edge.end).position.slice();
 edge.length=Math.round(edge.points.slice(1).reduce((sum,b,i)=>sum+Math.hypot(...b.map((v,j)=>v-edge.points[i][j])),0)*100)/100;
}
for(const link of layout.physicalLinks){if(link.edges.length===1){const e=layout.edges.find(e=>e.id===link.edges[0]);link.points=e.points;}}
fs.writeFileSync(file,JSON.stringify(layout,null,2)+'\n','utf8');
