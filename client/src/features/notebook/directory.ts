//! 冒险笔记（图鉴）的**目录**一半：`/assets/notebook.json`。
//!
//! 目录回答「世界上有哪些可展示的条目」，与「这个角色获得过什么」严格分开
//! （计划 §4.2）。它随资源发布、按内容版本配对，所以：
//! - **不含任务分区**：任务页的基集合是服务器算出来的已获得集合，把静态清单
//!   发到这里等于先泄后藏（§12.2）。缺少 `quest` 就是这个决定的可见痕迹。
//! - 只在第一次开窗时取一次：目录接近 1 MB，不该为了打开菜单就下载。
//! - 版本由服务器回显核对，不一致时窗口拒绝排版，而不是用旧页码解释新目录。

import type { NotebookSection } from '../../../../shared/protocol';
import { resolveAssetUrl } from '../../assets/resource-url';

export type Availability = 'obtainable' | 'unavailable' | 'unverified';

export interface NotebookItemDefinition {
  inventoryType: number;
  equipmentSlot?: string;
  isPet: boolean;
  availability: Availability;
  questIds: string[];
}

export interface NotebookRegion {
  region: number;
  name: string;
  recordId: string;
  rewardItemId: string;
  pages: number[];
}

export interface NotebookRowDefinition {
  rowKey: string;
  region: number;
  regionName: string;
  page: number;
  pageName: string;
  row: number;
  name: string;
  recordId: string;
  rewardItemId: string;
  explorationCycleMinutes: number;
  explorationRewardSelector: number;
  entryIds: string[];
}

export interface NotebookMonsterEntry {
  monsterTemplateId: string;
  rowKey: string;
  slot: number;
  sourceType: number;
  collectable: boolean;
  hasEpisode: boolean;
}

export interface NotebookStatus {
  registration: string;
  registrationReason: string;
  rewardCondition: string;
  rewardReason: string;
  rewardItemAvailability: string;
  rewardItemReason: string;
  rewardItemCounts: { deliverable: number; definitionMissing: number };
  exploration: string;
  explorationReason: string;
  sourceType: string;
}

export interface NotebookDirectory {
  catalogVersion: string;
  contentVersion: string;
  /** 物品分区。**没有 `quest`** —— 见本文件顶部。 */
  sections: Record<Exclude<NotebookSection, 'monster' | 'quest'>, string[]>;
  items: Record<string, NotebookItemDefinition>;
  monsterStructure: {
    regions: Record<string, NotebookRegion>;
    rows: Record<string, NotebookRowDefinition>;
  };
  monsterEntries: Record<string, NotebookMonsterEntry>;
  monsterText: Record<string, { episode: string; spawnMapIds: string[]; rewardItemIds: string[] }>;
  collectableEntryCount: number;
  rewardItems: Record<string, {
    roles: string[];
    referenceCounts: Record<string, number>;
    definitionStatus: string;
    definitionAvailable: boolean;
    name: string | null;
    nameSource: string | null;
    reason: string | null;
  }>;
  status: NotebookStatus;
}

let pending: Promise<NotebookDirectory> | undefined;

/** 取目录。  反复开窗只取一次；失败不留缓存，下一次可以重试。 */
export function loadNotebookDirectory(): Promise<NotebookDirectory> {
  pending ??= fetch(resolveAssetUrl('/assets/notebook.json')).then(response => {
    if (!response.ok) throw new Error(`图鉴目录加载失败 (${response.status})`);
    return response.json() as Promise<NotebookDirectory>;
  }).catch(error => {
    pending = undefined;
    throw error;
  });
  return pending;
}

/** 测试与离线检查用：直接注入一份目录，跳过网络。 */
export function primeNotebookDirectory(directory: NotebookDirectory) {
  pending = Promise.resolve(directory);
}
