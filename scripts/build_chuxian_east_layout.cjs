// The editable Blender layout supplies spatial roads; authority uses isolated arc-distance rails.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(root,'resources/scenes/chuxian-east-v1/source-layout.json'),'utf8'));
// Split crowded multi-road crossings into compact courtyard loops; keep original routes.
if(!source.fourWayJunctions){
 const crowded=new Map();source.routes.forEach((r,ri)=>r.points.forEach((name,i)=>{const entry=crowded.get(name)??new Map();entry.set(ri,(entry.get(ri)??0)+(i>0)+(i<r.points.length-1));crowded.set(name,entry);}));
 for(const [name,roads] of crowded){if([...roads.values()].reduce((a,b)=>a+b,0)<=4)continue;
  const p=source.nodes[name],anchors=[...roads.keys()].map((ri,i)=>{const anchor=i?`${name}-J${i}`:name,angle=i*2*Math.PI/roads.size;
   if(i)source.nodes[anchor]=[p[0]+2.5*(Math.cos(angle)-1),p[1]+2.5*Math.sin(angle),p[2]];
   source.routes[ri].points=source.routes[ri].points.map(n=>n===name?anchor:n);return anchor;
  });
  source.routes.push({name:`${name}庭院岔口`,points:[...anchors,anchors[0]],width:3,kind:'loop'});
 }
 source.fourWayJunctions=true;fs.writeFileSync(path.join(root,'resources/scenes/chuxian-east-v1/source-layout.json'),JSON.stringify(source,null,2)+'\n','utf8');
}
let offset=100000, id=920001;
const junctions=new Map(), platforms=[];
const routes=source.routes.map((route,index)=>{
  let x=offset;
  const nodes=route.points.map((name,i)=>{
    const p=source.nodes[name];
    if(i){const a=source.nodes[route.points[i-1]];x+=Math.hypot(p[0]-a[0],p[1]-a[1])*45;}
    const n={name,x,y:-p[2]*45,position:[p[0],p[2],-p[1]]};
    const entries=junctions.get(name)??[];entries.push({route:index,x,y:n.y});junctions.set(name,entries);return n;
  });
  const segments=nodes.slice(1).map((b,i)=>{const a=nodes[i];assert(b.x>a.x);return {id:id++,x1:a.x,y1:a.y,x2:b.x,y2:b.y,prev:0,next:0,forbidFallDown:1};});
  segments.forEach((f,i)=>{f.prev=segments[i-1]?.id??0;f.next=segments[i+1]?.id??0;});
  platforms.push(...segments);offset=x+10000;
  return {name:route.name,kind:route.kind,width:route.width,start:nodes[0].x,end:x,loop:route.points[0]===route.points.at(-1),nodes,firstId:segments[0].id,lastId:segments.at(-1).id};
});
const first=routes[0].nodes[1];
const data={mapId:'100000000',name:'初弦地',district:'初弦地东边村落',pixelsPerMetre:45,directionSlots:true,source:'resources/scenes/chuxian-east-v1/source-layout.json',routes,platforms,junctions:[...junctions.entries()].filter(([,entries])=>new Set(entries.map(e=>e.route)).size>1).map(([name,entries])=>({name,entries})),spawn:{x:first.x+450,y:first.y+(routes[0].nodes[2].y-first.y)*450/(routes[0].nodes[2].x-first.x)},bounds:{xMin:routes[0].start,xMax:routes.at(-1).end,yMin:-2200,yMax:300},miniBounds:{xMin:-104,yMin:-62,width:208,height:132}};
assert(routes.length>=16);assert(data.junctions.length>10);
fs.writeFileSync(path.join(root,'shared/chuxian-east.json'),JSON.stringify(data,null,2)+'\n','utf8');
console.log(JSON.stringify({routes:routes.length,segments:platforms.length,junctions:data.junctions.length}));
