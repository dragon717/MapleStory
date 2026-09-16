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
  // The TMS273 source tab canvas reads 裝飾 for the third slot-order tab
  // (frame 4 before frame 3); keep the aria label aligned with that drawing.
  inventorySetup: { zh: '装饰', en: 'Setup' },
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
  shopBuyTab: { zh: '购买', en: 'Buy' },
  shopSellTab: { zh: '出售', en: 'Sell' },
  shopRebuyTab: { zh: '赎回', en: 'Redeem' },
  party: { zh: '队伍', en: 'Party' },
  partyCreate: { zh: '创建队伍', en: 'Create party' },
  partyInvite: { zh: '邀请', en: 'Invite' },
  partyKick: { zh: '踢出', en: 'Kick' },
  partyLeave: { zh: '退出队伍', en: 'Leave party' },
  partyLeader: { zh: '队长', en: 'Leader' },
  partyChangeLeader: { zh: '移交队长', en: 'Change leader' },
  partyClose: { zh: '关闭', en: 'Close' },
  partyNameLabel: { zh: '角色名称', en: 'Character name' },
  partyMembers: { zh: '成员', en: 'Members' },
  partyEmpty: { zh: '队伍里还没有其他成员。', en: 'Nobody else is in the party yet.' },
  partySolo: { zh: '你还没有队伍。输入角色名称即可创建。', en: 'You are not in a party. Enter a character name to create one.' },
  partyInvited: { zh: '已邀请', en: 'Invited' },
  partyWaiting: { zh: '等待对方回应…', en: 'Waiting for an answer…' },
  partyAccept: { zh: '接受', en: 'Accept' },
  partyDecline: { zh: '拒绝', en: 'Decline' },
  partyInviteFrom: { zh: '邀请你加入队伍', en: 'invites you to a party' },
  partyPickMember: { zh: '请先选择一名成员。', en: 'Pick a member first.' },
  partyNeedName: { zh: '请先输入角色名称。', en: 'Enter a character name first.' },
  partyDone: { zh: '完成。', en: 'Done.' },
  partyDisbanded: { zh: '队伍已解散。', en: 'The party has ended.' },
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
  whisper_unknown_player: { zh: '找不到这个名字的角色', en: 'No character with that name exists' },
  whisper_self: { zh: '不能给自己发密语', en: 'You cannot whisper yourself' },
  whisper_offline: { zh: '对方当前不在线', en: 'That character is not online' },
  whisper_blocked: { zh: '对方已把你加入黑名单', en: 'That character has blocked you' },
  whisper_ignored: { zh: '你已把对方加入黑名单', en: 'You have blocked that character' },
  npc_too_far: { zh: '距离太远，请靠近 NPC 后再对话', en: 'Stand closer to the NPC to talk' },
  npc_unknown: { zh: '找不到该 NPC', en: 'That NPC is not available' },
  npc_unavailable: { zh: '该 NPC 当前无法与你对话', en: 'That NPC cannot talk right now' },
  npc_step_invalid: { zh: '该对话选项已失效，请重新与 NPC 交谈', en: 'This conversation option is no longer available' },
  job_advance_unavailable: { zh: '当前状态无法进行转职', en: 'Job advancement is unavailable right now' },
  shop_unknown: { zh: '找不到这家商店', en: 'That shop is not available' },
  shop_too_far: { zh: '距离太远，请靠近商人', en: 'Stand closer to the merchant' },
  shop_item_unknown: { zh: '商店不出售此道具', en: 'The shop does not carry this item' },
  shop_not_enough_mesos: { zh: '金币不足', en: 'Not enough mesos' },
  shop_inventory_full: { zh: '物品栏已满', en: 'Inventory is full' },
  shop_quantity_invalid: { zh: '数量无效或道具不足', en: 'Invalid quantity or not enough items' },
  shop_slot_empty: { zh: '这个格子没有道具', en: 'That slot is empty' },
  shop_item_unsellable: { zh: '这个道具无法出售给商店', en: 'This item cannot be sold to a shop' },
  shop_rejected: { zh: '商店拒绝了这次交易', en: 'The shop rejected this trade' },
  shop_rebuy_unknown: { zh: '这一件已经不在赎回列表里了', en: 'That stack is no longer up for buy-back' },
  potion_cooldown: { zh: '道具冷却中，请稍后再使用', en: 'This item is cooling down' },
  map_move: { zh: '已使用传送卷轴，正在移动', en: 'Teleport scroll used; moving' },
  slot_expand_max: { zh: '该物品栏已扩充到上限，无法继续扩充', en: 'This inventory tab is already at its maximum capacity' },
  slot_expand: { zh: '已扩充物品栏', en: 'Inventory expanded' },
  scroll_blocked: { zh: '练习中不能使用传送卷轴', en: 'Teleport scrolls cannot be used during practice' },
  scroll_no_target: { zh: '此地图没有可返回的城镇，卷轴未被消耗', en: 'This map has no return town, so the scroll was not consumed' },
  scroll_unavailable: { zh: '目标城镇尚未开放，卷轴未被消耗', en: 'The destination town is not open yet, so the scroll was not consumed' },
  storage_unknown: { zh: '找不到这个仓库管理员', en: 'That storage keeper is not available' },
  storage_not_keeper: { zh: '这个 NPC 不是仓库管理员', en: 'That NPC is not a storage keeper' },
  storage_too_far: { zh: '距离太远，请靠近仓库管理员', en: 'Stand closer to the storage keeper' },
  storage_closed: { zh: '仓库已关闭，请重新打开', en: 'The storage window is closed; open it again' },
  storage_slot_empty: { zh: '仓库这个格子没有道具', en: 'That storage slot is empty' },
  storage_full: { zh: '仓库已满', en: 'The storage is full' },
  party_unknown_player: { zh: '找不到这个名字的角色', en: 'No character with that name is in the world' },
  party_self: { zh: '不能对自己执行这个操作', en: 'You cannot do that to yourself' },
  party_busy: { zh: '对方已有一个待回应的邀请', en: 'That character already has a pending invitation' },
  party_not_leader: { zh: '只有队长可以执行这个操作', en: 'Only the party leader can do that' },
  party_already: { zh: '对方已经在队伍中', en: 'That character is already in the party' },
  party_full: { zh: '队伍已满（最多 6 人）', en: 'The party is full (6 members at most)' },
  party_no_invite: { zh: '没有待回应的邀请', en: 'There is no pending invitation' },
  party_declined: { zh: '对方拒绝了邀请', en: 'The invitation was declined' },
  party_not_member: { zh: '对方不是这支队伍的成员', en: 'That character is not in this party' },
  party_unavailable: { zh: '这支队伍已经无法加入', en: 'That party can no longer be joined' },
  party_kicked: { zh: '你已被移出队伍', en: 'You were removed from the party' },
  friend_unknown_player: { zh: '找不到这个名字的角色', en: 'No character with that name exists' },
  friend_self: { zh: '不能把自己加入好友或黑名单', en: 'You cannot befriend or block yourself' },
  friend_already: { zh: '对方已经在名单中', en: 'That character is already in the list' },
  friend_full: { zh: '名单已满', en: 'The list is full' },
  friend_declined: { zh: '对方已把你加入黑名单', en: 'That character has blocked you' },
  friend_not_friend: { zh: '对方不是你的好友', en: 'That character is not your friend' },
  friend_not_blocked: { zh: '对方不在黑名单中', en: 'That character is not on the blacklist' },
  emoticon_unknown: { zh: '未知的表情贴图', en: 'Unknown emoticon' },
  emoticon_rate_limited: { zh: '表情发送太快，请稍后再试', en: 'You are sending emoticons too fast; wait a moment' },
  // 高频操作（T04）：攻击、拾取、任务、地图、宠物的拒绝以前没有文案，玩家看到的是
  // 服务端的英文诊断加一个裸错误码 —— "为什么我按了没反应"完全没有答案。以下每条
  // 对应一种玩家真的会撞上的情况，文案要说清**是什么挡住了他**。
  attack_while_climbing: { zh: '爬在绳子或梯子上时无法攻击', en: 'You cannot attack while on a rope or ladder' },
  attack_while_dead: { zh: '死亡状态无法攻击', en: 'You cannot attack while dead' },
  attack_while_channeling: { zh: '技能引导中无法攻击', en: 'You cannot attack while channelling a skill' },
  cooldown: { zh: '上一次攻击动作还没结束', en: 'The previous attack is still in progress' },
  capacity: { zh: '服务器暂时无法处理更多动作，请重新登录', en: 'The server cannot take more actions; please log in again' },
  busy: { zh: '服务器忙碌中，请稍后再试', en: 'The server is busy; try again shortly' },
  rate_limit: { zh: '操作过于频繁，请放慢一点', en: 'You are acting too fast; slow down' },
  invalid_message: { zh: '无法识别的操作', en: 'That request could not be understood' },
  invalid_hello: { zh: '连线握手失败，请重新整理页面', en: 'Handshake failed; reload the page' },
  unauthenticated: { zh: '登录已失效，请重新登录', en: 'Your session expired; log in again' },
  map_unavailable: { zh: '这个地图目前无法进入', en: 'That map is not available right now' },
  portal_unavailable: { zh: '这道传送门现在无法使用', en: 'That portal cannot be used right now' },
  pet_not_summoned: { zh: '尚未召唤宠物', en: 'No pet is summoned' },
  effect_persistence: { zh: '效果未能保存，请稍后再试', en: 'The effect could not be saved; try again' },
  // 采集物：别人先拿走 / 正在被摇动都是**正常的竞争结果**，不是错误，但也不该无声。
  reactor_unknown: { zh: '这里没有可以互动的物件', en: 'There is nothing to interact with here' },
  reactor_busy: { zh: '这个物件正在被摇动，请稍等', en: 'That object is already being used' },
  reactor_out_of_range: { zh: '再靠近一些才能互动', en: 'Move closer to interact with that' },
  reactor_spent: { zh: '这个物件已经被采完了', en: 'That object has already been taken' },
  quest_unknown: { zh: '这个任务不在目前的任务目录中', en: 'That quest is not in the current quest list' },
  quest_script_unavailable: { zh: '此任务的原版剧情尚未接入', en: 'This quest story is not available yet' },
  quest_npc_unavailable: { zh: '此任务NPC目前无法处理任务', en: 'That NPC cannot handle this quest right now' },
  quest_option_unavailable: { zh: '任务选项已更新，请重新开启对话', en: 'The quest options changed; reopen the dialogue' },
  quest_step_invalid: { zh: '这个任务选项已经不存在', en: 'That quest option is no longer offered' },
  quest_transition_invalid: { zh: '任务状态已更新', en: 'The quest state already changed' },
  quest_requirements_missing: { zh: '任务条件尚未完成', en: 'The quest requirements are not met yet' },
  quest_return_unavailable: { zh: '任务路线已更新，请重新开启对话', en: 'The quest route changed; reopen the dialogue' },
  quest_self_service_unavailable: { zh: '此任务无法在任务视窗处理，请找对应的NPC', en: 'This quest cannot be handled from the quest window; find its NPC' },
  // 冒险笔记（图鉴）：登记／奖励／探险的规则尚未核定，本构建只提供浏览与登记事实，
  // 不发放原版奖励，也不结算探险。服务端的回答另带 `blockedReason`，这里只是兜底文案。
  notebook_unverified: { zh: '这个图鉴机制尚未核定，本版本暂不提供', en: 'This notebook mechanic is not verified yet in this build' },
});

