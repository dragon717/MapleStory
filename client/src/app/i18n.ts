import OpenCC from 'opencc-js/t2cn';
export type UiLocale = 'zh' | 'en';

export function resolveLocale(requested?: string | null, saved?: string | null): UiLocale {
  const parse = (value?: string | null): UiLocale | undefined => {
    if (/^en(?:-|$)/i.test(value ?? '')) return 'en';
    if (/^zh(?:-|$)/i.test(value ?? '')) return 'zh';
    return undefined;
  };
  return parse(requested) ?? parse(saved) ?? 'zh';
}
let savedLocale: string | null = null;
try { savedLocale = window.localStorage.getItem('maple-ui-locale'); } catch { /* Storage may be disabled. */ }
const locale = resolveLocale(new URLSearchParams(window.location.search).get('lang'), savedLocale);
const simplify = OpenCC.Converter({ from: 'tw', to: 'cn' });
/** Convert authored display text only; never identifiers, resource paths or player input. */
export function displayText(text: string): string { return locale === 'zh' ? simplify(text) : text; }


const TEXT: Readonly<Record<string, Readonly<Record<UiLocale, string>>>> = Object.freeze({
  enteredMap: { zh: '已进入', en: 'Entered' },
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
  meso: { zh: '金币', en: 'mesos' },
});

const PROTOCOL_ERRORS: Readonly<Record<string, Readonly<Record<UiLocale, string>>>> = Object.freeze({
  invalid_inventory_type: { zh: '物品栏分类无效', en: 'Invalid inventory category' },
  legendary_spirit_required: { zh: '请先装备目标，再使用卷轴', en: 'Equip the target before using a scroll' },
  mesos_insufficient: { zh: '金币不足', en: 'Not enough mesos' },
  scroll_success: { zh: '强化成功，已消耗卷轴和一次升级次数', en: 'Upgrade succeeded; one scroll and upgrade slot were consumed' },
  scroll_failed: { zh: '强化失败，已消耗卷轴和一次升级次数', en: 'Upgrade failed; one scroll and upgrade slot were consumed' },
  unknown_item: { zh: '道具资料不可用', en: 'Item data is unavailable' },
  invalid_equipment_slot: { zh: '装备位置无效', en: 'Invalid equipment slot' },
  source_empty: { zh: '这个格子没有道具', en: 'The source slot is empty' },
  invalid_quantity: { zh: '道具数量无效', en: 'Invalid item quantity' },
  quantity_mismatch: { zh: '道具数量已变化，请重试', en: 'The item quantity changed; try again' },
  request_reused: { zh: '操作编号已使用，请重试', en: 'Request ID was already used; try again' },
  item_unavailable: { zh: '道具已经不可用', en: 'Item is unavailable' },
  item_not_usable: { zh: '这个道具不能直接使用', en: 'This item cannot be used directly' },
  unsupported_item: { zh: '这个道具尚不支持此操作', en: 'This item does not support this action' },
  not_enough_mesos: { zh: '金币不足', en: 'Not enough mesos' },
  dead: { zh: '角色死亡时无法进行此操作', en: 'This action is unavailable while dead' },
  cannot_drop: { zh: '这个道具不能丢弃', en: 'This item cannot be dropped' },
  item_untradeable: { zh: '这个道具不可交易', en: 'This item is untradeable' },
  requirements_not_met: { zh: '未满足装备要求', en: 'Equipment requirements are not met' },
  drop_unavailable: { zh: '道具已经不可用', en: 'Drop is unavailable' },
  drop_owned: { zh: '该物品暂时不可拾取', en: 'This item cannot be picked up yet' },
  drop_invalid: { zh: '道具数据无效', en: 'Drop data is invalid' },
  out_of_range: { zh: '距离道具太远', en: 'Drop is out of range' },
  inventory_full: { zh: '物品栏已满', en: 'Inventory is full' },
  quantity_overflow: { zh: '道具数量过大', en: 'Item quantity is too large' },
  invalid_slot: { zh: '物品栏格子无效', en: 'Inventory slot is invalid' },
  persistence: { zh: '保存失败，请稍后重试', en: 'Persistence failed; try again' },
  chat_rate_limited: { zh: '发言太快，请稍后再试', en: 'You are chatting too fast; wait a moment' },
  invalid_chat_text: { zh: '消息为空、过长或包含不允许的字符', en: 'Empty, overlong, or disallowed characters' },
  idempotency_conflict: { zh: '重复请求使用了不同的内容', en: 'A retried request changed its content' },
});

export function uiLocale(): UiLocale { return locale; }
export function uiText(key: string, fallback = key): string { return TEXT[key]?.[locale] ?? fallback; }
export function protocolText(code: string, fallback: string): string { return PROTOCOL_ERRORS[code]?.[locale] ?? fallback; }
export function mapText(id: string, sourceName: string): string { return displayText(sourceName || id); }
