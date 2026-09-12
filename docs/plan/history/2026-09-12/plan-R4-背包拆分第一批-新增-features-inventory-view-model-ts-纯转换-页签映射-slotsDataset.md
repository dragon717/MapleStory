# R4 背包拆分第一批：新增 `features/inventory/view-model.ts`（纯转换：页签映射、slotsDataset/

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。
> 状态：已完成（待验收）

> 来源：PLAN.md 原第 50 行起的已完成条目；原勾选状态保留。

- **R4 背包拆分第一批**：新增 `features/inventory/view-model.ts`（纯转换：页签映射、slotsDataset/
  slotsSignature/itemAtSlot/comparisonTarget/cooldownSeconds 等，页签 1,2,4,3,5 顺序原样保留）与
  `features/inventory/tooltip-view.ts`（TooltipController：showForItem/refresh/hide/reposition/scheduleHide/destroy，
  数据经构造回调注入，不导入 names/manifest）；`view.ts` 17 处替换为委托，对外 `InventoryView` 门面与
  update/requestId 流程不变；新增 `view-model.check.mjs` + `tooltip-view.check.mjs` 三件套测试；
  `scripts/check_inventory.mjs` 的 TAB_* 钉扎目标同步改指 view-model.ts。