/** Minimap window copy (UI/UIMap.img/MiniMap).  The controls themselves are
 *  pure art with no authored label, so these are their tooltips plus the one
 *  line shown for maps the source ships no minimap for. */
const MINIMAP_TEXT: Readonly<Record<string, Readonly<Record<UiLocale, string>>>> = Object.freeze({
  minimapShow: { zh: '展开小地图', en: 'Expand minimap' },
  minimapHide: { zh: '收起小地图', en: 'Collapse minimap' },
  minimapCompact: { zh: '切换为精简小地图', en: 'Switch to compact minimap' },
  minimapFull: { zh: '切换为完整小地图', en: 'Switch to full minimap' },
  minimapZoomOut: { zh: '缩小地图', en: 'Zoom out' },
  minimapZoomIn: { zh: '放大地图', en: 'Zoom in' },
  // The BtNpc button opens the authored NPC 目录 window (its zh tooltip is the
  // source's own `BtNpc/toolTip`; this is the en line and the window's aria
  // label).
  minimapNpc: { zh: 'NPC 目录', en: 'NPC list' },
  minimapPortal: { zh: '传送门标记', en: 'Portal markers' },
  minimapParty: { zh: '队伍成员标记', en: 'Party markers' },
  minimapWorld: { zh: '世界地图', en: 'World map' },
  minimapSelf: { zh: '你的位置', en: 'Your position' },
  minimapNpcListEmpty: { zh: '这张地图上没有 NPC。', en: 'No NPC is placed on this map.' },
  minimapNpcListClose: { zh: '关闭 NPC 目录', en: 'Close the NPC list' },
});

