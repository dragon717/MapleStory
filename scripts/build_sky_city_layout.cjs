// The city GLB and authority share these exact authored centre lines (glTF Y-up, metres).
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),source='resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-layout.json';
const layout=JSON.parse(fs.readFileSync(path.join(root,source),'utf8')),named=new Map(layout.nodes.map(n=>[n.id,n]));
let offset=100000,id=930001;const junctions=new Map(),platforms=[],ppm=45;
const routes=layout.edges.map((edge,ri)=>{
 let x=offset;
 const nodes=edge.points.map((position,i)=>{
  if(i)x+=Math.hypot(position[0]-edge.points[i-1][0],position[2]-edge.points[i-1][2])*ppm;
  const name=i===0?edge.start:i===edge.points.length-1?edge.end:`${edge.id}:${i}`,n={name,x,y:-position[1]*ppm,position};
  const entries=junctions.get(name)??[];entries.push({route:ri,x,y:n.y});junctions.set(name,entries);return n;
 });
 assert.deepEqual(nodes[0].position,named.get(edge.start).position);assert.deepEqual(nodes.at(-1).position,named.get(edge.end).position);
 const segments=nodes.slice(1).map((b,i)=>{const a=nodes[i];assert(b.x>a.x);return {id:id++,x1:a.x,y1:a.y,x2:b.x,y2:b.y,prev:0,next:0,forbidFallDown:1};});
 segments.forEach((f,i)=>{f.prev=segments[i-1]?.id??0;f.next=segments[i+1]?.id??0;});platforms.push(...segments);offset=x+10000;
 return {name:`${named.get(edge.start).label} → ${named.get(edge.end).label}`,kind:edge.kind,width:edge.width,start:nodes[0].x,end:x,loop:edge.start===edge.end,nodes,firstId:segments[0].id,lastId:segments.at(-1).id,edgeId:edge.id};
});
const positions=layout.nodes.map(n=>n.position),xs=positions.map(p=>p[0]),zs=positions.map(p=>p[2]),ys=positions.map(p=>p[1]);
const spawn=routes.find(r=>r.nodes[0].name==='P01').nodes[0];
const data={mapId:'200000000',name:'天空之城',district:'天空之城 · 空港',pixelsPerMetre:ppm,directionSlots:true,source,routes,platforms,junctions:[...junctions].filter(([,entries])=>new Set(entries.map(e=>e.route)).size>1).map(([name,entries])=>({name,entries})),spawn:{x:spawn.x+90,y:spawn.y},bounds:{xMin:routes[0].start,xMax:routes.at(-1).end,yMin:-Math.max(...ys)*ppm-1200,yMax:500},miniBounds:{xMin:Math.min(...xs)-20,yMin:Math.min(...zs)-20,width:Math.max(...xs)-Math.min(...xs)+40,height:Math.max(...zs)-Math.min(...zs)+40}};
fs.writeFileSync(path.join(root,'shared/sky-city.json'),JSON.stringify(data,null,2)+'\n','utf8');
console.log(JSON.stringify({routes:routes.length,segments:platforms.length,junctions:data.junctions.length}));
