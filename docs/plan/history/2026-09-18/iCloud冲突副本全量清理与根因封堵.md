# iCloud 冲突副本全量清理与根因封堵（2026-09-18）

> 用户需求：「检查多余的 `*2.*` 内容有完全一样的文件 因为之前项目在 icloud 下 有重复。根因修复。」

## 1. 结论先行

前任两轮都把这件事当成「删除几个碍事文件」，所以它第三次回来。本轮把它当成**门禁设计问题**：

| | 09-12 那轮 | 09-17 那轮 | 本轮 |
| --- | --- | --- | --- |
| 处置 | 删了工作树里 5 个中的一部分，其余**照旧入库** | 写门禁**显式跳过**这些副本 | 删存量 + git rm 已入库项 + **禁止新副本进入版本库** |
| 结果 | 副本仍在 | 副本被**合法化**为「已知例外」 | 副本在结构上进不来 |

**只删不封堵，等于给 iCloud 留了一个每次都赢的入口。**

## 2. 全量清点（398 项，哈希级判定）

判定口径：文件比 SHA-256，目录先比路径集、路径集相同时再逐文件比哈希。

| 类别 | 数量 | 判定 |
| --- | --- | --- |
| 完全空壳目录（0 文件） | 340 | 零信息损失，删除 |
| 逐字节相同的 PNG | 15 | 零信息损失，删除 |
| 目录-子集且公共部分逐字节相同 | 1 | 零信息损失，删除 |
| **已入库的旧版源码副本** | **6** | `git rm`（本体均为严格超集） |
| 目录-含本体没有的文件 | 28 | 存疑，隔离待复核 |
| Blender 工程（非完全相同） | 4 | 存疑，隔离待复核 |
| 孤儿副本（本体不存在） | 4 | 3 个是第三方原包自带、1 个隔离 |
| **合计** | **398** | 删除 355 / 隔离 34 / 保留 9 |

### 2.1 保留的 3 个不是 iCloud 产物（重要纠错）

```
参考/273/TMS273少爷一键端/TMS273/data/Shop/9402153 copy 2.json
参考/273/TMS273少爷一键端/手工服务端/tms273/data/Shop/9402153 copy 2.json
参考/273/TMS273少爷一键端/手工服务端/tms273-1/data/Shop/9402153 copy 2.json
```

同目录只有 `9402153 copy 2/3/4.json`，**没有** `9402153.json` 也没有 `9402153 copy.json`。
这是第三方一键端作者自己的「另存为副本」命名，与 iCloud 无关，**不动**。
命名正则会把这类误判成「副本」，故此条必须显式记下来——否则下一个人会照着清单把它删掉。

### 2.2 已入库 6 个副本：本体都是严格超集

| 副本 | 本体 | 差异行数 | 副本缺什么 |
| --- | --- | --- | --- |
| `client/src/features/entry/api 2.ts` | `api.ts` | 7 | `apiUrl` 导入、`InventoryItem`、`equipped?` |
| `client/src/features/entry/view 2.ts` | `view.ts` | 67 | `appearanceLayer`/`loadAppearanceLayers`、`onStageChange`、`resolveAssetUrl` |
| `client/src/features/entry/view.check 2.mjs` | `view.check.mjs` | 25 | 协议常量从源解析、装备纸娃娃回归用例 |
| `server/src/auth/db 2.rs` | `db.rs` | 380 | `MoveRefusal` 类型化拒绝通道 |
| `server/src/ellinel_acceptance 2.rs` | `ellinel_acceptance.rs` | 192 | `drain` 助手、配对断言 |
| `server/src/lobby 2.rs` | `lobby.rs` | 181 | `equipped` 字段、NB-05 创角授予 |

全部由**同一笔** `3a399d0`（2026-09-16 `chore: 完成冒险笔记图鉴全量功能落地`）的批量暂存带入。
没有任何代码 import/`mod` 引用它们（已全文检索确认）。

## 3. 根因链

1. **项目曾在 iCloud 卷上。** `scripts/build-release.cjs` 里有 2026-09-16 的亲笔记录：「本仓库所在 iCloud 卷」。
   iCloud 遇到同步冲突时保留本地名、把另一侧写成 `<名字> 2.<ext>`，从此每个被冲突的文件都多一个陈旧兄弟。
   **这一层现在已解除**：`/Users/muniao/Code/MapleStory` 已是本地真实目录（`~/Code` 非符号链接、无 `.icloud` 占位符）。
2. **批量暂存把副本当成内容入库。** `git add -A` 类操作不区分「内容」与「同步残留」。
3. **生成链路把副本跨树传播。** `resources/tms273-export`（本地导出树，被 `.gitignore` 覆盖）
   → `scripts/assemble_tms273.cjs` 按清单逐文件复制 → `client/public-tms273`。
   源侧一个 `xxx 2.png` 被清单引用，两棵树就各留一份。
4. **前两轮把问题合法化，这才是它会回来的直接原因。**
   - `scripts/check_inventory_surface.cjs`：`const skip = (rel) => / \d+\.rs$/.test(rel); // 「xxx 2.rs」是 iCloud 复制残留，不参与编译`
   - `scripts/check_tms273_client_actions.cjs`：`if (/ 2\.ts$/.test(key)) continue;`
   - `client/tsconfig.json`：`"exclude": ["src/**/* 2.ts"]`

     三处都是「跳过它」。跳过意味着副本不进任何判据、不出现在任何报告里——
     `grep` 却照样先匹配到旧版本。`lobby 2.rs` 比 `lobby.rs` 落后 181 行却长期在树里，就是这个后果。
