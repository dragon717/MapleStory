# 地图 NPC 点击对话：阶段二（2026-09-17）

> 需求单 tms273，分两阶段。**阶段二（本记录）＝让无脚本的 NPC 说出源里真正说过的话**，
> 并把「台词 → 任务菜单」串成同一次对话。
> 相关：[阶段一记录](地图NPC点击对话阶段一.md)、[`BUSINESS_DEVELOPMENT.md`](../../technical/BUSINESS_DEVELOPMENT.md)。

## 1. 范围与结论

| 项 | 结果 |
| --- | --- |
| 源台词是否真的存在 | ✅ **存在**，只存在于两张同版表的交叉引用里（见 §2） |
| 服务端说话 | ✅ 无脚本分支由「占位提示」改为**逐页说出源台词**（`npc-line:<i>` 状态机） |
| 任务衔接 | ✅ 有任务可做的 NPC 先逐页说完台词，**再**出任务选项（`npc-line:<i>:menu`） |
| 客户端改动 | **不需要**（`kind: 'next'` 与翻页控件阶段一前就有，本次复用同一条渲染路径） |
| 协议 / 内容版本 | **零改动**（协议 24、内容 `tms273-31`、198 图） |
| 覆盖 | **233 / 265** 个模板有了源台词；余 **32** 个源里确实一句话都没有（占位收窄为字面意思） |
| 门禁 | ✅ 新增 `scripts/check_tms273_npc_dialogue.cjs`（**从源独立重算**整张表）+ 验收增至 7 条 |
| 玩家可见行为变化 | ✅ 有（**需统一加载 3010 后实玩**，见 §7） |

## 2. 关键发现：源里有台词，但只在「声明」与「文本」的交叉引用里

阶段一的结论是「265 个模板只有 30 个带原版 `script`」——那是对**脚本**成立，对**台词**不成立。
`Npc.wz/<id>.img/info/script` 声明的 121 个脚本名（`infoArcher`、`talk_lukas`…）绝大多数在本包中
**没有实体**（只有 8 个能在随附服务端脚本里找到），所以本轮**不碰脚本**。真正能承载对话的是另一对表：

| 表 | 作用 |
| --- | --- |
| `Npc.wz/<id>.img/info/speak` | **有序**列表，值是 `String/Npc.json` 的键名（`n0`/`d0`/`s0`…）——源对「这个 NPC 说哪几句、按什么顺序」的权威声明 |
| `String/Npc.json/<id>` | 真正的文本；前缀分三类：`n*` 地图常态台词、`d*` 对话框台词、`s*` 职能短句 |

（`info/speak` 的结构是 `{_dirType:'sub', '0':{_dirType:'string',_value:'n0'}, '1':…}`，即带 `_dirType` 标记的索引列表。）

实测分发（对 `shared/gameplay.json` 的 265 个已摆放模板全量统计）：

| 类别 | 数量 |
| --- | --- |
| 有源台词（`info/speak` 声明） | **111** |
| 有源台词（无声明，回落 `d*` 再 `n*`） | **122** |
| **合计能说出源台词** | **233** |
| 源里一句话都没有（`傳送門`／`警告牌`／`繳納箱`／`武將排行榜` 这类物件型条目） | **32** |
| 台词总行数 | **553** |

## 3. 数据管线

| 文件 | 角色 |
| --- | --- |
| `scripts/export_tms273_npc_dialogue.cjs` | **新建**。读 `shared/gameplay.json` 的模板集合 + 上面两张源表 → `shared/npc-dialogue.json` |
| `shared/npc-dialogue.json` | **新建**。`{schemaVersion, kind:'npc-dialogue-zh', generatedFrom, encoding, npcs:{id:{origin,lines:[]}}}` |
| `scripts/build_tms273.cjs` | 装配链**新增一步**（见下） |
| `scripts/check_windows_resources.cjs` | Windows 资源清单**新增** `shared/npc-dialogue.json` |

### 3.1 导出侧的不补默认值原则

没有台词的模板**不出现在输出里**（绝不补一句来凑数），因此「表里查不到」＝「源里这个 NPC 没有说话内容」，
与「还没接」是两件事。这一条是服务端能把占位语义收窄（§5）的前提。

