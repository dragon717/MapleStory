# GM `/add` 唯一道具拒绝回执（1902000 野豬，2026-09-18）

日期：2026-09-18。用户报告：「GM：道具发放失败。（item_unavailable） `/add 1902000 1` 这个就是野猪」。
协议 **24** 与内容版本均未变，**客户端零改动**；纯服务端，重启 3010 生效。

## 1. 结论先说：不是发放通道坏了，是回执没把原因说出来

`1902000`（野豬，源 `Character/TamingMob/01902000.json`）的 `info.only = 1`
——源里「一个角色只能持有一份」。该角色此前已经 `/add` 成功过一次并装备到骑宠槽
`−18`，因此第二次发放被 `only` 判据拒绝是**符合源语义**的（用户确认按此方向修复）。

真正的缺陷在回执：`gm.rs` 的拒绝出口只认 `inventory_full` / `request_reused`，
其余一律兜底成「道具发放失败。」。GM 拿到一句没有主语、没有位置、没有解除办法的话，
只能当成发放通道故障。

## 2. 判据链（对磁盘实况取证，不靠推断）

`server/data/tms273.sqlite3` 的 `inventory_actions` 留下完整时间线（同一账号 `2a98bc…`）：

| rowid | requestId | operation | 结果 | code |
| --- | --- | --- | --- | --- |
| 85 | `chat-1789731128474-1` | gmAdd | 成功，装备栏 14 格 | — |
| 90 | `use-7c998b6b…` | equip | 成功（14 格 → `−18` 骑宠槽） | — |
| 94 | `chat-1789736862498-2` | gmAdd | **失败** | `item_unavailable` |
| 98 | `chat-1789743676089-1` | gmAdd | **失败**（本次报告） | `item_unavailable` |

`equipped` 表现存 `('2a98bc…', -18, '1902000', 1)`，`inventory` 里没有第二份 ——
数据是自洽的：那一头就在身上骑着。

## 3. 改动：拒绝与「报位置」共用一条判据

- `server/src/auth/db.rs`
  - 新增 `OnlyHeld` 枚举（`Inventory{kind,slot}` / `Equipped{slot}` / `MonsterBook`）
    与 `only_item_holder(db, …)`：**全仓唯一一处** `only` 冲突查询，按
    「背包 → 装备栏 → 图鉴」顺序返回先命中的那一处。
  - `add_inventory_tx` 里原来那段三表 `UNION ALL` 改成调用它（行为不变，判据收敛到一处）。
- `server/src/auth/bag.rs`：`Store::only_item_holder`（只读），供 GM 回执在事务提交后
  问「那一件现在在哪儿」——两次查询是同一个函数，拒绝理由与回执位置不可能脱节。
- `server/src/gm.rs`
  - `item_unavailable` 分支出**具名**回执：点名道具名（源 `String` 名，坐骑走
    `inventory::item_name` 回落，不再回成 id）+ 已持有的位置 + 解除办法。
    例：`野豬（1902000）是唯一道具（源 only=1）：你已装备在骑宠槽（-18）。先卸下或丢弃现有那一份再发放。`
  - 成功回执的道具名也从「只有宠物有名」扩到 `pet_name → item_name → id`（新增 `display_name`），
    否则发坐骑时回的是 `1902000（1902000）`。

未动：`world.rs` 使用路径的 `item_unavailable`（「道具已不可用。」）与客户端 i18n ——
那是**使用**语义，与**发放**语义不同，共用一个 wire 码但文案各归各。

## 4. 验收

- `cargo test` **575 passed / 0 failed**。
- 新增 `gm_add_refusing_a_unique_item_names_where_the_other_one_is_held`
  （`gm_acceptance.rs`）：store-backed 世界（无 store 时 `/add` 走内存 `add_items`，
  **不做** `only` 判据，所以这条事实只能在带持久化的世界钉住）——
  第一次 `/add 1902000` 成功且回执含「野豬」；第二次被拒且回执报出背包页签格；
  把该行挪到 `equipped(-18)` 后再发，回执报出「骑宠槽（-18）」。
- 客户端零改动：`gmResult` 的 `message` 由服务端直出。

## 5. 实玩待验

重启 3010 后：已骑着野豬再 `/add 1902000 1`，应看到上面那句带位置的回执；
卸下坐骑后再 `/add` 应恢复正常发放。
