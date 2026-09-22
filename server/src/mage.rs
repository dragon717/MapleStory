use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

fn default_book_id() -> u32 {
    200
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MageSkills {
    #[serde(default)]
    pub source_version: String,
    #[serde(default)]
    pub book_id: u32,
    #[serde(default)]
    pub skills: BTreeMap<String, MageSkill>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MageSkill {
    pub name: String,
    pub max_level: u32,
    #[serde(default = "default_book_id")]
    pub book_id: u32,
    /// TMS273 Skill/221 carries the elemental marker on the skill node rather
    /// than on every level.  Keep it optional because the older 200/220
    /// catalog does not export it.
    #[serde(default, rename = "elemAttr")]
    pub elem_attr: Option<String>,
    #[serde(default)]
    pub prerequisites: BTreeMap<String, u32>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub fixed_level: bool,
    /// TMS273 Hyper pool: 0 ordinary, 1 passive pool, 2 active pool.
    /// Hidden 2221055 is retained in the catalog as a source node but is
    /// never exposed as a learnable skill by World.
    #[serde(default)]
    pub hyper: u32,
    #[serde(default, rename = "requiredLevel")]
    pub required_level: u32,
    #[serde(default)]
    pub booster_action_speed: Option<i64>,
    pub levels: Vec<MageLevel>,
}

impl MageSkill {
    /// 源里这条技能是**主动**的吗。
    ///
    /// 判据只取源数据本身：任一级带 `mpCon`（耗蓝）或 `damage`（伤害）即为主动。
    /// 用途是施放路径上的**消息分流**——被动技能回「被动技能不能主动施放。」，
    /// 而源里是主动、本包还没接执行链的（召唤物 / 治疗 / DoT 场 / 增益窗等）
    /// 回「该技能尚未开放施放。」。改前这两类共用前一句话，火毒与主教的主动技能
    /// 在补齐准入之后会被误报成被动。
    ///
    /// 这不是「可施放白名单」：白名单仍然写在 `world.rs`（`castable` /
    /// `BRANCH_AREA_ATTACKS`），本方法只说源里的技能是哪一类。
    pub fn is_active_source_skill(&self) -> bool {
        self.levels
            .iter()
            .any(|level| level.mp_con.is_some() || level.damage.is_some())
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MageLevel {
    pub mp_con: Option<i64>,
    pub z: Option<i64>,
    #[serde(rename = "costmpR")]
    pub costmp_r: Option<i64>,
    #[serde(rename = "damR")]
    pub dam_r: Option<i64>,
    #[serde(rename = "criticaldamage")]
    pub critical_damage: Option<i64>,
    #[serde(rename = "subProp")]
    pub sub_prop: Option<i64>,
    #[serde(rename = "mdR")]
    pub md_r: Option<i64>,
    pub cooltime: Option<i64>,
    /// 用户指定规则字段（2026-09-10，**非 TMS273 源字段**）：等級冷卻，单位毫秒。
    /// 目前只有 2001009 瞬移使用；由 `scripts/tms273_skill_manifest.cjs` 的
    /// USER_SPECIFIED_SKILL_RULES 写入（原版瞬移没有 cooltime，数值为 P）。
    pub cooldown_ms: Option<i64>,
    /// 用户指定规则字段（2026-09-12，**非 TMS273 源字段**）：魔心防禦 2001002 的
    /// 逐级「MP 抵偿率」(%)，1 级 100、每级 -2、10 级正好 80。受伤的
    /// `world::MAGIC_GUARD_COVERED_PERCENT`% 由护罩接下、转由 MP 承受，其中本值 % 能被化去，
    /// 化不去的差额由护盾消解（不扣 HP、不扣 MP）；未被接下的那 1% 才落回 HP。
    /// 由 `scripts/tms273_skill_manifest.cjs` 的 USER_SPECIFIED_SKILL_RULES 写入；
    /// 原版 `x`（15+7*x = 22→85，「以 MP 代替的伤害百分比」）继续留在 `x`/`rawCommon`。
    pub mp_substitute_percent: Option<i64>,
    #[serde(rename = "asrR")]
    pub asr_r: Option<i64>,
    #[serde(rename = "terR")]
    pub ter_r: Option<i64>,
    #[serde(rename = "stanceProp")]
    pub stance_prop: Option<i64>,
    #[serde(rename = "madX")]
    pub mad_x: Option<i64>,
    #[serde(rename = "bufftimeR")]
    pub buff_time_r: Option<i64>,
    #[serde(rename = "basicStatUp")]
    pub basic_stat_up: Option<i64>,
    #[serde(rename = "attackDelay")]
    pub attack_delay: Option<i64>,
    #[serde(rename = "ignoreMobpdpR")]
    pub ignore_mob_pdp_r: Option<i64>,
    #[serde(rename = "hcHp")]
    pub hc_hp: Option<i64>,
    pub speed: Option<i64>,
    pub q: Option<i64>,
    pub q2: Option<i64>,
    #[serde(rename = "indieDamR")]
    pub indie_dam_r: Option<i64>,
    #[serde(rename = "targetPlus")]
    pub target_plus: Option<u32>,
    pub w2: Option<i64>,
    pub u2: Option<i64>,
    #[serde(rename = "mmpR")]
    pub mmp_r: Option<i64>,
    pub lv2mmp: Option<i64>,
    pub action_speed: Option<i64>,
    pub mastery: Option<i64>,
    pub cr: Option<i64>,
    pub int_x: Option<i64>,
    pub indie_mad: Option<i64>,
    pub sub_time: Option<i64>,
    #[allow(dead_code)] // Parsed source field; movement semantics remain a P adapter.
    pub s: Option<i64>,
    pub pdd_x: Option<i64>,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub prop: Option<i64>,
    #[serde(rename = "fixdamage")]
    pub fixdamage: Option<i64>,
    pub time: Option<i64>,
    pub v: Option<i64>,
    pub w: Option<i64>,
    pub u: Option<i64>,
    pub psd_speed: Option<i64>,
    pub speed_max: Option<i64>,
    pub range: Option<i64>,
    pub mob_count: Option<u32>,
    pub damage: Option<i64>,
    pub attack_count: Option<u32>,
    pub max_use_count_in_one_jump: Option<u32>,
    #[serde(default)]
    pub lt: Option<MagePoint>,
    #[serde(default)]
    pub rb: Option<MagePoint>,
}

#[derive(Clone, Copy, Deserialize)]
pub struct MagePoint {
    pub x: f64,
    pub y: f64,
}

// ── 技能书 ↔ 职业：**唯一的准入权威** ─────────────────────────────────────────
//
// 源里技能书的编号**就是职业号**（`1001005 → 100` 剑士一转、`110/111/112` 英雄的二三四转、
// `120/121/122` 聖騎士、`130/131/132` 黑騎士；`210/211/212` 火毒、`220/221/222` 冰雷、
// `230/231/232` 僧侶→祭司→主教；`310/311/312` 獵人→神射手、`320/321/322` 弩弓手→箭神；
// `410/411/412` 刺客→夜使者、`420/421/422` 俠盜→暗影神偷），四条一转书是
// `100/200/300/400`、`0` 是初学者书。
// 所以「谁能学这本书」「这个职业升级时收到哪本书」都从编号派生，**不逐处写死**。
//
// 2026-09-22 起本模块承载**全部四条探险家职业线**（不止法师）：战士 / 弓箭手 / 飞侠
// 的技能书、数值与准入都从同一张 `BOOKS` 表派生。模块名与类型名沿用 `Mage*` 是历史
// 名字（先有法师才有的这套模型），改成 `Skill*` 要动 30 多个调用点，收益只有可读性，
// 没有行为收益——这里用注释把语义钉住，不为此做大规模重命名。
//
// 改前这套判据在三处各写了一份，且三份都只认冰雷那三本：
//   `world.rs::skill_job_allowed`（施法与学习的职业闸）、`auth/skills.rs`（落库前的
//   同一道闸）、`auth/db.rs::grant_level_sp`（升级发点）。后果是**火毒与主教分支的
//   技能书在运行期既学不了、也拿不到升级点**——目录、任务、地图都装好了，玩家却碰不到。
// 这里收口成一张表；客户端的 `input.ts::BOOK_JOBS` 是同一张表的另一份实现，
// `scripts/check_tms273_skill_books.cjs` 对两份表逐格**双向断言**。
// 判据是「转职层级」而不是「某一本书」：同层各分支各自只认自己那一支，
// 低转职层级的书对同一分支的高转职职业继续有效（三转书四转照样能学）。

/// 已登记的技能书。**书号就是技能 id 的高位**（`2201005 → 220`、`1001005 → 100`）。
/// 排列：`0` 初学者、四条一转书、每条分支按「二转 / 三转 / 四转」各排三本。
/// 总数 35 = 1(初学者) + 4(一转) + 10(战士) + 10(法师) + 7(弓箭手) + 7(飞侠)。
pub const BOOKS: [u32; 35] = [
    0,
    100, 110, 111, 112, 120, 121, 122, 130, 131, 132,
    200, 210, 211, 212, 220, 221, 222, 230, 231, 232,
    300, 310, 311, 312, 320, 321, 322,
    400, 410, 411, 412, 420, 421, 422,
];
/// 四转书（分支书的末位为 2）：Hyper 池、`(mobCount, attackCount)` 上界等
/// 「按层级分档」的判据都看它。**按层级派生，不写死名单**（见 `is_fourth_job_book`）。
pub const FOURTH_JOB_BOOKS: [u32; 10] = [112, 122, 132, 212, 222, 232, 312, 322, 412, 422];
/// 初学者职业号（`0`）；它的书也是 `0`。
pub const BEGINNER_JOB: u32 = 0;
pub const BEGINNER_BOOK: u32 = 0;
/// 一转书号（书号 = 职业号）。
pub const WARRIOR_BOOK: u32 = 100;
pub const MAGE_BOOK: u32 = 200;
pub const BOWMAN_BOOK: u32 = 300;
pub const THIEF_BOOK: u32 = 400;
/// 四条职业线的全部职业号（不含初学者）。**每类的第 0 项是一转**，其后每 3 个
/// 是一条分支（二转 / 三转 / 四转）——`branch_jobs` 按这个布局切片，改顺序会错位。
pub const WARRIOR_JOBS: [u32; 10] = [100, 110, 111, 112, 120, 121, 122, 130, 131, 132];
pub const MAGE_JOBS: [u32; 10] = [200, 210, 211, 212, 220, 221, 222, 230, 231, 232];
pub const BOWMAN_JOBS: [u32; 7] = [300, 310, 311, 312, 320, 321, 322];
pub const THIEF_JOBS: [u32; 7] = [400, 410, 411, 412, 420, 421, 422];
/// 初学者书 `0` 的持有者：初心者本人 + 任何探险家职业（一转前也要用得到初学者被动）。
const BEGINNER_JOBS: [u32; 35] = [
    0,
    100, 110, 111, 112, 120, 121, 122, 130, 131, 132,
    200, 210, 211, 212, 220, 221, 222, 230, 231, 232,
    300, 310, 311, 312, 320, 321, 322,
    400, 410, 411, 412, 420, 421, 422,
];

/// 法师系职业判定（不含初心者）。法师专属规则（魔力成长、魔心防禦等）仍只认这一张表。
pub fn is_mage_job(job: u32) -> bool {
    MAGE_JOBS.contains(&job)
}

/// 是否四转书。按**层级**派生（分支书末位为 2），与 `FOURTH_JOB_BOOKS` 常量互为同一张表：
/// 常量供 `matches!` / 常量上下文使用，本函数供运行期判据使用，门禁对两者断言一致。
pub fn is_fourth_job_book(book: u32) -> bool {
    book % 100 >= 10 && book % 10 == 2
}

/// 书所属的**分支**（十位与百位合成，`book / 10`）：`11` 英雄 / `12` 聖騎士 / `13` 黑騎士、
/// `21` 火毒 / `22` 冰雷 / `23` 僧侶、`31` 獵人 / `32` 弩弓手、`41` 刺客 / `42` 俠盜。
/// `None` = 不是分支书（初学者书 `0` 与四条一转书 `100/200/300/400`）。
pub fn book_branch(book: u32) -> Option<u32> {
    (BOOKS.contains(&book) && book % 100 >= 10).then_some(book / 10)
}

/// 书在分支内的**转职层级**（个位）：`0` 二转 / `1` 三转 / `2` 四转。
pub fn book_tier(book: u32) -> Option<u32> {
    book_branch(book).map(|_| book % 10)
}

/// 分支 → 该分支三本书的持有者职业片段。
///
/// 各类职业表的布局是「一转 + 每 3 个一条分支」，所以第 `branch_index` 条分支
/// 第 `tier` 层的片段是 `[1 + 3×branch_index + tier, 1 + 3×branch_index + 3)`：
/// 片段语义 = 「本分支第 tier 本书及其后的转职都能学」（二转书二三四转都能学，
/// 三转书三四转能学，四转书只有四转能学）。**改 `*_JOBS` 的排列顺序必须同步改这里**。
fn branch_jobs(branch: u32, tier: u32) -> &'static [u32] {
    let (jobs, branch_index) = match branch {
        11 | 12 | 13 => (&WARRIOR_JOBS[..], (branch - 11) as usize),
        21 | 22 | 23 => (&MAGE_JOBS[..], (branch - 21) as usize),
        31 | 32 => (&BOWMAN_JOBS[..], (branch - 31) as usize),
        41 | 42 => (&THIEF_JOBS[..], (branch - 41) as usize),
        _ => return &[],
    };
    let start = 1 + 3 * branch_index + tier as usize;
    jobs.get(start..1 + 3 * branch_index + 3).unwrap_or(&[])
}

/// 技能书 → 可持有它的职业集合。
///
/// - 初学者书 `0`：初心者本人 + 任何探险家职业；
/// - 一转书（`100/200/300/400`）：本职业线的全部职业；
/// - 分支书：按分支与转职层级切片（见 `branch_jobs`）。
/// - 未登记的书：空集（拒绝），与改前 `_ => false` 同语义。
pub fn book_jobs(book: u32) -> &'static [u32] {
    match book {
        BEGINNER_BOOK => &BEGINNER_JOBS,
        WARRIOR_BOOK => &WARRIOR_JOBS,
        MAGE_BOOK => &MAGE_JOBS,
        BOWMAN_BOOK => &BOWMAN_JOBS,
        THIEF_BOOK => &THIEF_JOBS,
        _ => match book_branch(book).zip(book_tier(book)) {
            Some((branch, tier)) => branch_jobs(branch, tier),
            None => &[],
        },
    }
}

/// 技能书 → 职业是否匹配（施法、学习的同一道闸）。
pub fn skill_job_allowed(job: u32, book: u32) -> bool {
    book_jobs(book).contains(&job)
}

/// 职业 → 该职业升级时收到的技能书（`0` 初学者书 / 一转书各归各的）。
/// 未登记的职业返回 `None`（不发点，与改前 `_ => return` 同语义）。
pub fn book_for_job(job: u32) -> Option<u32> {
    if job == BEGINNER_JOB {
        Some(BEGINNER_BOOK)
    } else if WARRIOR_JOBS.contains(&job)
        || MAGE_JOBS.contains(&job)
        || BOWMAN_JOBS.contains(&job)
        || THIEF_JOBS.contains(&job)
    {
        Some(job)
    } else {
        None
    }
}

impl MageSkills {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let skills: Self = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        skills.validate()?;
        Ok(skills)
    }

    #[cfg(test)]
    pub fn bundled() -> Self {
        let skills: Self = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/mage-skills.json"
        )))
        .expect("shared/mage-skills.json must be valid");
        skills
            .validate()
            .expect("bundled mage skills must be valid");
        skills
    }

    pub fn validate(&self) -> Result<(), Box<dyn std::error::Error>> {
        // 书号清单与四转书集合是模块级常量（`BOOKS` / `FOURTH_JOB_BOOKS`）——它们同时被
        // 准入表 `book_jobs` 使用，这里不再各自写一份局部副本。
        /// 源里出现过的元素字母：`i` 冰 / `l` 雷 / `f` 火 / `s` 毒 / `h` 聖。
        const ELEM_ATTRS: [&str; 5] = ["i", "l", "f", "s", "h"];
        /// `(mobCount, attackCount)` 的合理性上界，按**转职层级**分档（下标 0..3 =
        /// 一转 / 二转 / 三转 / 四转与 Hyper）。每档都是该层级的**实测最大值**：
        /// mob 一转 6（`1001005 劍氣縱橫`）、二转 10（`1301014 追隨者衝擊`）、
        /// 三转 12（`1111012 究極突刺` 的 `7+d(x/2)` 满级 12——改前只有「四转 / 非四转」
        /// 两档，非四转一律 10，这本三转书当场把整本目录判成非法）；四转与 Hyper 15。
        /// atk 一转 4（`2001008 魔靈彈`）、二/三转 6、四转与 Hyper 15。
        /// 上界只用来发现「把 mobCount 与 attackCount 读串」这类投影错误，不是内容规则；
        /// 真实源值再涨一档时这里会红，逼人重新量一遍，而不是静默放行。
        const TIER_LIMITS: [(u32, u32); 4] = [(6, 4), (10, 6), (12, 6), (15, 15)];
        if self.source_version != "TMS273.7" {
            return Err("invalid TMS273 mage skill catalog".into());
        }
        // 书号集合的判据**从 `BOOKS` 派生**，不再写死条数名单：改前这里是
        // `matches!(len, 8|17|29|32|43|56|102|153)`——一本一本累加出来的硬编码，
        // 每加一本书都得记得改这里（漏改就是「整本目录静默进不来」）。现在要求
        // 「目录里出现的每一本书都已登记」，加上「已登记的书至少要有一条技能」，
        // 两头都钉住：多一本未登记的书、或登记了却整本掉出投影，都在启动时挡下。
        // 空目录（`MageSkills::default()` 与测试夹具）继续放行。
        if !self.skills.is_empty() {
            let mut seen_books = std::collections::BTreeSet::new();
            for skill in self.skills.values() {
                seen_books.insert(skill.book_id);
            }
            if let Some(book) = seen_books.iter().find(|book| !BOOKS.contains(book)) {
                return Err(format!("catalog carries unregistered skill book {book}").into());
            }
            if seen_books.len() != BOOKS.len() {
                return Err(format!(
                    "catalog is partial: {} of {} registered skill books present",
                    seen_books.len(),
                    BOOKS.len()
                )
                .into());
            }
        }
        for (id, skill) in &self.skills {
            let skill_id: u32 = id.parse().map_err(|_| "invalid mage skill id")?;
            let book = skill_id / 10_000;
            let tier_index = if skill.hyper > 0 {
                3
            } else {
                match book_tier(book) {
                    Some(tier) => tier as usize + 1,
                    None => 0,
                }
            };
            let (mob_limit, attack_limit) = TIER_LIMITS[tier_index];
            if !BOOKS.contains(&book)
                || skill.book_id != book
                || skill.max_level == 0
                || skill.max_level > 100
                || skill.levels.len() != skill.max_level as usize
                || skill.name.is_empty()
                || skill.hyper > 2
                || (skill.hyper == 0 && skill.required_level != 0)
                || (skill.hyper > 0
                    && (!FOURTH_JOB_BOOKS.contains(&skill.book_id) || skill.max_level != 1))
                || (skill.hyper > 0 && skill.required_level < 140)
                || skill
                    .elem_attr
                    .as_deref()
                    .is_some_and(|value| !ELEM_ATTRS.contains(&value))
                || skill.levels.iter().any(|level| {
                    level.mp_con.is_some_and(|value| value < 0)
                        || level.damage.is_some_and(|value| value < 0)
                        || level
                            .mastery
                            .is_some_and(|value| !(0..=100).contains(&value))
                        || level.cr.is_some_and(|value| !(0..=100).contains(&value))
                        || level.int_x.is_some_and(|value| value < 0)
                        || level.indie_mad.is_some_and(|value| value < 0)
                        || level.sub_time.is_some_and(|value| value < 0)
                        // `z` 与 `q` 同理是泛用语义字段，**负值是源事实**：
                        // `4121015 絕對領域` 的 common `x/z/y` 全为负（表减益），
                        // Hyper 被动 `4120046 絕對領域-強化效果` 是 `x:-10,z:-10,v:10`。
                        // 法师 153 条里 z 恰好全为非负才让旧判据活到现在；写成 `< 0`
                        // 会把 412 书整本拒掉。这里不再设符号判据。
                        || level.costmp_r.is_some_and(|value| value < 0)
                        || level.dam_r.is_some_and(|value| value < 0)
                        || level.critical_damage.is_some_and(|value| value < 0)
                        || level
                            .sub_prop
                            .is_some_and(|value| !(0..=100).contains(&value))
                        || level.md_r.is_some_and(|value| value < 0)
                        || level.cooltime.is_some_and(|value| value < 0)
                        || level.cooldown_ms.is_some_and(|value| value < 0)
                        || level
                            .mp_substitute_percent
                            .is_some_and(|value| !(0..=100).contains(&value))
                        || level.asr_r.is_some_and(|value| !(0..=100).contains(&value))
                        || level.ter_r.is_some_and(|value| !(0..=100).contains(&value))
                        || level.stance_prop.is_some_and(|value| value < 0)
                        || level.mad_x.is_some_and(|value| value < 0)
                        || level.buff_time_r.is_some_and(|value| value < 0)
                        || level.basic_stat_up.is_some_and(|value| value < 0)
                        || level.attack_delay.is_some_and(|value| value < 0)
                        || level
                            .ignore_mob_pdp_r
                            .is_some_and(|value| !(0..=100).contains(&value))
                        || level.hc_hp.is_some_and(|value| value < 0)
                        || level.speed.is_some_and(|value| value < 0)
                        || level.fixdamage.is_some_and(|value| value < 0)
                        // `q` 只拒绝**负数**：源 `2121011 炙焰毒火` 的 common 是 `"q": "0"`
                        // （恒为 0，不是投影错误），写成 `<= 0` 会把这本四转书整本拒掉。
                        // 0 与负数的区别是源事实，不是放宽判据：负 q 在任何一本书里都没出现过。
                        || level.q.is_some_and(|value| value < 0)
                        || level.q2.is_some_and(|value| value < 0)
                        || level.w2.is_some_and(|value| value < 0)
                        || level.u2.is_some_and(|value| value < 0)
                        || level.mob_count.is_some_and(|value| value == 0)
                        || level.attack_count.is_some_and(|value| value == 0)
                        || level.range.is_some_and(|value| value < 0)
                        || level.mob_count.is_some_and(|value| value > mob_limit)
                        || level.attack_count.is_some_and(|value| value > attack_limit)
                        || level
                            .lt
                            .is_some_and(|point| !point.x.is_finite() || !point.y.is_finite())
                        || level
                            .rb
                            .is_some_and(|point| !point.x.is_finite() || !point.y.is_finite())
                        || level
                            .lt
                            .zip(level.rb)
                            .is_some_and(|(lt, rb)| lt.x > rb.x || lt.y > rb.y)
                })
            {
                return Err(format!("invalid mage skill {skill_id}").into());
            }
            for (prerequisite, required_level) in &skill.prerequisites {
                let prerequisite_id: u32 = prerequisite
                    .parse()
                    .map_err(|_| format!("invalid mage prerequisite {skill_id}"))?;
                let Some(prerequisite_skill) = self.get(prerequisite_id) else {
                    return Err(format!("unknown mage prerequisite {prerequisite_id}").into());
                };
                if *required_level == 0 || *required_level > prerequisite_skill.max_level {
                    return Err(format!("invalid mage prerequisite level {skill_id}").into());
                }
            }
            let required = |present: bool, field: &str| {
                present
                    .then_some(())
                    .ok_or_else(|| format!("mage skill {skill_id} is missing {field}"))
            };
            for level in &skill.levels {
                match skill_id {
                    1_000 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.fixdamage.is_some(), "fixdamage")?;
                    }
                    1_001 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.x.is_some(), "x")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    1_002 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.speed.is_some(), "speed")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    2_000_006 => {
                        required(level.mmp_r.is_some(), "mmpR")?;
                        required(level.lv2mmp.is_some(), "lv2mmp")?;
                    }
                    2_000_007 => {
                        required(level.x.is_some(), "x")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.time.is_some(), "time")?;
                    }
                    2_000_010 => required(level.pdd_x.is_some(), "pddX")?,
                    2_001_002 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        // 用户指定规则：结算不再用源 x，改用抵偿率阶梯。
                        required(level.mp_substitute_percent.is_some(), "mpSubstitutePercent")?;
                    }
                    2_001_008 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.range.is_some(), "range")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                    }
                    2_001_009 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.psd_speed.is_some(), "psdSpeed")?;
                        required(level.speed_max.is_some(), "speedMax")?;
                    }
                    2_001_011 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    2_001_012 => {
                        required(level.time.is_some(), "time")?;
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.v.is_some(), "v")?;
                        required(level.w.is_some(), "w")?;
                        required(level.u.is_some(), "u")?;
                        required(
                            level.max_use_count_in_one_jump.is_some(),
                            "maxUseCountInOneJump",
                        )?;
                    }
                    2_200_000 => {
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    2_200_006 => {
                        required(level.mastery.is_some(), "mastery")?;
                        required(level.x.is_some(), "x")?;
                        required(level.cr.is_some(), "cr")?;
                    }
                    2_200_007 | 2_200_012 => required(level.int_x.is_some(), "intX")?,
                    2_200_011 => {
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    2_201_001 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.indie_mad.is_some(), "indieMad")?;
                    }
                    2_201_005 | 2_201_008 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                    }
                    2_201_009 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.time.is_some(), "time")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    2_210_000 => required(level.z.is_some(), "z")?,
                    2_210_001 => {
                        required(level.costmp_r.is_some(), "costmpR")?;
                        required(level.dam_r.is_some(), "damR")?;
                    }
                    2_210_009 => {
                        required(level.cr.is_some(), "cr")?;
                        required(level.critical_damage.is_some(), "criticaldamage")?;
                    }
                    2_210_013 => {
                        required(level.prop.is_some(), "prop")?;
                        required(level.sub_prop.is_some(), "subProp")?;
                    }
                    2_210_016 => {
                        required(level.u.is_some(), "u")?;
                        required(level.md_r.is_some(), "mdR")?;
                    }
                    2_211_002 | 2_211_014 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.time.is_some(), "time")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    2_211_007 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.sub_prop.is_some(), "subProp")?;
                        required(level.time.is_some(), "time")?;
                        required(level.y.is_some(), "y")?;
                        required(level.stance_prop.is_some(), "stanceProp")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    2_211_011 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.time.is_some(), "time")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.s.is_some(), "s")?;
                        required(level.w.is_some(), "w")?;
                        required(level.q.is_some(), "q")?;
                        required(level.u2.is_some(), "u2")?;
                    }
                    2_211_012 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.asr_r.is_some(), "asrR")?;
                        required(level.ter_r.is_some(), "terR")?;
                    }
                    2_211_015 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.time.is_some(), "time")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.u2.is_some(), "u2")?;
                    }
                    2_211_017 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    2_220_010 => {
                        required(level.ignore_mob_pdp_r.is_some(), "ignoreMobpdpR")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.time.is_some(), "time")?;
                    }
                    2_220_013 => {
                        required(level.mad_x.is_some(), "madX")?;
                        required(level.buff_time_r.is_some(), "bufftimeR")?;
                        required(level.stance_prop.is_some(), "stanceProp")?;
                    }
                    2_220_015 => {
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    2_221_000 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.basic_stat_up.is_some(), "basicStatUp")?;
                    }
                    2_221_004 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.q.is_some(), "q")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.w.is_some(), "w")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    2_221_005 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mastery.is_some(), "mastery")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                    }
                    2_221_006 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.time.is_some(), "time")?;
                        required(level.range.is_some(), "range")?;
                        required(level.cr.is_some(), "cr")?;
                    }
                    2_221_007 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.time.is_some(), "time")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.x.is_some(), "x")?;
                    }
                    2_221_008 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.time.is_some(), "time")?;
                    }
                    2_221_011 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.time.is_some(), "time")?;
                        required(level.q.is_some(), "q")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    2_221_012 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.time.is_some(), "time")?;
                        required(level.attack_delay.is_some(), "attackDelay")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    2_220_043 | 2_220_046 | 2_220_049 => {
                        required(level.dam_r.is_some(), "damR")?;
                    }
                    2_220_044 | 2_220_047 | 2_220_050 => {
                        required(level.target_plus.is_some(), "targetPlus")?;
                    }
                    2_221_045 => required(level.x.is_some(), "x")?,
                    2_220_048 => required(level.attack_count.is_some(), "attackCount")?,
                    2_220_051 => required(level.cr.is_some(), "cr")?,
                    2_221_052 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.q.is_some(), "q")?;
                        required(level.x.is_some(), "x")?;
                        required(level.w.is_some(), "w")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.s.is_some(), "s")?;
                    }
                    2_221_053 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.indie_dam_r.is_some(), "indieDamR")?;
                    }
                    2_221_054 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.w.is_some(), "w")?;
                        required(level.time.is_some(), "time")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.u.is_some(), "u")?;
                        required(level.q.is_some(), "q")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    2_221_055 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.w.is_some(), "w")?;
                        required(level.time.is_some(), "time")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.u.is_some(), "u")?;
                        required(level.u2.is_some(), "u2")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // ── 火毒（210/211）与僧侶（230/231）分支 ─────────────────────────
                    // 逐本登记「源里有、运行期模型也认」的字段：源里少了任何一个，投影就会静默
                    // 丢字段。源里那些**运行期模型没有**的字段（`dot`/`nbdR`/`t` 之类）只原样带出、
                    // 不消费，写在每本后面；接管这本技能时再把它们归到某一层。
                    // 2100000 魔力吸收
                    2_100_000 => {
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    // 2100006 咒語精通
                    2_100_006 => {
                        required(level.mastery.is_some(), "mastery")?;
                        required(level.x.is_some(), "x")?;
                        required(level.cr.is_some(), "cr")?;
                    }
                    // 2100007 智慧昇華
                    2_100_007 => {
                        required(level.int_x.is_some(), "intX")?;
                    }
                    // 2100009 元素吸收
                    2_100_009 => {
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.range.is_some(), "range")?;
                    }
                    // 2100010 燎原之火（源里还有 areaDotCount 未进模型）
                    2_100_010 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.time.is_some(), "time")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                    }
                    // 2100011 極速詠唱
                    2_100_011 => {
                        required(level.int_x.is_some(), "intX")?;
                    }
                    // 2101001 精神強化
                    2_101_001 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.indie_mad.is_some(), "indieMad")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2101004 魔火焰彈
                    2_101_004 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2101005 毒霧（源里还有 dot、dotInterval、dotTime 未进模型）
                    2_101_005 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2101010 燎原之火（源里还有 areaDotCount 未进模型）
                    2_101_010 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.x.is_some(), "x")?;
                    }
                    // 2110000 終極魔法(火，毒)
                    2_110_000 => {
                        required(level.x.is_some(), "x")?;
                        required(level.z.is_some(), "z")?;
                    }
                    // 2110001 魔力激發
                    2_110_001 => {
                        required(level.costmp_r.is_some(), "costmpR")?;
                        required(level.dam_r.is_some(), "damR")?;
                    }
                    // 2110009 魔法爆擊
                    2_110_009 => {
                        required(level.cr.is_some(), "cr")?;
                        required(level.critical_damage.is_some(), "criticaldamage")?;
                    }
                    // 2110015 自然力重置
                    2_110_015 => {
                        required(level.x.is_some(), "x")?;
                        required(level.md_r.is_some(), "mdR")?;
                        required(level.u.is_some(), "u")?;
                    }
                    // 2111002 末日烈焰
                    2_111_002 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2111003 致命毒霧（源里还有 dot、dotInterval、dotTime、s2、v2 未进模型）
                    2_111_003 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.u.is_some(), "u")?;
                        required(level.s.is_some(), "s")?;
                        required(level.v.is_some(), "v")?;
                    }
                    // 2111007 瞬間移動精通（源里还有 hcSubProp、hcTime、dot、dotInterval、dotTime 未进模型）
                    2_111_007 => {
                        required(level.prop.is_some(), "prop")?;
                        required(level.sub_prop.is_some(), "subProp")?;
                        required(level.y.is_some(), "y")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.time.is_some(), "time")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.stance_prop.is_some(), "stanceProp")?;
                    }
                    // 2111011 元素適應(火、毒)
                    2_111_011 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.asr_r.is_some(), "asrR")?;
                        required(level.ter_r.is_some(), "terR")?;
                    }
                    // 2111013 劇毒領域（源里还有 dot、dotInterval、dotTime、t、nbdR 未进模型）
                    2_111_013 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.u.is_some(), "u")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.w.is_some(), "w")?;
                        required(level.v.is_some(), "v")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.s.is_some(), "s")?;
                        required(level.w2.is_some(), "w2")?;
                        required(level.x.is_some(), "x")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.u2.is_some(), "u2")?;
                        required(level.attack_delay.is_some(), "attackDelay")?;
                    }
                    // 2111014 劇毒領域
                    2_111_014 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.mp_con.is_some(), "mpCon")?;
                    }
                    // 2111016 瞬間移動爆發
                    2_111_016 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    // 2300000 魔力吸收
                    2_300_000 => {
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    // 2300003 神聖之光（源里还有 damAbsorbShieldR 未进模型）
                    2_300_003 => {}
                    // 2300006 咒語精通
                    2_300_006 => {
                        required(level.mastery.is_some(), "mastery")?;
                        required(level.x.is_some(), "x")?;
                    }
                    // 2300007 智慧昇華
                    2_300_007 => {
                        required(level.int_x.is_some(), "intX")?;
                    }
                    // 2300009 祝福福音
                    2_300_009 => {
                        required(level.x.is_some(), "x")?;
                    }
                    // 2300011 極速詠唱
                    2_300_011 => {
                        required(level.int_x.is_some(), "intX")?;
                    }
                    // 2301002 群體治癒（源里还有 hp、hcCooltime 未进模型）
                    2_301_002 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.hc_hp.is_some(), "hcHp")?;
                        required(level.y.is_some(), "y")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.w.is_some(), "w")?;
                    }
                    // 2301004 天使祝福
                    2_301_004 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.u.is_some(), "u")?;
                        required(level.v.is_some(), "v")?;
                        required(level.w.is_some(), "w")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2301005 神聖之箭
                    2_301_005 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2301010 天使之觸
                    2_301_010 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.time.is_some(), "time")?;
                        required(level.x.is_some(), "x")?;
                        required(level.u.is_some(), "u")?;
                    }
                    // 2310008 神聖集中術（源里还有 ar 未进模型）
                    2_310_008 => {
                        required(level.cr.is_some(), "cr")?;
                        required(level.mastery.is_some(), "mastery")?;
                    }
                    // 2310010 魔法爆擊
                    2_310_010 => {
                        required(level.cr.is_some(), "cr")?;
                        required(level.critical_damage.is_some(), "criticaldamage")?;
                    }
                    // 2310013 聖十字魔法盾
                    2_310_013 => {}
                    // 2311001 淨化（源里还有 hcCooltime、hcProp 未进模型）
                    2_311_001 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.time.is_some(), "time")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.y.is_some(), "y")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    // 2311002 時空門
                    2_311_002 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                    }
                    // 2311003 神聖祈禱（源里还有 lt2、rb2 未进模型）
                    2_311_003 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.x.is_some(), "x")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                    }
                    // 2311004 聖光（源里还有 hcTime、hcProp 未进模型）
                    2_311_004 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.time.is_some(), "time")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2311007 瞬間移動精通（源里还有 hcSubProp、hcTime 未进模型）
                    2_311_007 => {
                        required(level.prop.is_some(), "prop")?;
                        required(level.sub_prop.is_some(), "subProp")?;
                        required(level.y.is_some(), "y")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.time.is_some(), "time")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.stance_prop.is_some(), "stanceProp")?;
                    }
                    // 2311009 聖十字魔法盾
                    2_311_009 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.hc_hp.is_some(), "hcHp")?;
                        required(level.w.is_some(), "w")?;
                        required(level.s.is_some(), "s")?;
                    }
                    // 2311011 神聖之泉
                    2_311_011 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.time.is_some(), "time")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2311012 聖靈守護
                    2_311_012 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.asr_r.is_some(), "asrR")?;
                        required(level.ter_r.is_some(), "terR")?;
                        required(level.u.is_some(), "u")?;
                    }
                    // 2311014 天使之泉
                    2_311_014 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.attack_delay.is_some(), "attackDelay")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2311015 勝利之羽（源里还有 bulletCount 未进模型）
                    2_311_015 => {
                        required(level.time.is_some(), "time")?;
                        required(level.u.is_some(), "u")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.w.is_some(), "w")?;
                        required(level.u2.is_some(), "u2")?;
                    }
                    // 2311016 瞬間移動爆發
                    2_311_016 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    // 2311017 勝利之羽（源里还有 bulletCount 未进模型）
                    2_311_017 => {
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // ── 火毒四转 212 ─────────────────────────
                    // 2120010 神秘狙擊
                    2_120_010 => {
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.ignore_mob_pdp_r.is_some(), "ignoreMobpdpR")?;
                        required(level.time.is_some(), "time")?;
                    }
                    // 2120012 大師魔法
                    2_120_012 => {
                        required(level.mad_x.is_some(), "madX")?;
                        required(level.buff_time_r.is_some(), "bufftimeR")?;
                        required(level.stance_prop.is_some(), "stanceProp")?;
                    }
                    // 2120013 火流星
                    2_120_013 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.prop.is_some(), "prop")?;
                    }
                    // 2120014 元素強化
                    2_120_014 => {
                        required(level.x.is_some(), "x")?;
                    }
                    // 2120043 致命毒霧-強化傷害
                    2_120_043 => {
                        required(level.dam_r.is_some(), "damR")?;
                    }
                    // 2120044 致命毒霧-持續效果（源里还有 dotTime 未进运行期模型）
                    2_120_044 => {
                    }
                    // 2120045 致命毒霧-毒性蔓延（源里还有 dot 未进运行期模型）
                    2_120_045 => {
                    }
                    // 2120046 火焰之襲-強化
                    2_120_046 => {
                        required(level.dam_r.is_some(), "damR")?;
                    }
                    // 2120047 火焰之襲-持續強化（源里还有 dot 未进运行期模型）
                    2_120_047 => {
                    }
                    // 2120048 火焰之襲-額外攻擊
                    2_120_048 => {
                        required(level.attack_count.is_some(), "attackCount")?;
                    }
                    // 2120049 地獄爆發-強化加農
                    2_120_049 => {
                        required(level.dam_r.is_some(), "damR")?;
                    }
                    // 2120050 地獄爆發-無視防禦
                    2_120_050 => {
                        required(level.ignore_mob_pdp_r.is_some(), "ignoreMobpdpR")?;
                    }
                    // 2120051 地獄爆發-冷卻減免（源里还有 coolTimeR 未进运行期模型）
                    2_120_051 => {
                    }
                    // 2121000 楓葉祝福
                    2_121_000 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.basic_stat_up.is_some(), "basicStatUp")?;
                    }
                    // 2121003 地獄爆發（源里还有 s2/updatableTime 未进运行期模型）
                    2_121_003 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.q.is_some(), "q")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.ignore_mob_pdp_r.is_some(), "ignoreMobpdpR")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.w.is_some(), "w")?;
                        required(level.s.is_some(), "s")?;
                    }
                    // 2121004 魔力無限（源里还有 s2 未进运行期模型）
                    2_121_004 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.hc_hp.is_some(), "hcHp")?;
                        required(level.w.is_some(), "w")?;
                        required(level.q.is_some(), "q")?;
                        required(level.w2.is_some(), "w2")?;
                        required(level.u.is_some(), "u")?;
                        required(level.s.is_some(), "s")?;
                    }
                    // 2121005 召喚火魔（源里还有 dot/dotInterval/dotTime 未进运行期模型）
                    2_121_005 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mastery.is_some(), "mastery")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                    }
                    // 2121006 火焰之襲（源里还有 dot/dotInterval/dotTime/hcProp/hcTime 未进运行期模型）
                    2_121_006 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.x.is_some(), "x")?;
                        required(level.time.is_some(), "time")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2121007 火流星（源里还有 hcCooltime 未进运行期模型）
                    2_121_007 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.x.is_some(), "x")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.u.is_some(), "u")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.y.is_some(), "y")?;
                    }
                    // 2121008 楓葉淨化　
                    2_121_008 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.time.is_some(), "time")?;
                    }
                    // 2121011 炙焰毒火（源里还有 dot/dotInterval/dotTime/s2 未进运行期模型）
                    2_121_011 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.time.is_some(), "time")?;
                        required(level.range.is_some(), "range")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.x.is_some(), "x")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.s.is_some(), "s")?;
                        required(level.q.is_some(), "q")?;
                        required(level.u.is_some(), "u")?;
                        required(level.v.is_some(), "v")?;
                    }
                    // 2121052 藍焰斬（源里还有 bulletCount/dot/dotInterval/dotTime/v2 未进运行期模型）
                    2_121_052 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.y.is_some(), "y")?;
                        required(level.v.is_some(), "v")?;
                        required(level.u2.is_some(), "u2")?;
                        required(level.u.is_some(), "u")?;
                        required(level.w.is_some(), "w")?;
                        required(level.w2.is_some(), "w2")?;
                    }
                    // 2121053 傳說冒險
                    2_121_053 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.indie_dam_r.is_some(), "indieDamR")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2121054 火靈結界（源里还有 dot/dotInterval/dotTime 未进运行期模型）
                    2_121_054 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.x.is_some(), "x")?;
                    }
                    // ── 主教四转 232 ─────────────────────────
                    // 2320011 神秘狙擊
                    2_320_011 => {
                        required(level.prop.is_some(), "prop")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.ignore_mob_pdp_r.is_some(), "ignoreMobpdpR")?;
                        required(level.time.is_some(), "time")?;
                    }
                    // 2320012 大師魔法
                    2_320_012 => {
                        required(level.mad_x.is_some(), "madX")?;
                        required(level.buff_time_r.is_some(), "bufftimeR")?;
                        required(level.stance_prop.is_some(), "stanceProp")?;
                        required(level.md_r.is_some(), "mdR")?;
                    }
                    // 2320013 祝福旋律
                    2_320_013 => {
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    // 2320043 聖十字魔法盾-額外防禦
                    2_320_043 => {
                        required(level.x.is_some(), "x")?;
                    }
                    // 2320044 聖十字魔法盾-持續防禦
                    2_320_044 => {
                        required(level.time.is_some(), "time")?;
                    }
                    // 2320045 聖十字魔法盾-效果強化
                    2_320_045 => {
                        required(level.w.is_some(), "w")?;
                    }
                    // 2320046 神聖祈禱-經驗提升
                    2_320_046 => {
                        required(level.y.is_some(), "y")?;
                    }
                    // 2320047 神聖祈禱-抗性提升
                    2_320_047 => {
                        required(level.asr_r.is_some(), "asrR")?;
                        required(level.ter_r.is_some(), "terR")?;
                    }
                    // 2320048 神聖祈禱-掉寶提升
                    2_320_048 => {
                        required(level.v.is_some(), "v")?;
                    }
                    // 2320049 進階祝福-加碼傷害
                    2_320_049 => {
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                    }
                    // 2320050 進階祝福-魔王剋星（源里还有 bdR 未进运行期模型）
                    2_320_050 => {
                    }
                    // 2320051 進階祝福-血魔加成（源里还有 indieMhp/indieMmp 未进运行期模型）
                    2_320_051 => {
                    }
                    // 2321000 楓葉祝福
                    2_321_000 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.basic_stat_up.is_some(), "basicStatUp")?;
                    }
                    // 2321001 核爆術（源里还有 nbdR 未进运行期模型）
                    2_321_001 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2321003 召喚聖龍
                    2_321_003 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                    }
                    // 2321004 魔力無限（源里还有 s2 未进运行期模型）
                    2_321_004 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.hc_hp.is_some(), "hcHp")?;
                        required(level.w.is_some(), "w")?;
                        required(level.q.is_some(), "q")?;
                        required(level.w2.is_some(), "w2")?;
                        required(level.u.is_some(), "u")?;
                        required(level.s.is_some(), "s")?;
                    }
                    // 2321005 進階祝福（源里还有 indieMhp/indieMmp/mpConReduce 未进运行期模型）
                    2_321_005 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.u.is_some(), "u")?;
                        required(level.v.is_some(), "v")?;
                        required(level.w.is_some(), "w")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2321006 復甦之光
                    2_321_006 => {
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.x.is_some(), "x")?;
                        required(level.sub_time.is_some(), "subTime")?;
                        required(level.y.is_some(), "y")?;
                        required(level.z.is_some(), "z")?;
                        required(level.w.is_some(), "w")?;
                        required(level.u.is_some(), "u")?;
                    }
                    // 2321007 天使之箭（源里还有 hp/t 未进运行期模型）
                    2_321_007 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.range.is_some(), "range")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.u.is_some(), "u")?;
                        required(level.w.is_some(), "w")?;
                    }
                    // 2321008 天怒
                    2_321_008 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.cr.is_some(), "cr")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.attack_delay.is_some(), "attackDelay")?;
                        required(level.u.is_some(), "u")?;
                        required(level.y.is_some(), "y")?;
                    }
                    // 2321009 楓葉淨化　
                    2_321_009 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.time.is_some(), "time")?;
                    }
                    // 2321015 神聖之水（源里还有 dot/s2/v2 未进运行期模型）
                    2_321_015 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.u.is_some(), "u")?;
                        required(level.w.is_some(), "w")?;
                        required(level.range.is_some(), "range")?;
                        required(level.x.is_some(), "x")?;
                        required(level.y.is_some(), "y")?;
                        required(level.s.is_some(), "s")?;
                        required(level.q.is_some(), "q")?;
                        required(level.q2.is_some(), "q2")?;
                        required(level.v.is_some(), "v")?;
                        required(level.u2.is_some(), "u2")?;
                        required(level.w2.is_some(), "w2")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2321016 神聖之血
                    2_321_016 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.u.is_some(), "u")?;
                        required(level.q.is_some(), "q")?;
                        required(level.v.is_some(), "v")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                    }
                    // 2321052 天堂之門
                    2_321_052 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.time.is_some(), "time")?;
                    }
                    // 2321053 傳說冒險
                    2_321_053 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.time.is_some(), "time")?;
                        required(level.cooltime.is_some(), "cooltime")?;
                        required(level.indie_dam_r.is_some(), "indieDamR")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                    }
                    // 2321054 復仇天使（源里还有 cooltimeMS 未进运行期模型）
                    2_321_054 => {
                        required(level.mp_con.is_some(), "mpCon")?;
                        required(level.ignore_mob_pdp_r.is_some(), "ignoreMobpdpR")?;
                        required(level.md_r.is_some(), "mdR")?;
                        required(level.mad_x.is_some(), "madX")?;
                        required(level.x.is_some(), "x")?;
                        required(level.u.is_some(), "u")?;
                    }
                    // 2321055 天堂之門
                    2_321_055 => {
                        required(level.damage.is_some(), "damage")?;
                        required(level.attack_count.is_some(), "attackCount")?;
                        required(level.mob_count.is_some(), "mobCount")?;
                        required(level.lt.is_some(), "lt")?;
                        required(level.rb.is_some(), "rb")?;
                        required(level.time.is_some(), "time")?;
                    }
                    // 未接执行链的技能：只做上面的通用范围校验，不要求字段契约。
                    //
                    // 这张 `match` 是「**运行期真正消费的技能**」的字段契约（谁消费哪些
                    // 字段、哪些字段不许缺席）。改前写的是 `_ => unreachable!()`——那在本包
                    // 只有法师 11 本 / 153 条时成立，因为每个条目都有契约臂。2026-09-22
                    // 目录扩到四条职业线 35 本 / 504 条后，只有一转主动技能接了执行链
                    // （见交付记录），其余条目**没有运行期消费者**，不该被要求有契约臂。
                    // 谁把一条新技能接进执行链，就必须同时在这里给它加臂；
                    // `scripts/check_tms273_attributes.cjs` / `check_tms273_damage_pipeline.cjs`
                    // 会按「源里带这个字段」反向要求服务端声明，漏接会在门禁红而不是这里静默。
                    _ => {}
                }
            }
        }
        Ok(())
    }

    pub fn get(&self, skill_id: u32) -> Option<&MageSkill> {
        self.skills.get(&skill_id.to_string())
    }

    pub fn level(&self, skill_id: u32, level: u32) -> Option<&MageLevel> {
        level.checked_sub(1).and_then(|index| {
            self.get(skill_id)
                .and_then(|skill| skill.levels.get(index as usize))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_catalog_is_strict_and_has_energy_bolt_geometry() {
        let catalog = MageSkills::bundled();
        // The catalog grows whenever another source row is exported; the point
        // of this assertion is that it never *loses* rows, so it is a floor.
        assert!(
            catalog.skills.len() >= 43,
            "bundled catalog shrank to {} rows",
            catalog.skills.len()
        );
        let bolt = catalog.get(2_001_008).expect("energy bolt catalog row");
        assert_eq!(bolt.max_level, 20);
        let level = catalog.level(2_001_008, 1).expect("energy bolt level 1");
        assert_eq!(level.mob_count, Some(4));
        assert_eq!(level.attack_count, Some(4));
        assert_eq!(level.range, Some(340));
        assert!(level.lt.is_some_and(|point| point.x <= point.y));
        assert!(catalog.get(2_000_007).is_some_and(|skill| skill.hidden));
        assert!(catalog.get(2_001_012).is_some_and(|skill| skill.hidden));
        let cold = catalog.get(2_201_008).expect("cold beam catalog row");
        assert_eq!(cold.book_id, 220);
        assert_eq!(
            catalog
                .level(2_201_008, 1)
                .and_then(|level| level.mob_count),
            Some(6)
        );
        assert!(catalog
            .get(2_200_011)
            .is_some_and(|skill| skill.fixed_level));
        let throw = catalog.level(1_000, 3).expect("beginner throw level 3");
        assert_eq!(throw.mp_con, Some(7));
        assert_eq!(throw.fixdamage, Some(40));
        assert_eq!(catalog.level(1_001, 3).and_then(|level| level.x), Some(12));
        assert_eq!(
            catalog.level(1_002, 3).and_then(|level| level.speed),
            Some(20)
        );
        assert!(catalog.get(2_211_015).is_some_and(|skill| skill.hidden));
    }
}
