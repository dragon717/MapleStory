# view.ts 意图层拆分（intents.ts）：重跑 `--sizes` 后 churn 最高的

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。
> 状态：已完成（待验收）

> 来源：PLAN.md 原第 134 行起的已完成条目；原勾选状态保留。

- **view.ts 意图层拆分（intents.ts）**：重跑 `--sizes` 后 churn 最高的
  `features/inventory/view.ts`（1,245 行、churn=15）按 R7 同款回调注入纪律拆出
  `features/inventory/intents.ts`（225 行）——`InventoryIntents` 拥有意图构造+发送+请求生命周期
  （`pendingScroll`/`pendingUseRequestId`/`pendingInventoryOperation`/`requestSequence` 与
  `requestId` 生成、move/drop/gather-sort/use/mesos 五类消息），经 `InventoryIntentHost` 10 个
  窄回调读真值（status/t/itemAt/slotLimit/itemLabel/practice/selectedTab/mesos/onTargetModeChange），
  不拥有槽位/金币真值；`MIN/MAX_DROP_MESOS` 常量与 `PendingScroll`/`SendClientMessage`/`UseItemMessage`
  类型随迁，view 侧 7 个方法改一行委托、目标模式拆 `updateTargetMode`/`applyTargetMode`。
  消息形状与文案逐字保留（零行为改动）。新增 `intents.check.mjs`（消息形状、inventoryType 映射
  1/2/4/3/5 钉扎、practice 门控、prompt 流、pending 互斥、use 结果一次性消费、resetPending 语义），
  runner 增至 **26/26 全过**；tsc --noEmit 通过；audit `--deps --check` OK。
  **view.ts 1,244 → 1,124 行**。执行坑：iCloud 两次静默回滚 Edit（view.ts 与 check 各一次），
  均以幂等 python 脚本（逐替换断言命中 + banned-string 终检）补齐。



