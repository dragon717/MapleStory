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

export type AvatarActionSet = Record<'stand' | 'walk' | 'jump' | 'attack', Frame[]> & Partial<Record<'climb' | 'ladder' | 'rope' | 'dead' | 'skill2001008' | 'skill2001011' | 'skill2001012', Frame[]>>;
