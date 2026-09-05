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
  const type = Number.parseInt(itemId.slice(0, 1), 10);
  return type >= 1 && type <= 5 ? type - 1 : 3;
}
