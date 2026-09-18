# F/mounts —— 骑乘状态与开关（審計第 30 项）

## 这个目录为什么存在

源里坐骑是**装备层的普通一件**：`Character/TamingMob/*` 的 `info.islot` 是 `Tm`（槽 18）
或 `Sd`（槽 19），穿脱走的是既有装备路径，**一行都没改**。缺的是穿上去之后的**骑乘**：
状态、移动倍率、上下马。目录就只做这件事。

## 边界

| 谁负责 | 内容 |
| --- | --- |
| `server/src/inventory.rs` | 物品持有、穿脱、`islot → ±18/±19`（既有代码，未重写） |
| `server/src/mounts.rs` | 骑乘会话状态、每拍对账、拒绝码、速度/跳跃倍率 |
| `model.ts` | 把 `PlayerState.mount` / `equipped` 翻成读数与一个开关意图（**只读**） |
| `store.ts` | 缓存最近一次投影，视图不持有 `PlayerState` |
| `view.ts` | 状态标记 + 上下马按钮 |

## 三条不许越过的线

1. **不推导骑乘状态**：`player.mount` 在不在是服务端事实。装备里有坐骑**不等于**在骑，
   `mountReadout({ equipped: [坐骑] })` 必须返回 `undefined`（`model.check.mjs` 钉住）。
2. **判据用源字段**：是不是坐骑看 `info.tamingMob`，**不看** `islot`。`Tm` 槽里还有
   21 件现金件、以及機械師整套装备（同样 `islot = Tm`）——按槽位判会把它们全认成坐骑。
3. **开关失败即不给**：快照与权威装备行对不上时返回 `undefined`，不硬凑一个槽位。
   服务端还会再复核（不符回 `mount_mismatch`）。

## 上下马与地图表现

装备窗主画布的源布局没有 Tm/Sd 两槽；网页附栏补上骑宠与鞍具的可访问格子，
复用图标、拖动和右键卸下逻辑。只有带 tamingMob 的骑宠双击切换上下马，鞍具双击卸下。
状态标记保留为快捷入口，仍发送 `useItem(1, −槽位, id)`。

地图 `PlayerView` 按权威 mount 状态读取 `rideScenes.mounts` 单件场景，
按源动作时间轴播放，按 navel 对齐角色与骑宠，整体随角色翻转。
图标装配进统一 manifest.items，使背包、装备、仓库及掉落显示使用同一资源。
