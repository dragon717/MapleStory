# 冒险笔记：骑宠页签 + 配置 ID 展示（TMS273）

日期：2026-09-19。用户需求单：「骑宠也记到 冒险笔记 新页签里；冒险笔记 也把配置id展示出来」。

协议 **24 → 25**（`NotebookSection` 增加 `mount`），内容版本沿用 **`tms273-32`**（未变），
目录版本 **`notebook-catalog-1` → `notebook-catalog-2`**。前后端必须一起换。

## 1. 关键决定：骑宠是独立表 + 独立页签，不是装备页的一格

- 骑宠（`Character/TamingMob`，`shared/mounts.json`，935 件）**不在物品树里**：源把它们标成
  `notSale:1 / only:1`，不进掉落、不进商店。而 `shared/items.json` 同时承担「当前可获得」的
  **分母**角色（见 `server/src/inventory.rs::shipped_mounts`）——把 935 件骑宠塞进 `items`，
  等于把分母改成 3559，物品页的「已获得 / 总数」立刻失真。
- 因此目录里新增第二张定义表 `mounts` + 分区 `sections.mount`，客户端新增第五个页签
  `mount`。门禁反向断言「骑宠不得混进物品定义表」。
- 骑宠页**没有「当前可获得」这一档**：源没有一条开放的获取途径，按它过滤会得到空页，
  读起来像「本版本没有坐骑」。浏览方式是 `MOUNT_MODES = ['all','obtained','missing']`，
  默认 `all`；服务端 `item_rows` 的骑宠分支基集合就是整张坐骑表，分母 = 935。

## 2. 改动清单

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 目录生成 | `scripts/generate_tms273_notebook_catalog.cjs` | `CATALOG_VERSION` 升 2；`buildCatalog` 收 `mounts`；产出 `mountDefinitions` / `sections.mount` / `mountCount` |
| 装配 | `scripts/assemble_tms273.cjs` | 传 `shared/mounts.json`；客户端投影 `notebook.json` 增加 `mounts` 段（只带 `tamingMob / reqLevel / availability`） |
| 协议 | `shared/protocol.ts`、`server/src/protocol.rs` | `PROTOCOL_VERSION` 25；`NotebookSection` 加 `'mount'` |
| 服务端查询 | `server/src/notebook.rs` | `catalog_section` 派 `Mount`；`MOUNT_BLOCKED` 文案；`item_rows` 骑宠分支（基集合=整表，分母=935） |
| 服务端事实层 | `server/src/auth/notebook.rs` | `MOUNT_SECTION`；`CatalogFile.mounts` / `CatalogMount`；`availability()` 合并查两张表；`is_mount()`；`classify_item` 让发放的骑宠会留档；`mount_count()` |
| 客户端 | `features/notebook/{view-model,view,directory,item-section,monster-section,section-context,style}.ts`、`app/i18n.ts` | 第五页签；`MOUNT_MODES`；`NotebookMountDefinition`；配置 ID 标签；骑宠坐骑档；i18n 四个新 key |
| 门禁 | `scripts/check_tms273_notebook.cjs`、`scripts/check_tms273_notebook_ui.mjs`、`view-model.check.mjs`、`view.check.mjs` | 分区覆盖改为「物品 ∪ 骑宠」；骑宠定义/可获得性/投影断言；浏览方式断言；UI 样张加骑宠页与配置 ID 命中测试 |

## 3. 配置 ID 展示

- **物品格**：左上角等宽小标 `#<itemId>`（`.notebook-slot-id`，绝对定位 `left/top: 7px`，
  深底浅字；原先「本版本未开放」的牌子因此下移到 `bottom: 25px`，避免叠字）。
- **详情面板**：先报配置 ID（怪物=模板 id，物品=item id）；物品且是骑宠时再报一行
  **坐骑档**（`directory.mounts[itemId].tamingMob`，源未提供时报「源未提供」）。
- **怪物格**：`title` / `aria-label` 追加 `#<monsterTemplateId>`，不改可见排版。

`.notebook-slot-id` 初版漏写 `position: absolute` → 被同层的绝对定位槽位牌盖住（截图里
看不见），UI 门禁因此补了 `elementFromPoint` 命中测试：标签必须落在最上层。

## 4. 验证

- `cargo test` **576 passed**（基线 575，新增骑宠页/分类/留档用例）。
- `tsc --noEmit` 0 错；`i18n.check.ts` 通过。
- 客户端离线：`view-model.check.mjs`、`view.check.mjs` 通过（页签 4→5，骑宠页默认 `all`）。
- UI 几何/可读性：`check_tms273_notebook_ui.mjs` 通过（配置 ID 标签对比度 10.87，命中测试
  在牌子之上），四尺寸样张落 `evidence/2026-09-19/notebook-ui/`。
- 目录门禁：`check_tms273_notebook.cjs` 的**骑宠部分与其余全部断言通过**
  （`itemDefinitions 2624` + `mountDefinitions 935`）。

## 5. 未修（如实登记，与本次改动无关）

### 5.1 目录门禁在奖励块红灯：源树漂移

`check_tms273_notebook.cjs` 仍在第 271 行失败：6 个收藏奖励物品在目录里声明
`definitionStatus: json-present`，但源 JSON 文件已不在位——

- 5 条指向 `Item/Consume/0243 2/*.json`（`0243 2` 是 iCloud 冲突副本目录，已被清理）：
  `2434929 / 2434930 / 2434931 / 2434958 / 2434959`
- 1 条路径规范但文件同样缺失：`2437618`（`Item/Consume/0243/02437618.json`）

**这不是本轮引入的**：`git show HEAD:shared/notebook-catalog.json` 的奖励块与本轮 byte-identical
（`rewardItems` / `items` / `excluded` / `monsterEntries` 全部相同，本轮只动了
`catalogVersion`、`sections` 与新增 `mounts`），而那些源文件在磁盘上早就没了。

影响面不止这 6 条：`shared/items.json`（同样未改动）里有 **62** 条物品的 `source` 指向
`Item/Consume/0NNN 2/*.json` 这类已消失的冲突副本目录——其中 **47** 条在规范目录里有同样的
文件（只需改指路径），**6** 条只在 `手工服务端/tms273/WZ_JSON_TW` 那棵提取树里，
**9** 条两棵树都没有（`2048701, 2048702, 2103000, 2120000, 2430813, 2430819, 2434958,
2434959, 4031993`）。修它要重跑物品与目录生成，会改动物品分母与数量，**需要单独决策**：
是接受这 9 条无源定义（从目录里剔除），还是从另一棵提取树回灌。

### 5.2 其余既有失败项

`run-checks.mjs` 里与本次无关的预存红灯：`check_tms273_npc_dialogue.cjs`（npc 9010000
台词重算失败）、`check_tms273_player_status.cjs`（MobSkill 124 源文件缺失）、
`check_tms273_desktop_package.cjs`（icons/32x32.png 缺失）、
`check_repository_layout.cjs`（evidence/INDEX.md 断链）、`update-service.check.ts`、
`build-release.check.cjs`（本机 `ps` 受限卡在 activate）。本轮未动。

## 6. 待用户加载实玩

协议 24→25 与内容 `tms273-32` 需经 `启动3010.command` 统一加载后实玩：

- [ ] 冒险笔记窗口出现第五个页签「骑宠」，点开列出 935 件，默认「全部」。
- [ ] 物品格左上角能看到 `#配置ID`（不被「本版本未开放」牌子压住）；骑宠详情额外报坐骑档。
- [ ] 骑宠页浏览方式只有「全部 / 已获得 / 未获得」；用 GM 发放一件骑宠后该格转为已获得。
