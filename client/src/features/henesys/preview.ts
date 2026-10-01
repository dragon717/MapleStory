import east from '../../../../shared/chuxian-east.json';
// Development-only entry: the production build has only index.html.
import Phaser from 'phaser';
import { installGameAudio } from '../world/game-audio';
import { loadManifest, type MapDefinition } from '../../assets/manifest';
import { World } from '../../scenes/world';
import { ActivitiesView } from '../windbell/activities';
import type { PlayerState, ServerMessage } from '../../../../shared/protocol';
import { HENESYS_MAP_ID } from './coordinates';
const manifest = await loadManifest();
manifest.map = manifest.mapCatalog!.maps.find(map => map.id === HENESYS_MAP_ID) as MapDefinition;
const status = (message: string) => { document.querySelector('output')!.textContent = message; };
const world = new World(manifest, status, undefined, npc => { status(`NPC 点击：${npc.id}`); });
const canvas = document.createElement('canvas');
const context = canvas.getContext('webgl2', {alpha:true,stencil:true,depth:true,antialias:false,powerPreference:'high-performance'});
let game:Phaser.Game;
const gameAudio=installGameAudio(document.body,()=>game);
game = new Phaser.Game({canvas,context:context as unknown as CanvasRenderingContext2D,type: Phaser.WEBGL, parent:'game', transparent:true, pixelArt:true, roundPixels:true, scene:[world], scale:{mode:Phaser.Scale.RESIZE}, input:{keyboard:false}, audio:{noAudio:!new URLSearchParams(location.search).has("audio"),context:gameAudio.context()}});
gameAudio.bind(game);
const activities = new ActivitiesView(document.querySelector('#windows')!, () => {}, () => {}, undefined, undefined, undefined, manifest, {enabled:()=>world.isThreeActive,available:()=>world.mapId===HENESYS_MAP_ID&&world.isLoaded,setEnabled:value=>world.setThreeEnabled(value),resetCamera:()=>world.resetThreeCamera(),toggleQuality:()=>world.toggleThreeQuality(),previewSky:value=>world.previewSky(value),environment:{get:()=>world.environment,set:value=>world.setEnvironment(value)},audio:{spatial:()=>world.spatialAudioEnabled,setSpatial:value=>world.setSpatialAudio(value),volume:()=>world.soundVolume,setVolume:value=>world.setSoundVolume(value)}});
document.querySelector('#activities')!.addEventListener('click', () => activities.show());
const player: PlayerState = {id:'preview',username:'原版纸娃娃',x:east.spawn.x,y:east.spawn.y,vx:0,vy:0,facing:1,grounded:true,action:'stand',actionId:null,actionStartedTick:0,lastInputSeq:0,climbing:false,ladderId:null,hp:50,maxHp:50,mp:30,maxMp:30,level:1,exp:0,expToNext:15,mesos:123,inventory:[]};
const snapshot: Extract<ServerMessage,{type:'snapshot'}> = {type:'snapshot',serverTick:1,tickMs:50,mapId:HENESYS_MAP_ID,selfId:player.id,players:[player],monsters:[],drops:[],npcs:[]};
// Test driver sends normal protocol messages through World.receive, never a second gameplay implementation.
const timer = setInterval(() => { snapshot.serverTick++; world.receive(snapshot); }, 50);
Object.assign(window, {henesysPreview:{game,world,manifest,snapshot,timer,activities}});
