---
name: maplestory-derivation-collapse
description: 把 MapleStory TMS273 复刻版里「同一笔数值派生散落在多处、而且各处写法互相不一致」的账收口成唯一源字段派生点。当任务是把重复/分叉的时长、周期、倍率、阈值等派生统一到一个函数、或发现某处把源字段写死、或要给这类收口补双向门禁断言时使用。触发词：收口、唯一派生点、散落、写法差异未统一、写死、静默漂移、derivation。
agent_created: true
---

# MapleStory TMS273：把散落的数值派生收口成唯一派生点

本仓是 Rust 权威服务端 + Phaser TS 客户端 + Python/CJS 资源导出流水线。
本技能处理的是**纯收口**类任务：机制已经在跑，缺的是「同一笔账只写一份」。

## 先判这是不是「纯收口」

| 收口 | 不是收口（别用本技能） |
|---|---|
| 同一笔派生写了 N 处，各处写法/默认值不一致 | 源里有字段但**本包没有消费点** ⇒ 那是**新机制**，不接、如实登记 |
| 其中某处**根本不读源**（写死字面量）⇒ 源改数即静默漂移 | 需要先决定一个新的语义（如「跟随施法者」怎么建模）⇒ 新机制 |
| 收口后行为**逐件复现**收口前 | 收口会**改变**行为（哪怕只是默认值）⇒ 必须另行论证 |

**零内容改动判据**：只动 Rust 源码 + 门禁脚本、`shared/**` 零字节 ⇒ 按本仓口径
**不升内容版本、不重跑装配器**（与 S5 召唤通用化、召唤存活时长收口同例）。
反之若碰了 `shared/**`，见 `maplestory-skill-copy-wiring` 技能的「内容版本 + 装配」一节。

## 步骤

### 1. 先数清「这份账到底写了几处」

```bash
# 按物理量名找所有写入点（别只搜函数名）
grep -rn "expires_at\|duration_ticks\|next_hit_at" server/src/
```

逐处抄下**当前写法**（单位、默认值、是否读源），做成一张对照表。这张表就是交付记录的骨架。

### 2. 判据能不能从源里「结构性地」判出来——先证伪，再决定

**这一步最容易踩坑：不要凭直觉认定某个结构字段能定单位/语义。**
本轮实测过三条被源数据否掉的结构判据（`time` 的单位）：

- 「本书有没有 `summon` 节点」✗ —— `1121055` 有 `summon` 节点却写 `time=10000`（只能是毫秒）；
  `2100010` 没有 `summon` 节点却写 `time=4+d(x/4)`（只能是秒）。
- 「毫秒槽 `attackDelay` 在不在场」✗ —— `1301014` 带 `attackDelay=360` 却写 `time=5`（秒）。
- 「是公式还是字面量」✗ —— 按秒的 `1301014` 是字面量 `5`，按毫秒的 `2221012` 也是字面量 `4000`。

做法：写一段一次性 node 脚本，**把全目录所有带该字段的技能都列出来**，再逐条验证候选判据：

```bash
node -e '
const s=require("./shared/mage-skills.json").skills;
const hits=Object.entries(s).filter(([,r])=>(r.levels[0]||{}).time!==undefined);
console.log("带 time 的技能:", hits.length);
for(const [id,r] of hits) console.log(id, "time="+(r.levels[0]||{}).time);
'
```

只有**全样本一致、且两侧没有重叠区**的判据才可用。若只能用**量级判据**（经验判据），
必须把「两侧无重叠」做成门禁断言，并在文档里写明边界（新数据落进灰色区间时门禁**不会红**）。

### 3. 在机制模块建唯一派生点

放在既有的机制模块（本仓是 `server/src/mechanics.rs`），**照抄同族既有派生点的形状**。
本仓既有先例：`summon_pulse_ms(skills, skill_id, level) -> u64`。

