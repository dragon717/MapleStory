# 任务 `infoex` 语义核定 + 脚本计数器边界精确化（2026-09-16）

> 任务单来源：`docs/plan/PLAN.md`「下一个 P0（未领取）」里的 **T05 剩余
> （打通 36317 需核定 `infoex` 语义）**。
> 上游阻塞记录：[`续章路径阻塞可解释.md`](../2026-09-14/续章路径阻塞可解释.md) §9、
> [`任务进度与最小场景执行.md`](../2026-09-14/任务进度与最小场景执行.md) §12
> （原文写「`Quest.wz` 二进制解不开，`exVariable`/`value` 哪个是变量名仍未核定」）。
> 任务卡：[审计 §11 T05](../../topics/MapleStory_TMS273_功能落地审计与Agent复刻计划_2026-09-14.md)。

## 1. 范围与结论

上一轮把 36317 的阻塞从「沉默」改成「说清楚」，但理由只能是笼统的
「原版腳本計數器尚未復刻」，并留下一个前提：**`infoex` 字段语义未核定**。
本轮把这条前提消掉，结论分两类：

| 项 | 核定结果 | 本轮动作 |
| --- | --- | --- |
| `infoex` 字段语义 | **已核定**：`exVariable` 是计数器名字、`value` 是目标数（1090 : 5 交叉验证） | 写进代码与门禁（见 §3） |
| 脚本计数器种类 | **已核定**：`dummy` = 剧情场景布尔位、`talk` = 对话步骤、其余只有 token | 停下的理由按种类说准 |
| 36317 / 36350「打通」 | **不能忠实打开**（推进脚本与目标地图在源里都不存在） | **维持阻塞**，不造替代（见 §2.6） |

**协议 24 未变、内容版本 `tms273-30` 未变、装配数据一行未改**（本轮只读
`sourceInfoex`，而它本来就在 `shared/gameplay.json` 里）。因此**无需重跑装配**，
也没有内容版本同步问题。

## 2. 核定过程（全部为源侧实测）

### 2.1 先更正一条已失效的前提

阻塞记录当初写「Quest 数据只存在于 `Quest.wz`（本地 `unpack_tms273_ms` 只解析
`.ms` 归档）」。**该前提现已失效**：源目录
`参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/Quest/QuestData/`
已**全量解包 23404 个任务 JSON**，`infoex` 可直接读，本轮全部结论都从它得出。

### 2.2 两个子节点谁是名字：用需求串交叉验证

`QuestInfo.demandSummary` 的进度串语法把**变量名写在串里**：

```
#questorder1#擊殺藍色蘑菇王 (#R36315ExkillRef36315#)
                     └── 任务 36315 的 Ex 变量 `kill`
```

拿 `Ex<token>Ref<id>` 里的 token 去比对同一任务的 `Check/1/infoex` 两个子节点：

| token 命中 | 条数 |
| --- | --- |
| `exVariable` | **1090** |
| `value` | **5** |
| 都不命中 | 18 |

18 条「都不命中」全部是**引用了别的任务**的变量，属正常引用而非反例
（如 15974 的串写着 `#R18764ExE1Ref15959#`）。

> **结论**：`exVariable` 是计数器名字、`value` 是目标数。少数条目是原著把两个
> 子节点**写反**（`36319` 是 `value:"kill"` / `exVariable:"1"`，`36350` 是
> `value:"talk"` / `exVariable:"lord"`）—— 这是**数据里的个例**，不是第二套编码。
> 所以运行时仍取「任一子节点出现该 token」的保守并集，与适配器
> `tms273_remaster.cjs::infoexMentionsKill` 同一口径，不按字段名猜。

### 2.3 源里还有第三个子节点：`conditionContent`

`39422` 的 infoex 节点是
`{order:1, value:"clear", conditionContent:"返回據點", exVariable:"dummy"}`
—— `conditionContent` 是**源自己的人话条件文本**。全量扫描：**1048 个任务文件**
带这个子节点；本仓库适配器只导出 `{value, exVariable}`，**没有导出它**。
这是一处已知缺口，但**本轮 55 条 remaster 任务没有一条带它**，导出它没有任何
玩家可见收益（见 §4）。

### 2.4 `dummy` 是什么：26 条带需求串的同类任务全是场景/地点

`dummy` 共 74 条。其中：