/** World-map window copy (Map.wz WorldMap + UI/UIWindow2.img/WorldMap).  The
 *  window title and every region plate are baked into the source art, so these
 *  are only the control tooltips and the two lines the art cannot carry. */
const WORLD_MAP_TEXT: Readonly<Record<string, Readonly<Record<UiLocale, string>>>> = Object.freeze({
  worldMapClose: { zh: '关闭世界地图', en: 'Close the world map' },
  worldMapAll: { zh: '返回世界总览', en: 'Back to the world overview' },
  worldMapBefore: { zh: '上一张地图', en: 'Previous map' },
  worldMapNext: { zh: '下一张地图', en: 'Next map' },
  worldMapYou: { zh: '你的位置', en: 'Your position' },
  worldMapMissing: { zh: '这个区域还没有可浏览的地图素材。', en: 'No browsable map art is assembled for this region yet.' },
  worldMapNoSource: { zh: '这张地图在原版没有世界地图素材。', en: 'The original ships no world-map art for this map.' },
  worldMapUnreachable: { zh: '这个区域没有可进入的地图，未收录。', en: 'This region holds no reachable map, so it is not assembled.' },
});

/** 冒险笔记（图鉴）窗口文案（计划 §6.3）。  窗口标题与四个页签的名字是**另绘**
 *  的（源把名字烘焙在按钮图里），所以它们是本地化文本而不是源标签；怪物名与
 *  物品名另有各自的目录，不在这里。 */
