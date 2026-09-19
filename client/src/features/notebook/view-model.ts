//! 冒险笔记（图鉴）的**视图**一半：目录 + 私有状态 → 展示数据。
//!
//! 纯转换，不碰 DOM、不发消息、不持有状态（计划 §4.2）。视图可以随目录版本、
//! 页签和屏幕尺寸重建，但它永远不能反向修改事实：这里没有一处会写回
//! `obtained` / `registered`，也没有一处会自己算一个完成率去覆盖服务器的摘要。

import type { NotebookRow, NotebookSection, NotebookSlot, NotebookSummary } from '../../../../shared/protocol';
import type {
  NotebookDirectory,
  NotebookRegion,
  NotebookRowDefinition,
} from './directory';

/** 六个页签。索引顺序就是窗口上的顺序。 */
export const NOTEBOOK_TABS: readonly { section: NotebookSection; key: string }[] = [
  { section: 'monster', key: 'notebookTabMonster' },
  { section: 'equipment', key: 'notebookTabEquipment' },
  { section: 'use', key: 'notebookTabUse' },
  { section: 'mount', key: 'notebookTabMount' },
  { section: 'chair', key: 'notebookTabChair' },
  { section: 'quest', key: 'notebookTabQuest' },
] as const;

/** 骑宠页下的两个**子页**。  鞍具与骑宠出自同一张 `shared/mounts.json`（源
 *  `Character/TamingMob`），是它 `islot = Sd` 的那一半，所以鞍具不进顶栏当第七个
 *  页签——顶栏是六个分区，子页只切这一页的查询分区。  顺序就是窗口上的顺序。 */
export const MOUNT_SUBSECTIONS: readonly { section: NotebookSection; key: string }[] = [
  { section: 'mount', key: 'notebookSubMount' },
  { section: 'saddle', key: 'notebookSubSaddle' },
] as const;

/** 骑宠族（骑宠 + 鞍具）。  两半共用一套口径：同出一张表、同样没有开放获取途径、
 *  同样不逐格标「本版本未开放」。 */
export function isMountFamily(section: NotebookSection): boolean {
  return section === 'mount' || section === 'saddle';
}

/** 物品页的浏览方式。  服务端解释它，这里只负责显示顺序与默认值。 */
export const BROWSE_MODES = ['available', 'obtained', 'missing', 'all'] as const;
export type BrowseMode = typeof BROWSE_MODES[number];

/** 骑宠页（含它的鞍具子页）没有「当前可获得」：源把整族标成 `notSale / only`，
 *  本版本没有一条开放的获取途径，按它过滤会得到空页——读起来像「本版本没有
 *  坐骑」。这一页的基集合是整张表，浏览方式只在「全部 / 已获得 / 未获得」之间
 *  切换。 */
export const MOUNT_MODES = ['all', 'obtained', 'missing'] as const;

/** 椅子页同样不给「当前可获得」：源把椅子整族排除在掉落与商店之外，2799 件里
 *  真进商店的是个位数，按它过滤会得到一个几乎空页——读起来像「本版本没有椅子」。
 *  椅子页的基集合是整张椅子表，浏览方式只在「全部 / 已获得 / 未获得」之间切换；
 *  服务端仍认得 `available`（会如实筛出那几件），只是界面不给这一档。 */
export const CHAIR_MODES = ['all', 'obtained', 'missing'] as const;

/** 任务页没有「未获得」开关：未获得的条目根本不在服务器给的行里（计划 §6.3）。 */
export function browseModesFor(section: NotebookSection): readonly BrowseMode[] {
  if (section === 'quest') return ['all'];
  if (isMountFamily(section)) return MOUNT_MODES;
  return section === 'chair' ? CHAIR_MODES : BROWSE_MODES;
}

export function defaultModeFor(section: NotebookSection): BrowseMode {
  // 骑宠页（含鞍具子页）与椅子页默认「全部」：它们的基集合是整张表，而
  // 「当前可获得」那一档要么为空（骑宠／鞍具）、要么只有个位数（椅子），
  // 默认落在上面等于空页。
  return isMountFamily(section) || section === 'chair' ? 'all' : 'available';
}

/** 页签的本地化键。  鞍具不是页签，它是骑宠页的子页，所以映射到父页签的键——
 *  页眉与顶栏选中态都靠它，映射只写这一处。 */
export function tabKeyFor(section: NotebookSection): string {
  const base = section === 'saddle' ? 'mount' : section;
  return `notebookTab${base[0].toUpperCase()}${base.slice(1)}`;
}

