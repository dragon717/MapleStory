// MVP contract: positions are world-space foot coordinates; Rust owns all authoritative state.
export const PROTOCOL_VERSION = 2;
export const CONTENT_VERSION = 'gms83-gameplay-2';
export type Facing = -1 | 1;
export interface InventoryItem { slot: number; itemId: string; quantity: number }
export interface PlayerState {
  id: string; username: string; x: number; y: number; vx: number; vy: number;
  facing: Facing; grounded: boolean; action: 'stand' | 'walk' | 'jump' | 'attack' | 'climb' | 'ladder' | 'rope' | 'dead';
  actionId: string | null; actionStartedTick: number; lastInputSeq: number;
  climbing: boolean; ladderId: number | null;
  hp: number; maxHp: number; mp: number; maxMp: number;
  level: number; exp: number; expToNext: number; mesos: number;
  inventory: InventoryItem[];
}
export interface MonsterState {
  id: string; templateId: string; x: number; y: number; facing: Facing;
  hp: number; maxHp: number; action: 'stand' | 'move' | 'hit' | 'die'; actionStartedTick: number;
}
export interface DropState { id: string; itemId: string; quantity: number; x: number; y: number; }
export type ClientMessage =
  | { type: 'hello'; token: string; protocolVersion: number; contentVersion: string }
  | { type: 'input'; seq: number; direction: -1 | 0 | 1; vertical: -1 | 0 | 1; jump: boolean }
  | { type: 'attack'; requestId: string }
  | { type: 'revive'; requestId: string }
  | { type: 'pickup'; requestId: string; dropId: string }
  | { type: 'portal'; requestId: string; portalName: string }
  | { type: 'inventoryMove'; requestId: string; sourceSlot: number; targetSlot: number; quantity: number }
  | { type: 'dropItem'; requestId: string; sourceSlot: number; quantity: number };
export type ServerMessage =
  | { type: 'snapshot'; serverTick: number; tickMs: number; mapId: string; selfId: string; players: PlayerState[]; monsters: MonsterState[]; drops: DropState[] }
  | { type: 'actionStarted'; serverTick: number; playerId: string; actionId: string; requestId: string; durationMs: number; eventId: string; x: number; y: number; facing: Facing }
  | { type: 'damageEvent'; eventId: string; serverTick: number; attackerId: string; targetId: string; x: number; y: number; damage: number; killed: boolean; critical?: boolean }
  | { type: 'pickupResult'; requestId: string; dropId: string; itemId: string; quantity: number; slot?: number }
  | { type: 'portalResult'; requestId: string; success: boolean; code: string; sourceMapId: string; targetMapId?: string }
  | { type: 'inventoryResult'; requestId: string; operation: 'move' | 'drop'; sourceSlot: number; targetSlot?: number; itemId: string; quantity: number; dropId?: string; success: boolean; code: string }
  | { type: 'inventoryDropResult'; requestId: string; operation: 'drop'; sourceSlot: number; itemId: string; quantity: number; dropId?: string; success: boolean; code: string }
  | { type: 'reviveResult'; requestId: string; success: boolean; code: string }
  | { type: 'rejected'; code: string; message: string; requestId?: string };
export interface LoginResponse { token: string; playerId: string; username: string; protocolVersion: number; contentVersion: string; }
export interface MapData {
  id: string; bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  spawn: { x: number; y: number };
  footholds: { id: number; x1: number; y1: number; x2: number; y2: number; prev: number; next: number; forbidFallDown: number }[];
  ladders: { id: number; x: number; y1: number; y2: number; l: number; uf: number; page: number }[];
}