const NOTEBOOK_TEXT: Readonly<Record<string, Readonly<Record<UiLocale, string>>>> = Object.freeze({
  notebookTitle: { zh: '冒险笔记（图鉴）', en: 'Adventure Notebook' },
  notebookClose: { zh: '关闭冒险笔记', en: 'Close the notebook' },
  notebookDetailClose: { zh: '关闭详情', en: 'Close details' },
  notebookTabMonster: { zh: '怪物收集', en: 'Monsters' },
  notebookTabEquipment: { zh: '装备图鉴', en: 'Equipment' },
  notebookTabUse: { zh: '道具图鉴', en: 'Use items' },
  notebookTabQuest: { zh: '任务道具', en: 'Quest items' },
  notebookLoading: { zh: '正在读取图鉴……', en: 'Loading the notebook…' },
  notebookLoadFailed: { zh: '图鉴目录加载失败。', en: 'The notebook catalogue failed to load.' },
  notebookRetry: { zh: '重试', en: 'Retry' },
  notebookOffline: { zh: '当前未连接服务器，无法读取图鉴。', en: 'Not connected — the notebook cannot be read.' },
  notebookCatalogMismatch: { zh: '图鉴目录版本与服务器不一致，请刷新页面后重试。', en: 'The notebook catalogue is out of date. Reload the page.' },
  notebookSearch: { zh: '搜索名称', en: 'Search by name' },
  notebookPrev: { zh: '上一页', en: 'Previous page' },
  notebookNext: { zh: '下一页', en: 'Next page' },
  notebookModeAvailable: { zh: '当前可获得', en: 'Obtainable now' },
  notebookModeObtained: { zh: '已获得', en: 'Obtained' },
  notebookModeMissing: { zh: '未获得', en: 'Not obtained' },
  notebookModeAll: { zh: '全部', en: 'All' },
  notebookRegistered: { zh: '已登记', en: 'Registered' },
  notebookUnregistered: { zh: '尚未登记', en: 'Not registered' },
  // 源 `monsterStructure.regions[100]` 自己没有名字（那 5 行
  // 「2017冬季怪物收藏活動N」在它里面）。给它编一个地区名是凑数，做成一个
  // 点不出东西的空按钮也没意义——这里标出的是「源没给名字」这件事本身。
  notebookUnnamedRegion: { zh: '（源未命名地区）', en: '(region unnamed in source)' },
  notebookUncollectable: { zh: '尚不可收集', en: 'Not collectable yet' },
  notebookUnavailable: { zh: '本版本未开放', en: 'Not open in this build' },
  notebookObtained: { zh: '已获得', en: 'Obtained' },
  notebookNotObtained: { zh: '未获得', en: 'Not obtained' },
  notebookUnknown: { zh: '未知怪物', en: 'Unknown monster' },
  notebookSpawn: { zh: '出没地图', en: 'Found in' },
  notebookFirstRecord: { zh: '首次记录', en: 'First recorded' },
  notebookTimeUnknown: { zh: '首次获得时间未知（历史补记）', en: 'First obtain time unknown (backfilled)' },
  notebookSourceUnverified: { zh: '获取来源待核实', en: 'Source not verified yet' },
  notebookEmpty: { zh: '没有符合条件的收藏条目。', en: 'No collection row matches what you are looking at.' },
});

