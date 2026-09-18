import { uiLocale, displayText } from '../../app/i18n';
import catalog from '../../../../shared/items.json';
import petCatalog from '../../../../shared/pets.json';
import mountIndex from '../../../../shared/mount-index.json';
import chairNames from '../../../../shared/chair-names.json';
import type { InventoryItem } from '../../../../shared/protocol';

// Source info also retains nested metadata such as equipment growth levels.
type CatalogInfo = Record<string, unknown>;

/** TMS273 pet rows (`shared/pets.json`): pets are not in items.json but still
 *  need authoritative display names in the cash tab and tooltips. */
const PETS = petCatalog as Record<string, { name?: string }>;

/** 坐骑索引（源 `Character/TamingMob/*` 的 `info.islot`/`info.tamingMob`
 *  ＋ `String/Eqp.json` 的名字）与椅子名索引（源 `String/Ins.json`）。
 *
 *  为什么不 import `shared/mounts.json` / `chairs.json` 整表：`items.json` 已经
 *  被静态打进客户端包（构建产物 3.34 MB），再挂 1.68 MB 的整表会把包推到 ~5 MB，
 *  而渲染路径上真正要的只有「名字／槽位／是不是坐骑」。两份索引由
 *  `scripts/export_tms273_mounts_chairs.cjs` 与整表**同一次导出**产出，
 *  因此不可能与整表分叉。
 *
 *  坐骑索引必须带 `islot`（`equipmentSlot` 用）与 `tamingMob`（`isMountItem` 用），
 *  不能只有名字：见 `scripts/export_tms273_mounts_chairs.cjs` 里那一段的理由。
 *  两处缺席都表示「源里就没有」——坐骑 935 件里有 840 件在 `String/Eqp.json/Eqp/Taming`
 *  下没有名字，此时 `itemName` 回落成 id，而不是编一个名字。 */
const MOUNT_INDEX = mountIndex as Record<string, { islot?: string; tamingMob?: number; name?: string }>;
const CHAIR_NAMES = chairNames as Record<string, string>;

/**
 * `islot` is the TMS273 source field used by server/src/inventory.rs.  Keep
 * the client lookup in the same source vocabulary; numeric item ranges are
 * not equipment-slot rules.
 */
const EQUIPMENT_SLOT_BY_SOURCE: Readonly<Record<string, number>> = {
  Cp: 1, HrCp: 1, Af: 2, Ay: 3, Ae: 4, Ma: 5, MaPn: 5, Pn: 6, So: 7,
  GlGw: 8, Gv: 8, Sr: 9, Si: 10, Wp: 11, WpSi: 11, WpSp: 11, Ri: 12,
  Ri2: 13, Ri3: 15, Ri4: 16, Pe: 17, Tm: 18, Sd: 19, Me: 49, Ba: 50, Be: 50,
};

const EQUIPMENT_STAT_LABELS: readonly [string, string, string][] = [
  ['incSTR', '力量', 'STR'], ['incDEX', '敏捷', 'DEX'], ['incINT', '智力', 'INT'], ['incLUK', '运气', 'LUK'],
  ['incPAD', '攻击力', 'Weapon attack'], ['incMAD', '魔法攻击力', 'Magic attack'],
  ['incPDD', '物理防御', 'Weapon defense'], ['incMDD', '魔法防御', 'Magic defense'],
  ['incACC', '命中', 'Accuracy'], ['incEVA', '回避', 'Avoidability'],
  ['incHP', 'HP', 'HP'], ['incMP', 'MP', 'MP'], ['incMHP', '最大 HP', 'Max HP'], ['incMMP', '最大 MP', 'Max MP'],
  ['incJump', '跳跃力', 'Jump'], ['incSpeed', '移动速度', 'Speed'],
];

function catalogInfo(itemId: string): CatalogInfo | undefined {
  const item = catalog[itemId as keyof typeof catalog] as { info?: CatalogInfo } | undefined;
  // items.json 是可达性驱动目录，坐骑与椅子不在其中（源里 notSale/only）。
  // 回落顺序与 `server/src/inventory.rs` 的 `shipped_mounts → shipped_chairs`
  // 逐字同序：两端对「这件东西的 islot 是什么」必须给出同一个答案。
  return item?.info ?? MOUNT_INDEX[itemId];
}

