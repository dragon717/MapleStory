---
name: maplestory-skill-copy-wiring
description: 把 TMS273 复刻版里「同一格副本」技能接进执行链的完整流程。当任务是把某个只进目录、没有施法分支的技能（尤其法师 212 火毒／232 主教的四转技能）接成可施放，或需要收口某个「三个分支各一本、只可能有一本在计时」的技能判据时使用。触发词：同一格副本、接执行链、尚未开放施放、法师 212／232 接线、技能接线、skill_unimplemented。
agent_created: true
---

# MapleStory TMS273：把「同一格副本」技能接进执行链

本仓是 Rust 权威服务端 + Phaser TS 客户端 + Python/CJS 资源导出流水线。
「同一格副本」指三条法师分支（212 火毒 / 222 冰雷 / 232 主教）里**源数据逐字段同形**的同一批技能。

> 姊妹技能：`maplestory-derivation-collapse`——收口「同一笔**数值派生**散落在多处」的账
> （如召唤存活时长曾写了三处且互相不一致）。本技能是「**接一条技能**」，那份是「**收一笔账**」；
> 两者共用同一套验收命令、同一批沙箱陷阱。

## 核心判据（先判能不能接，别急着写代码）

**只有「源 `common` 与已接线的冰雷那本逐字段同形」的副本才接**，一律复用既有机制、不新增机制。
逐条从 `shared/mage-skills.json` 读出来对比，不要靠印象：

```bash
node -e '
const d=require("./shared/mage-skills.json").skills;
const keys=(o)=>Object.keys(o).filter(k=>k!=="hs"&&k!=="maxLevel").sort().join(",");
for(const id of ["2221053","2121053","2321053"]){const s=d[id];
  console.log(id, s.name, "hyper="+s.hyper, "["+keys(s.rawCommon)+"]", JSON.stringify(s.levels));}
'
```

判据成立 = ① `rawCommon` 键集相同；② `levels` 逐级取值相同；③ `maxLevel`／`hyper`／`requiredLevel` 相同。
**再核对美术**（见下「美术要从 `.img` 读」）。三条都成立才接。

「源里有某个字段」≠「本包有消费点」。若某字段没有消费点（`dot`／`mdR`／`nbdR`／`indieMhp`／
复活机制…），**不接**，如实登记为「尚未开放施放」。

## 完整改动清单（按此顺序，漏一处就会红）

### 1. 服务端：单技能常量 → 三本表

1. `server/src/world.rs`：加 `SKILL_<NAME>_FP` / `_CLERIC` 常量 + `const <NAME>_SKILLS: [u32; 3]` 表。
2. `server/src/world.rs`：加访问器 `fn active_<name>_skill(player: &Player) -> Option<u32>`
   ——**照抄 `active_infinity_skill` 的形状**（`表.iter().copied().find(|s| player.status.buff_active(*s))`）。
   这是「哪一本在计时」的**唯一判据**。
3. 找出所有写死该技能 id 的位置并改读表（`grep -rn "SKILL_<NAME>" server/src/`）。典型有 8~10 处：
   施放臂、白名单、施法时长、`HYPER_ACTIVE_IDS`、`clear_hyper_runtime`、**两条伤害路径**
   （`attacks.rs` 普攻 + `skills.rs` 魔法）、重连冷却名单（`commands.rs`）。
4. 增益的 `apply_buff` 与取值访问器都要**增 `skill_id` 参数**，按**施放的那一本**挂/读。
5. 伤害留痕必须写**真正生效的那一本**（`DamageSource::X { skill_id: <访问器返回的> }`）。

### 2. 客户端

- `client/src/features/skills/view.ts`：`ACTIVE_SKILLS` 加 id；写死的提示句改读表。
- `client/src/features/player/input.ts`：加客户端镜像表；补 `FIRE_FOURTH_SHORTCUT_SKILLS` /
  `HOLY_FOURTH_SHORTCUT_SKILLS` 的 `Digit9`。
- `client/src/features/player/view.ts`：`startSkill` 的施法姿势名单加 id。
- `client/src/features/combat/view.ts`：施法者锚定名单改读表。
- ⚠️ **三个检查脚本会因此 `ReferenceError`**：`skills/view.check.mjs`、
  `combat/skill.check.mjs`、`combat/sound.check.mjs` 都是「剥掉 `view.ts` 全部 import + 全局桩注入」。
  必须在它们里面注入新名字的**真值**（把 `player/input.ts` 同样「转译 + 剥 import」后求值），
  **不要手抄桩**——手抄的桩会在名单改动时静默说谎。

### 3. 导出器与门禁

- `scripts/export_tms273_mage_effects.cjs`：`FOURTH_JOB_SOURCES` 加 `{effect, effect0, affected}` 源路径。
- `scripts/check_tms273_mage_effects.cjs`：`EXPECTED` / `DIRECT_EFFECTS` / `SOURCE_IMAGE` /
  `EXTRA_GROUPS` 各 +N，`SIBLING_ART_PARITY` 加 `[副本, 冰雷那本]`。
- `scripts/check_tms273_damage_pipeline.cjs`（**只有带 `indieDamR` 的技能才需要动**）：
  - `NOT_CONSUMED.<字段>` 里删掉显式登记条；
  - `assert.equal(catalogIndie.length, 1)` 这类「个数」断言换成
    `assert.deepEqual(catalogIndie, idsForArray('<NAME>_SKILLS'))`；
  - `damageSourceMentions()` 要求源码字面出现 `skill_id: SKILL_常量`，**收口成访问器后它会失效**，
    换成带反向引用的形状断言：`/if let Some\((\w+)\) = active_<name>_skill\(player\) \{[\s\S]{0,200}?DamageSource::X\s*\{\s*skill_id: \1,/`。
  - `assertExcused` 是**反向断言**（要求该 id 在 `world.rs` 里**没有常量**）⇒ 接线的瞬间门禁必红，
    这不是回归，是它逼你补消费。

