// MVP contract: positions are world-space foot coordinates; Rust owns all authoritative state.
export const PROTOCOL_VERSION = 32;
export const CONTENT_VERSION = 'tms273-33';
export type Facing = -1 | 1;
export type AbilityStat = 'strength' | 'dexterity' | 'intelligence' | 'luck';
export interface AbilityStats { strength: number; dexterity: number; intelligence: number; luck: number; availableAp: number; }
export interface InventoryItem {
  slot: number; itemId: string; quantity: number;
  stats?: Record<string, number>; remainingSlots?: number; upgradeCount?: number;
}
export interface Appearance {
  gender: number; face: number; hair: number; skin: number;
  coat: number; pants: number; shoes: number; weapon: number;
}
/** Permanent, server-derived passives; never sent as a client intent. */
export interface RegenerationPassive {
  id: string; bookId: number; hpPerSecond: number; mpPerSecond: number;
}
/** 骑乘状态（协议 24 的加法字段，双端同名同形）。全部由服务端从**已装备**的骑宠行与
 *  源坐骑档推出；客户端只读，永远不能上报「我在骑」「我骑的是哪只」。 */
export interface MountState {
  /** 已装备的骑宠装备 id（源 islot Tm/Sd，身体槽 −18/−19）。 */
  itemId: string;
  /** 源 `info.tamingMob` 指向的坐骑档 id。 */
  tamingMob: number;
  /** 以下全部来自源 `TamingMob/<id>.json/info`：百分比口径（100 = 常规），不是像素速率。 */
  speed: number; jump: number; fs: number; fatigue: number;
}
/** 坐姿状态（协议 24 的加法字段）。坐姿是**会话状态**：不落库，
 *  重连/换图/死亡/受击/移动输入即结束。 */
export interface ChairState {
  itemId: string;
  /** 源 `info.recoveryHP` / `info.recoveryMP`（缺席即 0）。 */
  recoveryHp: number; recoveryMp: number;
  /** 恢复间隔。**缺席**表示该椅子的间隔未核定（源只看描述文案有没有写「每N秒」），
   *  此时服务端不恢复，客户端也不得显示倒计时——套一个默认 10 秒就是编规则。 */
  recoveryIntervalMs?: number;
  /** 距下一次恢复的剩余毫秒；与 `recoveryIntervalMs` 同生共死。 */
  nextRecoveryInMs?: number;
}
export interface PlayerState {
  id: string; username: string; appearance?: Appearance; x: number; y: number; vx: number; vy: number;
  facing: Facing; grounded: boolean;
  /** True while inside an authored water rectangle. A swimming body is never
   *  grounded, so clients need this to route the jump key correctly. */
  swimming?: boolean;
  action: 'stand' | 'walk' | 'jump' | 'attack' | 'climb' | 'ladder' | 'rope' | 'dead' | 'sit';
  actionId: string | null; actionStartedTick: number; lastInputSeq: number;
  climbing: boolean; ladderId: number | null;
  hp: number; maxHp: number; mp: number; maxMp: number;
  /** 骑乘中才有；服务端从已装备的骑宠行导出（缺席即未骑乘）。 */
  mount?: MountState;
  /** 坐在椅子上才有；服务端从设置栏的实物导出（缺席即未坐下）。 */
  chair?: ChairState;
  /** Server-owned persisted job ID; absent on older protocol 6 servers. */
  job?: number;
  /** Server-owned learned levels by skill ID; missing entries mean level 0, absent map means unknown. */
  skills?: Record<string, number>;
  /** Server-owned SP balances; source SP group mapping is not yet established. */
  skillPoints?: Record<string, number>;
  hyperPoints?: Record<string, number>;
  hyperResetCount?: number; hyperResetCost?: number;
  /** Server-owned consumable cooldowns: item id -> remaining ms. Only items
   *  that author a source cooldown appear; an empty or absent map means every
   *  carried potion is ready. Clients render this; they never decide it. */
  potionCooldowns?: Record<string, number>;
  abilityStats?: AbilityStats;
  derivedStats?: { hyperBarrierActive?: boolean; hyperTeleportEnabled?: boolean; damageReductionPercent?: number; regenerationPassives?: RegenerationPassive[]; infinityEnhanced?: boolean; skillCooldowns?: Record<string, number>; skillBuffs?: Record<string, number>; meditationRemainingMs?: number; iceTeleport?: boolean; teleportMastery?: boolean; teleportBoost?: boolean; adaptationCharges?: number; adaptationCooldownMs?: number; statusResistance?: number; elementResistance?: number; magicAttack: number; defense: number; moveSpeed: number; magicGuard: boolean; strength?: number; dexterity?: number; intelligence?: number; luck?: number };
  level: number; exp: number; expToNext: number; mesos: number;
  /** Server-owned 現金商店 balance (P: topped up only by the GM /cash command;
   *  no real charging exists).  Clients render it and never submit it. */
  cash?: number;
  inventory: InventoryItem[];
  equipped?: InventoryItem[];
  monsterBook?: Record<string, number>;
  /** Server-owned per-tab inventory capacity. Keys are inventoryType 1..=5
   *  (equip/use/setup/etc/cash), values are the current slot count. A fresh
   *  character starts at 24 per tab; slot-expansion coupons raise a tab by 8
   *  up to 128. Absent means every tab defaults to 24. */
  inventorySlots?: Record<number, number>;
  /** Server-owned away marker; display only, grants no protection or assets. */
  away?: AwayMarker;
  /** Character-owned companion instances; the server simulates up to three. */
  pets?: PetState[];
  /** Monster-inflicted abnormal statuses, present only while at least one is
   *  active. Remaining milliseconds are display-only; the server owns the
   *  authoritative deadlines and decides when each status actually ends. */
  abnormalStatus?: AbnormalStatus;
}
/** Authoritative companion snapshot; inventorySlot is its current cash-tab cell. */
export interface PetState {
  id: string; itemId: string; name: string; inventorySlot: number;
  x: number; y: number; facing: Facing; action: 'stand' | 'move' | 'jump';
  /** Display speed: 100 maps to the character's unbuffed 125 world units/s. */
  baseSpeed: number; moveSpeed: number; mode: 'idle' | 'follow' | 'loot';
  /** Growth state (protocol 21+): the server derives every value from the
   *  persisted instance stats and the source hunger pace.  `fullness` is the
   *  0-100 饱足感, `level` 1..=30, `closeness` the cumulative 亲密度 and
   *  `closenessToNext` the remainder to the next level (0 at the cap).
   *  `weak` marks the hungry display state, and `lifeRemainingMs` is the
   *  wall-clock time left before the pet reverts to a doll. */
  level?: number; fullness?: number; closeness?: number; closenessToNext?: number;
  weak?: boolean; lifeRemainingMs?: number;
}
/** Player-side abnormal-status presentation state. Emitted in snapshots; each
 *  entry is the remaining milliseconds for the named status. */
