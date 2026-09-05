// MVP contract: positions are world-space foot coordinates; Rust owns all authoritative state.
export const PROTOCOL_VERSION = 5;
export const CONTENT_VERSION = 'gms83-quest-1';
export type Facing = -1 | 1;
export interface InventoryItem {
  slot: number; itemId: string; quantity: number;
  stats?: Record<string, number>; remainingSlots?: number; upgradeCount?: number;
}
export interface PlayerState {
  id: string; username: string; x: number; y: number; vx: number; vy: number;
  facing: Facing; grounded: boolean; action: 'stand' | 'walk' | 'jump' | 'attack' | 'climb' | 'ladder' | 'rope' | 'dead';
  actionId: string | null; actionStartedTick: number; lastInputSeq: number;
  climbing: boolean; ladderId: number | null;
  hp: number; maxHp: number; mp: number; maxMp: number;
  level: number; exp: number; expToNext: number; mesos: number;
  inventory: InventoryItem[];
  equipped?: InventoryItem[];
  monsterBook?: Record<string, number>;
}
export interface MonsterState {
  id: string; templateId: string; x: number; y: number; facing: Facing;
  hp: number; maxHp: number; action: 'stand' | 'move' | 'hit' | 'die'; actionStartedTick: number;
}
export interface NpcState {
  id: string; templateId: string; name: string; x: number; y: number;
  facing: Facing; shopId?: string;
}
export interface DropState { id: string; itemId: string; quantity: number; x: number; y: number; }
export type ClientMessage =
  | { type: 'hello'; token: string; protocolVersion: number; contentVersion: string }
  | { type: 'input'; seq: number; direction: -1 | 0 | 1; vertical: -1 | 0 | 1; jump: boolean }
  | { type: 'attack'; requestId: string }
  | { type: 'revive'; requestId: string }
  | { type: 'pickup'; requestId: string; dropId: string }
  | { type: 'portal'; requestId: string; portalName: string }
  | { type: 'inventoryMove'; requestId: string; inventoryType: number; sourceSlot: number; targetSlot: number; quantity: number }
  | { type: 'dropItem'; requestId: string; inventoryType: number; sourceSlot: number; quantity: number }
  | { type: 'inventoryGather' | 'inventorySort'; requestId: string; inventoryType: number }
  | { type: 'useItem'; requestId: string; inventoryType: number; sourceSlot: number; itemId: string; targetSlot?: number; targetItemId?: string }
  | { type: 'dropMesos'; requestId: string; quantity: number }
  | { type: 'npcTalk'; requestId: string; npcId: string; step?: 'start' | 'next' | 'prev' | 'yes' | 'no' | 'select' | 'end'; selection?: number }
  | { type: 'shopBuy'; requestId: string; shopId: string; itemId: string; quantity: number };
export interface DialogueOption { index: number; text: string }
export interface QuestLogEntry {
  questId: string; name: string;
  status: 'active' | 'completed';
  summary: string;
}
export interface QuestRewardInfo {
  mesos: number; exp: number;
  items: { itemId: string; quantity: number }[];
}
export type ServerMessage =
  | { type: 'snapshot'; serverTick: number; tickMs: number; mapId: string; selfId: string; players: PlayerState[]; monsters: MonsterState[]; npcs?: NpcState[]; drops: DropState[] }
  | { type: 'actionStarted'; serverTick: number; playerId: string; actionId: string; requestId: string; durationMs: number; eventId: string; x: number; y: number; facing: Facing }
  | { type: 'damageEvent'; eventId: string; serverTick: number; attackerId: string; targetId: string; x: number; y: number; damage: number; killed: boolean; critical?: boolean }
  | { type: 'dropPickedUp'; mapId: string; dropId: string; playerId: string; x: number; y: number }
  | { type: 'pickupResult'; requestId: string; dropId: string; itemId: string; quantity: number; slot?: number }
  | { type: 'portalResult'; requestId: string; success: boolean; code: string; sourceMapId: string; targetMapId?: string }
  | { type: 'inventoryResult'; requestId: string; operation: 'move' | 'drop' | 'gather' | 'sort' | 'use' | 'equip' | 'unequip' | 'dropMesos'; inventoryType?: number; sourceSlot: number; targetSlot?: number; itemId: string; quantity: number; dropId?: string; success: boolean; code: string }
  | { type: 'inventoryDropResult'; requestId: string; operation: 'drop'; sourceSlot: number; itemId: string; quantity: number; dropId?: string; success: boolean; code: string }
  | { type: 'reviveResult'; requestId: string; success: boolean; code: string }
  | { type: 'npcResult'; requestId: string; success: boolean; code: string; npcId: string; name: string; dialog?: { kind: 'next' | 'nextPrev' | 'prev' | 'ok' | 'yesNo' | 'simple'; text: string; options?: DialogueOption[] }; shop?: { shopId: string }; warp?: { mapId: string }; ended?: boolean }
  | { type: 'shopResult'; requestId: string; success: boolean; code: string; shopId: string; itemId: string; quantity: number; mesosSpent: number }
  | { type: 'questList'; quests: QuestLogEntry[] }
  | { type: 'questUpdate'; questId: string; name: string; status: QuestLogEntry['status']; summary: string; reward: QuestRewardInfo }
  | { type: 'rejected'; code: string; message: string; requestId?: string };
export interface LoginResponse { token: string; playerId: string; username: string; protocolVersion: number; contentVersion: string; }
export interface MapData {
  id: string; bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  spawn: { x: number; y: number };
  footholds: { id: number; x1: number; y1: number; x2: number; y2: number; prev: number; next: number; forbidFallDown: number }[];
  ladders: { id: number; x: number; y1: number; y2: number; l: number; uf: number; page: number }[];
}
