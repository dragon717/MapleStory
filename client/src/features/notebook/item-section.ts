//! 装备／道具／任务道具三页的格子格架。
//!
//! 三页共用同一个窗口壳和同一套槽位：源 `itemCollection` 的 94x94 槽位牌
//! （`category/itemComplete` 已获得 / `itemIncomplete` 未获得），图标取自清单里的
//! 物品图标。任务页**没有未获得格**——服务器只给已获得的行，所以这里永远不会
//! 画出问号格或未来任务的分母（计划 §6.3）。
//!
//! 列数取 6：服务端一页 `ITEM_PAGE_SIZE = 60`，而 60 = 6 列 x 10 行，一页刚好
//! 是一个整矩形，最后一格不留半行。原来的 7 列 x 94px 共 670px，比 654px 的
//! 内容内宽还宽，会横向溢出（也正是原始截图里最右一列被切掉的原因）。
//!
//! 图标压在源牌子的孔位上，而源孔是暗的、物品图标本身也偏暗 ⇒ 在孔位铺一层
//! **纸色凹槽**（P：底色取源相册瓦片的纸色族）。牌子本身仍是源素材。

import { itemName } from '../inventory/names';
import { uiLocale, uiText } from '../../app/i18n';
import type { NotebookRow } from '../../../../shared/protocol';
import type { SectionContext } from './section-context';

/** 一页里格子的列数；与服务端 `ITEM_PAGE_SIZE` 一起决定格架形状。 */
export const ITEM_GRID_COLUMNS = 6;

function itemIcon(context: SectionContext, itemId: string): HTMLImageElement | undefined {
  const frame = context.manifest.items?.[itemId]
    ?? context.manifest.items?.[itemId.padStart(8, '0')];
  if (!frame) return undefined;
  const image = document.createElement('img');
  image.className = 'notebook-slot-art';
  image.src = frame.url;
  image.alt = '';
  image.draggable = false;
  image.loading = 'lazy';
  return image;
}

function itemCell(context: SectionContext, row: NotebookRow) {
  const itemId = row.itemId ?? row.key;
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'notebook-slot notebook-item-slot';
  cell.dataset.obtained = row.obtained ? 'true' : 'false';
  const name = row.label || itemName(itemId);
  cell.title = name;
  cell.setAttribute('aria-label', name);
  cell.setAttribute('aria-pressed', row.obtained ? 'true' : 'false');

  const plate = context.manifest.notebook?.frames.item?.[
    row.obtained ? 'category/itemComplete' : 'category/itemIncomplete'
  ];
  if (plate) {
    const plateImage = document.createElement('img');
    plateImage.className = 'notebook-slot-plate';
    plateImage.src = plate.url;
    plateImage.alt = '';
    plateImage.draggable = false;
    plateImage.setAttribute('aria-hidden', 'true');
    cell.append(plateImage);
  }
  // 纸色凹槽：先铺它，再把图标压在上面。缺素材时只是一个空孔位，不影响可读。
  const well = document.createElement('span');
  well.className = 'notebook-slot-well';
  well.setAttribute('aria-hidden', 'true');
  cell.append(well);

  const icon = itemIcon(context, itemId);
  if (icon) cell.append(icon);
  else if (!row.obtained) {
    const mark = document.createElement('span');
    mark.className = 'notebook-slot-mark';
    mark.textContent = '?';
    mark.setAttribute('aria-hidden', 'true');
    cell.append(mark);
  }

  const label = document.createElement('span');
  label.className = 'notebook-slot-label';
  label.textContent = name;
  cell.append(label);

  // 配置 ID：目录里这条条目的源 id。查源、核对内容、GM 发放都用它，
  // 而名字在源里可能根本没有（骑宠 935 件里有 840 件没有名字），只有它稳定。
  const idTag = document.createElement('span');
  idTag.className = 'notebook-slot-id';
  idTag.textContent = `#${itemId}`;
  cell.append(idTag);

  // 骑宠页与椅子页不逐格标「本版本未开放」：这两页的基集合是整张表，几乎每一件
  // 都没有开放获取途径，逐格标是噪声，而且会盖掉真正的事实——页内已经把这件事
  // 说了一遍（服务端 `blockedReason`）。
  if (row.availability && row.availability !== 'obtainable'
    && context.section !== 'mount' && context.section !== 'chair') {
    const flag = document.createElement('span');
    flag.className = 'notebook-slot-flag';
    flag.textContent = uiText('notebookUnavailable', '本版本未开放');
    cell.append(flag);
  }
  cell.addEventListener('click', () => context.onSelect(row));
  return cell;
}

/** 一页物品格架：页眉（源丝带 + 本页范围）+ 6 列格。 */
function sheetHead(context: SectionContext): HTMLElement {
  const head = document.createElement('div');
  head.className = 'notebook-sheet-head';
  const ribbon = context.manifest.notebook?.frames.item?.['category/backgrndN'];
  if (ribbon) {
    const image = document.createElement('img');
    image.className = 'notebook-sheet-head-art';
    image.src = ribbon.url;
    image.width = ribbon.width;
    image.height = ribbon.height;
    image.alt = '';
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    head.append(image);
  }
  const title = document.createElement('span');
  title.className = 'notebook-sheet-head-title';
  title.textContent = context.pageLabel ?? '';
  head.append(title);

  const range = document.createElement('span');
  range.className = 'notebook-sheet-head-range';
  // 页码与总页数都是服务器给的；任务页没有 pageCount，这里就只说本页格数。
  const parts: string[] = [];
  if (context.pageCount !== undefined && context.page !== undefined) {
    parts.push(uiLocale() === 'en'
      ? `Page ${context.page + 1} / ${context.pageCount}`
      : `第 ${context.page + 1} / ${context.pageCount} 页`);
  }
  parts.push(uiLocale() === 'en'
    ? `${context.rows.length} on this page`
    : `本页 ${context.rows.length} 格`);
  range.textContent = parts.join(' · ');
  head.append(range);
  return head;
}

/** 整个物品页内容（三个物品页签共用）。 */
export function renderItemPage(context: SectionContext): HTMLElement {
  const body = document.createElement('div');
  body.className = 'notebook-body notebook-item-body';
  body.style.setProperty('--notebook-grid-columns', String(ITEM_GRID_COLUMNS));

  const sheet = document.createElement('div');
  sheet.className = 'notebook-sheet notebook-sheet-items';
  sheet.append(sheetHead(context));

  // 与怪物页同一套：分区状态说明画在页内，是事实不是错误（`monster-section.ts`）。
  if (context.blockedReason) {
    const note = document.createElement('p');
    note.className = 'notebook-note';
    note.textContent = context.blockedReason;
    sheet.append(note);
  }
  if (!context.rows.length) {
    const empty = document.createElement('p');
    empty.className = 'notebook-empty';
    // 空态不能暗示「还有 N 个等你去拿」——未来任务条目不是公开信息（计划 §6.3）。
    empty.textContent = uiLocale() === 'en' ? 'Nothing here yet.' : '还没有记录。';
    sheet.append(empty);
    body.append(sheet);
    return body;
  }
  const grid = document.createElement('div');
  grid.className = 'notebook-item-grid';
  for (const row of context.rows) grid.append(itemCell(context, row));
  sheet.append(grid);
  body.append(sheet);
  return body;
}
