//! 四页共用的渲染上下文。
//!
//! 两个 section 渲染器只拿到它们需要的东西：目录（展示事实）、服务器给的那一页
//! （私有事实）、素材，以及**只用于显示**的分页坐标。它们不发消息、不改
//! `obtained`，只把传入的行画出来。
//!
//! `page` / `pageCount` / `pageLabel` 是纯展示数据：页码由服务器在 `notebookState`
//! 里给出，`pageLabel` 是窗口已经本地化好的页签名。渲染器只把它们写进页眉，
//! 不参与任何判定，也不自己补一个服务器没给的分母。

import type { NotebookRow, NotebookSection } from '../../../../shared/protocol';
import type { Manifest } from '../../assets/manifest';
import type { NotebookDirectory } from './directory';

export interface SectionContext {
  directory: NotebookDirectory;
  manifest: Manifest;
  /** 当前页签。  渲染器只用它决定「这一页要不要逐格标不可获得」，不参与判定。 */
  section: NotebookSection;
  rows: readonly NotebookRow[];
  /** 当前悬停／选中的行键，用于详情面板高亮。 */
  selectedKey?: string;
  /** 选中一格：详情面板由窗口统一渲染。 */
  onSelect: (row: NotebookRow, slotKey?: string) => void;
  /** 已核实的阻塞原因（例如登记规则未核定）；没有就不显示。 */
  blockedReason?: string;
  /** 服务端给的本页页码（0 起）。只用于页眉显示。 */
  page?: number;
  /** 服务端给的总页数。  任务页没有分母，这里也就不会有值。 */
  pageCount?: number;
  /** 已经本地化好的页签名（页眉用），例如「装备图鉴 · 当前可获得」。 */
  pageLabel?: string;
}

/** 详情面板要显示的一条内容。 */
export interface NotebookDetail {
  title: string;
  lines: string[];
}
