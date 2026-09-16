# 物品系统增量 4：收窄 `pub` 面 + 按差异持久化（2026-09-17）

> 任务单：`docs/plan/PLAN.md` §道具系统→权威世界模型改造「增量 4｜收窄 `pub` 面与堵住整表
> 重写（未领取，收益最大）」。方案依据：[`物品系统审查与权威世界模型改造.md`](../../technical/物品系统审查与权威世界模型改造.md)
> §7「增量 4」与 §33/§34。
> 前序：[道具系统权威世界模型改造已落地增量](../2026-09-15/道具系统权威世界模型改造已落地增量.md)（①②③）。

## 1. 范围与结论

| 项 | 结果 |
| --- | --- |
| 前置 1：`step_rental_expiries` 失败边界测试（A 组 4 处最后一个缺口） | ✅ 新增 1 条，用既有 `Store::deny_persistence` 注入 |
| 前置 2：`add_inventory_tx` 的 `&'static str` 收敛为类型 | ✅ 内层错误类型化为 `inventory::InventoryError`，新增 `ItemUnavailable` 变体 |
| 主体 a：原语收窄 | ✅ `add_items`/`add_items_expiring`/`remove_items`/`move_items` → `pub(crate)` |
| 主体 b：整表重写 → 按差异持久化 | ✅ `write_inventory_tx` 重写为差集最小写入；生产外观 `Store::write_inventory` **拆除** |
| A 组第 4 处（租赁清扫）事务化 | ✅ 新增 `auth/cash.rs::rental_sweep_commit`（与商店三个 commit helper 同形） |
| 门禁 | ✅ 新增 `scripts/check_inventory_surface.cjs`（接进 `client npm run check`） |

**协议 24 / 内容 `tms273-31` / 198 图全未动**——本轮是纯服务端内部形状改造，
wire 行为逐字符串保持（所有拒绝码 `.code()` 输出不变）。

## 2. 逐文件改动

| 文件 | 改动 |
| --- | --- |
| `server/src/inventory.rs` | ① `InventoryError` 新增 `ItemUnavailable`（wire 码 `"item_unavailable"`，此前只活在 `add_inventory_tx` 的字符串通道里）；② 四个 `&mut Vec` 原语 `pub` → `pub(crate)` |
| `server/src/auth/db.rs` | ① `add_inventory_tx` 内层错误 `&'static str` → `InventoryError`（`.code()` 只在调用方**出口**取）；② `write_inventory_tx` 重写为**按差异持久化**（§3） |
| `server/src/auth/item_world.rs` / `loot.rs` / `bag.rs` | 三个 `add_inventory_tx` 调用方在出口处 `.code().to_owned()`，行为逐字不变 |
| `server/src/auth/cash.rs` | 新增 `rental_sweep_commit`（租赁清扫的单事务提交；A 组第 4 处收口） |
| `server/src/auth/shop.rs` | `refuse_if_persistence_denied` 改 `pub(super)`（cash.rs 同守卫） |
| `server/src/cashshop.rs` | 清扫写库从 `write_inventory` 换成 `rental_sweep_commit` |
| `server/src/auth.rs` | **删除**生产外观 `write_inventory`；新增 `#[cfg(test)] seed_inventory_for_test`（测试种子专用，仍走 `write_inventory_tx`） |
| `server/src/cashshop_acceptance.rs` | 新增失败边界测试（§4.1）；种子调用改 `seed_inventory_for_test` |
| `server/src/inventory_persistence_acceptance.rs` | 新建：5 条差异持久化钉子（§4.2） |
| `scripts/check_inventory_surface.cjs` + `client/scripts/run-checks.mjs` | 新门禁：原语可见性、外观不复活、**调用点名单**（带双向断言，名单过期即失败） |
| `server/src/world_tests.rs` | `include!` 新验收文件 |

## 3. `write_inventory_tx` 的差异持久化（核心改动）

旧形状：`DELETE FROM inventory WHERE account_id=?` 整表重写——仓储把修改权整个交给
调用方的内存 Vec（§34），一次调用 = 全部背包行拆掉重插（§33）。

新形状（终点状态与整表重写**逐行等价**，同一事务内原子性不变）：