/** 地区按**数值**地区 id 升序（源的键是字符串，字典序会把 10 排在 2 前面）。 */
export function regionList(directory: NotebookDirectory): NotebookRegion[] {
  return Object.values(directory.monsterStructure.regions).sort((a, b) => a.region - b.region);
}

/** 一个地区的分页编号，取目录里真正存在的那些（源的 `pages` 可能不连续）。 */
export function pagesOfRegion(
  directory: NotebookDirectory,
  region: number,
): { page: number; name: string }[] {
  const authored = directory.monsterStructure.regions[String(region)]?.pages ?? [];
  const names = new Map<number, string>();
  for (const row of Object.values(directory.monsterStructure.rows)) {
    if (row.region !== region || names.has(row.page)) continue;
    names.set(row.page, row.pageName);
  }
  return [...new Set(authored)].sort((a, b) => a - b)
    .map(page => ({ page, name: names.get(page) ?? String(page) }));
}

/** 一个地区某一分页下的行，按行号升序。 */
export function rowsOfPage(
  directory: NotebookDirectory,
  region: number,
  page: number,
): NotebookRowDefinition[] {
  return Object.values(directory.monsterStructure.rows)
    .filter(row => row.region === region && row.page === page)
    .sort((a, b) => a.row - b.row);
}

/** 行键 → 行定义。服务器给的行用它还原分頁与行名。 */
export function rowDefinition(
  directory: NotebookDirectory,
  rowKey: string,
): NotebookRowDefinition | undefined {
  return directory.monsterStructure.rows[rowKey];
}

/** 一个地区的行，按 (分頁, 行) 升序——与服务器 `monster_rows` 的顺序一致。 */
export function rowsOfRegion(
  directory: NotebookDirectory,
  region: number,
): NotebookRowDefinition[] {
  return Object.values(directory.monsterStructure.rows)
    .filter(row => row.region === region)
    .sort((a, b) => a.page - b.page || a.row - b.row);
}

/** 把服务器给的行按分頁分组，保持服务器给的顺序。 */
export function groupRowsByPage(
  directory: NotebookDirectory,
  rows: readonly NotebookRow[],
): { page: number; name: string; rows: NotebookRow[] }[] {
  const groups = new Map<number, { page: number; name: string; rows: NotebookRow[] }>();
  for (const row of rows) {
    const definition = row.rowKey ? rowDefinition(directory, row.rowKey) : undefined;
    const page = definition?.page ?? -1;
    const group = groups.get(page);
    if (group) group.rows.push(row);
    else groups.set(page, { page, name: definition?.pageName ?? '', rows: [row] });
  }
  return [...groups.values()].sort((a, b) => a.page - b.page);
}

/** 一个收藏槽位的显示名。源没给名字时不拿模板 id 冒充。 */
export function slotLabel(slot: NotebookSlot): string {
  return slot.label || '？？？';
}

/** 分页控件要显示的页码。  当前页两侧各留两位，其余用省略号跳段。
 *  纯展示：不改页码含义，也不允许越界。 */
export function pageWindow(current: number, pageCount: number, span = 2): (number | '…')[] {
  if (pageCount <= 0) return [];
  const last = pageCount - 1;
  const clamped = Math.min(Math.max(current, 0), last);
  const pages = new Set<number>([0, last]);
  for (let page = clamped - span; page <= clamped + span; page += 1) {
    if (page >= 0 && page <= last) pages.add(page);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  let previous = -1;
  for (const page of sorted) {
    if (previous >= 0 && page - previous > 1) out.push('…');
    out.push(page);
    previous = page;
  }
  return out;
}

export interface ProgressText {
  /** 已获得／已登记。 */
  done: number;
  /** 分母；`null` 表示这个页签**故意没有分母**（任务页）。 */
  total: number | null;
  /** 分母之外的补充说明，例如「当前可收集 57」。 */
  note?: string;
}

/** 把服务器的摘要翻译成一行进度文案。
 *
 * 任务页只报「已记录 N 种」：未来的任务条目总数不是公开信息（§5.5），所以
 * 这里绝不能拿目录里的任务条目数去补一个分母。 */
export function progressOf(section: NotebookSection, summary: NotebookSummary): ProgressText {
  if (section === 'monster') {
    return {
      done: summary.registered,
      total: summary.total,
      note: summary.collectable > 0 ? String(summary.collectable) : undefined,
    };
  }
  if (section === 'quest') {
    return { done: summary.recorded ?? summary.registered, total: null };
  }
  return { done: summary.registered, total: summary.total };
}

/** 目录版本不一致：窗口必须明确报错，而不是用旧页码排版新目录。 */
export function catalogMismatch(
  served: string,
  directory: NotebookDirectory,
): boolean {
  return served !== directory.catalogVersion;
}
