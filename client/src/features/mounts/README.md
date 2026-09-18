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

## 上下马的入口为什么在这里

源 `UI/UIEquip.img/Equip/EquipTab/Slots` 里**没有** Tm/Sd 两个槽（子节点只有
1..13,15,16,17,21,22,28,31..36，`SlotName` 同样没有），也就是本版本的装备窗画不出坐骑槽。
因此「双击已装备坐骑」在原版 UI 里没有落点，本模块用一个纯文字标记承担开关：
点击发的是既有的 `useItem(1, −18, id)`，不发明任何源里没有的坐标或贴图。

骑宠**贴图**（`Character/TamingMob/<id>.img/{stand1,walk1,jump}`）本轮未抽取，
所以骑乘时纸娃娃仍用角色自身帧，只有状态与读数；见
`docs/plan/topics/MapleStory_Mounts_Chairs.md` §7。
