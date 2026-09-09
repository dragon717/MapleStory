// MVP contract: positions are world-space foot coordinates; Rust owns all authoritative state.
export const PROTOCOL_VERSION = 11;
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
  facing: Facing; grounded: boolean; action: 'stand' | 'walk' | 'jump' | 'attack' | 'climb' | 'ladder' | 'rope' | 'dead';
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
  abilityStats?: AbilityStats;
  derivedStats?: { hyperBarrierActive?: boolean; hyperTeleportEnabled?: boolean; damageReductionPercent?: number; regenerationPassives?: RegenerationPassive[]; infinityEnhanced?: boolean; skillCooldowns?: Record<string, number>; skillBuffs?: Record<string, number>; meditationRemainingMs?: number; iceTeleport?: boolean; teleportMastery?: boolean; teleportBoost?: boolean; adaptationCharges?: number; adaptationCooldownMs?: number; statusResistance?: number; elementResistance?: number; magicAttack: number; defense: number; moveSpeed: number; magicGuard: boolean; strength?: number; dexterity?: number; intelligence?: number; luck?: number };
  level: number; exp: number; expToNext: number; mesos: number;
  inventory: InventoryItem[];
  equipped?: InventoryItem[];
  monsterBook?: Record<string, number>;
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
  | { type: 'portal'; requestId: string; portalName: string }
  | { type: 'inventoryMove'; requestId: string; inventoryType: number; sourceSlot: number; targetSlot: number; quantity: number }
  | { type: 'dropItem'; requestId: string; inventoryType: number; sourceSlot: number; quantity: number }
  | { type: 'inventoryGather' | 'inventorySort'; requestId: string; inventoryType: number }
  | { type: 'useItem'; requestId: string; inventoryType: number; sourceSlot: number; itemId: string; targetSlot?: number; targetItemId?: string }
  | { type: 'dropMesos'; requestId: string; quantity: number }
  | { type: 'questInteract'; requestId: string; questId: string }
  | { type: 'npcTalk'; requestId: string; npcId: string; step?: 'start' | 'next' | 'prev' | 'yes' | 'no' | 'select' | 'end'; selection?: number }
  | { type: 'shopBuy'; requestId: string; shopId: string; itemId: string; quantity: number }
  | { type: 'chatSend'; requestId: string; text: string };
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
  | { type: 'snapshot'; serverTick: number; tickMs: number; mapId: string; sourceMapId?: string; bossPractice?: BossPracticeState; selfId: string; players: PlayerState[]; monsters: MonsterState[]; npcs?: NpcState[]; questInteractions?: QuestInteraction[]; summons?: SummonState[]; drops: DropState[] }
  | { type: 'actionStarted'; serverTick: number; playerId: string; actionId: string; requestId: string; durationMs: number; eventId: string; x: number; y: number; facing: Facing }
  | { type: 'skillCast'; phase?: 'prepare' | 'sustain' | 'final'; eventId: string; serverTick: number; playerId: string; skillId: number; skillLevel?: number; requestId: string; x: number; y: number; facing: Facing; durationMs: number; targetId?: string; targetX?: number; targetY?: number }
  | { type: 'skillResult'; requestId: string; skillId: number; operation: 'learn' | 'cast' | 'hyper_reset'; success: boolean; code: string }
  | { type: 'damageEvent'; eventId: string; serverTick: number; attackerId: string; targetId: string; x: number; y: number; damage: number; killed: boolean; critical?: boolean; skillId?: number; skillLevel?: number; segment?: number; targetCount?: number }
  | { type: 'dropPickedUp'; mapId: string; dropId: string; playerId: string; x: number; y: number }
  | { type: 'pickupResult'; requestId: string; dropId: string; itemId: string; quantity: number; slot?: number }
  | { type: 'portalResult'; requestId: string; success: boolean; code: string; sourceMapId: string; targetMapId?: string }
  | { type: 'inventoryResult'; requestId: string; operation: 'move' | 'drop' | 'gather' | 'sort' | 'use' | 'equip' | 'unequip' | 'dropMesos'; inventoryType?: number; sourceSlot: number; targetSlot?: number; itemId: string; quantity: number; dropId?: string; success: boolean; code: string }
  | { type: 'inventoryDropResult'; requestId: string; operation: 'drop'; sourceSlot: number; itemId: string; quantity: number; dropId?: string; success: boolean; code: string }
  | { type: 'reviveResult'; requestId: string; success: boolean; code: string }
  | { type: 'npcResult'; requestId: string; success: boolean; code: string; npcId: string; name: string; nameZh?: string; dialog?: { kind: 'next' | 'nextPrev' | 'prev' | 'ok' | 'yesNo' | 'simple'; text: string; options?: DialogueOption[] }; shop?: { shopId: string }; warp?: { mapId: string }; ended?: boolean; openSkills?: boolean }
  | { type: 'shopResult'; requestId: string; success: boolean; code: string; shopId: string; itemId: string; quantity: number; mesosSpent: number }
  | { type: 'questList'; quests: QuestLogEntry[] }
  | ({ type: 'questUpdate'; reward: QuestRewardInfo } & QuestLogEntry)
  | { type: 'rejected'; code: string; message: string; requestId?: string }
  | { type: 'chatMessage'; messageId: string; requestId?: string; mapId: string; authorId: string; authorName: string; text: string; occurredAtTick: number };
export interface LoginResponse { token: string; playerId: string; username: string; protocolVersion: number; contentVersion: string; }
export interface MapData {
  id: string; bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  spawn: { x: number; y: number };
  footholds: { id: number; x1: number; y1: number; x2: number; y2: number; prev: number; next: number; forbidFallDown: number }[];
  ladders: { id: number; x: number; y1: number; y2: number; l: number; uf: number; page: number }[];
}