标记处理：`#p<id>#`（NPC 名）、`#m<id>#`（地图名）按同一批源表还原；`#t<id>#`（道具名）只在本版
物品表能查到名字时还原，查不到就**整段丢弃**（实测 553 行中已无残留 `#…id…#`——留下半个标记会让客户端
把裸 id 打进对话框）。颜色／样式码（`#b/#k/#n/#r`）**原样搬运**，那是客户端 `sanitize()` 的职责。
同一句话在源里重复出现在多个槽位（如 `1300007` 声明 `d0 s0 d1 s1` 而两组同文）时按**保序首次出现**去重。

### 3.2 装配链位置：`generate_tms273_gameplay.py` 之后

```js
run('python3',['scripts/generate_tms273_gameplay.py']);
run(process.execPath,['scripts/export_tms273_npc_dialogue.cjs']);   // ← 新增
```

位置由**两个输入**共同决定，且已核对：该脚本读 `shared/gameplay.json`（`generate_tms273_gameplay.py`
写出最终模板集合）与 `shared/items.json`（同一脚本第 959 行写出）。所以放在这一位既拿得到两个输入，
也拿得到**装配完成后的**模板集合；`assemble_tms273.cjs` 在后段只**消费** `gameplay.npcs`（第 230 行是断言），
不改写它，因此本表不会在装配后过期。**装配新图后必须重跑**（`build_tms273.cjs` 会带上它）。

## 4. 服务端机制（逐文件）

| 文件 | 改动 |
| --- | --- |
| `server/src/npc.rs` | 新增 `NpcDialogue`（只声明 `lines`，`origin` 由 serde 忽略）、`NPC_LINE_NODE`／`line_node(index,menu)`／`parse_line_node()`、`line_view()`；`PLACEHOLDER_DIALOGUE` **保留**但语义收窄 |
| `server/src/dialogue.rs` | 新增 `handle_scriptless_npc_talk()`、`open_npc_lines()`、`advance_npc_lines()`、`LineStep`；无脚本分支不再直接回 `placeholder_view` |
| `server/src/quest.rs` | 任务菜单前先播台词：`LineStep::ContinueToMenu` 把控制权交回菜单分支 |
| `server/src/world.rs` | `World` 新增 `npc_dialogue` 字段与 `with_npc_dialogue()` 注入器 |
| `server/src/main.rs` | 读 `shared/npc-dialogue.json`（可用 `NPC_DIALOGUE_FILE` 覆盖）并注入；**读不到就硬失败**（静默降级会让全地图 NPC 集体回占位而不报警） |

### 4.1 会话状态复用既有槽位，不新增第二个

台词页用 `npc.conversation`（既有 `String` 节点名）编码，节点名 `npc-line:<index>` / `npc-line:<index>:menu`：

- `parse_line_node()` 只认 `npc-line:` 前缀 ⇒ 脚本节点、任务菜单缓存节点、法师训练节点都**解析不出**台词页，
  调用方因此不会把别人的状态机误当成自己的（`LineStep::NotALine`）。
- `:menu` 后缀表示「这句之后接任务菜单」。台词播完时清掉台词节点、把控制权交回 `quest.rs` 的菜单分支，
  由它写自己的 `QUEST_MENU_NODE…` 状态——**菜单不会抢在台词前面**。
- 只有**当前节点确实是台词页**时 `advance_npc_lines()` 才接手，所以「第一次点击」与「推进一页」共用同一入口而不打架。

### 4.2 演出规则

一页一句：非末页给 `kind: 'next'`（客户端渲染「下一页」并发 `step:'next'`），末页给 `kind: 'ok'`。
中途 `step:'end'`（关闭）**直接收掉这次对话**，不会因为「后面还挂着菜单」而把菜单弹出来——否则窗口关不掉。

## 5. 与阶段一 §4 计划的**偏离**（重要，如实登记）

阶段一记录 §4 预言阶段二会「删除 `npc::placeholder_view` 与 `PLACEHOLDER_DIALOGUE`、删除协议 `source` 字段、
删除客户端的 `is-placeholder` 与 `style.css` 规则」。**实际实现选择了相反的做法**：

