//! 怪物收集页：原版「地区 → 分頁 → 行 → 槽位」画成一页页相册。
//!
//! 结构**全部来自同版源**：地区／分頁／行与每个槽位的怪物 id 来自
//! `Etc/mobCollection.img`（这里不排序、不合并、不因为两个怪物同名就当作同一条目，
//! 计划 §5.3），页板与槽位底板来自 `UI/UIWindow4.img/monsterCollection`。
//!
//! 一张相册页 = **一个源分頁**：源在 `Etc/mobCollection.img` 里每个分頁就是
//! 5 行 x 每行 5 槽（310 行 / 62 分頁实测每个分頁都是 5x5），而源相册板
//! `Collection/backgrnd` 恰好烤着一块 5x5 的亮瓦片格，格位是
//! `x = 35 + 73i`、`y = 70 + 84j`（实测）。样式表用同一组数字算格位，
//! 所以槽位**贴**在源瓦片上，而不是另铺一层网格。
//!
//! 画在板上的三处文字各占一块源板自己的面板，不压住瓦片：
//!   右上深色面板 = 分頁名 + 地区名 + 图例
//!   右下深色面板 = 分区状态说明（「登记规则尚未核定」）
//!   每行瓦片上方的 16px 留白 = 行名
//!
//! 「本版本尚不可收集」是目录自己的结论（`collectable`），不是玩家做过什么。
//! 它满载时是 1550 格里的 1493 格，做成压在每格上的大红块等于噪声，所以这里
//! 只留一个角标；整句仍在 tooltip、`aria-label` 与详情面板里（可读性来自层级，
//! 不来自把字去掉）。

import { displayText, uiLocale, uiText } from '../../app/i18n';
import type { NotebookRow, NotebookSlot } from '../../../../shared/protocol';
import { groupRowsByPage, slotLabel } from './view-model';
import type { SectionContext } from './section-context';

/** 一个槽位：源收录的怪物图（只有已装配模板才有），否则一个「？」牌。 */
function slotCell(context: SectionContext, row: NotebookRow, slot: NotebookSlot) {
  // 配置 ID（源怪物模板 id）进 tooltip 与无障碍名：格子里已经画了名字与底板，
  // 再塞一行数字会挤掉位图，而查源与核对只靠它。
  const slotText = `${slotLabel(slot)} #${slot.monsterTemplateId}`;
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'notebook-slot notebook-monster-slot';
  cell.dataset.registered = slot.registered ? 'true' : 'false';
  cell.dataset.collectable = slot.collectable ? 'true' : 'false';
  cell.title = slotText;
  cell.setAttribute('aria-label', slotText);
  cell.setAttribute('aria-pressed', slot.registered ? 'true' : 'false');

  // 槽位底板是源 `Collection/monsterGrade/empty`（74x74，字身自 2px 起）。
  // 源不含逐槽位 grade（`U`：同版源没有登记概率／资格门／等级），所以不挑
  // `monsterGrade/0..4` 冒充等级，一律用 empty；三态靠底板亮度与描边区分。
  const plate = context.manifest.notebook?.frames.monster?.['Collection/monsterGrade/empty'];
  if (plate) {
    const plateImage = document.createElement('img');
    plateImage.className = 'notebook-slot-plate';
    plateImage.src = plate.url;
    plateImage.alt = '';
    plateImage.draggable = false;
    plateImage.loading = 'lazy';
    plateImage.setAttribute('aria-hidden', 'true');
    cell.append(plateImage);
  }

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
    // 整句留给 tooltip 与详情；这里只留角标，不加可见文字。
    const flag = document.createElement('span');
    flag.className = 'notebook-slot-flag';
    flag.textContent = uiText('notebookUncollectable', '尚不可收集');
    flag.setAttribute('aria-hidden', 'true');
    cell.append(flag);
  }
  cell.addEventListener('click', () => context.onSelect(row, slot.key));
  return cell;
}

/** 一行：源的行名 + 本行的槽位，槽位顺序就是源的顺序。
 *
 * 槽位**直接**是 `.notebook-monster-row` 的 grid 子项：行的
 * `grid-template-columns: repeat(5, 68px)` 就是源瓦片的列距，多套一层
 * 容器会让那一层独自占掉第 1 格，5 个槽位反而被挤成一列（实测过）。
 * 行名是 `position: absolute`，不参与 grid 排布，所以排在它后面不影响列序。 */