```rust
/// 一句话说清「收口前有几份账、各自怎么写的、为什么互相不一致」。
pub(super) fn summon_lifetime_ms(skills: &MageSkills, skill_id: u32, level: u32) -> u64 {
    let Some(time) = skills.level(skill_id, level).and_then(|row| row.time) else {
        return SUMMON_LIFETIME_FALLBACK_MS;
    };
    if time >= SUMMON_LIFETIME_MS_THRESHOLD { time as u64 }
    else { u64::try_from(time.max(0)).unwrap_or(0).saturating_mul(1_000) }
}
```

要点：

- **取 `&MageSkills` 而不是 `&self`**：调用点（如 `step_summons`）可能正持有 `player` 的可变借用，
  经 `self.方法()` 会被借用检查器挡下。
- **兜底值提成常量**（`*_FALLBACK_MS`），不要 `unwrap_or(0)`。
- **「写明的 0」≠「没写」**：`Some(0)` 走数值分支得 0，由调用方 `.max(1)` 收敛；
  只有 `None` 才落兜底。别把两者并成一支（本仓已有专门陷阱登记）。
- 跨模块可见性：`mechanics.rs` 的函数用 `pub(super)`，`world.rs` 里有 `use self::mechanics::*;`
  ⇒ 兄弟模块（`elemental.rs`／`skills.rs`／`attacks.rs`）经 `use super::*;` 直接可用，无需新增 import。

### 4. 调用点改走它，并**交出对源字段的访问权**

- 三个调用点全部改成 `summon_lifetime_ms(&self.mage_skills, <id>, <level>)`。
- 参数若因此不再使用，改名成 `_level`（本仓既有风格，如 `cast_frozen_orb(&mut self, id, request_id, _level: &MageLevel)`）。
- **用 `player.state.skills.get(&skill_id)` 得到的等级**去查派生点，而不是传进来的 `&MageLevel`
  ——两者在本仓等价（`level` 就是从同一个 `mage_skills.level(skill_id, skill_level)` 来的），
  但读同一个来源才能保证「施放入口与派生点看到的是同一行」。
- 顺带核对该函数上下的**文档注释是否已经陈旧**（本轮抓到「冰魔 1→30 级 90→200」，实测是 `115→260`）。

### 5. 门禁：加一段**双向**断言

加在本仓 `scripts/check_tms273_damage_pipeline.cjs` 里「判据改动必须有行为撑腰」那一族
（§3g 之后编号续写，本轮是 §3h）。四件都要有：

1. **唯一派生点在不在**：正则确认函数存在、确认它从源字段派生、确认分界比较存在；
   且 Rust 侧的分界常量值必须与门禁自己算的**同值**（两处漂移即红）。
2. **每个调用点是否都经过它**：**逐条点名**（`['elemental.rs::cast_demon_summon', 源, /fn cast_demon_summon\([\s\S]*?\n    \}/]`），
   函数体里必须出现派生点调用。
3. **反向断言（最有效的一条）**：这些函数体里**不许再出现该源字段**（`.time`）。
   这条直接堵死「又长出一份账」——施放入口自己读一次源字段就是自算。
4. **从源 JSON 独立重算 + 双录**：逐本取源字段、按判据算出期望值、与门禁里的期望表逐项比对；
   同时**逐级**断言该字段存在（⇒ 兜底分支不可达）。

注意 `codeOnly(read('mechanics.rs'))` 会**去掉整行注释**——门禁要数的是代码里出现过几次，
不是文档里提过几次。所以派生点的函数文档里可以随便写 `.time`，但代码里必须真的有。

### 6. 验收：Rust 侧一条用例，四段

加在 `server/src/mechanics_acceptance.rs`（`include!` 进 `world_tests.rs::mod tests`，助手一律 `mech_` 前缀）：

1. **逐件等于源值**（硬编码期望 + 源值出处写在注释里）+ **反向断言**：
   写死字面量恰好对的那一处，钉的不是「数值变了」而是「数值的**来源**变了」。