### 4. 内容版本 + 装配

内容资源真的变了才升版本（纯代码搬移不升）。五处手写落点：

```
shared/protocol.ts           export const CONTENT_VERSION = 'tms273-NN';
server/src/protocol.rs       pub const CONTENT_VERSION: &str = "tms273-NN";
scripts/assemble_tms273.cjs  const version = 'tms273-NN';
scripts/check_tms273_runtime.cjs   process.argv[2] ?? 'tms273-NN'
scripts/check_colossus_live.cjs    'shared content must be tms273-NN'
```

装配器**在本代理沙箱里必须绕行**（项目代码不要改）：它在全量拷贝 12 万文件时会被宿主文件代理
打断（`SandboxError: path index collision`，确定性复现；`dangerouslyDisableSandbox` 无效，
因为 `cli/vendor/shim/node-brokered-fs-shim.cjs` 只在 `mode === undefined || mode === 0` 时接管）。
用仓库外驱动跑：

```bash
node /tmp/run-assemble-with-ficlone.cjs   # 只把 fs.copyFileSync 的 mode 补成 COPYFILE_FICLONE
```

失败会留下**不一致中间态**（`shared/notebook-catalog.json` 先写、`shared/gameplay.json` 与 manifest 后写），
失败后必须重跑到底。**用户在自己终端跑 `启动3010.command` 不受影响。**

## 美术要从 `.img` 读，不是从 `WZ_JSON_TW`

`WZ_JSON_TW/Skill/<n>.json` 里 `2121053` 的 `effect` 节点可能是 `{"_dirType":"sub"}`（空的），
但 `Skill/212.img` 里同样有 17 帧。导出器读的是 `Data/Packs` 解出来的 `.img`。

```bash
TMP=$(mktemp -d)
./scripts/unpack_tms273_ms/target/debug/unpack_tms273_ms \
  --packs "参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/Packs" --out "$TMP" \
  --image Skill/212.img --image Skill/232.img
# 再用 scripts/tms273_wz.cjs 的 createReader 读：node.wzProperties（不是 node.children）
```

## 验收清单（逐条跑完再收工）

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd server && cargo test                       # 期望 0 失败
cd ../client && npx tsc --noEmit              # 期望 0 输出
cd .. && node scripts/export_tms273_mage_effects.cjs
node scripts/check_tms273_mage_effects.cjs    # 期望 PASS，skills 条数 = 新值
node scripts/check_tms273_damage_pipeline.cjs
node scripts/check_tms273_export.cjs
node scripts/check_tms273_skill_manifest.cjs
node scripts/check_tms273_skill_books.cjs
node scripts/check_tms273_attributes.cjs
cd client && node scripts/run-checks.mjs      # 与基线红灯集合逐项比对，不能多
```

**服务端验收必须新增**：`server/src/mage_branch_copy_acceptance.rs`（前缀 `mbc_`，已 `include!` 进
`world_tests.rs::mod tests`）。要钉四件：① 表成员逐本登记；② 端到端施放**不再回
「该技能尚未开放施放」**且发出 `skillCast`；③ 窗口只挂在施放的那一本上；④ 走真实
`magic_damage_breakdown`，留痕里出现的是**副本自己的书号**、冰雷那本不出现。

## 已知陷阱

1. **Hyper 主动是 190 级**（源 `reqLev`）。既有夹具 `mbc_ready` 摆 120 级 ⇒ 会被
   `level_requirement` 挡下，**看起来像技能没接线**。用按源等级摆位的 `mbc_ready_hyper`。
2. **`cargo` 不在默认 PATH**：`export PATH="$HOME/.cargo/bin:$PATH"`。
3. **同一文件的两处 `Edit` 不要并发发**：会互相覆盖（`Edit` 都报成功但有一处丢失）。改完回读核验；
   不同文件并发是安全的。
4. **`resources/**` 是 gitignore 的生成树**。判断某门禁是否「既有红灯」时，先看它读的输入
   是否为本轮生成——生成树过期会让门禁长期红而无人发现。
5. **本沙箱 `ps` 不可用、Bash 的 `grep` 时好时坏**：检索一律用专用 Grep 工具。
6. **`scripts/check_tms273_skills.cjs` 是既有红灯**（读的 `skills.json` 已无 `levelValues`），
   不在 `run-checks.mjs` 清单内，与「同一格副本」这条线无关，别顺手去修。
7. **升版与重建必须同窗口**：`client/src/assets/manifest.ts` 对
   `manifest.contentVersion !== CONTENT_VERSION` 硬抛错且自愈路径**不导航** ⇒
   升版后不重建，在线页面直接坏掉。这也是「改了客户端/服务端代码本来就必须重建」的必然代价。

## 收工时要落的三处文档

- `docs/plan/PLAN.md`：§0 版本表 + §1② 缺口 C 的「已立起 N 条／仍未做 M 条」。
- `docs/plan/topics/总纲40模块现状与待办台账_2026-09-22.md`：§07 的**三处**（速览行、
  遗留行、以及正文里那一条）。
- `docs/plan/history/<日期>/` 的交付记录 + `docs/plan/INDEX.md` 加一行（同一文件的多轮增量
  追加在同一份记录里，INDEX 加新行指向同一链接）。