> 占位**没有被删除**，而是从「还没接」**收窄**成它的字面意思——「源里这个 NPC 就没有说话内容」。

理由：收窄后仍有 **32 个**模板真的落在这一支（物件型条目，源里既无 `info/speak` 也无 `String` 台词，
原版对它们也没有对话）。把占位删掉、让这 32 个退回「点了没反应」，等于用第二次退化换掉阶段一的成果。
因此 `source: 'placeholder'` 与客户端灰斜体继续保留，但含义与文案都改了：

- 文案：`这个 NPC 的对话内容尚未实装。` → **`这个 NPC 在原文中没有对话内容。`**（en 同步）；
- `shared/protocol.ts` 的 `dialog.source` 注释已按**实际决策**重写（原文写着「阶段二接入后连同取值一起删除」，
  现在会误导后来者删掉一个活着的取值）；
- `client/src/features/npc/dialogue.ts` 与 `dialogue.check.mjs` 里同样陈旧的注释／夹具文案一并更正。

阶段一记录 §4 第 4 条「`npc_click_acceptance.rs` 里钉着 `placeholders > 0` 的反向断言会主动失败」**没有发生**
——反向断言仍在，只是它的含义变成「源里确实有一批没有说话内容的模板」，并新增了**双向**约束（§6）。

## 6. 门禁与验收

### 6.1 新增仓库级门禁 `scripts/check_tms273_npc_dialogue.cjs`

**它不调用导出脚本、也不共用它的任何函数**：按两张源表**独立重算**一遍期望值，再要求落盘的那份
**逐字段相等**（键集合、`origin`、台词序列顺序）。共用同一份实现会让导出侧的 bug 在两侧同时成立。
反向断言（缺一不可）：

- 源里声明了台词的模板**必须**在表里（丢内容 ⇒ 失败）；
- 表里的 id **必须**是 `gameplay.json` 的真实模板（造内容 ⇒ 失败）；
- 源里一句话都没有的模板**必须不在**表里（补默认值凑数 ⇒ 失败）；
- **无台词模板数 > 0**——这条守着占位分支不会因为某次「全量补齐」被掏空；
- `speak` 与 `strings` 两种来源都必须有实例（否则一条分支是死代码）；
- **接线检查**：`main.rs` 真的读它并 `.with_npc_dialogue(...)`、`dialogue.rs` 真的有 `open_npc_lines`/`advance_npc_lines`、
  `build_tms273.cjs` 真的会跑导出、`check_windows_resources.cjs` 真的带上它——任一环断掉都会让整张表
  静默回到占位提示而其余门禁全绿。

已接进 `client/scripts/run-checks.mjs` 的仓库级清单。

### 6.2 服务端验收（`server/src/npc_click_acceptance.rs`，3 条 → **7 条**）

阶段一 3 条的去向：`placeholder_view_is_bilingual_and_marked` **原样保留**；
`placeholder_is_the_scriptless_fallback_and_never_masks_a_script` 保留并改口径（下面第 3 条，断言文案改为
「源里没有说话内容」）；`every_placed_npc_template_answers_a_click` **改名并加强**为下面第 1 条。
**新增 4 条**（第 2、4、5、6 条）：

1. **`every_placed_npc_template_answers_a_click_with_source_dialogue`**（阶段一基础上加强）——对真实
   `gameplay.json` 的**每一个**模板点一次，结合真实 `shared/npc-dialogue.json`：有源台词的模板第一页
   **逐字**等于源的第 1 句；占位**只允许**落在源里没有说话内容的模板上（**双向**：有台词却回占位 ⇒ 失败；
   没台词却回台词 ⇒ 失败）。
2. **`quest_npc_speaks_source_lines_before_the_menu`**——有任务可做的 NPC 先逐页说完台词，菜单在台词**之后**出现。
3. **`placeholder_is_the_source_less_fallback_and_never_masks_a_script`**——占位是「源里没有说话内容」的退路，
   且绝不遮蔽脚本：有脚本走真实对白且**不带** `source` 标记，仓库管理员走职能分发，未知 NPC 仍以 `npc_unknown` 拒绝。