- **26 条带需求串**，需求文本**全部是场景或地点**，没有一条是数量类：
  `和雷卡托村長對話`、`進入反轉城市`、`抵達頂層`、`尋找生存者`、`守護江`、
  `前往毀損之塔`、`破壞黑洞產生器`…… 显示形式是 `(#R<id>ExdummyRef<id>#)` 的 0/1 勾选。
- **全部 74 条都没有 `endscript`**（`c1_endscript` = 0）。
- **21 条 `selfComplete=1`**，且这 21 条**无一**带 `mob[]` / `item[]` / `endscript`。

`dummy` 不是「无要求」的占位：74 条里**没有一条**同时缺
`startscript` / `endscript` / `npc`（n=0）⇒ 总有脚本或 NPC 能置位它，
它是**真闸门**，只是置位者在脚本体里。

### 2.5 `talk` 是什么：36350 自己的需求串就写着「对话」

`36350`（艾靈森林・荒蕪之地）的 `demandSummary` 是
`和#questorder1##r#p2132001##k對話`，其 `Check/1/infoex` 是
`{value:"talk", exVariable:"lord"}` ⇒ **`talk` = 对话步骤**。
（`36329`/`36333`「再次，疑問的聲音」也用 `exVariable:"talk"`。）

### 2.6 为什么 36317 / 36350 仍不能忠实打开

以 36317「再次前往現在的門」为例，四层全部缺失：

1. **没有玩家侧入口**：源无 `selfStart`、无 `selfComplete`、`Check/1` 无 `endscript`，
   ⇒ 起止都只能由脚本完成。
2. **目标位置在权威表里查不到**：`QuestDestination.json` 无 `36317`；`Check/0`
   无 `fieldEnter`；`Check/0` 也没有 map 字段。
3. **推进脚本确实不在源里**：`q36317s`（startscript）/`q36317x`（resignScript）
   与 NPC `1012100`（赫麗娜）的脚本**都不存在**。这不是「本包脚本层本来就薄」——
   本包随附 **4529 个**原版脚本（`item` 3130 / `portal` 295 / `npc` 191 /
   `event` 133 / `quest` 106 / `map` 3 个子目录），而 `363xx` 链的 `q3631x`
   **一个都没有**；全仓 `script/` 里 `36317` 零命中。
4. **T05 任务卡不授权硬凑**：卡上写「无脚本体时利用已经授权的 P 范围做**有限
   执行**……新的跨范围临时政策单列，**不默认为"允许任何替代"**」。

⇒ 真实步骤（去哪、做什么）在源里**没有任何依据**，做成「和赫麗娜说两次话就完成」
就是替原作伪造完成条件。**维持阻塞**，与上一轮候船室的判断同一形状
（「补门会造出源里不存在的通路」）。

> 换句话说：本轮**不是**「还没打通」，而是「核定完了，结论是这一步的原版机制
> 不在源里，照实说清楚」。这就是 T05 剩余项要的答案。

## 3. 本轮的改动（纯 Rust + 一条门禁断言，零装配数据改动）

| 文件 | 改动 |
| --- | --- |
| `server/src/world.rs` | `QuestSpec` 增加 `source_infoex`（读 JSON 里**早已存在**、此前被丢掉的 `sourceInfoex`）+ 新结构 `QuestInfoex`（`value` / `exVariable`）。**纯描述性**：它只用来命名计数器种类，可玩性仍只由 `blocked_by` 决定 |
| `server/src/quest.rs` | 新增 `counter_kinds`（取任一子节点的非数值 token，保守并集）与 `script_counter_reason`；`script-counter` 文案改为按种类生成 |
| `server/src/chapter_route_acceptance.rs` | 改写旧断言（它钉的是核定前的笼统措辞）＋新增 1 条验收 |
| `scripts/tms273_remaster.cjs` | 更正**已失效的注释**（原文称「Quest 数据只存在于 `Quest.wz`、无法判定字段语义」），换成 1090:5 的核定口径；判定逻辑**一字未改** |
| `scripts/check_tms273_remaster.cjs` | 反向断言：被打上 `script-counter` 的任务必须有源 `infoex` |

文案规则（`script_counter_reason`）：

