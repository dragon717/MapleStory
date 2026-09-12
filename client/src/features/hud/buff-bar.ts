import type { Manifest, SkillArt } from '../../assets/manifest';

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
 *  * the source hides this plate behind a settings window that can move it, and
 *    the setting window itself is out of scope; the row simply sits at the end
 *    of the HUD line here;
 *  * the remaining seconds use text with a black outline instead of the status
 *    bar glyph sprites, because the value changes every second;
 *  * monsters' `abnormalStatus` (debuffs) are not merged into this row yet —
 *    they need their own state sprites.
 */
const SLICES = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'] as const;

interface BuffRow {
  item: HTMLLIElement;
  icon: HTMLImageElement;
  time: HTMLSpanElement;
}

/** Seconds shown in the corner of an icon; sub-second remainders round up so a
 *  buff never reads "0" while it is still active. */
export function buffSeconds(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '';
  const seconds = Math.ceil(remainingMs / 1000);
  if (seconds < 60) return String(seconds);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export class BuffBar {
  private readonly root: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly rows = new Map<string, BuffRow>();
  private readonly iconFor: (skillId: string) => SkillArt | undefined;
  private signature = '';

  constructor(host: HTMLElement, manifest: Manifest) {
    const ui = manifest.buffUi?.ui ?? {};
    const catalog = manifest.skillCatalog ?? {};
    this.iconFor = skillId => catalog[skillId]?.icons?.normal;

    this.root = document.createElement('div');
    this.root.className = 'tms-buff-bar';
    this.root.hidden = true;
    this.root.setAttribute('role', 'status');
    // Static label on purpose: `app/i18n` reads `window` at module load, which
    // would break the offline node checks that transpile this module.
    this.root.setAttribute('aria-label', '增益状态');
    if (manifest.buffUi?.layout) this.root.style.setProperty('--tms-buff-space-x', `${manifest.buffUi.layout.spaceX}px`);

    const panel = document.createElement('div');
    panel.className = 'tms-buff-panel';
    panel.setAttribute('aria-hidden', 'true');
    for (const slice of SLICES) {
      const frame = ui[`favoriteBuff/${slice}`];
      if (!frame) continue;
      const image = document.createElement('img');
      image.className = `tms-buff-slice tms-buff-slice-${slice}`;
      image.src = frame.url;
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
   * Draw the authoritative buff map.  Rows are reused keyed by skill id so a
   * ticking timer only rewrites its own text node.
   */
  update(buffs: Record<string, number> | undefined) {
    const active = Object.entries(buffs ?? {})
      .filter(([, remaining]) => Number.isFinite(remaining) && remaining > 0)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const signature = active.map(([id]) => id).join(',');
    if (signature !== this.signature) {
      this.signature = signature;
      const wanted = new Set(active.map(([id]) => id));
      for (const [id, row] of this.rows) {
        if (wanted.has(id)) continue;
        row.item.remove();
        this.rows.delete(id);
      }
      for (const [id] of active) {
        if (this.rows.has(id)) continue;
        this.rows.set(id, this.createRow(id));
      }
      this.list.replaceChildren(...active.map(([id]) => this.rows.get(id)!.item));
    }
    for (const [id, remaining] of active) {
      const row = this.rows.get(id);
      if (!row) continue;
      const text = buffSeconds(remaining);
      if (row.time.textContent !== text) row.time.textContent = text;
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

  private createRow(skillId: string): BuffRow {
    const item = document.createElement('li');
    item.className = 'tms-buff-entry';
    item.dataset.skillId = skillId;
    const icon = document.createElement('img');
    icon.className = 'tms-buff-icon';
    icon.alt = '';
    icon.draggable = false;
    const art = this.iconFor(skillId);
    if (art) {
      icon.src = art.url;
      icon.width = art.width;
      icon.height = art.height;
    }
    const time = document.createElement('span');
    time.className = 'tms-buff-time';
    item.append(icon, time);
    item.setAttribute('aria-label', skillId);
    return { item, icon, time };
  }
}
