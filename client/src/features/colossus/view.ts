import type { ColossusAction, ServerMessage, NpcState } from '../../../../shared/protocol';
import type { Manifest } from '../../assets/manifest';
import type { ColossusScene } from './scene';
import { ColossusMaps } from './maps';
import config from '../../../../shared/colossus.json';
import './style.css';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
export type ColossusControl = 'replay' | 'skip' | 'orbit' | 'quality' | 'leave';

/** Owns only the renderer. HUD, maps, controls and messages use the existing game UI. */
export class ColossusView {
  private root = document.createElement('section');
  private canvas = document.createElement('div');
  private scene?: ColossusScene;
  private latest?: Snapshot;
  private gone = false;
  private low = false;
  private muted = false;
  private caption = '';
  readonly maps: ColossusMaps;
  constructor(host: HTMLElement, manifest: Manifest, private send: (action: ColossusAction) => void, private notify: (text: string) => void, private talk: (npc: NpcState) => void) {
    this.maps = new ColossusMaps(manifest);
    manifest.npcs ??= {};
    for (const name of ['harbor-worker', 'harbor-child', 'netmender'] as const) manifest.npcs['colossus-'+name] = { name, source: 'original colossus character art', stand: [{ url: config.art[name], width: 1024, height: 1536, x: 0, y: 0, origin: {x:0,y:0}, delay:100 }] };
    this.root.className = 'colossus-view';
    this.root.setAttribute('aria-label', '巨石之约');
    this.canvas.className = 'colossus-canvas';
    this.root.append(this.canvas);
    host.classList.add('show-colossus');
    host.append(this.root);
    void import('./scene').then(async ({ ColossusScene }) => {
      if (this.gone) return;
      this.scene = await ColossusScene.create(this.canvas, manifest, text => {
        if (this.caption === text) return;
        this.caption = text;
        this.notify(text);
      }, index => { const npc = this.npc(index); if (npc) this.talk(npc); });
      if (this.gone) { this.scene.destroy(); return; }
      this.scene.setMuted(this.muted);
      if (this.latest) this.receive(this.latest);
    }).catch(e => { if (!this.gone) this.notify(`港口加载失败：${String(e)}。可从活动窗口返回来处。`); });
  }
  private npc(index: number): NpcState | null {
    const body = this.latest?.colossus?.people[index];
    if (!body) return null;
    return { id: 'colossus-person-'+index, templateId: 'colossus-'+(index===5?'harbor-child':index===6?'netmender':'harbor-worker'), name: index===5?'港口孩子':index===6?'补网人':'船工', x:body.position[0],y:body.position[1],facing:body.facing<0?-1:1 };
  }
  nearestNpc(preferPassage = false): NpcState | null {
    const state=this.latest?.colossus, self=state?.actors.find(a=>a.id===this.latest?.selfId)?.body;
    if (!state || !self) return null;
    if (preferPassage && state.passage) return null;
    const nearby=state.people.map((body,index)=>({body,index,d:Math.hypot(...body.position.map((n,i)=>n-self.position[i]))})).filter(n=>n.body.track===self.track&&n.d<=6).sort((a,b)=>a.d-b.d)[0];
    return nearby ? this.npc(nearby.index) : null;
  }
  control(action: ColossusControl) {
    switch (action) {
      case 'replay': this.scene?.replay(); break;
      case 'skip': this.scene?.skip(); this.send('skip'); break;
      case 'orbit': this.scene?.rotateCamera(); break;
      case 'quality': this.low = !this.low; this.scene?.setLow(this.low); this.notify(this.low ? '已切换省电画质。' : '已恢复标准画质。'); break;
      case 'leave': this.send('leave'); break;
    }
  }
  skill(event: Extract<ServerMessage,{type:'skillCast'}>) { this.scene?.skill(event); }
  direction(raw: -1|0|1): -1|0|1 { return this.scene?.direction(raw) ?? raw; }
  setMuted(muted: boolean) { this.muted = muted; this.scene?.setMuted(muted); }
  receive(s: Snapshot) {
    this.latest = s;
    if (s.colossus) this.scene?.receive(s.colossus, s.serverTick, s.selfId, s.players);
  }
  destroy() { this.gone = true; this.scene?.destroy(); this.root.parentElement?.classList.remove('show-colossus'); this.root.remove(); }
}
