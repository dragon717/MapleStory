//! 怪物收集页：原版地区 → 分頁 → 行 → 槽位。
//!
//! 结构**全部来自同版源**（`Etc/mobCollection.img` 的地区／分頁／行与每个槽位的
//! 怪物 id）：这里不排序、不合并、不因为两个怪物同名就当作同一条目（计划 §5.3）。
//! 「本版本尚不可收集」是目录自己的结论（`collectable`），不是玩家做过什么。

import { displayText, uiLocale, uiText } from '../../app/i18n';
import type { NotebookRow, NotebookSlot } from '../../../../shared/protocol';
import { groupRowsByPage, slotLabel } from './view-model';
import type { SectionContext } from './section-context';

/** 一个槽位：源收录的怪物图（只有已装配模板才有），否则一个「？」牌。 */
function slotCell(context: SectionContext, row: NotebookRow, slot: NotebookSlot) {
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'notebook-slot notebook-monster-slot';
  cell.dataset.registered = slot.registered ? 'true' : 'false';
  cell.dataset.collectable = slot.collectable ? 'true' : 'false';
  cell.title = slotLabel(slot);
  cell.setAttribute('aria-label', slotLabel(slot));
  cell.setAttribute('aria-pressed', slot.registered ? 'true' : 'false');

  const frame = context.manifest.monsters?.[slot.monsterTemplateId]?.actions?.stand?.[0];
  if (frame) {
    const image = document.createElement('img');
    image.className = 'notebook-slot-art';
    image.src = frame.url;
    image.alt = '';
    image.draggable = false;
    image.loading = 'lazy';
    cell.append(image);
  } else {
    const mark = document.createElement('span');
    mark.className = 'notebook-slot-mark';
    mark.textContent = slot.registered ? '★' : '?';
    mark.setAttribute('aria-hidden', 'true');
    cell.append(mark);
  }

  const label = document.createElement('span');
  label.className = 'notebook-slot-label';
  label.textContent = displayText(slotLabel(slot));
  cell.append(label);
  if (!slot.collectable) {
    const flag = document.createElement('span');
    flag.className = 'notebook-slot-flag';
    flag.textContent = uiText('notebookUncollectable', '尚不可收集');
    cell.append(flag);
  }
  cell.addEventListener('click', () => context.onSelect(row, slot.key));
  return cell;
}

/** 一行：源的行名 + 本行的槽位，槽位顺序就是源的顺序。 */
function rowStrip(context: SectionContext, row: NotebookRow) {
  const strip = document.createElement('div');
  strip.className = 'notebook-monster-row';
  const name = document.createElement('span');
  name.className = 'notebook-monster-row-name';
  name.textContent = displayText(row.label || row.key);
  strip.append(name);
  const cells = document.createElement('div');
  cells.className = 'notebook-monster-slots';
  for (const slot of row.slots ?? []) cells.append(slotCell(context, row, slot));
  strip.append(cells);
  return strip;
}

/** 整个怪物页内容。  `region`／`page` 由窗口给出，这里只负责画。 */
export function renderMonsterPage(
  context: SectionContext,
  pageName: string,
): HTMLElement {
  const body = document.createElement('div');
  body.className = 'notebook-body notebook-monster-body';
  // 分区状态说明（现状＝登记规则尚未核定，计划 §5.5）是**这一页的事实**，不是一次
  // 失败：画在页内、跟内容一起滚，不上报成全局错误。它出现在这里而不在窗口级
  // 横幅上，是因为它解释的正是下面这批格子的状态。
  if (context.blockedReason) {
    const note = document.createElement('p');
    note.className = 'notebook-note';
    note.textContent = context.blockedReason;
    body.append(note);
  }
  if (!context.rows.length) {
    // 空态只说「这次筛选没命中」：登记未核定已经由上面那条说明讲过了，不重复。
    const empty = document.createElement('p');
    empty.className = 'notebook-empty';
    empty.textContent = uiLocale() === 'en'
      ? 'No collection row matches what you are looking at.'
      : '没有符合条件的收藏条目。';
    body.append(empty);
    return body;
  }
  for (const group of groupRowsByPage(context.directory, context.rows)) {
    if (group.name) {
      const heading = document.createElement('h4');
      heading.className = 'notebook-monster-page-name';
      heading.textContent = displayText(group.name);
      body.append(heading);
    }
    for (const row of group.rows) body.append(rowStrip(context, row));
  }
  if (pageName) body.dataset.pageName = pageName;
  return body;
}
