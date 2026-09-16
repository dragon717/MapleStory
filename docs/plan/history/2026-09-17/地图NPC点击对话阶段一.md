# 地图 NPC 点击对话：阶段一（2026-09-17）

> 用户需求：依据需求单 tms273，落地地图上所有 NPC 的点击对话，分两阶段。
> **阶段一（本记录）**：原版里所有地图上的 NPC 均可被点击并触发基础响应（选中高亮 + 占位提示），
> 暂不接入完整对话内容，但**预留接口**供后续扩展。
> **阶段二（后续迭代）**：接入完整 NPC 对话，并对接任务系统。
> 相关：[`BUSINESS_DEVELOPMENT.md`](../../technical/BUSINESS_DEVELOPMENT.md)、图鉴 NB-07 的
> `blockedReason` 归属结论（分区事实不下沉为全局错误）在本轮复用了同一口径。

## 1. 范围与结论

| 项 | 结果 |
| --- | --- |
| 缺口定位 | ✅ **在服务端，不在客户端的命中测试**（见 §2） |
| 服务端兜底 | ✅ 无脚本 NPC 由「静默 `ended`」改为占位对话（`source: 'placeholder'`） |
| 客户端选中反馈 | ✅ 被点击（或 ↑ 键）的 NPC 名牌转金并全不透明，窗口关闭即复原 |
| 客户端占位呈现 | ✅ 灰斜体，与 NPC 本人台词视觉可分 |
| 阶段二预留接口 | ✅ **唯一替换点**（§4），加法改动，**不升协议 / 不升内容版本** |
| 门禁 | ✅ 新增 `server/src/npc_click_acceptance.rs` 3 条（全量内容遍历） |
| 玩家可见行为变化 | ✅ 有（**需统一加载 3010 后实玩**，见 §6） |

**协议 24 / 内容 `tms273-31` / 198 图全未动。** `dialog.source` 是可选字段的加法扩展，
缺省语义＝「服务端脚本或职能分发产生的对话」，老客户端不读它也不受影响。

## 2. 根因：点击本来就打得到，是服务端回了个「结束」

已摆放的 NPC 模板共 **265 个**（分布在 **111 张图**、**381 个出生位**），其中：

| 类别 | 数量 |
| --- | --- |
| 带原版 `script` | **30** |
| 无 `script`、由**职能分发**接走（商店／仓库／转职／船务／呼叫器／任务菜单等） | 21 |
| 任务阶段**隐藏**（只回一句「当前无法对话」`npc_unavailable`） | 3 |
| **落入占位分支（本轮的兜底对象）** | **211** |

客户端的命中测试（`world.ts::handlePointerDown`，含 marker 帧）**本来就能点到全部模板**，
问题在服务端：既无 `script`、又不属于任何已接入职能分发的模板，走到
`server/src/dialogue.rs::handle_npc_talk` 的「无脚本」分支后只回一个 `DialogueView::End`。
客户端收到 `ended` 就把窗口关掉 ⇒ 玩家看到的是**「点了没反应」**。

> 因此本轮**没有**改命中测试、没有动 `handlePointerDown`、也没有放宽 `nearestNpc` 的距离判定
> ——那些都不是缺陷。

## 3. 逐文件改动

