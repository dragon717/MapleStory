# 物品系统增量 3：地面掉落的拾取去处建模（`PickupSink`）（2026-09-17）

> 任务单：`docs/plan/PLAN.md` §道具系统→权威世界模型改造「增量 3｜地面掉落」。
> 方案依据：[`物品系统审查与权威世界模型改造.md`](../../technical/物品系统审查与权威世界模型改造.md) §7「增量 3」。
> 前序：[增量 4 交付记录](物品系统增量4-收窄pub面与按差异持久化.md)——**增量 3 的阻塞（原语 `pub` 面 + 整表重写）已由上轮解除**；
> 本轮按上轮留下的收窄范围执行，**不越界**。

## 1. 范围与结论

| 项 | 结果 |
| --- | --- |
| 给"拾取去处"建模 | ✅ `auth/item_world.rs::PickupSink`（`Inventory` / `MonsterBookCard` / `Mesos`） |
| 哪条支路会拒绝 | ✅ `PickupSink::can_refuse()` —— **只有 `Inventory`**，这是"拒绝后要把掉落放回地上"的唯一依据 |
| 三个分支的 SQL 搬回 `auth/db.rs` | ✅ `read_active_drop_tx` + `apply_pickup_sink_tx`；`Store::pickup` 只留编排 |
| 卡片饱和语义保留 | ✅ 计数封顶 5（`MONSTER_BOOK_CARD_LIMIT`），掉落照样认领，不是拒绝 |
| 金币不是物品 | ✅ `Mesos` 分支只写 `player_stats.mesos`，不进背包、不产生图鉴获得记录 |
| 行为等价 | ✅ **无玩家可见变化**：wire 形状、拒绝码、幂等回执、留档口径逐字不变 |
| 门禁 | ✅ `scripts/check_inventory_surface.cjs` 新增第 4 段（含双向断言） |
| 验收 | ✅ 新增 6 条；cargo **501 过 / 0 失败**、非测试构建 **0 告警**、客户端 `npm run check` **37/39**（2 项＝既有失败） |

**协议 24 / 内容 `tms273-31` / 198 图全未动**，客户端零改动。

### 按上轮结论主动不做的事

- **不做 `ItemLocation::Ground`**：地面掉落不实现 `Source`/`Destination`（世界模型 §41：它的规则是
  "谁在什么时候获得操作权"，属于 §11 排除的那一类）。本轮只给**去处**建模。
- **不做 `world.drop_owners` 去镜像**：进程内镜像服务高频伤害归属，改读库是性能决策，需单独论证。
- **不做"丢弃方向"**：`is_drop_restricted` 的"取出后直接消失"按词汇是**销毁**而非 Move，另立领域动词。
- **不做 B 组 11 处调用方形状改造**：上轮已记"需逐路径论证，另立增量"。

## 2. 改动前的形状（为什么要做）

`Store::pickup` 原来把四件事写在同一个 `else` 里：认领掉落（`UPDATE drops SET active=0`）、
判定去处的三连 `if`（`item_id == "0"` / `consume_on_pickup` / 其余）、三条支路各自的 SQL、
以及失败时恢复 `active=1`。后果是"哪条支路会让掉落留在地上"只能靠读实现顺序推断——
而这条恰恰是**物品会不会凭空消失**的唯一防线。

## 3. 改动后的形状

```
Store::pickup（auth/loot.rs）                 auth/db.rs                      auth/item_world.rs
  读取掉落行      ← read_active_drop_tx ────────┘                              drop_fact / pickup_allowed
  认领（active=0）                                                             PickupSink::for_drop(item_id)
  分派            → apply_pickup_sink_tx(sink) ── 三条支路 SQL 唯一归属地        PickupSink::can_refuse()
  失败恢复（active=1）   ← 只有 can_refuse() 为真才会走到
  留档 granted_tx ← 非 Mesos 去处才发
```

- **`PickupSink::for_drop`** 的判定顺序即语义：金币先看（它不是物品，不能用物品目录的
  `consumeOnPickup` 判定），再看源 `consumeOnPickup`（旧 MonsterBook 卡），其余进背包。
- **`can_refuse()`** 把"卡片饱和 ≠ 拒绝"这条规则变成类型上的事实：饱和时掉落照样被认领，
  玩家看到的是"卡片收满了"而不是"拿不起来"。
- 恢复分支里加了一条 `debug_assert!(sink.can_refuse())`：将来若有人新增一个不可拒绝的去处
  却让它走到恢复路径，测试会直接炸，而不是静默地把掉落变没。

## 4. 逐文件改动

| 文件 | 改动 |
| --- | --- |
| `server/src/auth/item_world.rs` | 新增 `MESOS_DROP_ITEM_ID` 常量、`PickupSink` 枚举 + `for_drop` / `can_refuse`，以及 i05/i06 两条真值表测试 |
| `server/src/auth/db.rs` | 新增 `MONSTER_BOOK_CARD_LIMIT`、`PickupDropRow`、`read_active_drop_tx`、`apply_pickup_sink_tx`（从 `loot.rs` 逐字搬来三支 SQL） |
| `server/src/auth/loot.rs` | `pickup` 改为「读行 → 认领 → 按 sink 分派 → 失败恢复 → 留档」；内联 SQL 与三连 `if` 删除 |
| `server/src/pickup_sink_acceptance.rs` | 新建 4 条：金币入账不碰背包/图鉴、卡片饱和仍认领、满页签拒绝后掉落回地上且可重试、留档正反向对照 |
| `server/src/world_tests.rs` | `include!` 新验收文件 |
| `scripts/check_inventory_surface.cjs` | 新增第 4 段：去处类型存在、`db.rs` 覆盖三个变体、三条 SQL 不得回到 `loot.rs` |

## 5. 门禁与反向验证

第 4 段断言全部带反向面，两处扰动均已实测会让门禁失败：

| 扰动 | 结果 |
| --- | --- |
| 把 `INSERT INTO monster_book_cards` 写回 `loot.rs` | ❌ `the monster-book branch must not creep back into Store::pickup` |
| `db.rs` 里少处理 `PickupSink::Mesos` | ❌ `apply_pickup_sink_tx must handle PickupSink::Mesos` |

（`PickupSink` 加变体而 `db.rs` 不加分支，还会被 Rust 的穷尽 `match` 在编译期拦住。）

## 6. 未做的事 / 边界

- 卡片上限 5 在**写库**（`MONSTER_BOOK_CARD_LIMIT`）与**内存快照**
  （`pickup_rules::saturate_monster_book`）各写死一次，两边同源于 TMS273；本轮没有合并成
  一个跨层常量，因为那需要把 `pickup_rules` 的纯函数接到 `auth` 上，超出本增量范围。
  两处都留了指向对方的注释。
- `MESOS_DROP_ITEM_ID` 只在新代码里用：`inventory_ops.rs` / `monsters.rs` 里的字面量 `"0"`
  维持原样，避免把一次增量扩成全仓改名。
- 满页签夹具不能靠改 `inventory_slots_json` 缩小页签——`read_inventory_slots_tx` 会把写入值
  clamp 到 `SLOT_LIMIT` 下限；验收改用"填满 SLOT_LIMIT 个格子"的做法（与
  `shop_buy_acceptance` 的满页签夹具同口径）。
- **本轮对玩家不可见**（行为在三条支路上逐字等价），无需实玩验收；未重启在线服务（3010 由用户跑
  `启动3010.command`）。
