// Replace >4-way junctions with small walkable courtyard loops, preserving every exit.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),file=path.join(root,'resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-layout.json');
const layout=JSON.parse(fs.readFileSync(file,'utf8'));
if(!layout.fourWayJunctions){
 const degrees=new Map();
 for(const edge of layout.edges)for(const side of ['start','end']){const list=degrees.get(edge[side])??[];list.push({edge,side});degrees.set(edge[side],list);}
 for(const [id,exits] of degrees){
  if(exits.length<=4)continue;
  const node=layout.nodes.find(n=>n.id===id),p=node.position;
  // Keep the first authored road and its landing/portal coordinate unchanged.
  const anchors=exits.map((exit,i)=>{
   const angle=2*Math.PI*i/exits.length,radius=4;
   const position=i===0?p.slice():[p[0]+radius*(Math.cos(angle)-1),p[1],p[2]+radius*Math.sin(angle)];
   const anchor=i===0?node:{...node,id:`${id}-J${i}`,label:`${node.label}·岔口${i}`,position};
   if(i)layout.nodes.push(anchor);
   exit.edge[exit.side]=anchor.id;
   exit.edge.points[exit.side==='start'?0:exit.edge.points.length-1]=position;
   return anchor;
  });
  for(let i=0;i<anchors.length;i++){
   const a=anchors[i],b=anchors[(i+1)%anchors.length],edgeId=`J-${id}-${i}`;
   layout.edges.push({id:edgeId,route:'arrival',routes:['arrival'],start:a.id,end:b.id,width:3,points:[a.position,b.position],length:Math.hypot(a.position[0]-b.position[0],a.position[2]-b.position[2]),origin:'P',gradeDegrees:0,undersideWalkable:false,kind:'walkway',interior:false,surface:'terrace',carrier:'existing-courtyard-landing'});
  }
 }
 layout.fourWayJunctions=true;
 fs.writeFileSync(file,JSON.stringify(layout,null,2)+'\n','utf8');
}
// Single-edge physical links use that edge's direction; no stale renamed endpoint inference.
let changed=false;
for(const link of layout.physicalLinks){
 if(link.edges.length!==1)continue;
 const edge=layout.edges.find(e=>e.id===link.edges[0]);
 if(link.start!==edge.start||link.end!==edge.end||JSON.stringify(link.points)!==JSON.stringify(edge.points))changed=true;
 link.start=edge.start;link.end=edge.end;link.points=edge.points;
}
for(const edge of layout.edges){const length=Math.round(edge.points.slice(1).reduce((sum,b,i)=>sum+Math.hypot(...b.map((v,j)=>v-edge.points[i][j])),0)*100)/100;if(edge.length!==length)changed=true;edge.length=length;}
if(changed)fs.writeFileSync(file,JSON.stringify(layout,null,2)+'\n','utf8');
const counts=new Map();for(const e of layout.edges)for(const id of [e.start,e.end])counts.set(id,(counts.get(id)??0)+1);
assert([...counts.values()].every(n=>n<=4),'all paths selectable with one of four arrows');
console.log(JSON.stringify({fourWay:true,roads:layout.edges.length,maxDegree:Math.max(...counts.values())}));
