import { uiLocale } from '../../app/i18n';
import catalog from '../../../../shared/items.json';
import type { InventoryItem } from '../../../../shared/protocol';

/** The active TMS273 String catalog is authoritative for item names. */
export function itemName(itemId: string): string {
  if (itemId === '0') return uiLocale() === 'en' ? 'Mesos' : '楓幣';
  const item = catalog[itemId as keyof typeof catalog];
  return item && "name" in item ? item.name : itemId;
}

/**
 * Item id / 1_000_000 identifies the five ordinary inventory categories.
 * Unknown ids are left for the
 * Etc tab so an unrecognised item remains visible.
 */
export function itemCategoryTab(itemId: string): number {
  const type = /^\d+$/.test(itemId) ? Math.floor(Number(itemId) / 1_000_000) : 0;
  return type >= 1 && type <= 5 ? type - 1 : 3;
}


export function itemDescription(itemId: string): string {
  const item = catalog[itemId as keyof typeof catalog];
  return item && 'description' in item ? item.description.replaceAll('\\n', '\n') : '';
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
