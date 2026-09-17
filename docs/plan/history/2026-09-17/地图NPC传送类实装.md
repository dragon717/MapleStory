# 地图 NPC 传送类实装：計程車等（2026-09-17）

> 用户需求单：「传送类型的 npc，如计程车等，需要实装，根因修复。」
> 本轮是「地图 NPC 点击对话」阶段一／阶段二的**续作**：那两阶段解决了「点了没反应」与
> 「说什么」，本轮解决「说了之后什么都不发生」——**传送类 NPC 只是说一句话，不做它该做的事**。

## 1. 范围与结论

| 项 | 结论 |
| --- | --- |
| 病 | 点击 **維多利亞計程車（模板 `1012000`）** 只说一句出场白，**没有菜单、不换图** |
| 根因 | 不在传送逻辑（`DialogueView::Warp`、`warp_player()`、客户端 `warp` 分支**早就在**），在**内容**：`scripts/generate_tms273_gameplay.py` 从设计上不转换 `Npc.wz/<id>.img/info/script`，模板 `script` 恒为 `null`。全 198 图里**没有任何一条** warp 动作（实测 0 条） |
| 修法 | 新增 `scripts/export_tms273_npc_scripts.cjs` → `shared/npc-scripts.json`，把源包 `script/npc/*.js` 里**可证明的一种模式**转成同一套对话 DSL，服务端在**与 `template.script` 同一个槽位**消费 |
| 引擎扩展 | 最小必要：`Condition::map_is_not` + `MenuOption.cond` + `DialogueContext.map_id`（源里的 `if (taxiMaps[i] != map.getId())`） |
| 实测 | 129 个模板声明了 `info/script`；8 个在包内找到实体；**1 个转换成功**（計程車）；128 个拒绝（121 缺实体／5 模式不支持／2 目的地未装配） |
| 客户端 | **零改动**（`warp` 消息与 `kind:'simple'` 菜单列表都是既有渲染路径） |
| 装配数据 | 协议 **24** / 内容 **`tms273-31`** / **198 图**零改动（纯增量表 + 引擎可选字段） |

**为什么不写 JS 解释器**：源脚本是任意 JS。猜测出来的对话比没有对话更糟——玩家会被传到一个源里从未提供的地方。
只转换能逐字引用出来的那一种模式，转不了的一律拒绝并写明原因。

## 2. 修掉的两个 bug（第二个是本轮自己写出来的）

### 2.1 病本身：`info/script` 被上游丢弃

`scripts/generate_tms273_gameplay.py` 的 `incomplete` 段明写：

> TMS273 NPC dialogue/script references are not converted

于是即使源脚本实体就躺在包里（`参考/273/TMS273少爷一键端/TMS273/script/npc/victoria_taxi.js`），
运行时看到的仍然只是 `template.script = null`。**这一层不缺引擎能力，缺的是接线。**

### 2.2 形状契约 bug（**启动即失败**级别，必须记）

产物初版把脚本包了一层：`npcs.<id>.script`。而加载器 `server/src/main.rs` 读的是
`BTreeMap<String, npc::DialogueScript>`——**形状不匹配**。这是 `cargo check` **查不出来**的：
类型没错，错的是运行时 JSON。表现是 3010 **起不来**，报 `missing field 'start'`。

修法：`npcs.<id>` 的值**就是** `DialogueScript`（与姊妹表 `npc-dialogue.json` 的「值是数据本身」同构），
产地信息（源脚本名、被排掉的目的地）移到独立的 `provenance` 段。

**双层防线（都在本轮补齐）**：

* `scripts/check_tms273_npc_scripts.cjs` 断言 `provenance` 与 `npcs` 的 **id 集合一致**，并断言
  `main.rs` 的加载类型仍是 `BTreeMap<String, npc::DialogueScript>`；
* `server/src/npc_teleport_acceptance.rs` **直接反序列化发布产物**（不是自造的夹具）——
  它跑起来就等于「服务端能启动」。

已用扰动验证：把 `npcs` 重新包一层 ⇒ 门禁报 `npc 1012000 的 start 节点不存在`、
验收报 `missing field 'start'`，**两边都挡住**。

## 3. 数据管线

