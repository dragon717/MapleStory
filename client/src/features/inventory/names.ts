/**
 * Item names copied from the local v83 String.wz source tree
 * (参考/repos/P0nk__Cosmic/wz/String.wz/{Consume,Etc,Eqp}.img.xml).
 * The special id 0 is the server's mesos drop and uses the source UIWindow
 * currency label rather than pretending it is a String.wz item.
 *
 * The server still treats the item id as authoritative.  An id without a
 * verified source name is intentionally returned unchanged instead of being
 * presented as a guessed display name.
 */
import { uiLocale } from '../../app/i18n';
import catalog from '../../../../shared/items.json';
import type { InventoryItem } from '../../../../shared/protocol';

const ITEM_NAMES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  '0': ['金币', 'Mesos'],
  '1002067': ['绿色发带', 'Green Headband'],
  '1040002': ['白色背心', 'White Undershirt'],
  '1052095': ['棕色岩石服', 'Brown Rocky Suit'],
  '1302000': ['单手剑', 'Sword'],
  '2000000': ['红色药水', 'Red Potion'],
  '2010009': ['绿苹果', 'Green Apple'],
  '2040002': ['头盔防御卷轴', 'Scroll for Helmet for DEF'],
  '2041001': ['披风魔防卷轴', 'Scroll for Cape for Magic Def.'],
  '2041043': ['披风魔防卷轴', 'Scroll for Cape for Magic DEF'],
  '2041045': ['披风防御卷轴', 'Scroll for Cape for Weapon DEF'],
  '2060000': ['弓箭', 'Arrow for Bow'],
  '2061000': ['弩箭', 'Arrow for Crossbow'],
  '2380000': ['蜗牛卡', 'Snail Card'],
  '4000019': ['蜗牛壳', 'Snail Shell'],
  '4010000': ['青铜矿', 'Bronze Ore'],
  '4020000': ['石榴石矿', 'Garnet Ore'],
});

export function itemName(itemId: string): string {
  const name = ITEM_NAMES[itemId];
  return name ? name[uiLocale() === 'en' ? 1 : 0] : itemId;
}

/**
 * Cosmic's ItemConstants.getInventoryType uses itemId / 1_000_000 for the
 * five v83 inventory tabs (EQUIP, USE, SETUP, ETC, CASH). Keep the same
 * source-backed mapping for the client filter; unknown ids are left for the
 * Etc tab so an unrecognised item remains visible.
 */
export function itemCategoryTab(itemId: string): number {
  const type = /^\d+$/.test(itemId) ? Math.floor(Number(itemId) / 1_000_000) : 0;
  return type >= 1 && type <= 5 ? type - 1 : 3;
}


const DESCRIPTIONS_ZH: Record<string, string> = {
  '2000000': '用红色药草制成的药水。恢复 50 HP。',
  '2010009': '酸脆的绿苹果。恢复 30 MP。',
  '2040002': '提高头盔防御力。成功率 10%，物理防御 +5，魔法防御 +3，命中 +1。',
  '2041001': '提高披风魔法防御力。成功率 60%，魔法防御 +3，物理防御 +1。',
  '2041043': '提高披风魔法防御力。成功率 15%，魔法防御 +5，物理防御 +3，最大 MP +10。',
  '2041045': '提高披风物理防御力。成功率 15%，物理防御 +5，魔法防御 +3，最大 HP +10。',
  '2060000': '一筒弓箭。只能配合弓使用。',
  '2061000': '一筒弩箭。只能配合弩使用。',
  '2380000': '印有蜗牛的怪物卡片。',
  '4000019': '从蜗牛身上取下的壳。',
  '4010000': '轻而柔软的青铜矿石。',
  '4020000': '红色宝石的矿石。',
};

export function itemDescription(itemId: string): string {
  const item = catalog[itemId as keyof typeof catalog];
  return uiLocale() === 'zh' ? DESCRIPTIONS_ZH[itemId] ?? '' : (item?.description ?? '').replaceAll('\\n', '\n');
}

export function itemDetails(itemId: string, instance?: InventoryItem): string {
  const item = catalog[itemId as keyof typeof catalog];
  const lines = [itemName(itemId)];
  if (!item) return lines[0];
  const info: Record<string, string | number> = { ...item.info, ...instance?.stats };
  if (instance?.remainingSlots !== undefined) info.tuc = instance.remainingSlots;
  if (instance?.upgradeCount) lines[0] += ` (+${instance.upgradeCount})`;
  const labels: [string, string, string][] = [
    ['reqLevel', '需要等级', 'Required level'], ['reqSTR', '需要力量', 'Required STR'],
    ['reqDEX', '需要敏捷', 'Required DEX'], ['reqINT', '需要智力', 'Required INT'],
    ['reqLUK', '需要运气', 'Required LUK'], ['incPAD', '攻击力', 'Weapon attack'],
    ['incPDD', '物理防御', 'Weapon defense'], ['incMDD', '魔法防御', 'Magic defense'],
    ['incMHP', '最大 HP', 'Max HP'], ['incMMP', '最大 MP', 'Max MP'],
    ['incACC', '命中', 'Accuracy'], ['tuc', '可升级次数', 'Upgrade slots'],
  ];
  if (item.inventoryType === 1) {
    const jobs: Record<number, [string, string]> = { 0: ['全职业', 'All jobs'], 1: ['战士', 'Warrior'], 2: ['魔法师', 'Magician'], 4: ['弓箭手', 'Bowman'], 8: ['飞侠', 'Thief'], 16: ['海盗', 'Pirate'] };
    const job = jobs[Number(info.reqJob)];
    if (job) lines.push(`${uiLocale() === 'zh' ? '职业' : 'Job'}: ${job[uiLocale() === 'zh' ? 0 : 1]}`);
    for (const [key, zh, en] of labels) if (Number(info[key]) > 0 || (key === 'tuc' && info[key] !== undefined)) lines.push(`${uiLocale() === 'zh' ? zh : en}: ${info[key]}`);
  }
  const description = itemDescription(itemId);
  if (description) lines.push(description);
  if (info.tradeBlock) lines.push(uiLocale() === 'zh' ? '不可交易' : 'Untradeable');
  if (info.only) lines.push(uiLocale() === 'zh' ? '固有道具' : 'Unique item');
  return lines.join('\n');
}
