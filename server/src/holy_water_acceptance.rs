/// 神聖之水 `2321015`（主教四转**主动：攒瓶 → 摆杯 → 上键吸收**）的接线验收（2026-09-24）。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `hw_` 前缀
/// （`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 要钉住的是**判据**，不是某个数字。四条判据各自都有「删掉它也能全绿」的退化形态，
/// 所以每条都必须配一个反例：
///
/// * **瓶数走真实持久化**：源把「命中 `u` 次得 1 瓶、最多攒 `w` 瓶」写成**跨施放的
///   累积资源**，所以两个计数落在 `player_stats` 的两列上、不经 `Profile` 快照。判据是
///   「重登之后**瓶数与余数都还在**」——只测瓶数会漏掉余数（重登后进度倒退），
///   只测内存会漏掉整列没写。
/// * **「空间不足」＝逐点问地面**：源「若空間不足則僅形成部分聖水」的判据是
///   [`holy_water::candidate_offsets`] 铺在源框 `lt`/`rb` 内的候选点**各自**去问
///   `Map::ground_below`，取不到的**不生成**。判据的两侧都要测：地形够宽时「每瓶都摆得下」，
///   以及**合成一片只覆盖框左端的地面**时「只摆得下 1 只」。只测前者的话，
///   把逐点问地面改成「容器里随便找个位置」也能全绿。
/// * **「一只也没摆下」不是失败**：源把它写成消耗之后的正常分支，所以施放仍要放行、
///   瓶数仍要被消耗。若谁加了「摆不下就回滚」的兜底，这条会红。
/// * **吸收的三条裁决**（距离 / 同图 / 归属）各有自己的拒绝码：源只写「隊員對聖杯按下
///   「上」方向鍵」，距离与框都是本包补的（reach 与 `portals.rs` 逐值相同），所以
///   三条都要有反例——尤其**归属**那条（同图非队友）与**跨图**那条（地图键对不上）。
/// * **`v2` 的前提是「有剩餘持續時間」**：两条清除点必须分开测——施法者离图（提前清除）
///   要按 `v2` 补偿，自然到期**不补**。只测前者的话，把 `has_remaining_time` 整个删掉
///   也能全绿（到期的杯子当时还在表里，照样会被补一次）。
/// * **`u` / `w` / `q` / `s2` / `q2` / `u2` / `dot` / `w2` / `v2` 全部逐级相同** ⇒ 本文件
///   用 L1 的 [`hw_rules`] 算期望值，另在①里断言 L10 与 L1 逐字段相同。
const HW_BISHOP: &str = "hw-bishop";
const HW_MATE: &str = "hw-mate";
const HW_STRANGER: &str = "hw-stranger";
const HW_PARTY: &str = "hw-party";
const HW_BISHOP_JOB: u32 = 232;
/// 「另一张图」。源框是**绕施法者**的，所以跨图判定只需要 `map_id` 不相等；
/// 这个名字不进 `world.maps`，`World::map_for` 会回落到默认地图（与 `chapter_place`
/// 的其它用法一致——它写的是 `map_id` 字符串，不做目录校验）。
const HW_ELSEWHERE: &str = "hw-elsewhere";

/// 一名主教四转当事人 + 一名同图同队队员 + 一名同图**非队友**，全部走真实 `Store`
/// 与真实地图目录，并且**三个人的收件箱都留着**。
///
/// ⚠️ 必须保留每一路 `Receiver`：吸收的恢复跳字按源「隊員…可恢復HP」发给**按上键的
/// 那个人**，不是发给施法者。上一轮（`revive_light_acceptance.rs`）只留施法者的收件箱
/// 是够用的，本技能不够——收件箱被丢掉时 `try_send` 静默失败，断言会「看不到事件」
/// 而不是「事件发错人」，两者看起来一模一样。
struct HwRig {
    world: World,
    bishop: mpsc::Receiver<String>,
    mate: mpsc::Receiver<String>,
    stranger: mpsc::Receiver<String>,
    store: auth::Store,
    /// 存档文件的路径。**夹具需要另一条只读连接**去清 `skill_cooldowns` 表：
    /// `Store` 的 `db` 字段是 `auth` 私有的（`third_store_acceptance.rs` 能拿到是因为
    /// 它被 `include!` 进了 `auth` 自己的测试模块，本文件在 `world::tests` 里拿不到）。
    path: std::path::PathBuf,
}