2. **兜底不可达**：逐级断言该字段存在。
3. **派生值真被消费**：施放后 `expires_at - 施放拍 == 派生值.div_ceil(TICK_MS).max(1)`。
4. **合成目录扰动**：真实内容的字段是源给的定值、扰动不了，所以用 `serde_json::from_str`
   造一本同形技能，只改那一个字段，钉住分界两侧（`999 → 999_000`、`1000 → 1_000`、
   `0 → 0`、缺失 → 兜底）。`MageSkills` 的 `name` / `maxLevel` 是必填，`levels` 里缺的
   `Option` 字段 serde 自动当 `None`。

### 7. 扰动验证（本仓纪律，不能省）

逐条把新断言**弄红**再还原，证明它们真的会咬人。本轮三条：

1. 分界常量 `1_000 → 500` ⇒ 红在「两处必须同值」。
2. 某调用点改回写死字面量 ⇒ 红在「没有经过唯一派生点」。
3. 门禁双录期望值错一位 ⇒ 红在「源 `time` 变了」。

跑法：直接 `node scripts/check_tms273_damage_pipeline.cjs`（不加 `| grep`，
本沙箱 Bash 的 `grep` 时好时坏；看 `AssertionError` 那几行即可）。

## 已知陷阱

1. **别把「默认值统一」当成无行为改动**。收口前各处的静默默认可能互相矛盾
   （本轮：一处 1 拍即到期、另一处 20 秒／60 秒）。统一成契约值时必须**证明该分支不可达**
   （逐级断言字段存在），否则只是把一个静默缺陷换成一个静默行为变化。
2. **同名源字段可能有多种语义**，别顺手一起收。本仓 `time` 有三种：
   自增益窗（`AttackPlan::self_buff_window_ms`，S1）、负面状态窗（仍被门禁
   `NEGATIVE_STATUS_TIME_ATTACKS` 挡在表外）、召唤存活时长。另有第四类：
   `player.hyper_vortex`（冰雪结界）读的是源 `u2`、住在 `HyperVortex` 而非 `Summon` 队列。
3. **`cargo` 不在默认 PATH**：`export PATH="$HOME/.cargo/bin:$PATH"`。
4. **同一文件的两处 `Edit` 不要并发发**：会互相覆盖（`Edit` 都报成功但有一处丢失）。改完回读核验。
5. **`resources/**` 是 gitignore 的生成树**；判断某门禁是否「既有红灯」时，先看它读的输入是否本轮生成。
6. **本沙箱 `ps` 不可用、Bash 的 `grep` 时好时坏**：检索一律用专用 Grep 工具。
7. **别顺手去修既有红灯**（如 `scripts/check_tms273_skills.cjs` 读的 `skills.json` 已无 `levelValues`，
   不在 `run-checks.mjs` 清单内）。验收只要求「失败集合与基线**逐项相同**」。
8. 装配器、美术探测（`.img` 才是权威、`node.wzProperties` 不是 `node.children`）等细节，
   见 `maplestory-skill-copy-wiring` 技能。

## 收工时验收与文档

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd server && cargo test                       # 期望 0 失败，条数 = 基线 + 新增
cd .. && node scripts/check_tms273_damage_pipeline.cjs   # 期望 PASS + 新自报行
node scripts/check_tms273_mage_effects.cjs    # 期望 PASS（条数不变）
cd client && node scripts/run-checks.mjs      # 与基线红灯集合**逐项**比对，不能多
```

要落的三处文档：

- `docs/plan/PLAN.md`：§0 基线表（**顺手回写陈旧数字**：`cargo test` 条数、装机规模、`run-checks` 叙述）
  + §1② 里该缺口「仍未做」那一段（把已完成项从「仍未做」挪走，别只加不改）。
- `docs/plan/topics/总纲40模块现状与待办台账_2026-09-22.md`：§0 版本与验收基线表（往往比 PLAN 更陈旧）
  + 缺口正文那条 + §5.1 补一句「本轮复跑，失败集合逐项相同」。
- `docs/plan/history/<日期>/` 的交付记录 + `docs/plan/INDEX.md` 加一行。
  **`docs/plan/history/**` 是历史记录，一律不回头改**（旧数字留在旧记录里是对的）。
