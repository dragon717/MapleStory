import type { Manifest, SkillArt } from '../../assets/manifest';
import { resolveAssetUrl } from '../../assets/resource-url';
import type { PlayerState } from '../../../../shared/protocol';
import { chairReadout, chairRecoveryLabel, chairDrains } from '../chairs/model';

/**
 * The on-screen buff row.
 *
 * The server owns every buff duration (`derivedStats.skillBuffs`: skill id ->
 * remaining ms) and the client only draws it, exactly like the potion
 * cooldowns and the EXP gauge.  The plate behind the icons is the authored
 * `UI/StatusBar3.img/BuffSetting/favoriteBuff` 9-slice and the gaps between
 * icons are its own `spaceX` / `spaceY` — 5 px in TMS273.7 — so the row keeps
 * the source rhythm instead of a client-chosen spacing.
 *
 * P boundaries (recorded in `docs/technical/UI_WINDOW_SYSTEM.md` §5):
 *  * the row sits above the shortcuts in a white backdrop-blurred frame;
 *  * the remaining seconds use text with a black outline instead of the status
 *    bar glyph sprites, because the value changes every second;
 *  * disease thumbnails use the original MobSkill's first affected frame.
 */
const SLICES = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'] as const;

interface BuffRow {
  item: HTMLLIElement;
  icon: HTMLImageElement;
  time: HTMLSpanElement;
}
type StatusPlayer = Pick<PlayerState, 'derivedStats' | 'abnormalStatus' | 'mount' | 'chair' | 'skills'>;
export interface StatusEntry { id: string; label?: string; remainingMs?: number; count?: number; itemId?: string; }

/** Active effects only: passive attributes remain in the character window. */
export function playerStatuses(player: StatusPlayer): StatusEntry[] {
  const stats=player.derivedStats, entries=new Map<string,StatusEntry>();
  const add=(id:string,remainingMs?:number,extra:Partial<StatusEntry>={})=>{
    if(remainingMs!==undefined&&(!Number.isFinite(remainingMs)||remainingMs<=0))return;
    if(!entries.has(id))entries.set(id,{id,remainingMs,...extra});
  };
  for(const [id,ms] of Object.entries(stats?.skillBuffs??{}))add(id,ms);
  if(stats?.meditationRemainingMs)add('2201001',stats.meditationRemainingMs);
  for(const [on,id] of [[stats?.magicGuard,'2001002'],[stats?.iceTeleport,'2201009'],[stats?.teleportMastery,'2211007'],[stats?.teleportBoost,'2211017'],[stats?.hyperBarrierActive,'2221054'],[stats?.fireWardActive,'2121054'],[stats?.hyperTeleportEnabled,'2221045']] as const)if(on)add(id);
  if((stats?.adaptationCharges??0)>0)add(player.skills?.['2111011']?'2111011':'2211012',undefined,{count:stats?.adaptationCharges});
  for(const [name,label] of [['seal','封印'],['stun','眩晕'],['curse','诅咒'],['poison','中毒'],['slow','缓速']] as const){
    const ms=player.abnormalStatus?.[`${name}Ms`];if(ms)add(`disease:${name}`,ms,{label});
  }
  if(player.mount)add('mount',undefined,{itemId:player.mount.itemId,label:`骑乘 · 速度 ${player.mount.speed}%`});
  const chair = chairReadout(player);
  if (chair) add('chair', undefined, { itemId: chair.itemId, label: [
    '坐姿', chair.name, chairRecoveryLabel(chair) ?? '此椅子没有恢复效果',
    chair.secondsToRecovery === undefined ? '' : `每 ${chair.intervalSeconds} 秒${chairDrains(chair) ? '扣减' : '恢复'}一次，下次结算 ${chair.secondsToRecovery} 秒`,
    '移动、跳跃或攻击即起身',
  ].filter(Boolean).join(' · ') });
  return [...entries.values()].sort((a,b)=>a.id.localeCompare(b.id));
}

/** Seconds shown in the corner of an icon; sub-second remainders round up so a
 *  buff never reads "0" while it is still active. */
export function buffSeconds(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '';
  return String(Math.min(999,Math.ceil(remainingMs / 1000)));
}

export class BuffBar {
  private readonly root: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly rows = new Map<string, BuffRow>();
  private readonly iconFor: (entry: StatusEntry) => SkillArt | undefined;
  private readonly nameFor: (entry: StatusEntry) => string;
  private signature = '';