export interface AbnormalStatus {
  sealMs?: number;
  stunMs?: number;
  curseMs?: number;
  poisonMs?: number;
  slowMs?: number;
}
/** Away presentation state. Durations are display-only; the server re-derives
 *  the stage from its own clock and decides when residency actually ends. */
export interface AwayMarker {
  /** True once continuous absence reached the full-retention threshold. */
  residency: boolean;
  /** Milliseconds until the normal exit path runs. Display only. */
  remainingMs: number;
}
export interface MonsterState {
  id: string; templateId: string; x: number; y: number; facing: Facing;
  freezeStacks?: number;
  hp: number; maxHp: number; action: 'stand' | 'move' | 'hit' | 'freeze' | 'die' | 'attack1' | 'attack2' | 'skill1'; actionStartedTick: number;
}
export interface SummonState {
  id: string; playerId: string; skillId: number; x: number; y: number;
  facing: Facing; expiresInMs: number; stationary: boolean;
}
export interface QuestInteraction { questId: string; mapId: string; x: number; y: number; range: number; label: string; mapLayerKey?: string; }
export interface NpcState {
  id: string; templateId: string;
  /** Authoritative English display name (reference v83). */
  name: string;
  /** Chinese display name (server carries shared/npc-names.json). Additive optional. */
  nameZh?: string;
  x: number; y: number;
  facing: Facing; shopId?: string;
  jobAdvancementAvailable?: boolean;
  questAvailable?: boolean;
}
export interface DropState { id: string; itemId: string; quantity: number; x: number; y: number; }
/** 原创扩展「死亡世界」：一座墓碑的权威快照。虚影演化阶段（0 潜伏 → 1 游荡 →
 *  2 凝聚）由服务端按死亡经过时间与悼念人数**纯函数推导**，客户端只渲染标签与
 *  观感差异，永远不自行推进或回退阶段。碑文是死亡事实的一部分，随快照公开；
 *  `expiresInMs` 是展示倒计时，真正的到期裁决永远在服务端时钟里。
 *  `appearance` 是死亡时刻的角色外观：虚影的样子 = 这份外观的灰色形态，走现有
 *  纸娃娃管线渲染；缺席（老快照/无外观）时客户端退回抽象光点。 */
export interface TombstoneSnapshot {
  id: string; x: number; y: number;
  characterName: string; epitaph: string;
  stage: 0 | 1 | 2; stageName: string;
  mourners: number; expiresInMs: number;
  appearance?: Appearance;
}
/** Authoritative live state of one placed map reactor. `state` is the authored
 *  WZ state index; the last state is the empty "used up" form. */
export interface ReactorState {
  id: string; templateId: string; x: number; y: number; flip: boolean;
  /** Source event type from ReactorPlacement: 0=attack, 9=area/click.
   *  Older snapshots may omit this, so clients should treat missing as 0. */
  hitType?: number;
  state: number; spent: boolean; hitting: boolean; respawnInMs?: number;
}
/** Direction of one warehouse move. The client only names the direction, the
 *  tab and the slot; the server resolves the item and its quantity. */
export type StorageDirection = 'deposit' | 'withdraw';
/** One authoritative view of the account warehouse. Sent only to its owner. */
export interface StorageState {
  /** Warehouse rows ordered by slot; equipment keeps its instance stats. */
  items: InventoryItem[];
  /** Warehouse mesos, a balance separate from the character's purse. */
  mesos: number;
  /** Total number of rows the warehouse can hold. */
  slotLimit: number;
  /** The storage keeper this window belongs to. */
  npcId: string;
}
/** One row of the character's buy-back list: a stack sold to a merchant that
 *  can be bought back for what the shop paid for it. Rows are owned by the
 *  server (persisted, newest first, capped) and only ever shown, never
 *  authored, by the client. */
export interface ShopRebuyEntry {
  itemId: string;
  quantity: number;
  /** What the shop paid per unit when the stack was sold, i.e. the price the
   *  character pays to buy the row back. */
  unitPrice: number;
}
/** One row of an authoritative party roster. The roster is rebuilt server-side
 *  from the characters actually in the world, so a departed member never
 *  lingers and a stale cached copy can never be trusted. */
export interface PartyMember {
  id: string; name: string; level: number; job: number;
  mapId: string; hp: number; maxHp: number; mp: number; maxMp: number;
  /** Exactly one row per party carries this; it is the leader the server owns. */
  leader: boolean;
}
/** One authoritative view of a party, or `closed: true` when the character is
 *  no longer in one — a party of fewer than two members stops existing, except
 *  while the invitation it just sent is still pending. */
