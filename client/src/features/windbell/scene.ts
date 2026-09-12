import Phaser from 'phaser';
import type { WindbellState, PlayerState } from '../../../../shared/protocol';
import config from '../../../../shared/windbell.json';
import { WINDBELL_ASSETS as A } from './maps';

/** Visuals follow the same authored foot coordinates as Rust; no local physics. */
export class WindbellScene {
  static readonly sounds=['cut_rope','bridge_land','fire_ignite','fire_extinguish','wing_open','material_handoff','cart_wood_support','craftsman_install','arrival','bell'];
  private previous?: WindbellState;
  private dynamic: Phaser.GameObjects.Container;
  private wing: Phaser.GameObjects.Image;
  private dragon?: Phaser.GameObjects.Image;
  private cart?: Phaser.GameObjects.Image;
  private falling?: Phaser.GameObjects.TileSprite;
  private fallElapsed = 0;
  private last = '';
  private clock = 0;
  constructor(private scene: Phaser.Scene, private kind: 'island'|'bridge') {
    this.dynamic = scene.add.container(0,0).setDepth(-1);
    const map = config.maps[kind];
    for (const f of map.footholds) this.platform(f.x1,f.y1,f.x2,f.y2, f.id===5 && kind==='island' ? 'wood':'ground');
    if (kind==='island') {
      const ladder = config.maps.island.ladders[0];
      const rope = scene.add.graphics().setDepth(-2); rope.lineStyle(5,0x866144); rope.lineBetween(ladder.x,ladder.y1,ladder.x,ladder.y2);
      for(let y=ladder.y1;y<ladder.y2;y+=24){rope.lineStyle(3,0xc6a577);rope.lineBetween(ladder.x-7,y,ladder.x+7,y+3);}
      this.prop('prop-waystation',2310,550,380); this.prop('prop-bell',2420,455,40);
      this.prop('prop-leafwing',1100,1080,88);
      this.dragon=this.prop('prop-dragon',1500,260,220).setDepth(-3);
      this.label('支撑绳',560,590); this.label('干枝 · 叶翼',1060,1030); this.label('根道 →',790,1160); this.label('树梢驿站',2300,370);
    } else { this.prop('prop-waystation',2130,700,330); this.prop('prop-materials',630,700,125); this.label('材料交接处',650,550); }
    this.wing = this.prop('prop-leafwing',0,0,100).setDepth(2).setVisible(false);
  }
  private label(text:string,x:number,y:number){return this.scene.add.text(x,y,text,{fontSize:'17px',fontFamily:'sans-serif',color:'#fff8d6',stroke:'#264839',strokeThickness:4}).setOrigin(.5,1).setDepth(3);}
  private prop(name:string,x:number,y:number,width:number){const image=this.scene.add.image(x,y,A+name+'.png').setOrigin(.5,1).setDepth(-1);return image.setDisplaySize(width,width*image.height/image.width);}
  private platform(x1:number,y1:number,x2:number,y2:number,texture:string,parent?:Phaser.GameObjects.Container){
    const length=Math.hypot(x2-x1,y2-y1);
    const sprite=this.scene.add.tileSprite(x1,y1,length,texture==='wood'?24:60,A+texture+'.png').setOrigin(0,0).setRotation(Math.atan2(y2-y1,x2-x1)).setDepth(-2);
    if(parent)parent.add(sprite);
    return sprite;
  }
  update(state:WindbellState|undefined,player:PlayerState|undefined,delta:number,tickMs=50){
    if(!state)return;
    const old=this.previous;
    if(old){
      const cues:string[]=[];
      if(state.treeBridge!==old.treeBridge)cues.push(state.treeBridge==='falling'?'cut_rope':'bridge_land');
      if(state.heat!==old.heat)cues.push(state.heat==='burning'?'fire_ignite':'fire_extinguish');
      if(state.leafwing&&!old.leafwing)cues.push('wing_open');
      if(state.planks<old.planks||state.ropes<old.ropes)cues.push('material_handoff');
      if(state.cartUpright&&!old.cartUpright)cues.push('cart_wood_support');
      if((state.bridgeSegments??0)>(old.bridgeSegments??0))cues.push('craftsman_install');
      if((state.arrivalPath&&!old.arrivalPath)||(state.bridgeStage==='inhabited'&&old.bridgeStage!=='inhabited'))cues.push('arrival','bell');
      for(const cue of cues){const key=A+'sfx/'+cue+'.ogg';if(this.scene.cache.audio.exists(key))this.scene.sound.play(key,{volume:.25});}
    }
    this.previous=state;
    const key=[state.treeBridge,state.heat,state.bridgeStage,state.cartUpright,state.bridgeSegments].join('|');
    if(key!==this.last){
      this.dynamic.removeAll(true); this.cart=undefined; this.falling=undefined; this.fallElapsed=0;
      if(this.kind==='island'){
        const f=config.island.treeBridge.dynamicFoothold;
        if(state.treeBridge==='landed')this.platform(f.x1,f.y1,f.x2,f.y2,'wood',this.dynamic);
        else this.falling=this.platform(f.x1,f.y1,f.x1+720,f.y1-280,'wood',this.dynamic);
        const fire=this.scene.add.graphics();this.dynamic.add(fire);
        if(state.treeBridge==='held'){fire.lineStyle(4,0xa08050);fire.lineBetween(560,650,560,500);fire.lineBetween(560,500,1150,455);}
        fire.fillStyle(0x657a70);fire.fillEllipse(1060,1100,110,24);
        if(state.heat==='burning'){
          fire.fillStyle(0xffb740,.85);fire.fillTriangle(1020,1090,1065,990,1100,1090);
          fire.lineStyle(3,0xffde91,.6);for(let i=0;i<4;i++)fire.lineBetween(1010+i*60,1000,1020+i*60,380);
        }
      }else{
        const count=state.bridgeSegments ?? (['connected','inhabited'].includes(state.bridgeStage)?3:0);
        for(const f of config.bridge.segments.slice(0,count))this.platform(f.x1,f.y1,f.x2,f.y2,'wood',this.dynamic);
        if(count===0) {this.platform(800,700,1000,780,'wood',this.dynamic);this.platform(1400,780,1600,700,'wood',this.dynamic);}
        this.cart=this.prop('prop-cart',state.cartX ?? 450,700,190).setAngle(state.cartUpright?0:-12);this.dynamic.add(this.cart);
      }
      this.last=key;
    }
    if(this.cart && state.cartX!==undefined)this.cart.x=state.cartX;
    if(this.falling && state.treeBridge==='falling'){
      this.fallElapsed+=delta;
      const t=Math.min(1,this.fallElapsed/(config.island.treeBridge.fallingTicks*tickMs));
      const f=config.island.treeBridge.dynamicFoothold;
      this.falling.rotation=Phaser.Math.Linear(Math.atan2(-280,720),Math.atan2(f.y2-f.y1,f.x2-f.x1),t);
      this.falling.width=Phaser.Math.Linear(Math.hypot(720,280),Math.hypot(f.x2-f.x1,f.y2-f.y1),t);
    }
    this.clock+=delta;
    if(this.dragon){this.dragon.x=1400+Math.sin(this.clock/7000)*380;this.dragon.y=260+Math.sin(this.clock/1800)*12;}
    this.wing.setVisible(Boolean(player&&state.leafwing&&!player.grounded));if(player)this.wing.setPosition(player.x,player.y-35);
  }
  destroy(){this.dynamic.destroy();this.wing.destroy();this.dragon?.destroy();}
}