### 3.1 导出侧：`scripts/export_tms273_npc_scripts.cjs`

源：`shared/gameplay.json`（已摆放模板）+ `参考/.../Npc/<id>.json` 的 `info/script` 声明 +
`参考/.../script/npc/<name>.js` 实体 + `shared/maps.json` + 同版 `String/Npc.json` / `String/Map.json`。

只认这一种模式，每一环都必须**指向同一个目的地数组**（东拼西凑会把 A 的名单配到 B 的确认句上）：

```
let taxiMaps = [100000000, 101000000, …];   // 字面量数组
if (taxiMaps[i] != map.getId())             // 隐藏玩家脚下那张图
prompt += "…" + i + "…" + taxiMaps[i] + "…" // 选项文案 #L<i>##m<id>##l
askMenu(prompt)
say(出场白) / say(拒绝句)                    // 两句
askYesNo("…" + taxiMaps[….] + "…")          // 确认句，点名目的地
changeMap(taxiMaps[…])
```

转换结果（計程車）：

| 节点 | 内容 |
| --- | --- |
| `greet` | 源出场白逐字，`kind:'next'` → `pick` |
| `pick` | `menu`，源 prompt 逐字；4 项 = 源数组下标 **0/1/2/4** |
| `confirm-<i>` | 源确认句（`#m<id>#` 已按同版表解析成地图名），`yes → go-<i>`、`no → decline` |
| `go-<i>` | `act { kind:"warp", mapId }` |
| `decline` | 源拒绝句，`kind:'ok'` |