  constructor(host: HTMLElement, manifest: Manifest) {
    const ui = manifest.buffUi?.ui ?? {};
    const catalog = manifest.skillCatalog ?? {};
    this.iconFor = entry => entry.itemId
      ? manifest.items?.[entry.itemId]??manifest.mounts?.[entry.itemId]
      : entry.id.startsWith('disease:') ? manifest.statusIcons?.[entry.id.slice(8) as keyof NonNullable<Manifest['statusIcons']>]
      : catalog[entry.id]?.icons?.normal;
    this.nameFor = entry => entry.label??catalog[entry.id]?.name??`状态 ${entry.id}`;

    this.root = document.createElement('div');
    this.root.className = 'tms-buff-bar';
    this.root.hidden = true;
    this.root.setAttribute('role', 'group');
    // Static label on purpose: `app/i18n` reads `window` at module load, which
    // would break the offline node checks that transpile this module.
    this.root.setAttribute('aria-label', '角色状态');
    if (manifest.buffUi?.layout) this.root.style.setProperty('--tms-buff-space-x', `${manifest.buffUi.layout.spaceX}px`);

    const panel = document.createElement('div');
    panel.className = 'tms-buff-panel';
    panel.setAttribute('aria-hidden', 'true');
    for (const slice of SLICES) {
      const frame = ui[`favoriteBuff/${slice}`];
      if (!frame) continue;
      const image = document.createElement('img');
      image.className = `tms-buff-slice tms-buff-slice-${slice}`;
      image.src = resolveAssetUrl(frame.url);
      image.alt = '';
      image.draggable = false;
      panel.append(image);
    }

    this.list = document.createElement('ul');
    this.list.className = 'tms-buff-list';
    // The plate is only meaningful when the source export is present.
    this.root.dataset.available = String(Boolean(ui['favoriteBuff/c']));
    this.root.append(panel, this.list);
    host.append(this.root);
  }

  /**
   * Draw authoritative active states. Rows are reused by effect id so a
   * ticking timer only rewrites its own text node.
   */
  update(entries: readonly StatusEntry[]) {
    const active = entries;
    const signature = active.map(entry => `${entry.id}:${entry.itemId??''}`).join(',');
    if (signature !== this.signature) {
      this.signature = signature;
      const wanted = new Set(active.map(entry => entry.id));
      for (const [id, row] of this.rows) {
        if (wanted.has(id)) continue;
        row.item.remove();
        this.rows.delete(id);
      }
      for (const entry of active) {
        const {id}=entry;
        const row=this.rows.get(id);
        if (row?.item.dataset.itemId===(entry.itemId??'')) continue;
        row?.item.remove();
        this.rows.set(id, this.createRow(entry));
      }
      this.list.replaceChildren(...active.map(entry => this.rows.get(entry.id)!.item));
    }
    for (const entry of active) {
      const {id,remainingMs,count}=entry;
      const row = this.rows.get(id);
      if (!row) continue;
      const text = remainingMs===undefined ? count===undefined?'∞':String(count) : buffSeconds(remainingMs);
      if (row.time.textContent !== text) row.time.textContent = text;
      const label=`${this.nameFor(entry)} · ${remainingMs===undefined ? count===undefined?'持续':`剩余 ${count} 次` : `剩余 ${Math.ceil((remainingMs??0)/1000)} 秒`}`;
      row.item.title=label;row.item.setAttribute('aria-label',label);
    }
    this.root.hidden = active.length === 0;
  }

  clear() {
    this.signature = '';
    this.rows.clear();
    this.list.replaceChildren();
    this.root.hidden = true;
  }

  destroy() {
    this.clear();
    this.root.remove();
  }

  private createRow(entry: StatusEntry): BuffRow {
    const item = document.createElement('li');
    item.className = 'tms-buff-entry';
    item.dataset.skillId = entry.id;
    item.dataset.itemId = entry.itemId??'';
    const icon = document.createElement('img');
    icon.className = 'tms-buff-icon';
    icon.alt = '';
    icon.draggable = false;
    const art = this.iconFor(entry);
    if (art) {
      icon.src = resolveAssetUrl(art.url);
      icon.width = art.width;
      icon.height = art.height;
    }
    const time = document.createElement('span');
    time.className = 'tms-buff-time';
    item.append(icon, time);
    item.setAttribute('aria-label', this.nameFor(entry));
    return { item, icon, time };
  }
}
