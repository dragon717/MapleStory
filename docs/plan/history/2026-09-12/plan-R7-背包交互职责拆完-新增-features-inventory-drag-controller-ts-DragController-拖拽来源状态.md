# R7 背包交互职责拆完：新增 `features/inventory/drag-controller.ts`（DragController：拖拽来源状态、

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。
> 状态：已完成（待验收）

> 来源：PLAN.md 原第 79 行起的已完成条目；原勾选状态保留。

- **R7 背包交互职责拆完**：新增 `features/inventory/drag-controller.ts`（DragController：拖拽来源状态、
  背包/装备槽拖拽绑定、document 级拖出丢弃；只**输出意图回调** moveItem/dropItem/unequip/
  useScrollOnEquipment/useItem，不拥有槽位/金币真值与 requestId）与 `equipment-view.ts`
  （EquipmentView：装备窗口 DOM、开合状态、槽位渲染与点击/双击/右键交互；数据经 `equippedItemAt`/
  `itemFrame` 窄回调只读）；`view.ts` 1512→1244 行，保留门面 API、组装、requestId 生成、窗口拖动、
  键盘与布局（intents.ts 未建——意图构造+发送留在门面，符合 §8.2"需要时"措辞，未复制状态）。
  每个子模块只收窄回调（DragHost 12 个 / EquipmentHost 14 个），无共享巨型 Context。
  新增 `drag-controller.check.mjs`（意图路由、卷轴闸门、document drop-out、destroy 清理监听）与
  `equipment-view.check.mjs`（缺资源提前返回、开合同步、渲染状态、槽位点击分支、close 请求），
  runner 增至 **22/22 全过**；tsc 通过；`check:inventory` 通过；audit `--deps --check` OK
  （0 环 0 违规 0 债）。页签顺序 1,2,4,3,5 与全部交互语义未动。