export interface PartyState {
  partyId: string; leaderId: string; members: PartyMember[];
}
/** One row of the friend or blacklist window. The persisted half (id, name,
 *  level, job) comes from the account rows; `online` and `mapId` are derived
 *  from the live world on every push, so an offline friend has no location
 *  and a stale snapshot can never be presented as a live one. */
export interface FriendEntry {
  id: string; name: string; level: number; job: number;
  online: boolean;
  /** Empty while the character is offline. */
  mapId: string;
}
export interface BossPracticeState {
  status: 'available' | 'active' | 'cleared' | 'failed';
  sourceMapId: string; bossId: string; minimumLevel: number; encounterId?: string;
  canEnter: boolean; blockReason?: string; phaseLabel?: string;
  effects?: { skillId: number; elapsedMs: number; remainingMs: number }[];
  telegraph?: { kind: 'rect' | 'circle'; x: number; y: number; width?: number; height?: number; radius?: number; remainingMs: number };
}
export type WindbellAction = 'enterIsland' | 'enterBridge' | 'leave' | 'cutSupport' | 'ignite' | 'deployLeafwing' | 'talk' | 'braceCart' | 'deliverPlank' | 'deliverRope' | 'rest' | 'dryRecords';
export interface WindbellState {
  scene: 'island' | 'bridge'; instanceId: string;
  treeBridge: 'held' | 'falling' | 'landed'; heat: 'dry' | 'burning' | 'spent';
  leafwing: boolean; leafwingLearned?: boolean; arrivalPath: 'root' | 'bridge' | 'fire' | 'leafwing' | null;
  bridgeStage: 'broken' | 'working' | 'connected' | 'inhabited';
  bridgeSegments?: number; cartX?: number;
  livelihood?: { phase: 'loading' | 'outbound' | 'resting' | 'returning'; source: number; shelter: number; cargo: number; deliveries: number; paperMoisture: number };
  archiveSafe?: boolean;
  journey?: { braceCart: boolean; deliveredPlanks: number; deliveredRopes: number; arrived: boolean; arrivalPath: WindbellState['arrivalPath']; lastAttempt: string | null; leafwingLearned: boolean; archiveHelped: boolean; archiveRead: boolean; huaishengMet: boolean };
  cartUpright: boolean; planks: number; ropes: number; dialogue: string[]; revision: number;
}
export type ColossusAction = 'enter' | 'leave' | 'board' | 'skip' | 'travel';
export type Vec3 = [number, number, number];
export interface ColossusBody { track: string; s: number; position: Vec3; velocity: Vec3; grounded: boolean; speed: number; facing: number }
export interface ColossusState {
  region: string; passage: { id: string; track: string; s: number; toTrack: string; toS: number; label: string } | null;
  seconds: number; sequence: number;
  frame: { id: string; revision: number; position: Vec3; yaw: number };
  bridgeOpen: boolean; bridgeAge: number | null; helped: boolean; seaLevel: number;
  actors: { id: string; name: string; body: ColossusBody; attacking: boolean }[];
  people: ColossusBody[]; stones: ColossusBody[];
}
export type ClientMessage =
  | { type: 'colossus'; requestId: string; sequence: number; action: ColossusAction }
  | { type: 'windbell'; requestId: string; sequence: number; action: WindbellAction; instanceId?: string }
  | { type: 'hello'; token: string; protocolVersion: number; contentVersion: string; lang?: 'zh' | 'en' }
  | { type: 'input'; seq: number; direction: -1 | 0 | 1; vertical: -1 | 0 | 1; jump: boolean }
  | { type: 'attack'; requestId: string }
  | { type: 'bossPractice'; requestId: string; action: 'enter' | 'leave' | 'retry'; encounterId?: string }
  | { type: 'allocateAp'; requestId: string; stat: AbilityStat }
  | { type: 'resetHyper'; requestId: string; expectedCost: number }
  | { type: 'learnSkill'; requestId: string; skillId: number }
  | { type: 'castSkill'; requestId: string; skillId: number; direction?: -1 | 0 | 1; vertical?: -1 | 0 | 1 }
  | { type: 'releaseSkill'; requestId: string }
  | { type: 'revive'; requestId: string }
  /** 原创扩展「死亡世界」：向一座墓碑悼念。客户端只命名墓碑；存在性、到期、
   *  同图、距离与去重全部由服务器裁决——重复悼念重放同一份状态，不重复计数。 */
  | { type: 'tombstoneMourn'; requestId: string; tombstoneId: string }
  | { type: 'pickup'; requestId: string; dropId: string }
  /** Intent to strike one authored map reactor. The client only names the prop;
   *  the server decides range, whether it is still usable, and the next state. */
  | { type: 'reactorHit'; requestId: string; reactorId: string }
  | { type: 'portal'; requestId: string; portalName: string }
  /** Intent to jump to one map through the world map (大地图).  The client
   *  only names the map id of the clicked spot; the server decides whether
   *  that map is assembled and lands the body on its authored `sp` spawn. */
  | { type: 'worldMapMove'; requestId: string; mapId: string }
  | { type: 'inventoryMove'; requestId: string; inventoryType: number; sourceSlot: number; targetSlot: number; quantity: number }
  | { type: 'dropItem'; requestId: string; inventoryType: number; sourceSlot: number; quantity: number }
  | { type: 'inventoryGather' | 'inventorySort'; requestId: string; inventoryType: number }
  | { type: 'useItem'; requestId: string; inventoryType: number; sourceSlot: number; itemId: string; targetSlot?: number; targetItemId?: string }
  | { type: 'dropMesos'; requestId: string; quantity: number }
  | { type: 'questInteract'; requestId: string; questId: string }
  /** Accept/hand in a self-service quest from the quest window.  `action` is
   *  the only client input; every condition and the self-service flag are
   *  re-read from the server's own quest catalog. */
  | { type: 'questService'; requestId: string; questId: string; action: 'start' | 'complete' }
  | { type: 'npcTalk'; requestId: string; npcId: string; step?: 'start' | 'next' | 'prev' | 'yes' | 'no' | 'select' | 'end'; selection?: number }
  | { type: 'shopBuy'; requestId: string; shopId: string; itemId: string; quantity: number }
  /** Intent to sell one inventory stack back to an NPC shop. The client names
   *  the shop, tab and slot only; the item, its sellability and the mesos paid
   *  are all resolved server-side. No itemId or price is accepted. */
  | { type: 'shopSell'; requestId: string; shopId: string; inventoryType: number; sourceSlot: number; quantity: number }
  /** Intent to buy one row back from the shop's buy-back tab. The client names
   *  the item and the price it was sold for; the server looks the row up in the
   *  character's persisted list, so a forged request can neither invent an item
   *  nor claim a price. */
  | { type: 'shopRebuy'; requestId: string; shopId: string; itemId: string; unitPrice: number }
  /** Open (or refresh) the 現金商店 window. The client names nothing that
   *  matters: the balance is an account fact the server re-reads. */
  | { type: 'cashOpen'; requestId: string }
  /** Buy one commodity row `quantity` deals. The client may only name the SN
   *  it accepts; the item, its price, stack count and every sale condition
   *  (on-sale flag, level, popularity, gender) are resolved server-side. */
  | { type: 'cashBuy'; requestId: string; sn: string; quantity: number }
  /** Open the account warehouse at a placed storage keeper. The server decides
   *  whether that npc is a keeper and whether the player is close enough. */
  | { type: 'storageOpen'; requestId: string; npcId: string }
  /** Move one stack between the inventory and the warehouse. The client names
   *  only the direction, tab and slot; item identity, quantity and capacity are
   *  resolved server-side. */
  | { type: 'storageTransfer'; requestId: string; operation: StorageDirection; inventoryType: number; slot: number; quantity: number }
  /** Move mesos between the character purse and the warehouse. */
  | { type: 'storageMesos'; requestId: string; operation: StorageDirection; quantity: number }
  /** Invite one character into a party. The client names only the character;
   *  the server resolves the name to somebody actually in the world, decides
   *  whether a party has to be created, and owns the pending invitation. */
  | { type: 'partyInvite'; requestId: string; playerName: string }
  /** Accept or decline the pending invitation. The server owns which
   *  invitation exists and who it was addressed to, so a client can never
   *  answer somebody else's invitation or join a party uninvited. */
  | { type: 'partyRespond'; requestId: string; accept: boolean }
  /** Leave the party the character currently belongs to. */
  | { type: 'partyLeave'; requestId: string }
  /** Remove one member. Leader only; the server re-checks both the leadership
   *  and the membership, and `playerId` is validated before it is used. */
  | { type: 'partyKick'; requestId: string; playerId: string }
  /** Hand leadership to another member (source `BtChangeBoss`). */
  | { type: 'partyLeader'; requestId: string; playerId: string }
  /** Open (or refresh) the friend & blacklist window. The client names
   *  nothing: friends are account facts, and the online flag is a live world
   *  fact the server derives on every push. */
  | { type: 'friendOpen'; requestId: string }
  /** Add one character as a friend. The client types a name — the source
   *  context menu carries no id — and the server resolves it, owns the cap,
   *  and writes the pair in both directions. */
  | { type: 'friendAdd'; requestId: string; playerName: string }
  /** Drop one friend. The client names the row it selected; the server
   *  re-checks that the friendship exists before deleting both directions. */
  | { type: 'friendRemove'; requestId: string; playerId: string }
  /** Put one character on the blacklist. Blocking also dissolves an existing
   *  friendship and stops that character's map chat from reaching us. */
  | { type: 'friendBlock'; requestId: string; playerName: string }
  /** Take one character off the blacklist. */
  | { type: 'friendUnblock'; requestId: string; playerId: string }
  | { type: 'chatSend'; requestId: string; text: string }
  /** Whisper one character (密語). The client types the *other* character's
   *  display name and the body; the server resolves the name, decides whether
   *  the pair may talk (self / offline / either blacklist), and is the only
   *  author of the delivered message. No id, map or channel is accepted. */
  | { type: 'whisperSend'; requestId: string; targetName: string; text: string }
  /** Show one chat emoticon (表情貼圖) to the current map. The client names
   *  only a catalogue id (`<groupId>:<sourceName>`) taken from the exported
   *  `UI/ChatEmoticon.img` table; the server checks that id against the same
   *  table, owns the source send budget (`ChatLimit`, 4 per 5000 ms) and is
   *  the only author of the delivered message, so a modified client can
   *  neither invent a sticker nor flood the room. */
  | { type: 'emoticonSend'; requestId: string; emoticonId: string }
  /** Page lifecycle hint. Server keeps its own away clock; this never grants
   *  assets, invulnerability, or control of the away window. */
  | { type: 'lifecycle'; hidden: boolean; away?: boolean; clientNowMs?: number }
  /** Explicit logout: removes the character instead of keeping it resident. */
  | { type: 'logout' }
  /** 冒险笔记（图鉴）查询. The client names a section, a page and a bounded
   *  filter — never a character or account id, and never a monster or item it
   *  claims to have. The quest section is filtered server-side over the rows
   *  this character really obtained, so an un-obtained task entry is never on
   *  the wire in the first place (not merely hidden with CSS). */
  | { type: 'notebookQuery'; requestId: string; section: NotebookSection; page: number; catalogVersion: string; filter?: string; mode?: NotebookBrowseMode }
  /** Claim one original completion reward. The `rewardKey` is one the server
   *  itself handed out; eligibility, the receiving character and the slot
   *  capacity are all recomputed server-side. */
  | { type: 'collectionClaim'; requestId: string; rewardKey: string }
  /** Dispatch one collection row on an exploration. The client names only the
   *  row; the combination requirement, the duration and the slot rule belong
   *  to the server. */
  | { type: 'explorationStart'; requestId: string; rowKey: string }
  /** Claim a finished exploration. `runId` must be one the server issued. */
  | { type: 'explorationClaim'; requestId: string; runId: string };
