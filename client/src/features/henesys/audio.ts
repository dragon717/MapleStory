import Phaser from 'phaser';
import type { PlayerState } from '../../../../shared/protocol';
import { MUSIC_SPOTS, point3d, segmentAt } from './coordinates';
import footsteps from '../../../../shared/chuxian-audio.json';

export const FOOT_SOUNDS = Object.values(footsteps.sounds).flat().map(s=>s.url);
type Point = [number,number,number];
type Source = {sound:Phaser.Sound.WebAudioSound;panner:PannerNode;owner?:string;point?:Point};
export class VillageAudio {
  private manager:Phaser.Sound.WebAudioSoundManager;
  private context:AudioContext;
  private nodes:AudioNode[]=[];
  private sources=new Map<Phaser.Sound.BaseSound,Source>();
  private owned=new Set<Phaser.Sound.BaseSound>();
  private steps=new Map<string,{point:Point;grounded:boolean;distance:number;last:number;at:number;speed:number;variant:number}>();
  private players=new Map<string,PlayerState>();
  private listener?:Point;
  private yaw=0;
  private pitch=0;
  private dry:GainNode;
  private spatial:GainNode;
  private wet:GainNode;
  private music:PannerNode[]=[];
  private bgm:Phaser.Sound.WebAudioSound;
  private enabled=true;
  private disposed=false;
  constructor(private scene:Phaser.Scene,bgm:Phaser.Sound.WebAudioSound){
    this.manager=scene.sound as Phaser.Sound.WebAudioSoundManager;this.context=this.manager.context;this.bgm=bgm;
    const c=this.context, destination=this.manager.destination;
    this.dry=c.createGain();this.spatial=c.createGain();this.wet=c.createGain();
    this.dry.connect(destination);this.spatial.connect(destination);this.wet.gain.value=.12;this.wet.connect(this.spatial);
    const reverb=c.createConvolver(),impulse=c.createBuffer(2,Math.round(c.sampleRate*.65),c.sampleRate);
    let seed=273;
    for(let channel=0;channel<2;channel++){
      const data=impulse.getChannelData(channel);
      for(let i=0;i<data.length;i++){seed=(1664525*seed+1013904223)>>>0;data[i]=(seed/2147483648-1)*Math.exp(-i/c.sampleRate*10)*.28;}
    }
    reverb.buffer=impulse;reverb.connect(this.wet);
    this.nodes.push(this.dry,this.spatial,this.wet,reverb);
    bgm.volumeNode.disconnect();bgm.volumeNode.connect(this.dry);
    // The original is a stereo mix, not stems: retain it and gently place filtered colour at props.
    MUSIC_SPOTS.forEach(spot=>{
      const filter=c.createBiquadFilter(),gain=c.createGain(),pan=this.panner();
      filter.type=spot.type;filter.frequency.value=spot.frequency;filter.Q.value=.55;gain.gain.value=.24;
      bgm.volumeNode.connect(filter);filter.connect(gain);gain.connect(pan);pan.connect(this.spatial);pan.connect(reverb);
      this.music.push(pan);this.nodes.push(filter,gain,pan);
    });
    this.reverb=reverb;
    try{this.enabled=localStorage.getItem('chuxian-spatial-audio')!=='off';}catch{}
    this.dry.gain.value=this.enabled?.85:1;this.spatial.gain.value=this.enabled?1:0;
  }
  private reverb:ConvolverNode;
  get spatialEnabled(){return this.enabled;}
  setSpatial(enabled:boolean){
    this.enabled=enabled;try{localStorage.setItem('chuxian-spatial-audio',enabled?'on':'off');}catch{}
    this.dry.gain.setTargetAtTime(enabled?.85:1,this.context.currentTime,.15);
    this.spatial.gain.setTargetAtTime(enabled?1:0,this.context.currentTime,.15);
    for(const source of this.sources.values())this.place(source.panner,this.sourcePoint(source));
  }
  private panner(){const p=this.context.createPanner();p.panningModel='HRTF';p.distanceModel='inverse';p.refDistance=5;p.maxDistance=100;p.rolloffFactor=1.25;return p;}
  private sourcePoint(source:Source):Point|undefined{
    const player=source.owner?this.players.get(source.owner):undefined;
    return source.point??(player?point3d(player.x,player.y):undefined);
  }
  private place(p:PannerNode,point?:readonly number[],music=false){
    let x=0,y=0,z=0;
    if(this.listener&&point&&(this.enabled||music)){
      const dx=point[0]-this.listener[0],dy=point[1]-this.listener[1],dz=point[2]-this.listener[2];
      x=dx*Math.cos(this.yaw)-dz*Math.sin(this.yaw);
      const forward=dx*Math.sin(this.yaw)+dz*Math.cos(this.yaw);
      y=dy*Math.cos(this.pitch)-forward*Math.sin(this.pitch);z=forward*Math.cos(this.pitch)+dy*Math.sin(this.pitch);
    }
    const t=this.context.currentTime;
    p.positionX.setTargetAtTime(x,t,.04);p.positionY.setTargetAtTime(y,t,.04);p.positionZ.setTargetAtTime(z,t,.04);
  }
  attach(sound:Phaser.Sound.BaseSound,owner?:string,point?:{x:number;y:number}){
    if(this.disposed||!(sound instanceof Phaser.Sound.WebAudioSound)||this.sources.has(sound))return;
    const p=sound.spatialNode;if(!p)return;
    p.panningModel='HRTF';p.refDistance=5;p.rolloffFactor=1.25;
    const source:Source={sound,panner:p,owner,point:point?point3d(point.x,point.y):undefined};
    this.sources.set(sound,source);this.place(p,this.sourcePoint(source));
    p.connect(this.reverb);
    sound.once('destroy',()=>{this.sources.delete(sound);this.owned.delete(sound);});
  }
  play(key:string,volume:number,owner?:string,point?:{x:number;y:number}){
    if(this.disposed||this.context.state!=='running'||document.hidden||!this.scene.cache.audio.exists(key))return;
    const sound=this.scene.sound.add(key);this.owned.add(sound);this.attach(sound,owner,point);
    sound.once('complete',()=>sound.destroy());if(!sound.play({volume}))sound.destroy();
  }
  update(players:PlayerState[],selfId:string,view?:{yaw:number;pitch:number},now=performance.now()){
    const self=players.find(p=>p.id===selfId);if(!self)return;
    this.players=new Map(players.map(p=>[p.id,p]));this.listener=point3d(self.x,self.y);this.listener[1]+=1.4;
    this.yaw=view?.yaw??0;this.pitch=view?.pitch??0;
    MUSIC_SPOTS.forEach((spot,i)=>this.place(this.music[i],[spot.position[0],spot.position[1]+1,spot.position[2]],true));
    for(const source of this.sources.values())this.place(source.panner,this.sourcePoint(source));
    const audible=this.context.state==='running'&&!document.hidden&&!this.manager.mute;
    for(const player of players){
      const point=point3d(player.x,player.y),previous=this.steps.get(player.id);
      const distance=previous?Math.hypot(...point.map((v,i)=>v-previous.point[i])):0;
      const dt=previous?now-previous.at:0;
      const nearby=Math.hypot(...point.map((v,i)=>v-this.listener![i]))<28;
      // Physical metres ignore route-chart changes; teleports and stale frames never emit a backlog.
      const valid=Boolean(previous&&dt>0&&dt<=200&&distance<1.8&&audible&&nearby&&player.hp>0&&!player.mount&&!player.chair&&!player.climbing);
      let accumulated=valid?previous!.distance:0,last=previous?.last??now;
      let speed=valid?previous!.speed:0,variant=previous?.variant??Math.floor(Math.random()*6);
      const route=segmentAt(player.x).route,samples=footsteps.sounds[route.kind==='dock'?'wood':route.name==='林根小径'?'grass':'stone'];
      const foot=(volume:number)=>{const sample=samples[variant%samples.length];variant++;this.play(sample.url,Math.min(1,volume*sample.gain),player.id);last=now;};
      if(valid&&player.grounded){
        if(!previous!.grounded){foot(.21);accumulated=0;speed=0;}
        else if(player.action==='walk'&&distance>1e-4){
          const measured=distance*1000/dt;
          speed=speed?speed+(measured-speed)*(1-Math.exp(-dt/160)):measured;
          // Faster motion lengthens strides as well as cadence; recordings keep their natural pitch.
          const stride=Math.min(1.3,Math.max(.7,.62+.18*speed));
          accumulated+=distance;
          if(accumulated>=stride&&now-last>=180){foot(Math.min(.18,.10+.02*speed));accumulated%=stride;}
        }else {accumulated=0;speed=0;}
      }else {accumulated=0;speed=0;}
      this.steps.set(player.id,{point,grounded:player.grounded,distance:accumulated,last:audible?last:now,at:now,speed,variant});
    }
    for(const id of this.steps.keys())if(!this.players.has(id))this.steps.delete(id);
  }
  destroy(){
    if(this.disposed)return;this.disposed=true;
    for(const sound of [...this.owned])sound.destroy();
    for(const source of this.sources.values()){try{source.panner.disconnect(this.reverb);}catch{};source.panner.positionX.value=source.panner.positionY.value=source.panner.positionZ.value=0;}
    this.sources.clear();this.steps.clear();this.players.clear();
    this.bgm.volumeNode.disconnect();this.bgm.volumeNode.connect(this.bgm.spatialNode);
    for(const node of this.nodes)node.disconnect();
  }
}
