# F/chairs —— 坐姿状态（審計第 31 项）

## 这个目录为什么存在

设置栏（页签 3、`inventoryType 3`）本来就能装道具，但**通用使用路径拒绝该栏**
（落到 `InvalidInventoryType`），角色动作集合也没有坐姿。现在：双击椅子 → 服务端
`chair_toggle` → `action = "sit"`，坐下后有源作者的恢复量。

## 边界

| 谁负责 | 内容 |
| --- | --- |
| `F/inventory/` | 椅子的持有、拖动、丢弃（既有代码，未重写） |
| `server/src/chairs.rs` | 坐姿会话状态、恢复结算与落库、拒绝码 |
| `model.ts` | 把 `PlayerState.chair` 翻成读数（**只读**） |
| `view.ts` | 状态标记：椅子名 + 恢复量 + 倒计时 |

## 一条不许越过的线：间隔未核定就是未核定

源 `Item/Install/*/*.json` 的 `info` **没有**恢复间隔字段，只有描述文案里写「每N秒」。
因此 `shared/chairs.json` 只在文案确实写出时才给 `recoveryIntervalMs`：2797 把椅子里
1192 把有间隔、**173 把有恢复量但文案没写间隔**。这 173 把：

* 服务端**不恢复**；
* 客户端**不显示倒计时**、也**不按默认 10 秒推算**（`model.check.mjs` 钉住
  `secondsToRecovery === undefined`）。

套一个默认值就是编规则。同理，`chair.status` 在服务端快照里缺席这两个字段时，
`F/chairs/model.ts` 走的是「只坐、不恢复」分支，并**明说不会恢复**，而不是留空。

## 开关的入口

坐下／起立都走**既有的背包双击**（设置栏双击椅子 → `useItem(3, +槽, id)`），
方向由服务端在回执里点名（`chair_sit` / `chair_stand`），客户端不猜。
移动输入、跳跃、普攻、技能、受击、死亡、换图也都会起身（服务端收口），
所以这里**不放**「起身」按钮——多一个入口就多一处要和权威状态对齐。

椅子本体没有源坐标可依（源 `Item/Install` 只有 `info/icon` 与 `effect`，**没有 `sit` 节点**，
584 件全查过），所以标记只画状态，不画椅子。角色坐姿的帧来自角色自身部件
（`Character/00002000.img/sit` 等），见 `scripts/export_tms273_avatar.cjs`。