| 文件 | 改动 |
| --- | --- |
| `server/src/npc.rs` | 新增 `PLACEHOLDER_DIALOGUE` 常量、双语文案与 `placeholder_view()`（`ok` 节点 + `source` 标记） |
| `server/src/dialogue.rs` | 「无脚本」分支：**开启**步回占位视图，其余步骤仍回 `End`（否则关闭动作会被当成新一轮开启） |
| `shared/protocol.ts` | `npcResult.dialog` 增加可选 `source?: 'placeholder'`（带注释说明它是阶段二的预留标记） |
| `client/src/features/npc/view.ts` | `NpcView` 增加 `selected` / `setSelected()` / `isSelected()` / `applyLabelStyle()`；名牌配色提为常量 |
| `client/src/scenes/world.ts` | 新增 `selectNpc()` / `selectedNpc()`；`clear()` 与「视图被快照撤掉」两条路径都收掉选中态 |
| `client/src/app/main.ts` | `talkToNpc` 开头点亮选中（鼠标点击与 ↑ 键共用这一处入口）；构造 `NpcDialogueView` 时传关闭回调 |
| `client/src/features/npc/dialogue.ts` | 构造参数新增 `onClose`；新增 `syncOpenState()` 边沿检测（开窗武装、关窗恰好通知一次）；`renderDialogue` 切 `is-placeholder` 类 |
| `client/src/app/style.css` | `.npc-dlg-msg.is-placeholder{color:#8a8a8a;font-style:italic}` |
| `server/src/npc_click_acceptance.rs` | **新建**，经 `world_tests.rs` `include!` 挂载（助手一律 `npd_` 前缀） |
| `client/src/features/npc/view.check.mjs` / `dialogue.check.mjs` | 各新增一段（选中高亮／占位样式与关闭通知） |

### 3.1 为什么关闭通知放在 `syncOpenState` 而不是每个调用点

Escape、关闭按钮、服务端 `ended`、换图、断线**都会**落进 `closeDialogue`/`closeShop`。
通知若写在调用点，漏一条路径就会让地图上的名牌**一直亮着**。所以通知挂在
`closeDialogue`/`closeShop` 共同调用的 `syncOpenState()` 上，用「与上次告知宿主的状态比对」
做边沿检测：开窗武装、关窗只触发一次，`clear()`（同时关两个窗）也不会重复通知。

### 3.2 选中态的三条销毁路径

名牌是客户端**唯一自己画的** NPC 元素（精灵是源美术），所以选中反馈落在它身上。清理由三处覆盖：

1. `selectNpc(null)`——对话窗口关闭回调；
2. `World.clear()`——换图；
3. `updateGameplayEntities` 里**视图被快照撤掉**时（任务阶段会把 NPC 从快照移除）。

第 3 条不做的话，`selectedNpcId` 会指着一个不在图上的实例，同名新实例再也不会被点亮。

## 4. 阶段二的唯一替换点

`dialog.source === 'placeholder'` 这个标记**不是给玩家的文案**，只是让客户端与门禁能把
「占位」与「本人台词」分开。阶段二接入真实对话时：

1. `server/src/dialogue.rs` 的那一个分支把 `npc::placeholder_view` 换成真实来源；
2. 删除 `npc::placeholder_view` 与 `npc::PLACEHOLDER_DIALOGUE`；
3. 删除 `shared/protocol.ts` 的 `source` 字段、`dialogue.ts` 的 `is-placeholder` 切换与
   `style.css` 的对应规则；
4. `npc_click_acceptance.rs` 里钉着 `placeholders > 0` 的反向断言会**主动失败**，提示删除占位分支。

**上面的分发顺序与下面的脚本路径都不动**，所以阶段二不会与阶段一冲突。

## 5. 新增验收（`server/src/npc_click_acceptance.rs`，3 条）

1. **`every_placed_npc_template_answers_a_click`**——对真实 `shared/gameplay.json` 的**每一个**模板点一次：
   - 绝不出现「什么都没回」，也绝不出现「只回 `ended`」；
   - 除了任务阶段隐藏的 NPC（名单写死为 `QUEST_HIDDEN_NPC_2/3` + `QUEST_OLIVIA_NPC`，并断言这三条
     常量**确实是**发布内容里的模板），**不允许任何其他拒绝**；
   - 占位只能落在无 `script` 的模板上（防止占位顶掉已接入的真实内容）；
   - 三条**反向断言**：`placeholders > 0`（占位分支不是死代码）、`scripted > 0`（脚本路径不是死代码）、
     `placeholders < templates.len()`（不存在「整体失效却全绿」的退化）。
2. **`placeholder_is_the_scriptless_fallback_and_never_masks_a_script`**——最小夹具固定边界：
   占位内容与标记、`end` 必须结束（且不得再吐占位对白）、有脚本走真实对白且**不带**标记、
   仓库管理员走职能分发、未知 NPC 仍以 `npc_unknown` 拒绝。
