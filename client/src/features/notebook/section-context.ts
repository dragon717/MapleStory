//! 四页共用的渲染上下文。
//!
//! 两个 section 渲染器只拿到它们需要的东西：目录（展示事实）、服务器给的那一页
//! （私有事实）和素材。它们不发消息、不改 `obtained`，只把传入的行画出来。

import type { NotebookRow } from '../../../../shared/protocol';
import type { Manifest } from '../../assets/manifest';
import type { NotebookDirectory } from './directory';

export interface SectionContext {
  directory: NotebookDirectory;
  manifest: Manifest;
  rows: readonly NotebookRow[];
  /** 当前悬停／选中的行键，用于详情面板高亮。 */
  selectedKey?: string;
  /** 选中一格：详情面板由窗口统一渲染。 */
  onSelect: (row: NotebookRow, slotKey?: string) => void;
  /** 已核实的阻塞原因（例如登记规则未核定）；没有就不显示。 */
  blockedReason?: string;
}

/** 详情面板要显示的一条内容。 */
export interface NotebookDetail {
  title: string;
  lines: string[];
}