4. **`source_lines_page_one_at_a_time_and_stop_at_the_end`**——分页推进、末页给确认、中途关闭不再吐台词、重开回到第一句。
5. **`source_dialogue_is_reachable_without_any_quest`**——没有任何任务的模板也能说出源台词（一句话时直接给 `ok`）。
6. **`line_node_round_trips_and_only_line_nodes_parse`**——节点编解码与 `kind` 规则的纯函数边界（脚本／菜单节点解析不出来）。

### 6.3 实测数字（时点见 §9）

| 项 | 结果 |
| --- | --- |
| `cargo test`（全量） | **505 过 / 0 失败**（02:21:45 GMT+8 起跑，13.3s 收尾） |
| 本模块文件的 7 条验收 | **全过**（由全量 505/0 覆盖；其中 5 条在日志里逐条可见 `ok`） |
| 非测试构建 | **0 告警** |
| `npc_click_acceptance.rs` 贡献的告警 | **0 条**（全量 49 条告警全在既有验收文件里，最大的 `away_acceptance.rs` 25 条，该文件及其余告警文件本模块**全程未触碰**） |
| `tsc --noEmit` | exit 0（无输出） |
| 客户端 `run-checks.mjs` | **38/40**（新增的 `check_tms273_npc_dialogue.cjs` PASS；2 项＝既有失败） |
| 门禁自跑 | `NPC dialogue table: 233/265 templates carry source lines (111 from info/speak, 122 from String/Npc.json), 553 lines, 32 templates have no dialogue in the source` |
| 协议 / 内容版本 | **零改动**（协议 24、`tms273-31`、198 图） |

2 项既有失败与本轮无关：`src/scenes/layer-animation.check.ts`（`assets/manifest.ts` 无扩展名导入
`../features/windbell/maps`，Node ESM 解析不了）与 `build-release.check.cjs`（沙箱禁用 `ps`；加 `ps` 桩即 PASS）。

## 7. 待你实玩验收（统一加载 3010 后）

1. 点**商店外的普通 NPC**（如 10000 这位「關於機器我可是專家喔」的居民）：应看到**逐页**台词，
   末页按「确认」结束；不再出现灰色斜体的占位文案。
2. 点**既有职能的 NPC**（商人开店、仓库管理员、转职官、飞行船服务、带脚本 NPC）：观感应与改动前**完全一致**。
3. 点**有任务可做**的 NPC：先出台词，台词播完**才**出现「接取／交付」选项；选项顺序与之前一致。
4. 点 `傳送門`／`警告牌` 这类物件型条目：应看到灰色斜体的「这个 NPC 在原文中没有对话内容。」
   （**文案已改**，不再是「尚未实装」）。
5. 中途按关闭 / Escape：对话应立即收掉，**不应**在台词没播完时弹出任务菜单。
6. 换图、断线重连后再点同一 NPC：应从第一句重新开始。

## 8. 未做 / 边界（如实登记）

- **没有编造任何台词**：233 个模板的每一句都逐字来自 `String/Npc.json`，且以 `info/speak` 声明的顺序为准；
  导出与本表内容由门禁从源独立重算校验（§6.1）。
- **没有接入脚本体**：`info/script` 声明的 121 个脚本名在本包中绝大多数没有实体，本轮**不造替代**。
- **32 个模板仍走占位**：源里确实没有说话内容（物件型条目），这是**收窄后的**占位，不是「还没接」。
- **英文 locale 下没有译文**：本表的源台词是繁体中文，`?lang=en` 时按原样显示（客户端
  `i18n.ts::displayText` 只在 `zh` 下做 tw→cn 转换）。脚本对话走的是 `LocalizedText` 的 `{zh,en}` 双语路径，
  本轮这批**没有**英文来源，故不补（补＝编造）。en 下的占位文案仍有英文。