3. **`placeholder_view_is_bilingual_and_marked`**——`zh` / `en` 文案与标记，未知语言回落简体。

`include!` 助手一律 `npd_` 前缀（该文件与既有验收共用 `mod tests`，裸名会撞）。
另注：`std::path::Path` 已被 `content_boot_acceptance.rs` 在同一模块 `use` 过，
本文件只能走全路径。

## 6. 验收

| 项 | 结果 |
| --- | --- |
| `cargo test`（全量） | **495 过 / 0 失败**（基线 492 + 净增 3）——本轮改动收口后的时点证据 |
| `cargo test` 定向（本轮 3 条） | **3 过 / 0 失败**（在并行会话文件已可编译的树上复跑，见下） |
| 非测试构建 | **0 告警** |
| `tsc --noEmit` | exit 0 |
| 客户端 `run-checks.mjs` | **37/39**（新增两段均 PASS；2 项＝既有失败） |
| `artifacts/refactor/frontend-deps.json` | 跑完已还原（`git status` 干净） |
| 装配数据 / 协议 / 内容版本 | **零改动**（协议 24、`tms273-31`、198 图） |

**时点说明（重要）**：全量 `cargo test` 的 **495/0 是在本轮改动全部落地后、且工作区只有本轮改动时**取得的。
此后同一工作区出现了**另一个会话正在进行的「物品系统增量 3（PickupSink）」未提交文件**
（`server/src/pickup_sink_acceptance.rs`、`auth/item_world.rs`、`auth/loot.rs`、`auth/db.rs`），
**本轮全程未触碰这些文件**。对方文件一度编译不过（`expected Arc<Store>, found Store`），
收口后复跑全量得到 **499 过 / 2 失败**，两条失败都在对方的新用例里
（`inventory_sink_refusal_restores_the_drop_and_a_later_pickup_succeeds`、
`monster_book_card_saturates_at_five_and_still_claims_the_drop`），与本轮无关；
**本轮的 3 条在同一次复跑中全过**（`499 = 495 + 对方净增 4`）。
非测试构建不受影响（`world_tests.rs` 只在 `cfg(test)` 下编译），**0 告警**在该时点后仍成立。

## 7. 待你实玩验收（统一加载 3010 后）

1. 点任意**没有对话内容**的 NPC（例如城内站着不动的装饰性 NPC）：应看到**名牌转金**且窗口弹出
   「这个 NPC 的对话内容尚未实装。」（灰色斜体），不再「点了没反应」。
2. 关闭窗口（Escape / 关闭按钮 / 点到窗口外）：**名牌应立即恢复白色**，不应残留高亮。
3. 点**已有内容**的 NPC（商人开店、仓库管理员、转职官、飞行船服务、带脚本 NPC）：
   观感应与改动前**完全一致**，且台词**不带**灰斜体。
4. `?lang=en` 下占位文案应为 `This NPC's dialogue has not been implemented yet.`。
5. 换图 / 断线重连后再进图：不应有名牌亮着。

## 8. 未做 / 边界（如实登记）

- **没有**为任何 NPC 编造对话内容：阶段一只解决「点了没反应」，占位文案本身明说「尚未实装」。
- **没有**接入任务系统（那是阶段二）。
- **没有**改协议版本号或内容版本号（`source` 是可选加法字段；`PROTOCOL_VERSION` 仍 24）。
- **没有**动客户端的 NPC 命中判定、`nearestNpc` 距离窗、`world.ts:145` 的门受理规则。
- 客户端 `run-checks.mjs` 的两项既有失败与本轮无关：
  `src/scenes/layer-animation.check.ts`（`assets/manifest.ts` 无扩展名导入 `../features/windbell/maps`，
  Node ESM 解析不了）与 `build-release.check.cjs`（沙箱禁用 `ps`；按既有做法加 `ps` 桩即 PASS）。
