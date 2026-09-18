//! 资源类型叶子模块（计划 §9.1：R5 依赖债务清偿）。
//!
//! 纸娃娃（avatar）相关的相互关联类型集中在这里：帧 / 部件 / 动作集。
//! `assets/manifest.ts`（资源目录）与 `features/entry/appearance.ts`（外观目录）
//! 都只依赖本模块，原先 manifest ↔ appearance 的双向 import type 环由此消除。
//!
//! 本模块**零导入**：任何把运行期依赖（DOM、网络、Scene、feature 实现）
//! 引进来的改动都违背叶子定位，会被 `refactor_audit.cjs --check` 的规则盯住。

export interface Point { x: number; y: number }

export interface Part {
  key: string;
  url: string;
  x: number;
  y: number;
  origin: Point;
  z: number;
  width?: number;
  height?: number;
  map?: Record<string, Point>;
  source?: string;
  resolvedSource?: string;
  anchor?: string;
}

export interface Frame { delay: number; parts: Part[] }

/**
 * `sit` 是可选的静态单帧动作（源 `Character/00002000.img/sit` 等只有 1 帧且**没有
 * delay**）：缺席时 `F/player/view.ts` 回落 `actions.stand`，因此没有 sit 帧的部件
 * （源 `Face/00020000.img` 就没有）不会破图。`scripts/export_tms273_avatar.cjs`
 * 只在角色自身部件上导出它。
 */
export type AvatarActionSet = Record<'stand' | 'walk' | 'jump' | 'attack', Frame[]> & Partial<Record<'climb' | 'ladder' | 'rope' | 'dead' | 'sit' | 'skill2001008' | 'skill2001011' | 'skill2001012', Frame[]>>;
