# 任务、NPC 内容与产物形状的跨会话约束细节（MEMORY.md 外移部分）

> 2026-09-17 建立（第三份外移文件）。`.workbuddy/memory/MEMORY.md` 是会话启动时注入的，有体积上限（超过会被截断、尾部丢失），因此把**任务 `infoex` 语义**、**NPC 对话**、**传送类 NPC** 与几条长铁律的细节移到这里，MEMORY.md 只留摘要与指针。
> 内容与原先 MEMORY.md 的对应条目一致，未改写结论；改动事实时两处一起改。
> 姊妹文件：`跨会话约束细节-管线内容与玩法.md`、`跨会话约束细节-图鉴与物品世界.md`。

## 1. 任务 `infoex` 语义（已核定，别再当「未核定」）

- `exVariable`＝计数器名字、`value`＝目标数。证据＝需求串 `#R<id>Ex<名>Ref<id>#` 的 token 与 `infoex` 交叉验证 **1090:5**；另 18 条是**引用别的任务**的变量。
- 少数条目原著把两子节点**写反**（`36319` value:"kill"/exVariable:"1"、`36350` value:"talk"/exVariable:"lord"）⇒ 运行时取**任一子节点**的保守并集，**不按字段名猜**。
- `dummy`＝剧情场景布尔位（26 条带需求串者需求文本**全是场景/地点**；74 条**无一**有 endscript；74 条中**无一条**同时缺 startscript/endscript/npc ⇒ 是**真闸门**）。
- `talk`＝对话步骤（36350 需求串「和#p2132001##k對話」）。
- `QuestData/*.json` **已全量解包（23404 文件）** ⇒ 旧记录「二进制解不开」的前提**作废**。
- `36317`/`36350` **不能忠实打开**（无 self 标记 / 无 endscript / 目标位置在 QuestDestination+fieldEnter+map 三处都查不到 / `q36317s` 与 NPC 1012100 脚本缺失，而本包**确实**随附 4529 个原版脚本）⇒ 维持阻塞、**不造替代**。
- 被丢掉的源字段：`conditionContent`（1048 文件带，源自己的人话条件如「返回據點」）本仓库**未导出**。

## 2. NPC 对话（阶段一 + 阶段二均已完成）

交付记录：`docs/plan/history/2026-09-17/`。

- 源台词**真的存在**——在 `Npc.wz/<id>.img/info/speak`（有序列表，值是 String 表键名）与 `String/Npc.json`（`n*`/`d*`/`s*` 文本）的**交叉引用**里。
- 导出 `shared/npc-dialogue.json`（**233/265** 模板、553 行；余 **32** 个是 `傳送門`/`警告牌` 这类物件型条目，**源里确实没台词**；`info/script` 的 121 个脚本名本包几乎无实体 ⇒ **不造替代**）。
- **占位没被删、只收窄成「源里没有说话内容」**（`placeholder_view`/`PLACEHOLDER_DIALOGUE`/协议 `dialog.source`/客户端 `is-placeholder` 都还在，文案已是「这个 NPC 在原文中没有对话内容。」）——**阶段一 §4 写的「阶段二删掉它们」是已作废的预言，别照着删**。
- 无脚本分支状态机＝`dialogue.rs::handle_scriptless_npc_talk` → `open_npc_lines`/`advance_npc_lines`，节点名 `npc-line:<i>[:menu]`（**复用 `npc.conversation`、不新增第二槽位**；`parse_line_node` 只认该前缀）。
- **有任务者先台词后菜单**（`LineStep::ContinueToMenu`）；一页一句、非末页 `kind:'next'`、中途 `end` 直接收掉（否则菜单关不掉）。
- 表由 `main.rs` 读入 → `.with_npc_dialogue()`，**读不到就硬失败**。
- 门禁 `scripts/check_tms273_npc_dialogue.cjs`（**独立重算源表** + 双向反向断言 + 接线检查，已进 `run-checks.mjs`）；导出插在 `generate_tms273_gameplay.py` 之后（该脚本第 959 行写 `items.json`，且它产出最终模板集合；`assemble_tms273` 只消费不改写）。
- **易混**：`shared/npc-dialogue-zh.json`（9-06、12 条、脚本对话简体**手稿**，`apply_dialogue_zh.py` 消费）**≠** `shared/npc-dialogue.json`（233 条**源台词表**）。
- 源台词是繁体，客户端 `i18n.ts::displayText`（OpenCC `tw→cn`，仅 `zh`）会转 ⇒ 简中合规；**en locale 下这批无译文**（不补＝不编造）。

## 3. 传送类 NPC（計程車等）已实装

交付记录：`docs/plan/history/2026-09-17/地图NPC传送类实装.md`。