- **没有改协议版本号或内容版本号**（`PROTOCOL_VERSION` 仍 24，内容仍 `tms273-31`，198 图未动）。
- **没有改客户端的 NPC 命中判定、`nearestNpc` 距离窗、`world.ts:145` 的门受理规则**；本轮客户端只更正了注释与夹具文案。
- **同名文件易混淆（提醒）**：`shared/npc-dialogue-zh.json`（2026-09-06 的 12 条，脚本对话简体**手稿**，
  由 `scripts/npc_i18n/apply_dialogue_zh.py` 消费）与本轮的 `shared/npc-dialogue.json`（233 条同版**源台词表**）
  **是两个不同的文件**，只是名字相近；`kind` 也不同（后者为 `npc-dialogue-zh`）。改动前先看清路径。
- **`save_quest_kill` 是既有死代码**：`server/src/auth/quests.rs:67` 定义、全仓无调用者，产生 1 条
  `method is never used` 告警，与本轮无关（本轮未触碰该文件）。

## 9. 时点说明（并发写入，重要）

全部数据与代码落在工作区后，于 **02:21:45（GMT+8）** 起跑全量 `cargo test`（13.3s 收尾）取得
**505 过 / 0 失败**；新门禁与 `npm run check` 在其后复跑。

**同一工作区存在另一个会话/进程的写入**：本模块的导出脚本、`shared/npc-dialogue.json` 与
`server/src/{npc,dialogue,quest,world,main}.rs`、`npc_click_acceptance.rs` 在本轮运行期间被**逐分钟写入**
（实测 mtime 序列 02:14:22 → 02:21:01，其中 `shared/npc-dialogue.json` 在 02:21:01 被重新导出）。
本记录所述「绿」指的是**上述时点**的状态；本轮未触碰、也未删除对方文件中的任何内容。
收尾前写入已静止（最后一次写入 02:21:01，之后无新写入）——**该句已被后续事实推翻，见 §10**。

## 10. 收尾追加（02:23–02:45，含对 §9 的更正与可复核的基线）

本节由收尾复核追加。§1–§9 的技术结论全部复核属实（逐项验过），本节只补充**当时还没有**的
数据与两处小改动。

### 10.1 §9 的「写入已静止」不成立

收尾期间工作区**仍有并发写入**：02:23:29 与 02:23:33 有人改了
`client/src/features/npc/dialogue.check.mjs` 与 `scripts/check_tms273_npc_dialogue.cjs`，
02:26:36 又改了 `scripts/export_tms273_npc_dialogue.cjs`；本文件自身也在 **02:24:18** 被写入。
⇒ 并发写作者在本轮运行期间**持续存在**，不是「02:21:01 之后静止」。工作区里同时出现过
`scripts/_probe_npc_string.cjs`（02:07 创建、02:14 前被其作者删除）与两个 prunable worktree
（`/private/tmp/ms-base`、`/private/tmp/ms-bug`），都非本记录作者所建、也未被触碰。

**复核口径**：本节所有数字取自「`git status` 只有本模块的 6 个 `M` + 4 个 `??`」的那个时点，
与 §9 的时点口径一致；此后未再改动 `server/src` 下任何文件。

### 10.2 基线的**实测**取法（§6.3 只给了本侧数字，这里补上对照侧）

`§6.3` 说「全量 49 条告警全在既有验收文件里」但没给出**对照基线**，因此无法回答「这 49 条是不是
本轮引入的」。用独立工作树在 `5f4f50b`（阶段一提交）上量得：

```sh
git worktree add /tmp/ms-baseline 5f4f50b --detach
cd /tmp/ms-baseline && cargo check --manifest-path server/Cargo.toml --tests   # 告警数
cd /tmp/ms-baseline && cargo test  --manifest-path server/Cargo.toml -- --list # 用例数
git worktree remove /tmp/ms-baseline --force
```

| 指标 | HEAD `5f4f50b`（基线） | 本轮工作区 | 差值 |
| --- | --- | --- | --- |
| 测试构建告警 | **49** | **49** | **0** |
| 用例总数 | **501** | **505** | **+4** |
| 非测试构建告警 | 0 | 0 | 0 |