/** 冒险笔记（图鉴）的页签。 Kept as its own union so an unknown or misspelled
 *  section is a deserialization error on both sides rather than a silently
 *  ignored field. `quest` is server-filtered: the client never learns an
 *  un-obtained task entry from it. `mount` is the ride-pet page: mounts are
 *  authored outside the item tree (`Character/TamingMob`, shipped as
 *  `shared/mounts.json`), so they get their own section rather than being
 *  folded into the equipment page's obtainable denominator. `chair` is the same
 *  shape: chairs ship as `shared/chairs.json` (`Item/Install/0301*`, `0302`),
 *  the item tree carries only the couple that a shop really sells, and the rest
 *  of the family lives only on this page. `saddle` is the `Sd` half of
 *  `shared/mounts.json` — the 26 saddle items that sit on a mount but carry no
 *  `tamingMob` (so the ride check never treats them as mounts). It is shown as
 *  a sub-page of the mount tab, and it is a section of its own so that
 *  membership stays a disjoint cover: one item belongs to exactly one page. */
export type NotebookSection = 'monster' | 'equipment' | 'use' | 'setup' | 'etc' | 'cash' | 'pet' | 'mount' | 'saddle' | 'chair' | 'quest';
/** How the server narrows an item page.  It is interpreted **inside** the
 *  server's own set, so no value of it can reveal an un-obtained quest entry:
 *  - `available` (default, and any unknown value): only templates the catalog
 *    says are obtainable today — the honest denominator (plan §5.5).
 *  - `all`: the whole section, including templates this build cannot source.
 *  - `obtained`: only what this character really obtained.
 *  - `missing`: obtainable but not obtained yet.  A template the catalog
 *    cannot source is not "missing", it is simply not open.
 *  The quest section ignores it on purpose: its base set is already "obtained",
 *  so a mode could only ever hide a fact the player really has. */