1. 先在内存归一化（`normalize_pet_instances` + 逐行 `ensure_*`）并做与旧版**逐字相同**
   的校验（同样的错误串），全部在校验期完成、不先动 SQL；新增**键重复提前拒绝**
   （旧版等价于 PRIMARY KEY 冲突失败）。
2. 读该账号**全部**持久行（不帯 `read_inventory_tx` 的显示期过滤）——旧版
   `DELETE-all` 会把窗口外垃圾行一并带走，差异化写入必须同样清掉，终点状态才等价。
3. 差集最小写入：键 `(inventory_type, slot)` 消失 ⇒ DELETE；键在但内容变
   （item_id/quantity/stats 语义值/upgrade/remaining 任一）⇒ 按 `rowid` UPDATE；
   新键 ⇒ INSERT。stats 比较按 `serde_json::Value` 语义比较，不吃序列化差异。

**等价性证据**：既有全套验收（storage / shop buy/sell/rebuy / bag / consume / scroll /
slot_expand / cashshop / quest_store / notebook …共 486 条基线）零改动全绿；
新增 5 条 `total_changes()` 行级计数钉子把「不许改回整表重写」钉死——旧行为下
原样重写一张 3 行表都会产生 6 行变更，新断言要求 0。

## 4. 新增测试（6 条，486 → 492）

### 4.1 租赁清扫失败边界（前置 1 的解锁项）
`the_rental_sweep_keeps_memory_authoritative_when_persistence_fails`：
注入 `deny_persistence` 后清扫**整笔不动**（内存保留过期品、不发 `rentalNotice`）；
解除注入后下一轮 10s 清扫成功回收、内存/存档/通知三方一致。A 组 4 处
（商店买/卖/买回 + 租赁清扫）至此全部有失败边界测试。

### 4.2 差异持久化钉子
原样重写零行变更 / 单格改数量恰好 1 条 UPDATE / 增删一叠各恰好 1 行 /
窗口外垃圾行照旧清扫 / 键重复提前拒绝且零写入。

## 5. 验收

| 项 | 结果 |
| --- | --- |
| `cargo test`（全量） | **492 过 / 0 失败**（基线 486 + 净增 6） |
| 非测试构建 | **0 告警** |
| `tsc --noEmit` | exit 0 |
| `check_tms273_runtime.cjs` | exit 0 — 198 图 / 111226 引用（本轮零装配数据改动） |
| `check_tms273_remaster.cjs` / `check_tms273_notebook.cjs` | exit 0 |
| `check_inventory_surface.cjs`（新） | PASS |
| 客户端 `run-checks.mjs` | **37/39**（新增 1 条 PASS；2 项＝既有失败） |
| `artifacts/refactor/frontend-deps.json` | 每次跑完已还原 |

## 6. 未做 / 边界（如实登记）

- **增量 3（地面掉落 `PickupSink`）由此解锁**——它依赖的正是本轮的类型收敛
  （`add_inventory_tx` 内层已是 `InventoryError`，拾取侧可直接 `match`）与收窄后的
  原语面；本轮未动拾取语义。
- B 组 11 处事务内整表写回的**调用方形状**（bag 7 / quests 2 / cash 1 / db 1）未改：
  它们继续传完整 after 表，但仓储已不再「拆整表」，§34 的「修改权泄漏」收敛为
  「调用方持有候选表」——若要进一步收成「领域原语直写」，需逐路径论证，另立增量。
- `cashshop.rs::remember_cash_purchase` 的 `let _ = store.record_cash_purchase(...)`
  仍吞错（限购预算非背包表，不在 A 组清单）；如需处理另立条目。
- **未真机实玩**（本轮无玩家可见行为变化，风险低）：统一加载后正常买/卖/买回、
  仓库存取、任务发奖、GM `/add`、现金购买与租赁到期回收各走一遍即可确认。
- `server/src` 下有三个 **iCloud 复制残留的已跟踪副本**（`auth/db 2.rs`、
  `ellinel_acceptance 2.rs`、`lobby 2.rs`，不参与编译但污染 grep）；新门禁已显式
  跳过它们，是否删除待用户决定。
