// Development-only entry: the production build has only index.html.
import Phaser from 'phaser';
import { loadManifest, type MapDefinition } from '../../assets/manifest';
import { World } from '../../scenes/world';
import { ActivitiesView } from '../windbell/activities';
import type { PlayerState, ServerMessage } from '../../../../shared/protocol';
import { HENESYS_MAP_ID } from './coordinates';
const manifest = await loadManifest();
manifest.map = manifest.mapCatalog!.maps.find(map => map.id === HENESYS_MAP_ID) as MapDefinition;
const status = (message: string) => { document.querySelector('output')!.textContent = message; };
const world = new World(manifest, status, undefined, npc => { status(`NPC 点击：${npc.id}`); });
const game = new Phaser.Game({type: Phaser.WEBGL, parent:'game', transparent:true, pixelArt:true, roundPixels:true, scene:[world], scale:{mode:Phaser.Scale.RESIZE}, input:{keyboard:false}, audio:{noAudio:true}});
const activities = new ActivitiesView(document.querySelector('#windows')!, () => {}, () => {}, undefined, undefined, undefined, manifest, {enabled:()=>world.isThreeActive,available:()=>world.mapId===HENESYS_MAP_ID&&world.isLoaded,setEnabled:value=>world.setThreeEnabled(value),resetCamera:()=>world.resetThreeCamera()});
document.querySelector('#activities')!.addEventListener('click', () => activities.show());
const player: PlayerState = {id:'preview',username:'原版纸娃娃',x:698,y:297,vx:0,vy:0,facing:1,grounded:true,action:'stand',actionId:null,actionStartedTick:0,lastInputSeq:0,climbing:false,ladderId:null,hp:50,maxHp:50,mp:30,maxMp:30,level:1,exp:0,expToNext:15,mesos:123,inventory:[]};
const snapshot: Extract<ServerMessage,{type:'snapshot'}> = {type:'snapshot',serverTick:1,tickMs:50,mapId:HENESYS_MAP_ID,selfId:player.id,players:[player],monsters:[],drops:[],npcs:[]};
// Test driver sends normal protocol messages through World.receive, never a second gameplay implementation.
const timer = setInterval(() => { snapshot.serverTick++; world.receive(snapshot); }, 50);
Object.assign(window, {henesysPreview:{game,world,manifest,snapshot,timer,activities}});