export type NotebookBrowseMode = 'available' | 'all' | 'obtained' | 'missing';
/** One displayable notebook row. `owned`/`registered` are the private halves
 *  and are only ever computed on the server; `label`, `iconItemId` and
 *  `monsterTemplateId` are directory facts the client already ships. */
export interface NotebookRow {
  /** Stable directory key: collection entry id, item template id, or quest row key. */
  key: string;
  label: string;
  /** `obtained` / `registered` are the private facts; `available` is the
   *  directory's own availability for the item pages. */
  obtained: boolean;
  registered: boolean;
  /** Item template id whose icon to draw, for the item pages. */
  itemId?: string;
  /** Monster template id whose standing frame to draw, for the monster page. */
  monsterTemplateId?: string;
  /** Item pages only: how the template is categorised (the directory's own
   *  availability value, never a projection of what the player did). */
  availability?: 'obtainable' | 'unavailable' | 'unverified';
  /** Monster page only: the authored row this entry belongs to. */
  rowKey?: string;
  /** First-record evidence for an obtained row. Absent means "not obtained". */
  firstRecordMs?: number;
  /** True when the row is a historical backfill whose real event time is
   *  unknown — the client must not render `firstRecordMs` as an obtain time. */
  timeUnknown?: boolean;
  /** Monster page only: the authored slots of this row, in `Etc/mobCollection`
   *  order.  Each slot is one collection entry, so the row's own
   *  `obtained`/`registered` are derived from them, never the other way round. */
  slots?: NotebookSlot[];
  /** Source-authored prose for the detail panel (monster `episode`).  Absent
   *  when the source writes none, so the panel never renders an empty block. */
  detail?: string;
  /** Monster page only: the authored spawn maps the source really names. */
  spawnMapIds?: string[];
}
/** One authored collection slot.  `collectable` is the directory's own verdict
 *  on whether this build actually fields the monster — it is not a promise that
 *  a registration rule exists. */
export interface NotebookSlot {
  key: string;
  label: string;
  monsterTemplateId: string;
  registered: boolean;
  collectable: boolean;
  detail?: string;
  spawnMapIds?: string[];
}
export interface NotebookSummary {
  /** Monster page: how many of the *whole original* entry set are registered. */
  registered: number;
  total: number;
  /** Monster page: the reduced "collectable in this build" count, kept apart
   *  from `total` so a row reward can never be earned against it. */
  collectable: number;
  /** Quest page: how many kinds this character has a record for. There is no
   *  denominator on purpose — the future task catalogue is not public. */
  recorded?: number;
}
export interface NotebookRewardState {
  /** Server-authored key; the client echoes it back verbatim. */
  rewardKey: string;
  label: string;
  rewardItemId: string | null;
  /** `unverified` means the source does not state the completion condition,
   *  so the client shows the reason instead of a progress bar. */
  status: 'unverified' | 'claimable' | 'claimed';
  reason?: string;
}
export interface NotebookExplorationState {
  runId: string;
  rowKey: string;
  label: string;
  startedAtMs: number;
  finishesAtMs: number;
  status: 'running' | 'claimable' | 'claimed';
  rewardItemId: string | null;
}
export interface DialogueOption { index: number; text: string }
export interface QuestLogEntry {
  questId: string; name: string;
  /** `blocked`: every prerequisite is met, but the current build cannot run
   *  this quest (missing source script / NPC / map).  Display-only — the row
   *  carries `blockReason` and never an accept control. */
  status: 'available' | 'active' | 'objectivesComplete' | 'completed' | 'blocked';
  summary: string;
  objectives?: { text: string; current: number; required: number }[];
  /** Source `QuestInfo/selfStart` / `selfComplete`: the quest window is this
   *  phase's real entrance because the source ships no NPC for it.  The client
   *  only offers the matching control and never decides the transition. */
  selfStart?: boolean; selfComplete?: boolean;
  targetMapId?: string; targetNpcId?: string; nextAction?: string; blockReason?: string;
}
export interface QuestRewardInfo {
  mesos: number; exp: number;
  items: { itemId: string; quantity: number }[];
}
/** 飞行船班次展示状态。Only maps on a ship route carry this snapshot field;
 *  the client renders it and never decides anything with it — the server owns
 *  the authoritative phase clock and boarding gate. */