用例差集（`comm`）显示**新增 6、消失 2**，消失的两条正是改名重写的：
`every_placed_npc_template_answers_a_click` → `..._with_source_dialogue`、
`placeholder_is_the_scriptless_fallback_and_never_masks_a_script` → `..._is_the_source_less_...`
⇒ **净增 4**，与 §6.2 的「3 条 → 7 条」一致。

用例数的完整链条（跨记录对得上）：**492**（增量 4 前）→ **495**（阶段一 +3）→ **501**（增量 3 +6）→ **505**（阶段二 +4）。

> **勘误：仓库记忆里记的「测试构建基线＝47 条告警」已过期，实测 `5f4f50b` 上就是 49 条。**
> 按文件分布是 `away_acceptance.rs` 25、`world_tests.rs` 2、`storage_acceptance.rs`/`party_acceptance.rs`
> 各 2、其余 18 个验收文件各 1。判绿口径不变：**本轮改动的 6 个服务端文件贡献 0 条**（不在该名单里）。

### 10.3 §6.1 门禁的**第 5 组**断言（当时未列）

门禁在第 4 组（接线）之后又补了一组，钉的是**占位链路的成对性**——它只影响样式，删掉任何一侧
都**不会**让任何一条测试失败：

1. `server/src/npc.rs` 仍有 `pub const PLACEHOLDER_DIALOGUE`；
2. `shared/protocol.ts` 仍声明 `source?: 'placeholder'`；
3. `client/src/features/npc/dialogue.ts` 仍消费 `is-placeholder`；
4. 简/英两条占位文案**读得到、非空、且互不相同**，且 `placeholder_view` 真的引用了英文常量
   （否则 `lang=en` 分支成了摆设而单侧测试照样全绿）。

### 10.4 §5 说的「夹具文案更正」具体做法：改成**不依赖服务端文案**

`client/src/features/npc/dialogue.check.mjs` 原来**抄了服务端的占位文案**
（`'这个 NPC 的对话内容尚未实装。'`，第 185/191 行）。服务端改了文案之后，它自带断言所以
**两侧测试仍然全绿**，谁也没发现已经不一致——这是本次实际遇到的一处陈旧夹具。

现在改成自造的哨兵串 `'（占位提示哨兵）'`：该检查验的是「带 `source:'placeholder'` 的对话被标成
备注、并且原样渲染」，与文案本身无关，**从根上去掉了这类陈旧的可能**。文案本身由 §10.3 第 4 条
直接读 `server/src/npc.rs` 的常量来钉。复跑：`NPC placeholder dialogue: remark styling and single
close notification passed.`

### 10.5 导出侧的确定性（可复核）

`node scripts/export_tms273_npc_dialogue.cjs` 复跑输出：

```json
{"templates":265,"withDialogue":233,"fromSpeak":111,"fromStrings":122,
 "withoutDialogue":32,"repeatedLinesDropped":61,"unresolvedReferenceMarkers":0,"totalLines":553}
```

且产物与复跑前**字节相同**（幂等）。补两个 §3.1 没给的具体数：**去重前 614 行**，去重掉 **61** 行；
**带引用标记的仅 3 行**（`1010100:d0`、`1010100:d1`、`2041022:d1`），其中 `#t1012109#` 在物品表里
查不到 ⇒ 整标记删除，故残留未解析标记 **0**。多页分布 `1:33 / 2:114 / 3:56 / 4:26 / 5:4`，
最长 5 句（`路卡斯` 12000、`麥加` 12100、`麗娜` 1010100、`微微安` 9010010）。

### 10.6 收尾复跑

| 项 | 结果 |
| --- | --- |
| `cargo test`（全量） | **505 过 / 0 失败** |
| `scripts/check_tms273_npc_dialogue.cjs` | PASS（`233/265 … 553 lines … 32 …every entry recomputed verbatim`） |
| `client/src/features/npc/dialogue.check.mjs` | PASS |
| `npm run check` | **38/40**（2 项＝既有失败） |
| `npm run typecheck`（`tsc --noEmit`） | exit 0 |
| `check_repository_layout.cjs` | PASS |
| `artifacts/refactor/frontend-deps.json` | 跑完已 `git checkout` 还原 |