- 病根**不在传送逻辑**（`DialogueView::Warp`/`warp_player`/客户端 `warp` 分支早就在），在 `scripts/generate_tms273_gameplay.py` **从设计上丢弃 `info/script`** ⇒ 模板 `script` 恒 `null`。
- 产物＝`shared/npc-scripts.json`（导出于 `export_tms273_npc_scripts.cjs`，`npcs.<id>` **就是** `DialogueScript`，产地另放 `provenance`）；服务端在**与 `template.script` 同一槽位**消费（`template.script.clone().or(source_script)`，**模板自带 DSL 优先、源脚本只补空槽**），`World::npc_scripts` + `main.rs` 硬失败加载 + 逐条 `validate()`。
- 实测 **129 声明 / 8 实体 / 1 转换（`1012000` 計程車）/ 128 拒绝**；**只转一种可证明的模式**（目的地字面量数组 + `!= map.getId()` + `askMenu` + 两句 `say` + `askYesNo` + `changeMap`，**五处必须同一数组**）。
- **目的地必须与 `shared/maps.json` 取交集**（`warp_player` 对目录外目标返 `false` ⇒ 玩家会收到与真实原因无关的「傳送未能保存」）；被排掉的记 `excluded`（計程車排了 `103000000`/`105000000`/`120000100`）。
- **菜单下标沿用源数组下标**（故留下 0/1/2/**4** 空档）。引擎扩展＝`Condition::map_is_not` + `MenuOption.cond`(`offered()`) + `DialogueContext.map_id`；**隐藏与不可选两条都要做**（只隐藏则旧客户端按 `index` 能选到源里从未提供的目的地，选中被拒回 `npc_step_invalid`）。
- 门禁 `scripts/check_tms273_npc_scripts.cjs`（6 组断言，已进 `run-checks.mjs` + Windows 清单）；验收 `server/src/npc_teleport_acceptance.rs` 5 条。
- **它复用 `npc_click_acceptance.rs` 的 `npd_click`/`npd_step`，而后者把玩家 id 写死成 `NPD_PLAYER`** ⇒ 夹具玩家 id 必须 `= NPD_PLAYER`，另起一个会让点击落在未加入的玩家上（`handle_npc_talk` 直接 `return`，表现为空白而非失败）。

## 4. `shared/*.json` 产物的形状必须与加载器的反序列化类型逐字对齐

2026-09-17 踩过：`shared/npc-scripts.json` 里脚本包在 `npcs.<id>.script` 下、而加载器是 `BTreeMap<String, DialogueScript>` ⇒ **`cargo check` 全绿但 3010 起不来**，报 `missing field 'start'`。

- **类型对不上不是运行期降级，是启动即失败**，且**只跑 cargo 查不出来**。
- 规矩：① 产物里「值是数据本身」，产地/溯源一律另放一个平行段（`provenance`），与 `npc-dialogue.json` 同构；② 验收要**直接反序列化发布产物**（不要自造夹具），它跑起来就等于「服务端能启动」；③ 门禁断言平行段与主段的 **id 集合一致** + 断言加载类型；④ 用「包回一层」做扰动验证两层都会失败。

## 5. 脚本门（pt:7/9/11）定路由要看 `Graph.json` 授权表

- 不能只看源邻接：源 `tm` 一律 `999999999`，`Graph.json` 的 `portalNum` 才是权威（`200000100.east00` 的授权是**七个码头**，港口通道不在其中）。
- **服务端写好的 P 路由必须同时把目标暴露进客户端目录**（`tms273_remaster.cjs::exposeScriptedGateRoutes`），否则 `world.ts:145` 只受理带 `targetMapId` 的门 ⇒ 玩家按 ↑ 发不出请求＝死代码。

## 6. 中文形制（服务端）

- 服务端玩家可见中文**一律简体**（物品名保留繁体，Store 层诊断串英文）。
- **例外：任务界面** —— `quest.rs` 里面向任务文本的字符串（`quest_map_label`/`quest_npc_label`/`quest_blocked_reason` 全部臂与「尚未開放：」前缀/`nextAction` 的「前往{}，與{}交談接取任務」等）**一律繁体**，因为它与 TMS273 源的繁体任务名/摘要/地图名同一窗口展示，且既有断言就钉着繁体串；**该文件的注释仍用简体**。别为了统一字形把这段改成简体。

## 7. 仓库运维

- **GitHub 单文件 100MB 硬限**：`references/tms273-data/maps.json`（152.60MB 派生导出）已脱离版本控制、只留工作区；新 clone 须从 `参考/` 重建（`import_tms273.py` + `export_tms273.cjs`）；守卫要 `git config core.hooksPath .githooks` 才生效。
