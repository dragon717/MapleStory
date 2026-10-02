const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRequire}=require('node:module'),root=path.resolve(__dirname,'..'),out=path.join(root,'build/.checks/voyage-city.cjs');
fs.mkdirSync(path.dirname(out),{recursive:true});
createRequire(path.join(root,'client/package.json'))('esbuild').buildSync({stdin:{contents:"export * from './voyage-city'; export * as T from 'three';",resolveDir:path.join(root,'client/src/features/entry'),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'silent'});
const {VoyageCity,islandOffset,T}=require(out),source=JSON.parse(fs.readFileSync(path.join(root,'resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-layout.json'),'utf8'));
for(const island of source.landscape.islands)for(let t=0;t<=180;t+=.5){const h=islandOffset(island,t,2,source.landscape.motion);assert(Number.isFinite(h)&&Math.abs(h)<=3.680001);}
const island=source.landscape.islands[0],other=source.landscape.islands[1],points=[[0,0,0],[10,0,0]],link={id:'road',start:'a',end:'b',points,surface:'suspension'};
const model=new T.Group();model.position.set(450,-80,-2200);model.scale.setScalar(1.8);
model.userData.spatial_layout=JSON.stringify({nodes:[{id:'a',islandWeights:{[island.id]:1}},{id:'b',islandWeights:{[other.id]:1}}],edges:[link],physicalLinks:[],landscape:{islands:[island,other],motion:source.landscape.motion}});
const geometry=new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute([0,0,0,10,0,0],3));
const deck=new T.Mesh(geometry,new T.MeshBasicMaterial());deck.userData.edge_id='road';model.add(deck);
const carrier=new T.Mesh(geometry.clone(),deck.material);carrier.userData.support_edge='road';model.add(carrier);
const plantGeometry=new T.BoxGeometry(),plantMaterial=new T.MeshBasicMaterial();
for(let i=0;i<2;i++){const plant=new T.Mesh(plantGeometry,plantMaterial);plant.userData.asset_module='test';plant.userData.island_binding=island.id;plant.position.x=i*4;model.add(plant);}
const city=new VoyageCity(model);city.update(.05,false,2);const p=deck.geometry.attributes.position.array;
assert(Math.abs(p[1]-city.nodeOffset('a'))<1e-6&&Math.abs(p[4]-city.nodeOffset('b'))<1e-6,'placed/scaled city must keep local endpoint ownership');
assert.deepEqual(p,carrier.geometry.attributes.position.array,'road and rock carrier share deformation');
assert(city.islandRoot(island.id).children.some(o=>o.isInstancedMesh&&o.count===2),'shared plant geometry must batch within its island');
const time=city.status().motionTime;city.update(3600,true);assert.equal(city.status().motionTime,time);assert.equal(deck.geometry.attributes.position.getY(0),0);
city.update(.05,false,0);assert.equal(deck.geometry.attributes.position.getY(1),0);assert.equal(city.islandRoot(island.id).position.y,0);
console.log('Voyage city: bounded energy, local endpoints under placement/scale, carrier agreement, island plant batching and reduced/zero motion passed');