function rowStrip(context: SectionContext, row: NotebookRow) {
  const strip = document.createElement('div');
  strip.className = 'notebook-monster-row';
  const name = document.createElement('span');
  name.className = 'notebook-monster-row-name';
  name.textContent = displayText(row.label || row.key);
  strip.append(name);
  for (const slot of row.slots ?? []) strip.append(slotCell(context, row, slot));
  return strip;
}

/** 一页相册：源相册板 + 页签卡 + 注记卡 + 最多 5 行槽位。
 *
 * `notes` 是这一页要说明的事实（分区状态、筛选没命中等），逐条画在注记卡里；
 * 空数组就只是留一块空面板，不编造话。 */
function sheet(
  context: SectionContext,
  pageName: string,
  regionName: string,
  rows: readonly NotebookRow[],
  notes: readonly string[],
) {
  const page = document.createElement('div');
  page.className = 'notebook-sheet notebook-sheet-monster';
  page.setAttribute('role', 'group');
  const heading = pageName || regionName;
  if (heading) page.setAttribute('aria-label', displayText(heading));

  const board = context.manifest.notebook?.frames.monster?.['Collection/backgrnd'];
  if (board) {
    const image = document.createElement('img');
    image.className = 'notebook-sheet-board';
    image.src = board.url;
    image.width = board.width;
    image.height = board.height;
    image.alt = '';
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    page.append(image);
  } else {
    // 只缺质感，不缺结构：样式表用源板面色把这块页面托住。
    page.classList.add('notebook-sheet-noboard');
  }

  // 页签卡（源板右上深色面板）：分頁名 + 地区名 + 图例。
  const card = document.createElement('div');
  card.className = 'notebook-sheet-card';
  if (heading) {
    const title = document.createElement('p');
    title.className = 'notebook-sheet-title';
    title.textContent = displayText(heading);
    card.append(title);
  }
  if (regionName && regionName !== heading) {
    const region = document.createElement('p');
    region.className = 'notebook-sheet-region';
    region.textContent = displayText(regionName);
    card.append(region);
  }
  const legend = document.createElement('p');
  legend.className = 'notebook-sheet-legend';
  // 图例只解释下面这批格子怎么读，不补任何服务器没给的分母。
  legend.textContent = uiLocale() === 'en'
    ? 'Lit frame: collectable in this build. Dim frame: not open. Gold name: registered.'
    : '亮框＝本版可收集 · 暗框＝本版未开放 · 金字＝已登记';
  card.append(legend);
  page.append(card);

  // 注记卡（源板右下深色面板）：分区状态说明是**这一页的事实**，不是一次失败，
  // 所以画在页内、跟内容一起滚，不上报成窗口级错误横幅（计划 §5.5）。
  const note = document.createElement('div');
  note.className = 'notebook-sheet-note';
  for (const text of notes) {
    const line = document.createElement('p');
    line.className = 'notebook-note';
    line.textContent = text;
    note.append(line);
  }
  page.append(note);

  const body = document.createElement('div');
  body.className = 'notebook-monster-rows';
  for (const row of rows) body.append(rowStrip(context, row));
  page.append(body);
  return page;
}

/** 整个怪物页内容：一个地区下的全部行，按源分頁分页排成相册。 */
export function renderMonsterPage(
  context: SectionContext,
  regionName: string,
): HTMLElement {
  const body = document.createElement('div');
  body.className = 'notebook-body notebook-monster-body';
  const facts = context.blockedReason ? [context.blockedReason] : [];
  if (!context.rows.length) {
    // 空态只说「这次筛选没命中」：登记未核定已经在相册的注记卡里讲过了，不重复。
    // 板仍然画：这一页本来就是一本相册的一页，空页也有页签与注记。
    const empty = uiLocale() === 'en'
      ? 'No collection row matches what you are looking at.'
      : '没有符合条件的收藏条目。';
    body.append(sheet(context, '', regionName, [], [...facts, empty]));
    return body;
  }
  // 每个源分頁一张板。筛选命中跨分頁时就是多张板，顺序仍按源分頁升序。
  for (const group of groupRowsByPage(context.directory, context.rows)) {
    body.append(sheet(context, group.name, regionName, group.rows, facts));
  }
  if (regionName) body.dataset.regionName = regionName;
  return body;
}
