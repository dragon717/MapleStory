// MVP contract: positions are world-space foot coordinates; Rust owns all authoritative state.
export const PROTOCOL_VERSION = 12;
export const CONTENT_VERSION = 'tms273-9';
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
export interface PlayerState {
  id: string; username: string; appearance?: Appearance; x: number; y: number; vx: number; vy: number;
  facing: Facing; grounded: boolean;
  /** True while inside an authored water rectangle. A swimming body is never
   *  grounded, so clients need this to route the jump key correctly. */
  swimming?: boolean;
  action: 'stand' | 'walk' | 'jump' | 'attack' | 'climb' | 'ladder' | 'rope' | 'dead';
  actionId: string | null; actionStartedTick: number; lastInputSeq: number;
  climbing: boolean; ladderId: number | null;
  hp: number; maxHp: number; mp: number; maxMp: number;
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
  inventory: InventoryItem[];
  equipped?: InventoryItem[];
  monsterBook?: Record<string, number>;
  /** Server-owned away marker; display only, grants no protection or assets. */
  away?: AwayMarker;
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
export type ClientMessage =
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
  | { type: 'pickup'; requestId: string; dropId: string }
  /** Intent to strike one authored map reactor. The client only names the prop;
   *  the server decides range, whether it is still usable, and the next state. */
  | { type: 'reactorHit'; requestId: string; reactorId: string }
  | { type: 'portal'; requestId: string; portalName: string }
  | { type: 'inventoryMove'; requestId: string; inventoryType: number; sourceSlot: number; targetSlot: number; quantity: number }
  | { type: 'dropItem'; requestId: string; inventoryType: number; sourceSlot: number; quantity: number }
  | { type: 'inventoryGather' | 'inventorySort'; requestId: string; inventoryType: number }
  | { type: 'useItem'; requestId: string; inventoryType: number; sourceSlot: number; itemId: string; targetSlot?: number; targetItemId?: string }
  | { type: 'dropMesos'; requestId: string; quantity: number }
  | { type: 'questInteract'; requestId: string; questId: string }
  | { type: 'npcTalk'; requestId: string; npcId: string; step?: 'start' | 'next' | 'prev' | 'yes' | 'no' | 'select' | 'end'; selection?: number }
  | { type: 'shopBuy'; requestId: string; shopId: string; itemId: string; quantity: number }
  /** Intent to sell one inventory stack back to an NPC shop. The client names
   *  the shop, tab and slot only; the item, its sellability and the mesos paid
   *  are all resolved server-side. No itemId or price is accepted. */
  | { type: 'shopSell'; requestId: string; shopId: string; inventoryType: number; sourceSlot: number; quantity: number }
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
  /** Page lifecycle hint. Server keeps its own away clock; this never grants
   *  assets, invulnerability, or control of the away window. */
  | { type: 'lifecycle'; hidden: boolean; away?: boolean; clientNowMs?: number }
  /** Explicit logout: removes the character instead of keeping it resident. */
  | { type: 'logout' };
export interface DialogueOption { index: number; text: string }
export interface QuestLogEntry {
  questId: string; name: string;
  status: 'available' | 'active' | 'objectivesComplete' | 'completed';
  summary: string;
  objectives?: { text: string; current: number; required: number }[];
  targetMapId?: string; targetNpcId?: string; nextAction?: string; blockReason?: string;
}
export interface QuestRewardInfo {
  mesos: number; exp: number;
  items: { itemId: string; quantity: number }[];
}
export type ServerMessage =
  | { type: 'abilityResult'; requestId: string; success: boolean; code: string; abilityStats: AbilityStats }
  | { type: 'snapshot'; serverTick: number; tickMs: number; mapId: string; sourceMapId?: string; bossPractice?: BossPracticeState; selfId: string; players: PlayerState[]; monsters: MonsterState[]; npcs?: NpcState[]; questInteractions?: QuestInteraction[]; summons?: SummonState[]; reactors?: ReactorState[]; drops: DropState[] }
  | { type: 'actionStarted'; serverTick: number; playerId: string; actionId: string; requestId: string; durationMs: number; eventId: string; x: number; y: number; facing: Facing }
  | { type: 'skillCast'; phase?: 'prepare' | 'sustain' | 'final'; eventId: string; serverTick: number; playerId: string; skillId: number; skillLevel?: number; requestId: string; x: number; y: number; facing: Facing; durationMs: number; targetId?: string; targetX?: number; targetY?: number }
  | { type: 'skillResult'; requestId: string; skillId: number; operation: 'learn' | 'cast' | 'hyper_reset'; success: boolean; code: string }
  | { type: 'damageEvent'; eventId: string; serverTick: number; attackerId: string; targetId: string; x: number; y: number; damage: number; killed: boolean; critical?: boolean; skillId?: number; skillLevel?: number; segment?: number; targetCount?: number }
  | { type: 'dropPickedUp'; mapId: string; dropId: string; playerId: string; x: number; y: number }
  /** Authoritative result of one reactor hit, broadcast to the whole map so
   *  every observer plays the same one-shot animation and sees the same state. */
  | { type: 'reactorState'; serverTick: number; mapId: string; reactorId: string; state: number; spent: boolean; hitDurationMs: number; respawnInMs?: number; playerId: string }
  | { type: 'pickupResult'; requestId: string; dropId: string; itemId: string; quantity: number; slot?: number }
  | { type: 'portalResult'; requestId: string; success: boolean; code: string; sourceMapId: string; targetMapId?: string }
  | { type: 'inventoryResult'; requestId: string; operation: 'move' | 'drop' | 'gather' | 'sort' | 'use' | 'equip' | 'unequip' | 'dropMesos'; inventoryType?: number; sourceSlot: number; targetSlot?: number; itemId: string; quantity: number; dropId?: string; success: boolean; code: string }
  | { type: 'inventoryDropResult'; requestId: string; operation: 'drop'; sourceSlot: number; itemId: string; quantity: number; dropId?: string; success: boolean; code: string }
  | { type: 'reviveResult'; requestId: string; success: boolean; code: string }
  | { type: 'npcResult'; requestId: string; success: boolean; code: string; npcId: string; name: string; nameZh?: string; dialog?: { kind: 'next' | 'nextPrev' | 'prev' | 'ok' | 'yesNo' | 'simple'; text: string; options?: DialogueOption[] }; shop?: { shopId: string }; warp?: { mapId: string }; ended?: boolean; openSkills?: boolean;
  /** Set when the npc is an account warehouse keeper, so the client opens the
   *  storage window instead of rendering a dialogue tree. */
  openStorage?: boolean }
  | { type: 'shopResult'; requestId: string; success: boolean; code: string; shopId: string; itemId: string; quantity: number; mesosSpent: number }
  /** Authoritative result of selling one stack to an NPC shop. `mesosGained`
   *  is 0 for every refusal; `mesos` is the fresh authoritative balance. */
  | { type: 'shopSold'; requestId: string; success: boolean; code: string; shopId: string; itemId: string; quantity: number; slot: number; mesosGained: number; mesos: number }
  | { type: 'questList'; quests: QuestLogEntry[] }
  | ({ type: 'questUpdate'; reward: QuestRewardInfo } & QuestLogEntry)
  | { type: 'rejected'; code: string; message: string; requestId?: string }
  | { type: 'chatMessage'; messageId: string; requestId?: string; mapId: string; authorId: string; authorName: string; text: string; occurredAtTick: number }
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
  | { type: 'friendResult'; requestId: string; success: boolean; code: string };
export interface LoginResponse { token: string; playerId: string; username: string; protocolVersion: number; contentVersion: string; }
export interface MapData {
  id: string; bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  spawn: { x: number; y: number };
  footholds: { id: number; x1: number; y1: number; x2: number; y2: number; prev: number; next: number; forbidFallDown: number }[];
  ladders: { id: number; x: number; y1: number; y2: number; l: number; uf: number; page: number }[];
}