四个已装配目的地：**100000000 弓箭手村 / 101000000 魔法森林 / 102000000 勇士之村 / 104000000 維多利亞港**；
每项带 `cond: { mapIsNot: <id> }`（源里那条 `!=` 守卫）。菜单下标**沿用源数组下标**，
所以被排掉的 `103000000 墮落城市` 会留下编号空档（0/1/2/**4**），**与源行为一致**。

### 3.2 为什么目的地要与目录取交集

`portals.rs::warp_player` 对不在 `self.maps` 的目标返回 `false`，玩家会收到
**「傳送未能保存，請稍後重試。」**——一句与真实原因（这张图没装配）毫无关系的提示。
所以照抄源脚本会把三个未装配的图也列进菜单，玩家点了以后收到误导性报错。

源計程車列 7 个目的地，装配了 4 个，**被排掉的 3 个原样记进 `excluded`**
（`103000000 墮落城市` / `105000000 奇幻村` / `120000100 上層走廊`，原因 `not-rendered`）。
装配新图后重跑本脚本，它们会自己回来。

### 3.3 装配链位置

`scripts/build_tms273.cjs` 在 `export_tms273_npc_dialogue.cjs` **之后**跑本导出；
`scripts/check_windows_resources.cjs` 的 `REQUIRED_JSON` 加入 `shared/npc-scripts.json`
（**不加则 Windows 包里的服务端读不到它而启动失败**——与 §2.2 同一类失败）。

## 4. 引擎扩展（逐文件）

| 文件 | 改动 |
| --- | --- |
| `server/src/npc.rs` | `Condition` 新增 `map_is_not: Option<String>`（`matches` 尾部：站在该图即 false）；`MenuOption` 新增 `cond: Option<Condition>` 与 `fn offered(&self, ctx)`；`Menu` 解析时**过滤**掉不 offered 的项，`advance` 选中时**也校验** offered |
| `server/src/dialogue.rs` | `let Some(script) = template.script.clone().or(source_script)`；构造 `DialogueContext` 时补 `map_id`（取玩家当前图） |
| `server/src/world.rs` | `World` 新增 `npc_scripts: BTreeMap<String, DialogueScript>` + `with_npc_scripts(...)` |
| `server/src/main.rs` | 加载 `shared/npc-scripts.json`（**硬失败**），逐条 `script.validate(template_id)`（与 `gameplay.rs` 对 `template.script` 同口径，悬空跳转在启动时挡下），链式 `.with_npc_scripts(...)` |

### 4.1 为什么要「隐藏」和「不可选」两条都做

只隐藏不过滤选择，等于**旧客户端能按 `index` 直接选中被隐藏的项**，换图到源里从未提供的目的地。
所以 `offered()` 在两处都生效：列表（看不见）与选择（选不中，返回
`npc_step_invalid`「该对话选项已失效，请重新与 NPC 交谈。」）。

### 4.2 优先级：模板自带 DSL 优先

`template.script.clone().or(source_script)`——**模板自带的 DSL 优先**（那是本项目已核定的内容，
且 `validate()` 已在加载时校验过）。源脚本只补**空槽**。

## 5. 门禁与验收

### 5.1 新增仓库级门禁 `scripts/check_tms273_npc_scripts.cjs`（6 组断言）

1. **结构**：`npcs` 的每个值**就是** `DialogueScript`（与加载器形状对齐）、`provenance` 与 `npcs` **一一对应**、
   `start` 指向存在节点、所有跳转目标都在表内；
2. **逐条重算**：不共用导出脚本的代码，按同一套规则从 `script/npc/*.js` 重算 出场白／prompt／确认句／拒绝句／
   目的地清单，逐字比对；
3. **越界断言**（主干）：产物里**每一个** `act.mapId` 与 `cond.mapIsNot` 都必须在 `shared/maps.json` 里；
4. **反向断言**：源目的地里确实有目录外的（否则取交集是死代码）、也有目录内的（否则整条转换失效）；
   `excluded` 必须**恰好**是差集，且被排掉的不得又做成菜单项；
5. **`unconverted` 如实登记**：与 `npcs` 不相交，三类原因都要有实例，每条都写明 `source`/`reason`/`detail`；
6. **接线检查**：`main.rs` 读它并把类型钉住、`dialogue.rs` 在同一槽位读、`build_tms273.cjs` 会产出它、
   Windows 清单带它、本门禁已进 `run-checks.mjs`。

### 5.2 服务端验收 `server/src/npc_teleport_acceptance.rs`（5 条）

| 用例 | 钉住的事 |
| --- | --- |
| `source_scripts_fill_only_empty_slots` | 表真的进了 `World::npc_scripts`；**只补空槽**（源脚本表里的 id 在 gameplay 里必须 `script.is_none()`，否则优先级会静默吃掉一边） |
| `taxi_menu_lists_rendered_towns_and_hides_the_current_one` | 站弓箭手村时菜单**只列 3 项**（下标 1/2/4）、不列脚下这张图；按 `index 0` 直接选**被拒**且**不换图** |
| `taxi_confirm_yes_warps_and_no_stays` | 确认句点名目的地；「否」不换图；「是」真的换到 `101000000` 且**落点在图的范围内** |
| `every_shipped_warp_target_is_a_loaded_map` | 产物里每个地图引用都在 198 图目录里；且**至少有一条 warp**（否则说明根因没修上）、菜单路径也被查到 |
| `unconverted_teleport_npcs_never_warp` | `2010011 蕾雅`／`9071003 怪物公園公車` 目的地未装配 ⇒ 拒绝转换；把对话一路推完**绝不凭空换图** |

### 5.3 扰动验证（确认断言不是恒真）

| 扰动 | 结果 |
| --- | --- |
| 去掉菜单隐藏条件（`.filter(|option| option.offered(ctx))` → 恒真） | `taxi_menu_lists…` FAILED，打印出真实列表 `[(0,"弓箭手村"),(1,…),(2,…),(4,…)]` |
| 去掉选中侧的 offered 校验 | `taxi_menu_lists…` FAILED：`按 index 选中被隐藏的选项必须被拒绝…实际：Some("dialog")` |
| 把 `npcs` 重新包一层（形状回归） | 门禁 + 验收**双层**均 FAILED |
| 改换图目标 / 删 `excluded` / 删菜单项 / 去地图条件 / 改菜单文案 | 门禁全部拒绝（见 §5.1 各组的既往扰动记录） |

## 6. 实测数字（时点见 §8）

* 导出：129 声明 / 8 实体 / **1 转换** / 128 拒绝（`script-entity-missing` 121、
  `unsupported-pattern` 5、`destination-not-rendered` 2）；产物**幂等**（重跑逐字节相同）。
* cargo 全量 **511 过 / 0 失败**（基线 **505**，净增 **6** ＝ 验收 5 条 + `npc.rs` 引擎单测 1 条）。
* 非测试构建 `cargo check` **0 告警**；测试构建 **49 条告警 / 47 条可自动修复**，
  与 HEAD 实测基线**逐条相同**，**本轮改动的文件贡献 0 条**。
* `tsc --noEmit` **0**；`npm run check` **39/41**（2 项＝既有失败：
  `src/scenes/layer-animation.check.ts` 的 Node ESM 无扩展名导入、`build-release.check.cjs` 的沙箱无 `ps`）；
  新增门禁 `check_tms273_npc_scripts.cjs` **PASS**。
* `npm run check` 会改写 `artifacts/refactor/frontend-deps.json`，已 `git checkout --` **还原**。

## 7. 待你实玩验收（统一加载 3010 后）

1. 走到**弓箭手村（100000000）**等四张有計程車的图，点計程車：先说出场白，翻页后**看见菜单**——
   应只有**另外三个**村庄（当前所在那个**不出现**）；
2. 选「魔法森林」→ 确认句会**点名目的地** → 选「是」：**真的换到魔法森林**，落点在可行走范围内；
3. 选「否」：回到拒绝句，**原地不动**；
4. 重开对话，选任意目的地，确认换图后**没有**「傳送未能保存，請稍後重試。」这类报错；
5. 换图后 NPC 名牌高亮等既有观感不受影响。
6. 次元之鏡／怪物公園公車／蕾雅**仍然只是说话**（目的地未装配，见 §3.2 与 §8），不是漏配。

> 想要那三个被排掉的目的地也进来（`103000000 墮落城市` 等），先在对应图上做装配，
> 再重跑 `node scripts/build_tms273.cjs`（或至少 `export_tms273_npc_scripts.cjs`）。

## 8. 未做 / 边界（如实登记）

* **只接了 1 个 NPC**。`info/script` 声明 129 个，包内只有 8 个有实体，其中 **5 个是模式不支持**
  （不是計程車那种「列表 + 菜单 + 确认 + 换图」的形状，例如 `unityPortal` 用 `enterUnityPortal` 一类的
  引擎 API），**2 个目的地未装配**（`guild_move → 200000301 英雄公殿`、`mParkShuttle → 951000000 怪物公園`），
  **121 个连脚本实体都不在包里**（源 `info/script` 的宣告与随附脚本不完整，与阶段二同一结论）。
  **不造替代、不补默认值**。
* **`103000000` / `105000000` / `120000100` 三个源目的地没装配** ⇒ 計程車目前只到四个村庄。
  已如实记进 `excluded`，门禁反向断言钉住「差集恰好等于 excluded」。
* **en locale 下没有译文**：源脚本文案是繁体中文，客户端 `i18n.ts::displayText` 只在 `zh` 下做
  tw→cn 转换（`dialogue.ts:386` 渲染 `displayText(sanitize(dialog.text))`，与阶段二台词同一路径）。
  英文环境会看到繁体原文——**不补＝不编造**。
* **没有为「传送」新增任何协议字段**：`warp` 早已在协议里，客户端 `warp` 分支早已实现。
  本轮是内容 + 接线 + 引擎的一点点能力，**协议 24 不动**。
* 沙箱内**无法代跑统一启动链**（`启动3010.command` 由你运行），在线服务、数据库与陪测 bot 本轮**未动**。

## 9. 时点说明

* 本轮改动集（均未提交）：`server/src/{npc.rs,dialogue.rs,world.rs,main.rs,world_tests.rs}`（改）、
  `server/src/npc_teleport_acceptance.rs`（新）、
  `scripts/{export_tms273_npc_scripts.cjs,check_tms273_npc_scripts.cjs}`（新）、
  `scripts/{build_tms273.cjs,check_windows_resources.cjs}`（改）、
  `shared/npc-scripts.json`（新产物）、`client/scripts/run-checks.mjs`（改）。
* 跑全量 `cargo test` 前已 `git status` + `stat` 核对：未跟踪新文件**全部属于本轮**，
  没有并行会话正在写 `server/src`（2026-09-17 早前曾出现，见阶段二记录 §9）。
* 全量测试时点：**11:55 前后**（511/0）。若之后有并行会话改动 `server/src`，以各自时点为准。