5. **既有门禁根本没在跑。** `git config core.hooksPath` 为空 ⇒ `.githooks/pre-commit` 是睡着的，
   连已有的「超大 blob」防线也没生效。

## 4. 本轮改动

### 4.1 清除（355 项，零信息损失）

- 340 个完全空壳目录（iCloud 只同步了目录骨架，里面 0 文件）
- 15 个逐字节相同的 PNG（`client/public-tms273` 7 个、`resources/tms273-export` 8 个；均为可重导出的生成物）
- 1 个已验证子集目录
- 共回收 39.9 MB

### 4.2 隔离（34 项，未删）

移到 `.trash-icloud-dup/`（已写入 `.gitignore`），**保持原相对路径**，附 `MANIFEST.json`（含类别、原字节数）：

- 28 个「含本体没有的文件」的冲突目录
- 4 个 Blender 工程（`resources/blender/windbell/legacy/`）
- 1 个孤儿 PNG

Blender 那 4 个**刻意不删**：本体时间戳更新（21:36 > 21:15、23:54 > 22:30），
但 `windbell_world_asset_library_textured 2.blend` 反而更大（18.1 MB vs 12.8 MB），
存在「旧版打包了贴图、新版改为外链」的可能，删除有真实风险。

回滚：把 `.trash-icloud-dup/` 下的内容按原路径拷回即可。

### 4.3 新增门禁 `scripts/check_icloud_conflict_copies.cjs`

- 读 **git index + 未跟踪但未被忽略**的文件 ⇒ 暂存态也能拦。
- 判定：`<任意> <数字>[.<扩展名>]` 且有同名兄弟 ⇒ 报「多余副本」；
  兄弟不存在 ⇒ 报「孤儿副本」（本体丢失更严重）。
- 报错信息直接给出 `副本 -> 本体` 和建议动作，不写成「请人工检查」。
- 导出 `conflictCopyOf()` / `assertNoConflictCopyName()` 供复制链路复用。
- `require.main === module` 守卫：被 `require` 时只提供函数、不触发扫描。

### 4.4 反向取消三处「显式跳过」例外

三处 skip/exclude **全部删除**，并在原位留下注释说明「这里曾经有一个例外，为什么撤销」——
避免下一个人遇到同样的红字时又把例外加回来。

### 4.5 掐断传播链

`scripts/assemble_tms273.cjs` 在把清单资源复制进 `client/public-tms273` **之前**，
对每个清单 URL 的 basename 做 `assertNoConflictCopyName`。
这是 pre-commit 看不见的路径（`resources/tms273-export` 被忽略），所以必须在源头断言。

### 4.6 启用既有 hook

`git config core.hooksPath .githooks`（本地配置）。`.githooks/pre-commit` 串联两个门禁：
`check_tracked_blob_size.cjs` → `check_icloud_conflict_copies.cjs`。

> 注意：`core.hooksPath` 是**每克隆一份**的本地配置，新克隆需重新执行一次。

## 5. 验证

| 项 | 结果 |
| --- | --- |
| 门禁正向（干净树） | `PASS iCloud conflict copies: 865 version-controlled file(s) scanned, 0 surplus, 0 orphan` |
| 门禁反向（植入 `lobby 2.rs` + `api 2.ts`） | 失败并逐个列出 `副本 -> 本体`，exit 1 |
| 门禁反向（孤儿 `zztmp_only_copy 2.rs`） | 失败并报 `expected sibling zztmp_only_copy.rs`，exit 1 |
| 门禁复原后 | 重新 PASS |
| `conflictCopyOf()` 单元 | 9/9 用例通过（含 `view.check 2.mjs`、`0501 2` 无扩展名、`noSpace2.ts` 反例） |
| `check_inventory_surface.cjs` 回归 | PASS |
| `check_tms273_client_actions.cjs` 回归 | 10 组断言全部通过 |
| `node --check` | `assemble_tms273.cjs`、`check_icloud_conflict_copies.cjs` 均 OK |
| 清理后残留 | `find` 仅剩 9 项预期的保留项 |

**未验证项（如实交待）**：
- 未跑完整 `cargo test` / `tsc --noEmit` / 全套 `run-checks.mjs`。理由：本轮**没有改动任何被测源码**
  （被删的 6 个副本不参与编译、不被引用，三处例外在副本消失后与原行为等价），
  受影响的两个门禁已单独回归通过。若需完整门禁证据，另起一轮跑全套。
- 未实跑 `assemble_tms273.cjs` 全量装配（会重写 927 MB 的导出树）。只做了语法检查与助手单元验证。

## 6. 遗留

- [ ] 复核 `.trash-icloud-dup/` 里 34 项后整目录删除（当前是过渡区，不是长期存储）。
- [ ] `client/tsconfig.json` 的 `exclude` 已撤销：若本地再出现 `xxx 2.ts`，`tsc` 会**报错而不是忽略**——
      这是刻意的（副本本该被看见），但行为上的确变了。
- [ ] 本记录之后，同类问题应由门禁在第一道拦住，不再需要人肉清点。