fn hw_rig() -> HwRig {
    let path = std::env::temp_dir().join(format!("maple-hw-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    let store = service.store.clone();
    for id in [HW_BISHOP, HW_MATE, HW_STRANGER] {
        let mut profile = quest_profile();
        profile.level = 190;
        profile.job = HW_BISHOP_JOB;
        profile.hp = 40_000;
        profile.max_hp = 40_000;
        profile.mp = 60_000;
        profile.max_mp = 60_000;
        // 学习要过 `not_enough_sp`（`auth/skills.rs` 按 `book_id` 查这一格），
        // 所以 SP 必须**先写进数据库**、不能只在内存里补。
        profile.skill_points = BTreeMap::from([(HW_BISHOP_JOB, 255)]);
        store.load_profile(id, &profile).expect("seed profile");
        store.save_profile(id, &profile).expect("save profile");
    }
    let mut world = chapter_actual_world(store.clone()).with_mage_skills(MageSkills::bundled());
    let mut bishop = chapter_join(&mut world, HW_BISHOP);
    let mut mate = chapter_join(&mut world, HW_MATE);
    let mut stranger = chapter_join(&mut world, HW_STRANGER);
    chapter_drain(&mut bishop);
    chapter_drain(&mut mate);
    chapter_drain(&mut stranger);
    // 三个人都站到**真实地面**上：源框的纵向跨度是 `lt.y = -100` / `rb.y = 20`（相对
    // 施法者），`chapter_place` 默认的 (100, 100) 未必踩在 foothold 上 ⇒ 候选点全部落空、
    // 「地形够宽时每瓶都摆得下」会变成一条永远拿不到圣杯的断言。
    let home = world.players[HW_BISHOP].map_id.clone();
    for id in [HW_BISHOP, HW_MATE, HW_STRANGER] {
        hw_stand(&mut world, id, &home);
        world.players.get_mut(id).expect("joined").state.facing = 1;
    }
    // 队伍＝主教 + 队员。`hw-stranger` 站在同一张图上但**不在队里** ——
    // 那是「归属判据真的是队伍」的唯一反例。
    world.parties.insert(
        HW_PARTY.to_owned(),
        Party {
            id: HW_PARTY.to_owned(),
            leader_id: HW_BISHOP.to_owned(),
            members: vec![HW_BISHOP.to_owned(), HW_MATE.to_owned()],
        },
    );
    // ⚠️ 学技能必须走**真实路径**（store + 内存一起落）：`advance_holy_water_charge`
    // 读 `player.state.skills`，而 store-backed 世界里 `handle_learn_skill` 把等级判据
    // 交给 `auth/skills.rs` 的数据库事务（只写内存会让每次施法以 `not_learned` 收场，
    // 看起来像「机制没生效」）。
    world.handle_learn_skill(HW_BISHOP.into(), "hw-learn".into(), SKILL_HOLY_WATER);
    let learned = chapter_drain(&mut bishop);
    assert!(
        learned
            .iter()
            .any(|value| value["type"] == "skillResult" && value["success"] == true),
        "夹具失效：神聖之水没有被学会：{learned:?}"
    );
    HwRig {
        world,
        bishop,
        mate,
        stranger,
        store,
        path,
    }
}

/// 把玩家放**在某条够宽的水平 foothold 的中心**上。
///
/// 判据不是「y 等于某个数」，而是「源框 `lt.x = -40` / `rb.x = 40` 里的每个候选点
/// 都还在这条 foothold 上」：所以这里挑**最长的一条水平 foothold**，宽度不足 80 时
/// 直接判夹具失效（否则「地形够宽」那条断言测的其实是地形不够宽）。
fn hw_stand(world: &mut World, id: &str, map_id: &str) {
    let (x, y) = hw_flat_ground(world, map_id);
    chapter_place(world, id, map_id, x, y);
}

fn hw_flat_ground(world: &World, map_id: &str) -> (f64, f64) {
    let map = world.map_for(map_id);
    let target = map
        .footholds
        .iter()
        .filter(|foothold| {
            !foothold.is_wall()
                && (foothold.y2 - foothold.y1).abs() < 1.0
                && (foothold.right() - foothold.left()) >= 80.0
        })
        .max_by(|a, b| (a.right() - a.left()).total_cmp(&(b.right() - b.left())))
        .expect("夹具失效：这张图上没有一条宽度 ≥ 80 的水平 foothold，源框放不下");
    let x = (target.left() + target.right()) / 2.0;
    (x, target.at(x).expect("中心点落在 foothold 上"))
}

/// 把某张图的地形**换掉**（只用于「空间不足」那一组断言）。
///
/// `World::map_for` 优先查目录、查不到才回落 `World::map`，所以两处都要能改；
/// 改完由调用方断言 `map_for` 真的看到新地形（只改一处而判据读另一处时，
/// 手术会静默无效、「只摆得下 1 只」变成「一只也摆不下」）。
fn hw_replace_terrain(world: &mut World, map_id: &str, footholds: Vec<Foothold>) {
    match world.maps.get_mut(map_id) {
        Some(map) => map.footholds = footholds,
        None => world.map.footholds = footholds,
    }
}

/// 从源等级行派生运行期规则。缺字段直接炸：源里 `u`/`w`/`q`/`s2`/`q2`/`u2`/`dot`/`w2`/`v2`
/// 一个都不能少（`holy_water.rs::from_level` 也因此返回 `Option`）。
fn hw_rules(world: &World) -> holy_water::HolyWaterRules {
    let level = mech_level(world, SKILL_HOLY_WATER);
    holy_water::HolyWaterRules::from_level(&level).expect("2321015 的源字段齐备")
}

/// 连放好几次的那条路：把挡路的**两份**冷却都归位，MP 也补满。
///
/// 源 `cooltime` = 10 秒、`mpCon` = 100 —— 两者都走 `skills.rs` 的**既有管道**
/// （四转书冷却分支 / 通用 MP 扣减），不是本文件要钉的判据（冷却本身在 test ④
/// 里有一条正式断言）。
///
/// ⚠️ **两份冷却都要清**：
///   * 内存的 `player.skill_cooldowns`（`skills.rs` 开头那道闸）；
///   * **落库的** `skill_cooldowns` 表（`store.cast_skill_with_cooldown` 读它）。
/// 只清内存那份的话，第二次施放会被 `handle_cast_skill` 里
/// `if !outcome.success { send_skill_result_with_request(…); return; }` 挡下 ——
/// 注意那条分支**只回一条 `skillResult`、连 `rejected` 都不发**，于是失败会表现成
/// 「一只圣杯也没摆下、瓶数还在」，看起来像地形问题，而不是冷却问题。
fn hw_ready(world: &mut World, id: &str, path: &std::path::Path) {
    let player = world.players.get_mut(id).expect("joined");
    player.skill_cooldowns.clear();
    player.state.mp = player.state.max_mp;
    player.state.action = "stand";
    player.state.climbing = false;
    player.attack_until = 0;
    player.channel_until = 0;
    hw_reset_durable_cooldowns(path, id);
}

/// 清掉这一格落库的冷却。用**另一条 `rusqlite` 连接**直改表：产品的冷却读写在
/// `auth` 里，测试只能从文件下手（同 `third_store_acceptance.rs` 的做法）。
fn hw_reset_durable_cooldowns(path: &std::path::Path, id: &str) {
    let Ok(db) = rusqlite::Connection::open(path) else {
        return;
    };
    let _ = db.execute("DELETE FROM skill_cooldowns WHERE account_id=?1", [id]);
}

/// 读落库的冷却到期时刻（epoch 毫秒）。`None` = 这一格**根本没有持久冷却**。
fn hw_durable_ready_at(path: &std::path::Path, id: &str, skill: u32) -> Option<i64> {
    let db = rusqlite::Connection::open(path).ok()?;
    db.query_row(
        "SELECT ready_at_ms FROM skill_cooldowns WHERE account_id=?1 AND skill_id=?2",
        rusqlite::params![id, i64::from(skill)],
        |row| row.get(0),
    )
    .ok()
}

fn hw_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn hw_cast(world: &mut World, id: &str, request_id: &str) {
    world.handle_cast_skill(
        id.into(),
        request_id.into(),
        SKILL_HOLY_WATER,
        Some(1),
        Some(0),
    );
}

/// 摆下**恰好一只**圣杯并返回它的 id（把累积瓶数直接置 1 ⇒ 候选点只有框中心那一个，
/// 位置因此完全确定）。⚠️ 先清空场上已有的杯子，否则返回值可能是上一批里的某一只。
///
/// 需要 `rx` 是为了让失败信息带上**被拒原因**与**逐候选点的地面查询结果**：
/// 「一只也没摆下」在只看长度的断言里是一句无法归因的闲话（施放被拒、地形没踩上、
/// 位置算错，三种都会长这样）。
fn hw_place_one(
    world: &mut World,
    id: &str,
    request_id: &str,
    rx: &mut mpsc::Receiver<String>,
    path: &std::path::Path,
) -> String {
    world.holy_waters.clear();
    hw_ready(world, id, path);
    {
        let player = world.players.get_mut(id).expect("joined");
        player.holy_water_charges = 1;
        player.holy_water_hits = 0;
    }
    hw_cast(world, id, request_id);
    let events = hw_drain(rx);
    assert_eq!(
        hw_codes(&events),
        Vec::<String>::new(),
        "夹具施放被拒了：{events:?}"
    );
    assert_eq!(
        world.holy_waters.len(),
        1,
        "没有摆下圣杯（施放后瓶数={} 余数={} 已学等级={:?} tick={}）：{}",
        world.players[id].holy_water_charges,
        world.players[id].holy_water_hits,
        world.players[id].state.skills.get(&SKILL_HOLY_WATER),
        world.tick,
        hw_placement_diagnostics(world, id, 1)
    );
    world.holy_waters.keys().next().cloned().unwrap()
}

/// 把「为什么一只都没摆下」讲清楚：施法者的位置与朝向、`map_for` 看到的那张图有几个
/// foothold、以及**逐候选点**各自的 `ground_below` 结果与两条判据（`search_from` /
/// `box_floor`）。判据来自 `spawn_holy_waters`，这里只是把它重算一遍印出来。
fn hw_placement_diagnostics(world: &World, id: &str, count: u32) -> String {
    let Some(player) = world.players.get(id) else {
        return "玩家不在世界里".to_owned();
    };
    let map_id = player.map_id.clone();
    let map = world.map_for(&map_id);
    let level = mech_level(world, SKILL_HOLY_WATER);
    let Some((lo, hi)) = holy_water::HolyWaterRules::placement_box(&level) else {
        return "源里没有框".to_owned();
    };
    let search_from = player.state.y + lo.1;
    let box_floor = player.state.y + hi.1;
    let mut parts = vec![format!(
        "map={map_id} pos=({:.1},{:.1}) facing={} footholds={} search_from={search_from:.1} box_floor={box_floor:.1}",
        player.state.x,
        player.state.y,
        player.state.facing,
        map.footholds.len()
    )];
    for (dx, _) in holy_water::candidate_offsets(lo, hi, count, player.state.facing) {
        let candidate_x = player.state.x + dx;
        let hit = map.ground_below(candidate_x, search_from);
        let verdict = match hit {
            Some((_, ground)) if ground <= box_floor => format!("ok ground={ground:.1}"),
            Some((_, ground)) => format!("below box_floor ground={ground:.1}"),
            None => "no ground".to_owned(),
        };
        parts.push(format!("dx={dx:.1} x={candidate_x:.1} {verdict}"));
    }
    parts.join(" | ")
}

fn hw_drain(rx: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    chapter_drain(rx)
}

fn hw_codes(events: &[serde_json::Value]) -> Vec<String> {
    events
        .iter()
        .filter(|value| value["type"] == "rejected")
        .map(|value| value["code"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn hw_water(world: &World, water_id: &str) -> (f64, f64, i64) {
    let water = &world.holy_waters[water_id];
    (water.x, water.y, water.heal_permille)
}

// ── ① 接纳表 + 源形状（含「它不是 Hyper」与「攒瓶不在自己身上」的反向对照） ──────

#[test]
fn hw_acceptance_table_and_source_shape() {
    assert_eq!(HOLY_WATER_SKILLS, [SKILL_HOLY_WATER]);
    assert_eq!(SKILL_HOLY_WATER, 2321015);
    // 攒瓶那条被动归**天使之箭**，不归它自己：源「每當天使之箭命中敵人時…」。
    assert_eq!(HOLY_WATER_CHARGE_SKILLS, [SKILL_ANGELIC_ARROW]);
    assert_eq!(SKILL_ANGELIC_ARROW, 2321007);
    assert!(
        !HOLY_WATER_CHARGE_SKILLS.contains(&SKILL_HOLY_WATER),
        "攒瓶那条被接到了技能自己身上 —— 源说圣水来自天使之箭的命中"
    );

    let rig = hw_rig();
    let world = &rig.world;
    let skill = world
        .mage_skills
        .get(SKILL_HOLY_WATER)
        .expect("2321015 在技能目录里");
    // ⚠️ **它不是 Hyper 技能**（源 `hyper: 0`、`maxLevel: 10`、`requiredLevel: 0`）。
    assert_eq!(
        skill.hyper, 0,
        "2321015 被判成了 Hyper —— `handle_cast_skill` 的等级闸门会跟着生效"
    );
    assert_eq!(skill.max_level, 10);
    assert!(!skill.hidden, "神聖之水必须可见（要有施放按钮）");
    // 反向对照：没有它，「hyper 0 就不是 Hyper」只是一句没有反例的口号。
    let hyper = world.mage_skills.get(2321054).expect("对照用的真 Hyper");
    assert_eq!(
        (hyper.hyper, hyper.max_level),
        (2, 1),
        "反向对照失守：真 Hyper 的形状不再是 (hyper 2, maxLevel 1)"
    );

    let level = mech_level(world, SKILL_HOLY_WATER);
    // 源 `common` 的 `lt`／`rb` 是**一对 `vector`**（导出树 `rawWz` 的 `_dirType`）。
    // ⚠️ **不是零矩形**：`references/tms273-data/*-source.json` 把整类 `vector` 丢成
    // `{}`，照它读会以为「源没给框」——唯一可信的输入是导出树的 `rawWz`。
    let lt = level.lt.as_ref().expect("源 common 有 lt（vector）");
    let rb = level.rb.as_ref().expect("源 common 有 rb（vector）");
    assert_eq!(
        (lt.x, lt.y, rb.x, rb.y),
        (-40.0, -100.0, 40.0, 20.0),
        "源框被投影成了别的数 —— 圣杯的生成位置会跟着漂"
    );

    // 源逐级值（**十档完全相同** ⇒ 本文件用 L1 算期望值、并在此断言 L10 与 L1 相等）。
    assert_eq!(
        (
            level.u,
            level.w,
            level.q,
            level.q2,
            level.s2,
            level.u2,
            level.w2,
            level.dot,
            level.v2
        ),
        (
            Some(7),
            Some(5),
            Some(5),
            Some(5),
            Some(2_500),
            Some(5),
            Some(5),
            Some(2_500),
            Some(50)
        ),
        "源的 u/w/q/q2/s2/u2/w2/dot/v2 变了 —— `holy_water.rs` 的派生与门禁都要跟着核"
    );
    assert_eq!(level.mp_con, Some(100), "源 L1 的 mpCon 是 100（走通用 MP 管道）");
    assert_eq!(
        level.cooltime,
        Some(10),
        "源 L1 的 cooltime 是 10 秒（走四转书那一支，本技能不新增冷却分支）"
    );
    assert_eq!(level.range, Some(200), "源 `range` 仍非零 —— 它登记为**不消费**");
    let last = world
        .mage_skills
        .level(SKILL_HOLY_WATER, 10)
        .cloned()
        .expect("2321015 L10");
    assert_eq!(
        (
            last.u, last.w, last.q, last.q2, last.s2, last.u2, last.w2, last.dot, last.v2,
            last.cooltime
        ),
        (
            level.u, level.w, level.q, level.q2, level.s2, level.u2, level.w2, level.dot,
            level.v2, level.cooltime
        ),
        "源不再逐级相同 —— 「按 L1 算期望值」这条前提没了"
    );
    // 派生出来的东西与源逐项对得上（`%` 存千分比、秒存毫秒）。
    let rules = hw_rules(world);
    assert_eq!(rules.hits_per_bottle(), 7);
    assert_eq!(rules.charges_cap(), 5);
    assert_eq!(rules.lifetime_ms(0), 5_000, "基础时长是源 `q` = 5 秒");
    assert_eq!(rules.lifetime_ms(2_500), 10_000, "满一档（`s2`）加 `q2` = 5 秒");
    assert_eq!(rules.heal_permille(0), 50, "基础恢复是源 `u2` = 5%");
    assert_eq!(rules.heal_permille(2_500), 100, "满一档（`dot`）加 `w2` = 5%");
    assert_eq!(rules.burst_permille(), 500, "补偿是源 `v2` = 50%");
}

// ── ② 攒瓶：天使之箭每 `u` 次命中 1 瓶、到顶停摆、没学的不攒 ────────────────────

#[test]
fn hw_charges_accumulate_per_source_period_and_saturate_at_the_cap() {
    let mut rig = hw_rig();
    let world = &mut rig.world;
    let rules = hw_rules(world);
    let hits = rules.hits_per_bottle();
    let cap = rules.charges_cap();

    let (mut now_hits, mut now_charges) = (
        world.players[HW_BISHOP].holy_water_hits,
        world.players[HW_BISHOP].holy_water_charges,
    );
    assert_eq!((now_hits, now_charges), (0, 0), "新账号一开始不该有瓶");

    for hit in 1..hits {
        world.advance_holy_water_charge(HW_BISHOP);
        now_hits += 1;
        assert_eq!(
            (
                world.players[HW_BISHOP].holy_water_hits,
                world.players[HW_BISHOP].holy_water_charges
            ),
            (now_hits, 0),
            "第 {hit} 次命中不该成瓶（源 `u` = {hits}）"
        );
    }
    world.advance_holy_water_charge(HW_BISHOP);
    assert_eq!(
        (
            world.players[HW_BISHOP].holy_water_hits,
            world.players[HW_BISHOP].holy_water_charges
        ),
        (0, 1),
        "第 {hits} 次命中该成一瓶，且余数归零"
    );
    // 落库：攒成瓶那一刻就已经写进存档（不是等到施放或下线）。
    assert_eq!(
        rig.store.holy_water_state(HW_BISHOP).unwrap(),
        (1, 0),
        "攒出来的瓶数没有落库 —— 重登就少一瓶"
    );

    // 攒满到上限：再多命中**一律不动**（否则施放放空之后会立刻从余数里回补）。
    for _ in 0..(hits * cap * 2) {
        world.advance_holy_water_charge(HW_BISHOP);
    }
    assert_eq!(
        world.players[HW_BISHOP].holy_water_charges, cap,
        "瓶数越过了源上限 `w` = {cap}"
    );
    let saturated = (
        world.players[HW_BISHOP].holy_water_hits,
        world.players[HW_BISHOP].holy_water_charges,
    );
    for _ in 0..hits {
        world.advance_holy_water_charge(HW_BISHOP);
    }
    assert_eq!(
        (
            world.players[HW_BISHOP].holy_water_hits,
            world.players[HW_BISHOP].holy_water_charges
        ),
        saturated,
        "到顶之后命中还在推进余数 —— 施放放空一次就会凭空回补一瓶"
    );
    assert_eq!(rig.store.holy_water_state(HW_BISHOP).unwrap().0, cap);

    // 没学这本的人不攒瓶：源把它写成 `2321015` 自己的被动效果。
    for _ in 0..hits {
        world.advance_holy_water_charge(HW_STRANGER);
    }
    assert_eq!(
        (
            world.players[HW_STRANGER].holy_water_hits,
            world.players[HW_STRANGER].holy_water_charges
        ),
        (0, 0),
        "没学 2321015 的人也在攒瓶 —— 被动归属错了"
    );
}

// ── ③ 两个计数跨重登存活（走 `player_stats` 两列，不经 `Profile`） ─────────────

#[test]
fn hw_charges_and_the_partial_hit_survive_a_relogin() {
    let mut rig = hw_rig();
    let hits = hw_rules(&rig.world).hits_per_bottle();
    // 3 瓶 + 一个没成瓶的余数：**余数也要留下**，否则重登之后进度倒退。
    for _ in 0..(hits * 3 + 2) {
        rig.world.advance_holy_water_charge(HW_BISHOP);
    }
    assert_eq!(
        (
            rig.world.players[HW_BISHOP].holy_water_charges,
            rig.world.players[HW_BISHOP].holy_water_hits
        ),
        (3, 2)
    );

    // 重登：同一个 store、新的世界（与真实登录同一条路：`commands.rs` 登录时读这两列）。
    let mut second = chapter_actual_world(rig.store.clone()).with_mage_skills(MageSkills::bundled());
    let mut rx = chapter_join(&mut second, HW_BISHOP);
    let joined = chapter_drain(&mut rx);
    assert!(
        joined.iter().any(|value| value["type"] == "snapshot"),
        "重登没有拿到快照：{joined:?}"
    );
    assert_eq!(
        (
            second.players[HW_BISHOP].holy_water_charges,
            second.players[HW_BISHOP].holy_water_hits
        ),
        (3, 2),
        "重登之后瓶数/余数丢了 —— 源把圣水写成跨施放的累积资源"
    );
    // 直读列，确认「重登看到的值」确实来自存档、而不是被内存带过去的。
    assert_eq!(rig.store.holy_water_state(HW_BISHOP).unwrap(), (3, 2));
}

// ── ④ 施放：消耗全部瓶数、按源框摆杯、「空间不足」只摆得下部分 ─────────────────

#[test]
fn hw_cast_spends_every_bottle_and_places_cups_inside_the_source_box() {
    let mut rig = hw_rig();
    let world = &mut rig.world;
    let rules = hw_rules(world);
    let cap = rules.charges_cap();
    let home = world.players[HW_BISHOP].map_id.clone();

    // 一瓶都没有 ⇒ 不放行（源：「聖水最少需有1瓶」）。这条是**运行期前置条件**，
    // 不在接纳表里（见 `skills.rs` 的注释），所以必须在这里钉住。
    hw_ready(world, HW_BISHOP, &rig.path);
    world.players.get_mut(HW_BISHOP).unwrap().holy_water_charges = 0;
    hw_cast(world, HW_BISHOP, "hw-place-none");
    let events = hw_drain(&mut rig.bishop);
    assert_eq!(
        hw_codes(&events),
        vec!["skill_requirement".to_owned()],
        "一瓶都没有却放出了技能：{events:?}"
    );
    assert!(world.holy_waters.is_empty(), "被拒的施放却摆出了圣杯");

    // 攒满再来。
    for _ in 0..(rules.hits_per_bottle() * cap) {
        world.advance_holy_water_charge(HW_BISHOP);
    }
    assert_eq!(world.players[HW_BISHOP].holy_water_charges, cap);
    hw_ready(world, HW_BISHOP, &rig.path);
    let (x, y) = {
        let player = &world.players[HW_BISHOP];
        (player.state.x, player.state.y)
    };
    let intelligence = world.players[HW_BISHOP]
        .state
        .derived_stats
        .intelligence
        .unwrap_or(0);
    hw_cast(world, HW_BISHOP, "hw-place-all");
    let events = hw_drain(&mut rig.bishop);
    assert_eq!(hw_codes(&events), Vec::<String>::new(), "施放被拒了：{events:?}");
    assert!(
        events
            .iter()
            .any(|value| value["type"] == "skillCast" && value["skillId"] == SKILL_HOLY_WATER),
        "没有发出 skillCast：{events:?}"
    );
    assert_eq!(
        world.holy_waters.len(),
        cap as usize,
        "地形够宽时每一瓶都该摆下来（源：消耗所有累積的聖水…在周圍形成聖水）"
    );
    // 源 `cooltime`（10 秒）走**既有四转书那一支** ⇒ 它必须落到 `skill_cooldowns` 表上
    // （不是只写内存）。这条与本文件的夹具正好互为对照：夹具每次连放前都要显式删掉
    // 这一行才放得出来（见 `hw_ready`）—— 也就是说，这条断言若被删掉，「夹具为什么
    // 要清库」就没有任何东西在解释了。
    let ready_at = hw_durable_ready_at(&rig.path, HW_BISHOP, SKILL_HOLY_WATER)
        .expect("源 `cooltime` 没有落库 —— 2321015 掉出了四转书那条持久冷却分支");
    let now = hw_now_ms();
    assert!(
        ready_at > now && ready_at - now <= 11_000,
        "落库的冷却不是源 `cooltime` = 10 秒（now={now} ready_at={ready_at}）"
    );
    assert_eq!(
        world.players[HW_BISHOP].holy_water_charges, 0,
        "施放没有消耗累积的瓶数"
    );
    assert_eq!(
        rig.store.holy_water_state(HW_BISHOP).unwrap(),
        (0, 0),
        "清空没有落库 ⇒ 重登之后同一批圣水能再放一次（双花）"
    );
    let lifetime_ticks = rules.lifetime_ms(intelligence).div_ceil(TICK_MS).max(1);
    for water in world.holy_waters.values() {
        assert_eq!(water.owner_id, HW_BISHOP);
        assert_eq!(water.map_id, home);
        assert!(
            (water.x - x).abs() <= 40.0 + 0.001,
            "圣杯 x 出了源框 lt/rb（相对施法者 {:+.1}）",
            water.x - x
        );
        assert!(
            (-100.0 - 0.001..=20.0 + 0.001).contains(&(water.y - y)),
            "圣杯 y 出了源框 lt/rb（相对施法者 {:+.1}）",
            water.y - y
        );
        // 时长与恢复量都在施放那一刻按施法者智力算定、整批同值。
        assert_eq!(water.expires_at, world.tick.saturating_add(lifetime_ticks));
        assert_eq!(water.heal_permille, rules.heal_permille(intelligence));
        assert_eq!(water.burst_permille, rules.burst_permille());
    }

    // ── 「空间不足」：把地形换成**一片只覆盖源框左端**的合成地面 ──────────────
    // （真实地形里这种情形出现在平台边缘；判据是「逐点问地面」，地形从哪来不影响它。）
    world.holy_waters.clear();
    hw_replace_terrain(
        world,
        &home,
        vec![Foothold {
            id: 9_000_001,
            x1: x - 45.0,
            y1: y,
            x2: x - 35.0,
            y2: y,
            prev: 0,
            next: 0,
            forbid_fall_down: 0,
        }],
    );
    assert_eq!(
        world.map_for(&home).footholds.len(),
        1,
        "地形手术没有生效（改的那张图不是判据读的那张）"
    );
    hw_ready(world, HW_BISHOP, &rig.path);
    world.players.get_mut(HW_BISHOP).unwrap().holy_water_charges = cap;
    hw_cast(world, HW_BISHOP, "hw-place-partial");
    let events = hw_drain(&mut rig.bishop);
    assert_eq!(hw_codes(&events), Vec::<String>::new(), "部分摆下不该被拒：{events:?}");
    assert_eq!(
        world.holy_waters.len(),
        1,
        "只覆盖框左端的地面应当只摆得下 1 只圣杯（源：若空間不足則僅形成部分聖水）：{}",
        hw_placement_diagnostics(world, HW_BISHOP, cap)
    );
    let only = world.holy_waters.values().next().unwrap();
    assert!(
        (only.x - (x - 40.0)).abs() < 0.001,
        "留下的那只不是框最左端那个候选位置（x = {:.1}）",
        only.x
    );
    assert_eq!(
        world.players[HW_BISHOP].holy_water_charges, 0,
        "部分摆下时瓶数没有被消耗"
    );

    // ── 一只也摆不下：**不是失败**，瓶数照样消耗 ──────────────────────────────
    world.holy_waters.clear();
    hw_replace_terrain(world, &home, Vec::new());
    assert!(world.map_for(&home).footholds.is_empty(), "地形手术没有生效");
    hw_ready(world, HW_BISHOP, &rig.path);
    world.players.get_mut(HW_BISHOP).unwrap().holy_water_charges = cap;
    hw_cast(world, HW_BISHOP, "hw-place-none-fits");
    let events = hw_drain(&mut rig.bishop);
    assert_eq!(
        hw_codes(&events),
        Vec::<String>::new(),
        "装不下的时候施放被拒了 —— 源把它写成消耗之后的正常分支：{events:?}"
    );
    assert!(world.holy_waters.is_empty());
    assert_eq!(
        world.players[HW_BISHOP].holy_water_charges, 0,
        "装不下时瓶数没被消耗 —— 源写的是「消耗…並形成」，不是「没放成就不消耗」"
    );
}

// ── ⑤ 上键吸收：距离 / 同图 / 归属三条裁决各有一个反例，且只恢复按上键的人 ────

#[test]
fn hw_absorb_heals_the_presser_and_rejects_every_other_reason() {
    let mut rig = hw_rig();
    let home = rig.world.players[HW_BISHOP].map_id.clone();
    let max_hp = rig.world.players[HW_MATE].state.max_hp;
    assert!(max_hp > 0, "夹具失效：队员没有血量");

    // ① 队友站在杯子旁按上键 ⇒ 恢复**最大 HP 的 `u2`%（＋智力档）**，杯子被用掉。
    let water_id = hw_place_one(&mut rig.world, HW_BISHOP, "hw-absorb-1", &mut rig.bishop, &rig.path);
    let (wx, wy, heal_permille) = hw_water(&rig.world, &water_id);
    chapter_place(&mut rig.world, HW_MATE, &home, wx, wy);
    // 血量留 1 点：恢复量因此**不可能**被「不超过最大 HP」夹住，
    // 断言量的就是公式本身（夹在缺口上时，公式算错也会看起来一样）。
    rig.world.players.get_mut(HW_MATE).unwrap().state.hp = 1;
    chapter_drain(&mut rig.mate);
    chapter_drain(&mut rig.bishop);
    rig.world
        .handle_holy_water_absorb(HW_MATE.into(), "hw-a1".into(), water_id.clone());
    let expected = max_hp * heal_permille / 1000;
    assert!(expected > 0, "恢复量算出来是 0 —— 派生点没读到源 `u2`");
    assert!(
        expected < max_hp - 1,
        "夹具失效：恢复量 {expected} 顶到了最大 HP {max_hp}，测不出公式"
    );
    assert_eq!(
        rig.world.players[HW_MATE].state.hp,
        1 + expected,
        "吸收的恢复量不是「最大 HP × 源 `u2`/`dot`/`w2` 派生的千分比」"
    );
    assert!(
        !rig.world.holy_waters.contains_key(&water_id),
        "被吸收的圣杯还留在场上"
    );
    // ⚠️ 收件箱**只抽一次**：`hw_drain` 是排空式的，抽两次的话第一次就把恢复跳字
    // 吞掉了，第二条断言会以「没发跳字」的形式失败（看起来像产品问题）。
    let events = hw_drain(&mut rig.mate);
    assert_eq!(hw_codes(&events), Vec::<String>::new(), "吸收被拒了");
    assert!(
        events.iter().any(|value| {
            value["type"] == "recoveryEvent"
                && value["source"] == "holyWater"
                && value["hp"] == expected
        }),
        "没有给按上键的人发恢复跳字：{events:?}"
    );
    assert!(
        !hw_drain(&mut rig.bishop)
            .iter()
            .any(|value| value["source"] == "holyWater"),
        "恢复跳字发给了施法者 —— 源说恢复的是按下「上」的那个人"
    );

    // ② 够不着：水平差 49 > 48（reach 与 `portals.rs` 判「够近」的口径逐值相同）。
    let water_id = hw_place_one(&mut rig.world, HW_BISHOP, "hw-absorb-2", &mut rig.bishop, &rig.path);
    let (wx, wy, _) = hw_water(&rig.world, &water_id);
    chapter_place(&mut rig.world, HW_MATE, &home, wx + 49.0, wy);
    rig.world
        .handle_holy_water_absorb(HW_MATE.into(), "hw-a2".into(), water_id.clone());
    assert_eq!(
        hw_codes(&hw_drain(&mut rig.mate)),
        vec!["holy_water_out_of_range".to_owned()],
        "离得远也能吸收 —— reach 判据不在"
    );
    assert!(
        rig.world.holy_waters.contains_key(&water_id),
        "被拒的吸收却把杯子拿走了"
    );
    // 边界内 48 恰好可以（reach 是 `>` 而不是 `>=`）。
    chapter_place(&mut rig.world, HW_MATE, &home, wx + 48.0, wy);
    rig.world.players.get_mut(HW_MATE).unwrap().state.hp = 1;
    chapter_drain(&mut rig.mate);
    rig.world
        .handle_holy_water_absorb(HW_MATE.into(), "hw-a3".into(), water_id.clone());
    assert_eq!(
        hw_codes(&hw_drain(&mut rig.mate)),
        Vec::<String>::new(),
        "边界（48）上被拒了 —— reach 变成了 `>=`"
    );
    assert!(!rig.world.holy_waters.contains_key(&water_id));

    // ③ 未知 id：报一个场上没有的杯子。
    rig.world
        .handle_holy_water_absorb(HW_MATE.into(), "hw-a4".into(), "hw-no-such-cup".into());
    assert_eq!(
        hw_codes(&hw_drain(&mut rig.mate)),
        vec!["holy_water_unknown".to_owned()]
    );

    // ④ 跨图：报价另一张图的杯子（走过传送门之后的陈旧请求）＝ 未知。
    let water_id = hw_place_one(&mut rig.world, HW_BISHOP, "hw-absorb-5", &mut rig.bishop, &rig.path);
    let (wx, wy, _) = hw_water(&rig.world, &water_id);
    chapter_place(&mut rig.world, HW_MATE, HW_ELSEWHERE, wx, wy);
    rig.world
        .handle_holy_water_absorb(HW_MATE.into(), "hw-a5".into(), water_id.clone());
    assert_eq!(
        hw_codes(&hw_drain(&mut rig.mate)),
        vec!["holy_water_unknown".to_owned()],
        "跨图吸收没有被拒 —— 「圣杯属于一张图」那条判据不在"
    );
    assert!(rig.world.holy_waters.contains_key(&water_id));

    // ⑤ 同图**非队友**：源说的是「隊員」。【归属判据的唯一反例】
    chapter_place(&mut rig.world, HW_STRANGER, &home, wx, wy);
    chapter_drain(&mut rig.stranger);
    rig.world
        .handle_holy_water_absorb(HW_STRANGER.into(), "hw-a6".into(), water_id.clone());
    assert_eq!(
        hw_codes(&hw_drain(&mut rig.stranger)),
        vec!["holy_water_not_party".to_owned()],
        "同图非队友也能吸收 —— 归属判据不是「施放者的队员」"
    );
    assert!(rig.world.holy_waters.contains_key(&water_id));

    // ⑥ 施法者**自己**也能吸收（用户裁决：源只写「隊員」，没写「除了自己」）。
    {
        let player = rig.world.players.get_mut(HW_BISHOP).expect("joined");
        player.state.action = "stand";
        player.state.hp = 1;
        player.state.x = wx;
        player.state.y = wy;
    }
    chapter_drain(&mut rig.bishop);
    rig.world
        .handle_holy_water_absorb(HW_BISHOP.into(), "hw-a7".into(), water_id.clone());
    assert_eq!(
        hw_codes(&hw_drain(&mut rig.bishop)),
        Vec::<String>::new(),
        "施法者吸收自己的圣杯被拒了 —— 「同队含自己」这条裁决没生效"
    );
    assert!(!rig.world.holy_waters.contains_key(&water_id));

    // ⑦ 死亡时不接受交互（与 reactor 同一条 `invalid_state`）。
    let water_id = hw_place_one(&mut rig.world, HW_BISHOP, "hw-absorb-8", &mut rig.bishop, &rig.path);
    let (wx, wy, _) = hw_water(&rig.world, &water_id);
    chapter_place(&mut rig.world, HW_MATE, &home, wx, wy);
    rig.world.players.get_mut(HW_MATE).unwrap().state.action = "dead";
    rig.world
        .handle_holy_water_absorb(HW_MATE.into(), "hw-a8".into(), water_id.clone());
    assert_eq!(
        hw_codes(&hw_drain(&mut rig.mate)),
        vec!["invalid_state".to_owned()]
    );
    assert!(
        rig.world.holy_waters.contains_key(&water_id),
        "被 `invalid_state` 拒掉的吸收把杯子拿走了"
    );

    // ⑧ 站回来再吸收一次：确认 ⑦ 的拒绝没有留下任何半边状态。
    let (wx, wy, _) = hw_water(&rig.world, &water_id);
    chapter_place(&mut rig.world, HW_MATE, &home, wx, wy);
    rig.world.players.get_mut(HW_MATE).unwrap().state.hp = 1;
    chapter_drain(&mut rig.mate);
    rig.world
        .handle_holy_water_absorb(HW_MATE.into(), "hw-a9".into(), water_id.clone());
    assert_eq!(
        hw_codes(&hw_drain(&mut rig.mate)),
        Vec::<String>::new(),
        "站起来之后吸收被拒了"
    );
    assert!(!rig.world.holy_waters.contains_key(&water_id));

    // ⑨ 到期（但本拍还没 `step`）⇒ `holy_water_spent`，且不给血。
    let water_id = hw_place_one(&mut rig.world, HW_BISHOP, "hw-absorb-10", &mut rig.bishop, &rig.path);
    let (wx, wy, _) = hw_water(&rig.world, &water_id);
    let expires_at = rig.world.holy_waters[&water_id].expires_at;
    chapter_place(&mut rig.world, HW_MATE, &home, wx, wy);
    rig.world.players.get_mut(HW_MATE).unwrap().state.hp = 1;
    chapter_drain(&mut rig.mate);
    rig.world.tick = expires_at;
    rig.world
        .handle_holy_water_absorb(HW_MATE.into(), "hw-a10".into(), water_id.clone());
    assert_eq!(
        hw_codes(&hw_drain(&mut rig.mate)),
        vec!["holy_water_spent".to_owned()],
        "到期的圣杯还能被吸收"
    );
    assert_eq!(
        rig.world.players[HW_MATE].state.hp, 1,
        "吸收一只已到期的圣杯却回了血"
    );
}

// ── ⑥ 两条清除点：提前清除按 `v2` 补偿，自然到期**不补** ──────────────────────

#[test]
fn hw_burst_pays_only_when_the_cup_still_had_time_left() {
    let mut rig = hw_rig();
    let home = rig.world.players[HW_BISHOP].map_id.clone();
    let max_hp = rig.world.players[HW_BISHOP].state.max_hp;
    let burst = hw_rules(&rig.world).burst_permille();
    assert!(burst > 0, "派生的 `v2` 是 0 —— 补偿这条路永远读不出来");

    // ① 施法者离开这张图 ⇒ 杯子成「有剩余持续时间却被清除」⇒ 按 `v2` 补。
    let water_id = hw_place_one(&mut rig.world, HW_BISHOP, "hw-burst-1", &mut rig.bishop, &rig.path);
    let expires_at = rig.world.holy_waters[&water_id].expires_at;
    assert!(expires_at > rig.world.tick, "刚放下的杯子就没有剩余时长");
    rig.world.players.get_mut(HW_BISHOP).unwrap().state.hp = max_hp / 4;
    chapter_drain(&mut rig.bishop);
    rig.world.players.get_mut(HW_BISHOP).unwrap().map_id = HW_ELSEWHERE.to_owned();
    rig.world.step_holy_waters();
    assert!(rig.world.holy_waters.is_empty(), "施法者离图后杯子还留在场上");
    let expected = max_hp * burst / 1000;
    assert!(
        expected < max_hp - max_hp / 4,
        "夹具失效：补偿量恰好被「不超过最大 HP」夹住，测不出公式"
    );
    assert_eq!(
        rig.world.players[HW_BISHOP].state.hp,
        max_hp / 4 + expected,
        "提前清除没有按源 `v2` 补偿给施法者"
    );
    let events = hw_drain(&mut rig.bishop);
    assert!(
        events.iter().any(|value| {
            value["type"] == "recoveryEvent"
                && value["source"] == "holyWaterBurst"
                && value["hp"] == expected
        }),
        "没有给施法者发 `v2` 补偿的跳字：{events:?}"
    );

    // ② 自然到期 ⇒ 移除、**不补偿**（源那句的前提是「有剩餘持續時間」）。
    hw_stand(&mut rig.world, HW_BISHOP, &home);
    let water_id = hw_place_one(&mut rig.world, HW_BISHOP, "hw-burst-2", &mut rig.bishop, &rig.path);
    let expires_at = rig.world.holy_waters[&water_id].expires_at;
    rig.world.players.get_mut(HW_BISHOP).unwrap().state.hp = max_hp / 4;
    chapter_drain(&mut rig.bishop);
    // 走到期的**那一拍**（`has_remaining_time` 是 `tick < expires_at`）。
    rig.world.tick = expires_at;
    rig.world.step_holy_waters();
    assert!(rig.world.holy_waters.is_empty(), "到点的圣杯没有被清掉");
    assert_eq!(
        rig.world.players[HW_BISHOP].state.hp,
        max_hp / 4,
        "自然到期也补了一次 `v2` —— 源的前提是「有剩餘持續時間」"
    );
    assert!(
        !hw_drain(&mut rig.bishop)
            .iter()
            .any(|value| value["source"] == "holyWaterBurst"),
        "自然到期发了补偿跳字"
    );

    // ③ 到期前**不能**被误清（否则上面那条「不补」只是「什么都没发生」的副产物）。
    let water_id = hw_place_one(&mut rig.world, HW_BISHOP, "hw-burst-3", &mut rig.bishop, &rig.path);
    let expires_at = rig.world.holy_waters[&water_id].expires_at;
    rig.world.tick = expires_at - 1;
    rig.world.step_holy_waters();
    assert!(
        rig.world.holy_waters.contains_key(&water_id),
        "还没到点就被清掉了 —— 上一条「不补」测的其实是「提前清掉」"
    );
    // 而这一拍之后它确实还在「有剩余时长」状态 ⇒ 施法者离图仍该补。
    rig.world.players.get_mut(HW_BISHOP).unwrap().state.hp = max_hp / 4;
    rig.world.players.get_mut(HW_BISHOP).unwrap().map_id = HW_ELSEWHERE.to_owned();
    rig.world.step_holy_waters();
    assert!(rig.world.holy_waters.is_empty());
    assert_eq!(
        rig.world.players[HW_BISHOP].state.hp,
        max_hp / 4 + expected,
        "剩余 1 拍时清除没有按 `v2` 补偿 —— 补偿判据不是「还有没有剩余时间」"
    );
}

// ── ⑦ 快照：杯子随**读的人所在的那张图**出去，且带相对剩余时长 ────────────────

#[test]
fn hw_snapshot_lists_only_the_cups_on_the_readers_map() {
    let mut rig = hw_rig();
    let home = rig.world.players[HW_BISHOP].map_id.clone();
    let water_id = hw_place_one(&mut rig.world, HW_BISHOP, "hw-snap-1", &mut rig.bishop, &rig.path);

    let snapshot: serde_json::Value =
        serde_json::from_str(&rig.world.snapshot(HW_BISHOP)).expect("snapshot json");
    let waters = snapshot["holyWaters"]
        .as_array()
        .expect("快照里没有 `holyWaters` 键 —— 客户端拿不到杯子就画不出「上键」提示");
    assert_eq!(waters.len(), 1);
    assert_eq!(waters[0]["id"], water_id.as_str());
    assert_eq!(waters[0]["ownerId"], HW_BISHOP);
    assert_eq!(waters[0]["x"], rig.world.holy_waters[&water_id].x);
    assert_eq!(waters[0]["y"], rig.world.holy_waters[&water_id].y);
    // `expiresInMs` 是**相对量**（客户端按它倒计时），不是绝对拍号。
    assert_eq!(
        waters[0]["expiresInMs"].as_i64(),
        Some(
            rig.world.holy_waters[&water_id]
                .expires_at
                .saturating_sub(rig.world.tick)
                .saturating_mul(TICK_MS) as i64
        )
    );

    // 同图的人看得到；换到别的图就看不到（与 `reactors` 同一条口径）。
    let same_map: serde_json::Value =
        serde_json::from_str(&rig.world.snapshot(HW_MATE)).expect("snapshot json");
    assert_eq!(
        same_map["holyWaters"].as_array().map(Vec::len),
        Some(1),
        "同图的人看不到圣杯"
    );
    rig.world.players.get_mut(HW_MATE).unwrap().map_id = HW_ELSEWHERE.to_owned();
    let other_map: serde_json::Value =
        serde_json::from_str(&rig.world.snapshot(HW_MATE)).expect("snapshot json");
    assert_eq!(
        other_map["holyWaters"].as_array().map(Vec::len),
        Some(0),
        "跨图的人看到了这张图的圣杯 —— 过滤键用错了"
    );
    assert_eq!(home, rig.world.players[HW_BISHOP].map_id);
}
