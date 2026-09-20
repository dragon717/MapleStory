import config from '../../../../shared/colossus.json';
import type { ColossusBody, ColossusState, PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest, MiniMapMapAsset, WorldMapUiData } from '../../assets/manifest';
import type { MiniMapInput } from '../world/minimap-view';
type Track = keyof typeof config.tracks;
type Region = keyof typeof config.regions;
const mapId = (region:string) => `colossus:${region}`;
function project(track:string,s:number) {
  const t=config.tracks[track as Track];let p=t.points[0];
  for(let i=1;i<t.points.length;i++) {
    const a=t.points[i-1],b=t.points[i],length=Math.hypot(...b.map((n,j)=>n-a[j]));
    p=a.map((n,j)=>n+(b[j]-n)*Math.max(0,Math.min(1,s/length)));
    if(s<=length)break;s-=length;
  }
  return 'anchor' in t && t.anchor==='shin.L'
    ? {x:p[0]-config.staging.kneeSurface[0],y:-(p[1]-config.staging.kneeSurface[1])}
    : {x:p[0],y:p[2]};
}
/** Each stage has a fixed drawing. Only markers move; carrier rotation never redraws the map. */
export class ColossusMaps {
  world?: WorldMapUiData;
  private stage=0;
  private maps=new Map<string,MiniMapMapAsset>();
  constructor(private manifest:Manifest) {
    for(const region of Object.keys(config.regions))for(const standing of [false,true]) {
      const tracks=Object.entries(config.tracks).filter(([id,t])=>t.region===region && (standing?id!=='arrival':id!=='climb'));
      const paths=tracks.map(([id,t])=>{let s=0;return t.points.map((_,i)=>{if(i)s+=Math.hypot(...t.points[i].map((n,j)=>n-t.points[i-1][j]));return project(id,s);});});
      const points=paths.flat(),xs=points.map(p=>p.x),ys=points.map(p=>p.y);
      const world={xMin:Math.min(...xs)-12,yMin:Math.min(...ys)-12,width:Math.max(...xs)-Math.min(...xs)+24,height:Math.max(...ys)-Math.min(...ys)+24};
      const rails=paths.map(path=>`<polyline points="${path.map(p=>`${(p.x-world.xMin)/world.width*230},${(p.y-world.yMin)/world.height*160}`).join(' ')}"/>`).join('');
      const drawing=`<svg xmlns="http://www.w3.org/2000/svg" width="230" height="160"><rect width="230" height="160" fill="${standing?'#a5c5c1':'#c5d9db'}"/><g fill="none" stroke="#637777" stroke-width="6" stroke-linejoin="round">${rails}</g><g fill="none" stroke="#fff3c5" stroke-width="2">${rails}</g></svg>`;
      this.maps.set(`${region}:${standing}`,{mapId:mapId(region),url:`data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawing)}`,width:230,height:160,world,centerX:0,centerY:0,mag:null,mark:'None',source:'P: fixed stage-local authority rails; harbor X/Z, exterior X/height'});
    }
  }
  input(state:ColossusState,players:PlayerState[],selfId:string):MiniMapInput {
    if(this.stage!==state.mapStage && this.manifest.worldMap) {
      this.stage=state.mapStage;
      const baseImg={url:`/assets/colossus/maps/stage-${this.stage}.png`,width:640,height:360,x:0,y:0,origin:{x:320,y:180}} as AssetFrame;
      const page={page:'colossus',parent:null,name:'巨石之约',baseImg,mapLinks:[],mapList:[]};
      this.world={...this.manifest.worldMap,root:'colossus',pages:{colossus:page},allPages:['colossus'],source:'P: GPT Imagegen discovery stages; original TMS273 map window'};
    }
    const at=(body:ColossusBody)=>project(body.track,body.s);
    const projected=players.flatMap(p=>{const body=state.actors.find(a=>a.id===p.id)?.body;return body?[{...p,...at(body),grounded:body.grounded,facing:body.facing<0?-1 as const:1 as const,vy:-body.verticalSpeed}]:[];});
    const standing=state.seconds>=65;
    return {mapId:mapId(state.region),map:this.maps.get(`${state.region}:${standing}`),names:{street:'巨石之约',map:config.regions[state.region as Region].name},self:projected.find(p=>p.id===selfId),players:projected,
      npcs:state.people.filter(p=>config.tracks[p.track as Track].region===state.region).map((b,i)=>({id:`colossus-person-${i}`,templateId:'colossus-person',name:i===5?'港口孩子':i===6?'补网人':'船工',facing:1,...at(b)})),
      portals:config.passages.filter(p=>config.tracks[p.track as Track].region===state.region && (standing||!['climb'].includes(p.toTrack))).map(p=>({name:p.label,type:2,...project(p.track,p.s),targetMapId:null,targetPortalName:null}))};
  }
}
