//! 装备／道具／任务道具三页的格子网格。
//!
//! 三页共用同一个窗口壳和同一套格子：`itemCollection` 的 94×94 槽位牌区分
//! 「已获得／未获得」，图标取自清单里的物品图标。任务页**没有未获得格**——服务器
//! 只给已获得的行，所以这里永远不会画出问号格或未来任务的分母（计划 §6.3）。

import { itemName } from '../inventory/names';
import { uiLocale, uiText } from '../../app/i18n';
import type { NotebookRow } from '../../../../shared/protocol';
import type { SectionContext } from './section-context';

/** 一页里格子的列数；与 `ITEM_PAGE_SIZE` 一起决定网格形状。 */
export const ITEM_GRID_COLUMNS = 7;

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
  const icon = itemIcon(context, itemId);
  if (icon) cell.append(icon);
  else if (!row.obtained) {
    const mark = document.createElement('span');
    mark.className = 'notebook-slot-mark';
    mark.textContent = '?';
    mark.setAttribute('aria-hidden', 'true');
    cell.append(mark);
  }
  if (row.availability && row.availability !== 'obtainable') {
    const flag = document.createElement('span');
    flag.className = 'notebook-slot-flag';
    flag.textContent = uiText('notebookUnavailable', '本版本未开放');
    cell.append(flag);
  }
  cell.addEventListener('click', () => context.onSelect(row));
  return cell;
}

/** 整个物品页内容（三个物品页签共用）。 */
export function renderItemPage(context: SectionContext): HTMLElement {
  const body = document.createElement('div');
  body.className = 'notebook-body notebook-item-body';
  body.style.setProperty('--notebook-grid-columns', String(ITEM_GRID_COLUMNS));
  if (!context.rows.length) {
    const empty = document.createElement('p');
    empty.className = 'notebook-empty';
    // 任务页的空态不能暗示「还有 N 个等你去拿」——未来任务条目不是公开信息。
    empty.textContent = context.directory && context.rows.length === 0 && context.blockedReason
      ? context.blockedReason
      : uiLocale() === 'en'
        ? 'Nothing here yet.'
        : '还没有记录。';
    body.append(empty);
    return body;
  }
  const grid = document.createElement('div');
  grid.className = 'notebook-item-grid';
  for (const row of context.rows) grid.append(itemCell(context, row));
  body.append(grid);
  return body;
}