/** 是否为可骑的坐骑装备。判据与 `inventory::is_mount_item` 同源：看 `info.tamingMob`
 *  在不在，**不看** `islot`——`Tm` 槽里还有 21 件现金件，按槽位判会把它们与機械師
 *  整套装备（同样 `islot = Tm`）一起误认成坐骑。 */
export function isMountItem(itemId: string): boolean {
  return MOUNT_INDEX[itemId]?.tamingMob !== undefined;
}

function numberOrZero(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Resolve the positive body-slot number used by the equipped InventoryItem. */
export function equipmentSlot(itemId: string): number | undefined {
  const sourceSlot = catalogInfo(itemId)?.islot;
  return typeof sourceSlot === 'string' ? EQUIPMENT_SLOT_BY_SOURCE[sourceSlot] : undefined;
}

/** Read one final equipment value, with an instance value taking precedence. */
export function equipmentAttribute(itemId: string, instance: InventoryItem | undefined, key: string): number {
  if (instance?.stats && Object.prototype.hasOwnProperty.call(instance.stats, key)) {
    return numberOrZero(instance.stats[key]);
  }
  return numberOrZero(catalogInfo(itemId)?.[key]);
}

function signed(number: number): string {
  return number > 0 ? `+${number}` : String(number);
}

/**
 * Text-only comparison block for a candidate equipment item.  It intentionally
 * reports attribute deltas and never invents a combat-power score.
 */
export function itemComparisonDetails(candidate: InventoryItem, current: InventoryItem | null): string {
  const locale = uiLocale();
  const zh = locale === 'zh';
  const slot = equipmentSlot(candidate.itemId);
  const lines = [zh ? `候选装备：${itemName(candidate.itemId)}` : `Candidate: ${itemName(candidate.itemId)}`];
  if (slot === undefined) {
    lines.push(zh ? '装备部位：未知，无法进行同部位对比' : 'Equipment slot: unknown; same-slot comparison unavailable');
    return lines.join('\n');
  }

  const sameSlot = current && Math.abs(current.slot) === slot ? current : undefined;
  lines.push(sameSlot
    ? (zh ? `当前同部位：${itemName(sameSlot.itemId)}` : `Equipped in same slot: ${itemName(sameSlot.itemId)}`)
    : (zh ? '当前同部位：无已装备' : 'Equipped in same slot: none'));
  lines.push(zh ? '属性差值（候选 − 当前）' : 'Stat difference (candidate − equipped)');
  const changes = EQUIPMENT_STAT_LABELS
    .map(([key, zhLabel, enLabel]) => {
      const candidateValue = equipmentAttribute(candidate.itemId, candidate, key);
      const currentValue = sameSlot ? equipmentAttribute(sameSlot.itemId, sameSlot, key) : 0;
      if (candidateValue === 0 && currentValue === 0) return undefined;
      return `${zh ? zhLabel : enLabel}: ${zh ? '当前' : 'Equipped'} ${currentValue} → ${zh ? '候选' : 'Candidate'} ${candidateValue} (${signed(candidateValue - currentValue)})`;
    })
    .filter((line): line is string => Boolean(line));
  lines.push(...(changes.length ? changes : [zh ? '无属性差异' : 'No stat differences']));
  return lines.join('\n');
}

/** The active TMS273 String catalog is authoritative for item names; pets,
 *  骑宠与椅子 fall back to their own source tables in the same order the server's
 *  `inventory::item_name` uses (items.json → 骑宠 → 椅子 → 宠物 → id). */
export function itemName(itemId: string): string {
  if (itemId === '0') return uiLocale() === 'en' ? 'Mesos' : '枫币';
  const item = catalog[itemId as keyof typeof catalog];
  if (item && "name" in item) return displayText(item.name);
  const mountName = MOUNT_INDEX[itemId]?.name;
  if (mountName) return displayText(mountName);
  const chairName = CHAIR_NAMES[itemId];
  if (chairName) return displayText(chairName);
  const petName = PETS[itemId]?.name;
  return petName ? displayText(petName) : itemId;
}

/**
 * Item id / 1_000_000 identifies the five ordinary inventory categories.
 * The tab index must match the source-authored `tab:category/<n>` frame
 * order in UI/UIInventory.img/Inventory: tab 2's frame reads "其他"
 * (Etc) and tab 3's frame reads "裝飾" (Setup), so the inventoryType → tab
 * map is *not* a straight `- 1`.  Unknown ids fall through to the Etc tab.
 */
const CATEGORY_TAB: Readonly<Record<number, number>> = {
  1: 0, // 裝備
  2: 1, // 消耗
  4: 2, // 其他
  3: 3, // 裝飾
  5: 4, // 現金
};

export function itemCategoryTab(itemId: string): number {
  const type = /^\d+$/.test(itemId) ? Math.floor(Number(itemId) / 1_000_000) : 0;
  return CATEGORY_TAB[type] ?? 2;
}


export function itemDescription(itemId: string): string {
  const item = catalog[itemId as keyof typeof catalog];
  return item && 'description' in item ? displayText(item.description).replaceAll('\\n', '\n') : '';
}

export function itemDetails(itemId: string, instance?: InventoryItem, comparison?: InventoryItem | null): string {
  const item = catalog[itemId as keyof typeof catalog];
  const lines = [itemName(itemId)];
  if (!item) return comparison === undefined ? lines[0] : lines.concat(itemComparisonDetails(instance ?? { slot: 0, itemId, quantity: 1 }, comparison)).join('\n');
  const info: CatalogInfo = { ...item.info, ...instance?.stats };
  if (instance?.remainingSlots !== undefined) info.tuc = instance.remainingSlots;
  if (instance?.upgradeCount) lines[0] += ` (+${instance.upgradeCount})`;
  const labels: [string, string, string][] = [
    ['reqLevel', '需要等级', 'Required level'], ['reqSTR', '需要力量', 'Required STR'],
    ['reqDEX', '需要敏捷', 'Required DEX'], ['reqINT', '需要智力', 'Required INT'],
    ['reqLUK', '需要运气', 'Required LUK'], ['incPAD', '攻击力', 'Weapon attack'],
    ['incMAD', '魔法攻击力', 'Magic attack'], ['incSTR', '力量', 'STR'], ['incDEX', '敏捷', 'DEX'],
    ['incINT', '智力', 'INT'], ['incLUK', '运气', 'LUK'],
    ['incPDD', '物理防御', 'Weapon defense'], ['incMDD', '魔法防御', 'Magic defense'],
    ['incACC', '命中', 'Accuracy'], ['incEVA', '回避', 'Avoidability'], ['incHP', 'HP', 'HP'],
    ['incMP', 'MP', 'MP'], ['incMHP', '最大 HP', 'Max HP'], ['incMMP', '最大 MP', 'Max MP'],
    ['incJump', '跳跃力', 'Jump'], ['incSpeed', '移动速度', 'Speed'], ['tuc', '可升级次数', 'Upgrade slots'],
  ];
  if (item.inventoryType === 1) {
    const jobs: Record<number, [string, string]> = { 0: ['全职业', 'All jobs'], 1: ['战士', 'Warrior'], 2: ['魔法师', 'Magician'], 4: ['弓箭手', 'Bowman'], 8: ['飞侠', 'Thief'], 16: ['海盗', 'Pirate'] };
    const job = jobs[Number(info.reqJob)];
    if (job) lines.push(`${uiLocale() === 'zh' ? '职业' : 'Job'}: ${job[uiLocale() === 'zh' ? 0 : 1]}`);
    for (const [key, zh, en] of labels) if (Number(info[key]) > 0 || (key === 'tuc' && info[key] !== undefined)) lines.push(`${uiLocale() === 'zh' ? zh : en}: ${info[key]}`);
  }
  const description = itemDescription(itemId);
  if (description) lines.push(description);
  if (numberOrZero(info.tradeBlock) !== 0) lines.push(uiLocale() === 'zh' ? '不可交易' : 'Untradeable');
  if (numberOrZero(info.only) !== 0) lines.push(uiLocale() === 'zh' ? '固有道具' : 'Unique item');
  // Rental deadline stamped by the server on cash-shop `Period` deliveries
  // (private `_expiresAt` instance key, unix seconds).
  const expiresAt = instance?.stats?.['_expiresAt'];
  if (expiresAt && expiresAt > 0) {
    const days = Math.ceil((expiresAt * 1000 - Date.now()) / 86_400_000);
    lines.push(uiLocale() === 'zh'
      ? (days > 0 ? `租赁期限：剩餘 ${days} 天` : '租赁期限：已到期')
      : (days > 0 ? `Rental: ${days} day(s) left` : 'Rental: expired'));
  }
  if (comparison !== undefined) lines.push(itemComparisonDetails(instance ?? { slot: 0, itemId, quantity: 1 }, comparison));
  return lines.join('\n');
}