/** Menu-entry names that differ from the source button.  The manifest keeps
 *  the source label (`scripts/check_tms273_notebook.cjs` pins it), so the
 *  visible name is decided here — next to the 繁體→简体 conversion every
 *  authored menu label goes through.  A renamed entry must also repaint its
 *  button: the source art bakes the label into the 136x40 image, so a DOM
 *  label alone would sit next to the old glyphs (see `features/menu/view.ts`). */
const MENU_ENTRY_TEXT: Readonly<Record<string, Readonly<Record<UiLocale, string>>>> = Object.freeze({
  // 冒险笔记（图鉴）: the source button is the modern 怪物收藏 entry, but this
  // build reuses that entry for the notebook window, so the name has to say
  // what the window is instead of what the old collection was.
  'menu/buttonInfo/3/6': { zh: '冒險筆記（圖鑑）', en: 'Adventure Notebook' },
});

export function uiLocale(): UiLocale { return locale; }
/** Whether a protocol code has a localized line of its own.  Sites that carry
 *  their own reason in the server message (for example `invalid_state`) answer
 *  `false` on purpose — a generic table entry would flatten those reasons into
 *  one useless sentence. */
export function hasProtocolError(code: string): boolean { return code in PROTOCOL_ERRORS; }
export function uiText(key: string, fallback = key): string { return TEXT[key]?.[locale] ?? MINIMAP_TEXT[key]?.[locale] ?? WORLD_MAP_TEXT[key]?.[locale] ?? NOTEBOOK_TEXT[key]?.[locale] ?? fallback; }
/** The name the menu shows for an entry: the localized override when one is
 *  registered for that entry key, otherwise the source label untouched.  The
 *  result is still authored text, so callers pass it through `displayText`. */
export function menuEntryText(key: string, sourceLabel: string): string { return MENU_ENTRY_TEXT[key]?.[locale] ?? sourceLabel; }
export function protocolText(code: string, fallback: string): string { return PROTOCOL_ERRORS[code]?.[locale] ?? fallback; }
export function mapText(id: string, sourceName: string): string { return displayText(sourceName || id); }
