export type UiLocale = 'zh' | 'en';

const locale: UiLocale = new URLSearchParams(window.location.search).get('lang')?.toLowerCase().startsWith('en') ? 'en' : 'zh';

const TEXT: Readonly<Record<string, Readonly<Record<UiLocale, string>>>> = Object.freeze({
  inventoryTitle: { zh: '物品栏', en: 'Inventory' },
  inventoryEquip: { zh: '装备', en: 'Equip' },
  inventoryUse: { zh: '消耗', en: 'Use' },
  inventorySetup: { zh: '设置', en: 'Setup' },
  inventoryEtc: { zh: '其他', en: 'Etc' },
  inventoryCash: { zh: '现金', en: 'Cash' },
  menu: { zh: '菜单', en: 'Menu' },
  shortcut: { zh: '快捷栏', en: 'Shortcut' },
  menuChannel: { zh: '频道切换', en: 'Change Channel' },
  menuSkin: { zh: '外观设置', en: 'Skin' },
  menuGameOptions: { zh: '游戏设置', en: 'Game Options' },
  menuSystemOptions: { zh: '系统设置', en: 'System Options' },
  menuQuit: { zh: '退出游戏', en: 'Quit' },
  shortcutItem: { zh: '物品栏', en: 'Item Inventory' },
  shortcutEquip: { zh: '装备栏', en: 'Equip Inventory' },
  shortcutStat: { zh: '属性', en: 'Stats' },
  shortcutSkill: { zh: '技能', en: 'Skills' },
  shortcutParty: { zh: '组队', en: 'Party' },
  shortcutQuest: { zh: '任务', en: 'Quest' },
  shortcutMessenger: { zh: '信使', en: 'Messenger' },
  shortcutGuild: { zh: '公会', en: 'Guild' },
  shortcutCommunity: { zh: '社区', en: 'Community' },
  shortcutMonsterBook: { zh: '怪物图鉴', en: 'Monster Book' },
  shortcutRanking: { zh: '排行榜', en: 'Ranking' },
});

const PROTOCOL_ERRORS: Readonly<Record<string, Readonly<Record<UiLocale, string>>>> = Object.freeze({
  drop_unavailable: { zh: '道具已经不可用', en: 'Drop is unavailable' },
  drop_owned: { zh: '这个道具属于其他冒险者', en: 'Drop belongs to another player' },
  drop_invalid: { zh: '道具数据无效', en: 'Drop data is invalid' },
  out_of_range: { zh: '距离道具太远', en: 'Drop is out of range' },
  inventory_full: { zh: '物品栏已满', en: 'Inventory is full' },
  quantity_overflow: { zh: '道具数量过大', en: 'Item quantity is too large' },
  invalid_slot: { zh: '物品栏格子无效', en: 'Inventory slot is invalid' },
  persistence: { zh: '保存失败，请稍后重试', en: 'Persistence failed; try again' },
});

const MAP_NAMES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  '000010000': ['蘑菇村', 'Mushroom Town'],
  '000020000': ['蜗牛花园', 'Snail Garden'],
  '000020001': ['蘑菇村街道', 'Mushroom Town Townstreet'],
  '000030000': ['蜗牛花田', 'Snail Field of Flowers'],
  '000030001': ['蘑菇村街道', 'Mushroom Town Townstreet'],
  '000040000': ['小森林', 'In a Small Forest'],
  '000040001': ['蜗牛狩猎场 II', 'Snail Hunting Ground II'],
  '000040002': ['蜗牛狩猎场 III', 'Snail Hunting Ground III'],
  '000050000': ['危险森林', 'Dangerous Forest'],
  '000050001': ['南港西部平原', 'The Field West of Southperry'],
  '000060000': ['南港', 'Southperry'],
  '000060001': ['南港防具店', 'Southperry Armor Store'],
  '001000000': ['彩虹村', 'Amherst'],
  '001000001': ['彩虹村武器店', 'Amherst Weapon Store'],
  '001000002': ['彩虹村街道', 'Amherst Townstreet'],
  '001000003': ['彩虹村百货店', 'Amherst Department Store'],
  '001000004': ['蜗牛花园', 'Snail Garden'],
  '001000005': ['森林中部狩猎场 I', 'Hunting Ground Middle of the Forest I'],
  '001000006': ['森林中部狩猎场 II', 'Hunting Ground Middle of the Forest II'],
});

export function uiLocale(): UiLocale { return locale; }
export function uiText(key: string, fallback = key): string { return TEXT[key]?.[locale] ?? fallback; }
export function protocolText(code: string, fallback: string): string { return PROTOCOL_ERRORS[code]?.[locale] ?? fallback; }
export function mapText(id: string, fallback: string): string { return MAP_NAMES[id]?.[locale] ?? fallback; }