| 源 `infoex` 的 token | 玩家读到 |
| --- | --- |
| 任一子节点是 `dummy` | `原版此步驟由劇情場景推進，腳本未隨源提供` |
| 任一子节点是 `talk` | `原版此步驟由對話腳本推進，腳本未隨源提供` |
| 其它 token（如 `kill` / `dir3`） | `原版腳本計數器尚未復刻（<token>）` —— token 只作括号内诊断 |
| 只写了数量、没写名字（`1401` 一族） | `原版腳本計數器尚未復刻`（**保持原文案，不发明种类**） |

繁体沿用 `quest.rs` 既有口径（该文件面向任务文本的字符串全为繁体，与 TMS273
客户端语言一致，且既有断言就钉着繁体串）——**没有**顺手改字形，避免把一次
语义修正扩散成一次无关的措辞翻修。

## 4. 未做 / 已知缺口

- **`conditionContent` 未导出**（源里 1048 个任务文件带它）：本轮 55 条 remaster
  任务**没有一条**带它 ⇒ 导出它没有玩家可见收益，不值得为它重跑一次装配。
  等某个真带它的任务进入范围时再补，届时它能让「此步骤：返回據點」这类文本
  直接进 `nextAction`/`blockReason`。
- **没有打开任何一条任务**：10 条 `script-counter` 任务（`1401`/`1403`/`1404`/
  `1405`/`36317`/`36328`/`36329`/`36333`/`36350`/`36365`）可执行性一字未改。
- **`36317` 的 `dummy` 仍不执行**：不实现脚本 VM，也不为它写 P 替代
  （理由见 §2.6；T03 任务卡同样禁止「为了少数缺口先做任意 JavaScript VM」）。
- **T05 任务卡的目标路线本身上一轮已达成**：36315→36316 真实可走，36316 之后是
  一个有明确后续说明的节点（36317 的 blocked 行）。本轮只让这个说明更准。

## 5. 验收

| 命令 | 结果 |
| --- | --- |
| `cargo test --offline --manifest-path server/Cargo.toml` | **479 过 / 0 失败**（基线 478 + 本轮净增 1 条） |
| `cargo build`（非测试） | **0 告警** |
| `client` 的 `tsc --noEmit` | 0 错 |
| `node scripts/check_tms273_remaster.cjs` | **exit 0** —— 55 条核对、`executable` 仍为 19 条、`implementedUntouched: 15`；新反向断言 PASS |
| `node scripts/check_tms273_runtime.cjs` | **exit 0** —— 188 图 / 108511 源引用 |
| `client` 的 `run-checks.mjs` | **36/38** —— 2 项为既有基线失败（`layer-animation.check.ts` 无扩展名导入、`build-release.check.cjs` 沙箱无 `ps`） |

新增验收（`chapter_route_acceptance.rs`）：

- `a_script_counter_is_named_from_the_source_and_still_opens_nothing` ——
  36317 的理由**逐字**等于 `尚未開放：原版此步驟由劇情場景推進，腳本未隨源提供`；
  36329/36333/36350 命中「對話腳本」；36328/36365 走括号诊断形
  （`（kill）`/`（dir3）`）；只写数量的合成规格**保持原文案**；
  并逐条断言这 10 条任务**仍不可执行、仍带 `script-counter`**（命名种类不放行）。
- 既有 `the_stop_after_the_hand_in_says_why_instead_of_disappearing` 的断言改写：
  它原本钉着核定前的笼统串，现在钉「说得说出种类」+ 反向断言「不许退回笼统措辞」。

> `artifacts/refactor/frontend-deps.json` 会被 `refactor_audit --deps` 重写（既有
> 现象，已确认还原到 HEAD 后该检查仍 PASS），本轮结束时**已还原**。

## 6. 未验证

- **未实玩**：在线 3010 实例跑的仍是旧二进制，本轮未重启；36317 的**新理由文案**
  在真实浏览器里读起来是否清楚，待统一加载核看。
- **未验 `conditionContent`**：见 §4，本轮不导出，故未验证它在 UI 里的落点。

## 7. 回退边界

- 代码可整体回退；**无数据库迁移、无装配数据变更、无协议变更、无内容版本变更**
  （协议 24、内容 `tms273-30`、188 图全部未动），回退不需要重跑装配链。
- `source_infoex` 只是多读一个 JSON 字段，缺字段时 serde 走 `default`，
  旧装配数据（不含该字段）也能正常加载。