export interface ShipSnapshotState {
  route: 'victoria-orbis' | 'orbis-victoria' | 'victoria-erev' | 'erev-victoria' | 'victoria-edelstein' | 'edelstein-victoria';
  phase: 'sailing' | 'boarding';
  secondsLeft: number;
  /** 甲板正被「地獄巴洛古」袭击时才有（三期）。同样是展示字段：袭击的刷怪、
   *  撤离与掉落在服务端权威模拟里完成，客户端只用它显示倒计时。 */
  event?: ShipEventState;
}
/** 飞行船甲板袭击（三期）。`monsterId` 是源模板 id，`monsterName` 取自同版
 *  怪物名表（`String/Mob.json`）。 */
export interface ShipEventState {
  monsterId: string;
  secondsLeft: number;
}
/** 甲板袭击开始/结束的全图播报。与 `shipEvent` 快照字段不同，这是**一次性**
 *  事件，只在袭击起止那一刻推给甲板上的观察者。 */
export interface ShipEventNotice {
  type: 'shipEvent';
  route: ShipSnapshotState['route'];
  event: 'balrog_attack' | 'balrog_over';
  monsterId: string;
  monsterName: string;
  seconds: number;
}
export type ServerMessage =
  | { type: 'worldMapMoveResult'; requestId: string; success: boolean; code: string; mapId: string }
  | { type: 'abilityResult'; requestId: string; success: boolean; code: string; abilityStats: AbilityStats }
  | { type: 'snapshot'; colossus?: ColossusState; colossusSequence?: number; windbellSequence?: number; serverTick: number; tickMs: number; mapId: string; sourceMapId?: string; bossPractice?: BossPracticeState; windbell?: WindbellState; ship?: ShipSnapshotState; selfId: string; players: PlayerState[]; monsters: MonsterState[]; npcs?: NpcState[]; questInteractions?: QuestInteraction[]; summons?: SummonState[]; reactors?: ReactorState[]; tombstones?: TombstoneSnapshot[]; drops: DropState[] }
  | { type: 'actionStarted'; serverTick: number; playerId: string; actionId: string; requestId: string; durationMs: number; eventId: string; x: number; y: number; facing: Facing }
  | { type: 'skillCast'; phase?: 'prepare' | 'sustain' | 'final'; eventId: string; serverTick: number; playerId: string; skillId: number; skillLevel?: number; requestId: string; x: number; y: number; facing: Facing; durationMs: number; targetId?: string; targetX?: number; targetY?: number }
  | { type: 'skillResult'; requestId: string; skillId: number; operation: 'learn' | 'cast' | 'hyper_reset'; success: boolean; code: string }
  /** 一次伤害结算的权威结果。`damage` 是**落在 HP 上**的那一份；开启了魔心防禦
   *  时，被护罩接下并由 MP 承受的那一份走 `mpDamage`（两者之和不超过这一击的
   *  实际承伤，见 `server/src/monsters.rs::commit_incoming_damage`）。客户端只
   *  照这两根数字表现，不自行拆分、不推导。
   *
   *  兼容性：`mpDamage` 是**新增的可选字段**，服务端自引入起就在发，这里只是把
   *  TS 侧对齐到已经存在的事实；不认识它的老客户端会把它当未知字段忽略。 */
  | { type: 'damageEvent'; eventId: string; serverTick: number; attackerId: string; targetId: string; x: number; y: number; damage: number; killed: boolean; critical?: boolean; skillId?: number; skillLevel?: number; segment?: number; targetCount?: number; mpDamage?: number }
  /** 一次权威的资源恢复，**只发给当事人**：恢复是私事，同图其他人不该看到你
   *  喝药水或坐椅子的数字。`hp`／`mp` 是这一 tick 的**实际增加量**，不是技能或
   *  道具声明的数值——已经顶到上限时它必然小于声明值，跳字要显示的是实际加了多少。
   *  `source` 只用于追溯与门禁，不参与表现选型：颜色只由 `hp`／`mp` 各自决定
   *  （绿字回血、蓝字回魔）。
   *
   *  刻意**没有**自然恢复（`regeneration_passives_for_job` 的每秒被动回复）这一档：
   *  原版那条路径不产生跳字，且每秒触发会持续刷屏。 */
  | { type: 'recoveryEvent'; eventId: string; serverTick: number; playerId: string; x: number; y: number; hp?: number; mp?: number; source: 'potion' | 'recovery' | 'chair' | 'infinity' | 'windbell' }
  /** A mob's authored abnormal-status skill cast, broadcast to its map so every
   *  observer can play the source action. `targetId` is the player the cast
   *  resolved against; the authoritative disease application rides the next
   *  snapshot as `abnormalStatus` on that player's row. */
  | { type: 'monsterSkill'; eventId: string; serverTick: number; monsterId: string; skillId: number; action: number; effectAfterMs: number; targetId: string }
  | { type: 'dropPickedUp'; mapId: string; dropId: string; playerId: string; x: number; y: number }
  /** Authoritative result of one reactor hit, broadcast to the whole map so
   *  every observer plays the same one-shot animation and sees the same state. */
  | { type: 'reactorState'; serverTick: number; mapId: string; reactorId: string; state: number; spent: boolean; hitDurationMs: number; respawnInMs?: number; playerId: string }
  | { type: 'pickupResult'; requestId: string; dropId: string; itemId: string; quantity: number; slot?: number }
  | { type: 'portalResult'; requestId: string; success: boolean; code: string; sourceMapId: string; targetMapId?: string }
  | { type: 'inventoryResult'; requestId: string; operation: 'move' | 'drop' | 'gather' | 'sort' | 'use' | 'equip' | 'unequip' | 'dropMesos'; inventoryType?: number; sourceSlot: number; targetSlot?: number; itemId: string; quantity: number; dropId?: string; success: boolean; code: string }
  | { type: 'inventoryDropResult'; requestId: string; operation: 'drop'; sourceSlot: number; itemId: string; quantity: number; dropId?: string; success: boolean; code: string }
  | { type: 'reviveResult'; requestId: string; success: boolean; code: string }
  /** 原创扩展「死亡世界」：一次悼念的权威结果（只发给悼念者本人）。`alreadyMourned`
   *  表示这份结果是一次重放：同一角色对同一座碑只计一次。 */
  | { type: 'tombstoneResult'; requestId: string; tombstoneId: string; characterName: string; epitaph: string; stage: 0 | 1 | 2; stageName: string; mourners: number; alreadyMourned: boolean }
  | { type: 'npcResult'; requestId: string; success: boolean; code: string; npcId: string; name: string; nameZh?: string; dialog?: { kind: 'next' | 'nextPrev' | 'prev' | 'ok' | 'yesNo' | 'simple'; text: string; options?: DialogueOption[];
  /** 这段对话的来源（阶段一 2026-09-17 / 阶段二 2026-09-17）。缺省＝源台词、
   *  服务端脚本或职能分发产生的对话；`placeholder`＝**源里这个 NPC 就没有说话
   *  内容**（`傳送門`／`警告牌`／`繳納箱` 这类物件型条目），服务端据实回占位提示
   *  （`server/src/npc.rs::PLACEHOLDER_DIALOGUE`，与这里必须同值）。
   *  它不是给玩家的文案，只是让客户端与门禁能把「源里没有说话内容」与「本人
   *  台词」分开的标记。阶段二接入源台词（`shared/npc-dialogue.json`）后这个取值
   *  **没有**被删除，而是从「还没接」收窄成了它的字面意思，所以客户端的灰斜体
   *  消费者（`is-placeholder`）继续保留。 */
  source?: 'placeholder' }; shop?: { shopId: string }; warp?: { mapId: string }; ended?: boolean; openSkills?: boolean;
  /** Set when the npc is an account warehouse keeper, so the client opens the
   *  storage window instead of rendering a dialogue tree. */
  openStorage?: boolean }
  | { type: 'shopResult'; requestId: string; success: boolean; code: string; shopId: string; itemId: string; quantity: number; mesosSpent: number }
  /** Authoritative result of selling one stack to an NPC shop. `mesosGained`
   *  is 0 for every refusal; `mesos` is the fresh authoritative balance. */
  | { type: 'shopSold'; requestId: string; success: boolean; code: string; shopId: string; itemId: string; quantity: number; slot: number; mesosGained: number; mesos: number }
  /** The character's authoritative buy-back list, newest first. Pushed when a
   *  merchant window opens and again after every sale or buy-back, so the tab
   *  always shows what the server would really sell back. */
  | { type: 'shopRebuyState'; entries: ShopRebuyEntry[] }
  /** Authoritative result of buying one row back. `mesosSpent` is 0 for every
   *  refusal; `mesos` is the fresh balance after the exchange. */
  | { type: 'shopRebought'; requestId: string; success: boolean; code: string; shopId: string; itemId: string; quantity: number; unitPrice: number; mesosSpent: number; mesos: number }
  | { type: 'questList'; quests: QuestLogEntry[] }
  | ({ type: 'questUpdate'; reward: QuestRewardInfo } & QuestLogEntry)
  | { type: 'rejected'; code: string; message: string; requestId?: string }
  /** Authoritative result of one GM chat command (`/add ...`).  The server
   *  intercepts `/`-prefixed chat text before it can broadcast, so commands
   *  never appear as map chat; this reply goes to the sender only and every
   *  field is server-authored. */
  | { type: 'gmResult'; requestId: string; success: boolean; code: string; message: string }
  | { type: 'chatMessage'; messageId: string; requestId?: string; mapId: string; authorId: string; authorName: string; text: string; occurredAtTick: number }
  /** One emoticon shown by one character, broadcast to the sender's map room
   *  exactly like map chat (and filtered by the same blacklist). Every field is
   *  server-authored: the room, the author identity, the catalogue id and the
   *  tick. `requestId` is present only on the sender's own echo so a pending
   *  line can be merged instead of duplicated. The sticker's icon and head
   *  animation frames are resolved client-side from `manifest.emoticon`. */
  | { type: 'emoticonMessage'; messageId: string; requestId?: string; mapId: string; authorId: string; authorName: string; emoticonId: string; occurredAtTick: number }
  /** One whisper, delivered to exactly two characters. The server is the only
   *  author of every field: a client cannot choose the sender, the recipient,
   *  the body or the timestamp. `requestId` is present only on the sender's own
   *  echo (and on a replay of it), so a pending line can be merged instead of
   *  duplicated; `replay` marks such a re-delivered echo. */
  | { type: 'whisperMessage'; messageId: string; requestId?: string; fromId: string; fromName: string; toId: string; toName: string; text: string; occurredAtTick: number; replay?: boolean }
  /** Result of one storage intent. `quantity` is the amount that actually
   *  moved, so 0 always means nothing changed. */
  | { type: 'storageResult'; requestId: string; success: boolean; code: string; npcId: string; inventoryType: number; slot: number; quantity: number }
  /** Result of one mesos move; both balances are the post-move values. */
  | { type: 'storageMesos'; requestId: string; success: boolean; code: string; operation: StorageDirection; quantity: number; mesos: number; storedMesos: number }
  /** Full warehouse view, or `closed: true` when the session ended. */
  | { type: 'storageState'; closed?: boolean; npcId?: string; items?: InventoryItem[]; mesos?: number; slotLimit?: number }
  /** Full party roster for the character, or `closed: true` when it is no
   *  longer grouped. The roster is derived from live characters, never cached. */
  | { type: 'partyState'; closed?: boolean; partyId?: string; leaderId?: string; members?: PartyMember[] }
  /** Display-only invitation prompt. Answer it with `partyRespond`; the
   *  authoritative outcome still arrives as a `partyState` view. */
  | { type: 'partyInvite'; invitationId: string; fromId: string; fromName: string }
  /** Result of one party intent. A replayed `requestId` replays this same
   *  outcome instead of acting a second time. */
  | { type: 'partyResult'; requestId: string; success: boolean; code: string }
  /** 甲板袭击的全图播报（三期）。一次性事件，不是权威状态：谁在甲板上、袭击
   *  何时起止、巴洛古何时被撤，全部由服务端的顺序模拟决定。 */
  | ShipEventNotice
  /** Display-only notice for a party event the character did not cause itself
   *  — a declined invitation, or being kicked. Never authoritative state. */
  | { type: 'partyNotice'; code: string; playerId: string; playerName: string }
  /** Full friend & blacklist window for one account. Unlike a party this is a
   *  persisted account fact, so the rows survive a restart; `online` and
   *  `mapId` are the only live halves and are derived on every push, which is
   *  why an offline friend always carries an empty `mapId`. */
  | { type: 'friendState'; friends: FriendEntry[]; blocked: FriendEntry[] }
  /** Result of one friend / blacklist intent. A replayed `requestId` replays
   *  this same outcome instead of writing a second time. */
  | { type: 'friendResult'; requestId: string; success: boolean; code: string }
  /** Authoritative 現金商店 balance for the window opener. */
  | { type: 'cashState'; requestId: string; cash: number }
  /** Authoritative result of one cash purchase. `cashSpent` is 0 for every
   *  refusal; `cash` is the fresh balance after the exchange. A replayed
   *  `requestId` replays this same outcome instead of charging again. */
  | { type: 'cashBuyResult'; requestId: string; success: boolean; code: string; sn: string; itemId: string; quantity: number; cashSpent: number; cash: number }
  /** Server-initiated: the rental sweep reclaimed expired cash-shop
   *  `Period` items from this character.  `itemIds` lists the distinct item
   *  ids that disappeared; the inventory snapshot already reflects it. */
  | { type: 'rentalNotice'; itemIds: string[] }
  /** 冒险笔记（图鉴）私有快照：一次查询的完整答复. `revision` is the account
   *  (monster page) or character (item pages) revision the rows were read at;
   *  a client that sees it jump past its own value re-queries instead of
   *  trusting a stale page. `serverNowMs` is the only clock the exploration
   *  countdown may be computed from. */
  /** `catalogVersion` is the **server's** catalogue version, not an echo of the
   *  client's: a mismatch means the client must refuse to lay the rows out
   *  rather than apply an old page index to a new catalogue (plan §12.2). */
  | { type: 'notebookState'; requestId: string; section: NotebookSection; catalogVersion: string; scope: 'account' | 'character'; revision: number; page: number; pageCount: number; rows: NotebookRow[]; summary: NotebookSummary; serverNowMs: number
      /** Monster page only: the authored region/page/row navigation, and the
       *  reward/exploration state of the row on screen. */
      rewards?: NotebookRewardState[];
      exploration?: NotebookExplorationState | null
      /** Present when the section itself cannot be served at all (an empty
       *  quest page is normal, this is not). */
      blockedReason?: string }
  /** Lightweight private invalidation. `addedKeys` are the entries that just
   *  became visible to this scope, so the window can play one "first found"
   *  cue without re-fetching the whole section. A revision gap always means
   *  "re-query", never "guess". */
  | { type: 'notebookChanged'; scope: 'account' | 'character'; revision: number; section: NotebookSection; addedKeys: string[] }
  /** Result of one collection claim / exploration intent. A replayed
   *  `requestId` replays this same outcome instead of paying out twice. */
  | { type: 'notebookActionResult'; requestId: string; operation: 'collectionClaim' | 'explorationStart' | 'explorationClaim'; success: boolean; code: string; rewardKey?: string; runId?: string; itemId?: string; quantity?: number; revision: number; serverNowMs: number
      /** Set when the refusal is "this mechanic is not verified in this build",
       *  so the window can show the reason rather than a generic failure. */
      blockedReason?: string };
export interface LoginResponse { token: string; playerId: string; username: string; protocolVersion: number; contentVersion: string; }
export interface MapData {
  id: string; bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  spawn: { x: number; y: number };
  footholds: { id: number; x1: number; y1: number; x2: number; y2: number; prev: number; next: number; forbidFallDown: number }[];
  ladders: { id: number; x: number; y1: number; y2: number; l: number; uf: number; page: number }[];
}
