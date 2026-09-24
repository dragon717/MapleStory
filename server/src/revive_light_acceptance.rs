/// 復甦之光 `2321006`（主教四转**队伍复活**）的接线验收（2026-09-24）。
///
/// 经 `include!` 进入 `world_tests.rs` 的 `mod tests`；本文件助手一律 `revl_` 前缀
/// （`include!` 把全部验收塞进同一模块，裸名会与既有验收撞名）。
///
/// 要钉住的是**判据**，不是某个数字：
///
/// * **范围 ＝ 同图 ∩ 源矩形**：源 `common` 的 `lt`／`rb` 是**一对 `vector`**
///   （`(-400,-350)`／`(400,250)`，逐级相同）。⚠️ `references/tms273-data/*-source.json`
///   把整类 `vector` 丢成 `{}`，照它读会以为「源没给框」—— 唯一可信的输入是导出树的
///   `rawWz`。所以判据要**两侧都测**：同图且在框内的被复活，而跨图队友、同图**非队员**、
///   以及**同图但在框外**的队员一概不动。只测前两条的话，把框判定整个删掉也能全绿。
/// * **目标集合必须另写一份**：`party_members_on_map` 带 `hp > 0` 过滤（它服务「分享
///   增益与击杀」），**结构上看不见死人**；复用了它的人会把「同图队友」当成「同图活着
///   的队友」，於是復甦之光永远救不到人，而代码看起来完全合理。**注意**：收集器刻意
///   **不做框判定**（框属施法臂）—— 所以「同图但框外」的那位**会**出现在目标集合里。
/// * **学技能要走真实路径**：本夹具是 store-backed ⇒ 施法与学习都以**数据库**为准
///   （`auth/skills.rs`），只改内存的 `player.state.skills` 会被判成 `not_learned`。
/// * **`time` 秒無敵只给施法者**：源那句话的主语是主教（同一段里要带上队员时作者
///   **显式**写「主教和復活的隊員」，那是 `subTime` 那半）。
/// * **不销碑、不换图**：复活走既有的唯一写路径 `complete_revive`（自复活也不销碑）。
/// * **`subTime` 那半没有副作用**：源里它逐级非零（30），但它的前提「在有死亡倒數的
///   地圖中」在本包不存在 ⇒ 施放前后属性必须逐项相同，且不许挂出任何增益窗。
/// * **冷却从源 `cooltime` 派生**（四转书那一支，单位是秒），不写死字面量。
const REVL_BISHOP: &str = "revl-bishop";
const REVL_MATE: &str = "revl-mate";
const REVL_FAR: &str = "revl-far";
const REVL_ALIVE: &str = "revl-alive";
const REVL_STRANGER: &str = "revl-stranger";
/// 同图、同队、**但站在源矩形之外**的死亡队员。它是「框判定真的在跑」的唯一反例：
/// 少了它，把 `inside_source_box` 整个删掉（退回「同图就收」）也能全绿。
const REVL_OUTSIDE: &str = "revl-outside";
const REVL_PARTY: &str = "revl-party";
const REVL_BISHOP_JOB: u32 = 232;
/// 目录里的**另一张**真实地图（嫩寶村）：跨图队友站这儿 —— 它必须仍是队伍成员，
/// 但不在施法者所在图上。
const REVL_ELSEWHERE: &str = "000020000";

/// 一名主教四转当事人 + 一名同图框内死亡队员 + 一名同图**框外**死亡队员 + 一名跨图
/// 死亡队员 + 一名同图健在队员 + 一名同图死亡**非队友**，全部走真实 `Store` 与真实地图目录。
///
/// 必须是 store-backed：复活走 `complete_revive → persist_player`，用内存支路测不到
/// 持久化那一半。
fn revl_world() -> (World, mpsc::Receiver<String>, auth::Store) {
    let path = std::env::temp_dir().join(format!("maple-revl-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).expect("temp store");
    let store = service.store.clone();
    for id in [
        REVL_BISHOP,
        REVL_MATE,
        REVL_FAR,
        REVL_ALIVE,
        REVL_STRANGER,
        REVL_OUTSIDE,
    ] {
        let mut profile = quest_profile();
        profile.level = 190;
        profile.job = REVL_BISHOP_JOB;
        profile.hp = 40_000;
        profile.max_hp = 40_000;
        profile.mp = 60_000;
        profile.max_mp = 60_000;
        // 学习要过 `not_enough_sp`（`auth/skills.rs` 按 `book_id` 查这一格），
        // 所以 SP 必须**先写进数据库**、不能只在内存里补。
        profile.skill_points = BTreeMap::from([(REVL_BISHOP_JOB, 255)]);
        store.load_profile(id, &profile).expect("seed profile");
        store.save_profile(id, &profile).expect("save profile");
    }
    let mut world = chapter_actual_world(store.clone()).with_mage_skills(MageSkills::bundled());
    let mut rx = chapter_join(&mut world, REVL_BISHOP);
    for id in [
        REVL_MATE,
        REVL_FAR,
        REVL_ALIVE,
        REVL_STRANGER,
        REVL_OUTSIDE,
    ] {
        let mut other = chapter_join(&mut world, id);
        chapter_drain(&mut other);
    }
    chapter_drain(&mut rx);
    let home = world.players[REVL_BISHOP].map_id.clone();
    for id in [REVL_BISHOP, REVL_MATE, REVL_ALIVE, REVL_STRANGER] {
        chapter_place(&mut world, id, &home, 100.0, 100.0);
    }
    // 框（`lt`/`rb` = -400,-350 / 400,250，绕施法者）之外的同图队友：x 偏移 900 远超
    // 右边界 400 ⇒ 无论朝向怎么摆都不在框内。
    chapter_place(&mut world, REVL_OUTSIDE, &home, 1_000.0, 100.0);
    chapter_place(&mut world, REVL_FAR, REVL_ELSEWHERE, 100.0, 100.0);
    // 队伍 = 主教 / 同图框内队员 / 同图框外队员 / 跨图队员 / 健在队员。`revl-stranger`
    // 站在同一张图上但**不在队里** —— 那是「范围是不是队伍」的对照点。
    world.parties.insert(
        REVL_PARTY.to_owned(),
        Party {
            id: REVL_PARTY.to_owned(),
            leader_id: REVL_BISHOP.to_owned(),
            members: vec![
                REVL_BISHOP.to_owned(),
                REVL_MATE.to_owned(),
                REVL_OUTSIDE.to_owned(),
                REVL_FAR.to_owned(),
                REVL_ALIVE.to_owned(),
            ],
        },
    );
    {
        let player = world.players.get_mut(REVL_BISHOP).expect("joined bishop");
        player.attack_until = 0;
        player.state.action = "stand";
        player.state.facing = 1;
    }
    // ⚠️ 学技能必须走**真实路径**（store + 内存一起落）。本夹具是 store-backed ⇒
    // `handle_cast_skill` 会把等级判据交给 `auth/skills.rs` 的数据库事务，
    // 那里读到的是 `player_stats.skills_json`。只写内存的 `state.skills` 会让每一次
    // 施法都以 `not_learned` 收场，而看起来像「机制没生效」。
    world.handle_learn_skill(REVL_BISHOP.into(), "revl-learn".into(), SKILL_REVIVAL_LIGHT);
    let learned = chapter_drain(&mut rx);
    assert!(
        learned
            .iter()
            .any(|value| value["type"] == "skillResult" && value["success"] == true),
        "夹具失效：復甦之光没有被学会：{learned:?}"
    );
    revl_die(&mut world, REVL_MATE);
    revl_die(&mut world, REVL_OUTSIDE);
    revl_die(&mut world, REVL_FAR);
    revl_die(&mut world, REVL_STRANGER);
    (world, rx, store)
}

/// 走**真实死亡路径**（`commit_incoming_damage`）：它一次置齐三件事 ——
/// `action = "dead"`、`death_id`、以及死亡世界的**墓碑**。手写 `action = "dead"`
/// 会把后两件漏掉，于是「不销碑」这条断言连对象都没有。
fn revl_die(world: &mut World, id: &str) {
    world.players.get_mut(id).expect("joined").state.hp = 1;
    let died = world
        .commit_incoming_damage(id, 999_999)
        .map(|(_, _, died)| died);
    assert_eq!(died, Some(true), "{id} 没有进入死亡状态 —— 夹具失效");
    let player = &world.players[id];
    assert_eq!(player.state.action, "dead");
    assert!(!player.death_id.is_empty(), "{id} 的 death_id 是空的");
}

fn revl_drain(rx: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    chapter_drain(rx)
}

fn revl_codes(events: &[serde_json::Value]) -> Vec<String> {
    events
        .iter()
        .filter(|value| value["type"] == "rejected")
        .map(|value| value["code"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn revl_cast(world: &mut World, request_id: &str) {
    world.handle_cast_skill(
        REVL_BISHOP.into(),
        request_id.into(),
        SKILL_REVIVAL_LIGHT,
        Some(1),
        Some(0),
    );
}

/// 主教的三个属性标量。`subTime` 那半若被偷偷接上（窗口内 `+x%` 伤害），这里会动。
fn revl_attributes(world: &World, id: &str) -> (i64, i64, i64) {
    let attributes = aggregate_attributes(AttributeInput::of(
        &world.gameplay,
        &world.mage_skills,
        world.players.get(id).expect("joined"),
    ));
    (
        attributes.magic_attack,
        attributes.value_of(AttributeKey::WeaponAttack),
        attributes.defense(),
    )
}

// ── ① 接纳表 + 源形状（含「它不是 Hyper」的**反向对照**） ─────────────────────

#[test]
fn revl_acceptance_table_and_source_shape() {
    assert_eq!(REVIVAL_LIGHT_SKILLS, [SKILL_REVIVAL_LIGHT]);
    assert_eq!(SKILL_REVIVAL_LIGHT, 2321006);

    let (world, _rx, _store) = revl_world();
    let skill = world
        .mage_skills
        .get(SKILL_REVIVAL_LIGHT)
        .expect("2321006 在技能目录里");
    // ⚠️ **它不是 Hyper 技能**（源 `hyper: 0`、`maxLevel: 10`、没有 `reqLev`）。
    // 本仓文档先前写作「主教四转 Hyper」，那是错记；判据是形状，不是名字。
    assert_eq!(
        skill.hyper, 0,
        "2321006 被判成了 Hyper —— `handle_cast_skill` 的等级闸门会跟着生效"
    );
    assert_eq!(skill.max_level, 10);
    assert!(!skill.hidden, "復甦之光必须可见（要有施放按钮）");
    // 反向对照：没有它，「hyper 0 就不是 Hyper」只是一句没有反例的口号。
    let hyper = world.mage_skills.get(2321054).expect("对照用的真 Hyper");
    assert_eq!(
        (hyper.hyper, hyper.max_level),
        (2, 1),
        "反向对照失守：真 Hyper 的形状不再是 (hyper 2, maxLevel 1)"
    );

    let level = mech_level(&world, SKILL_REVIVAL_LIGHT);
    // 源 `common` 的 `lt`／`rb` 是**一对 `vector`**（导出树 `rawWz` 的 `_dirType`），
    // 投影出来正好是这四个数。⚠️ **不是零矩形**：`references/tms273-data/*-source.json`
    // 把整类 `vector` 丢成 `{}`，照它写断言会把「源没给框」当成事实。
    let lt = level.lt.as_ref().expect("源 common 有 lt（vector）");
    let rb = level.rb.as_ref().expect("源 common 有 rb（vector）");
    assert_eq!(
        (lt.x, lt.y, rb.x, rb.y),
        (-400.0, -350.0, 400.0, 250.0),
        "源矩形被投影成了别的数 —— 「同图 ∩ 此框」那条范围判据会跟着漂"
    );
    // 框逐级相同（10 档都是这四个数）⇒ 施法臂才可以把它当常量、不必按等级重取。
    let last = world
        .mage_skills
        .level(SKILL_REVIVAL_LIGHT, 10)
        .cloned()
        .expect("2321006 L10");
    assert_eq!(
        last.lt.as_ref().map(|vector| (vector.x, vector.y)),
        Some((lt.x, lt.y)),
        "框随等级变了 —— 施法臂里就得按等级取框，不能再当常量"
    );
    // 源逐级值：冷却（秒）与無敵秒数。
    assert_eq!(level.cooltime, Some(1110), "源 L1 的 cooltime 是 1110 秒");
    assert_eq!(level.time, Some(3), "源 L1 的 time 是 3 秒（無敵窗）");
    assert_eq!(level.sub_time, Some(30), "源 subTime 非零 —— 不消费必须给理由");
    // `sub_time` 那一格在本包**多个**技能共用（冰雪結界 / 冰砾 / 冰瞬移力场），
    // 所以既不能按「全文出现过」判它被消费了，也必须显式确认復甦之光没读它。
    assert_eq!(
        level.mp_con,
        Some(285),
        "源 L1 的 mpCon 是 285（消耗走通用那一路）"
    );
}

// ── ② 端到端：只复活同图死亡队员；跨图 / 非队友 / 健在者一概不动 ──────────────

#[test]
fn revl_revives_the_downed_party_on_the_map_and_nobody_else() {
    let (mut world, mut rx, _store) = revl_world();
    let level = mech_level(&world, SKILL_REVIVAL_LIGHT);
    let source_time = u64::try_from(level.time.expect("源 time")).unwrap_or(0);
    let home = world.players[REVL_BISHOP].map_id.clone();
    let tombstones_before = world.death_tombstones.len();
    assert!(
        tombstones_before > 0,
        "夹具没有落下墓碑 —— 「不销碑」这条断言会变成一句空话"
    );
    let tick_at_cast = world.tick;

    revl_cast(&mut world, "revl-1");
    let events = revl_drain(&mut rx);
    assert_eq!(revl_codes(&events), Vec::<String>::new(), "復甦之光被拒了：{events:?}");
    assert!(
        events
            .iter()
            .any(|value| value["type"] == "skillCast" && value["skillId"] == SKILL_REVIVAL_LIGHT),
        "没有发出 skillCast：{events:?}"
    );

    // 同图死亡队员：活了、站起来了、death_id 清了，而且**还在同一张图**。
    let mate = &world.players[REVL_MATE];
    assert_eq!(mate.state.action, "stand", "同图死亡队员没有被复活");
    assert!(mate.state.hp > 0, "被复活的人血量还是 0");
    assert!(mate.death_id.is_empty(), "复活后 death_id 没有清空");
    assert_eq!(mate.map_id, home, "复活把队员换图了 —— 復甦之光不该改落点");

    // 跨图队员：源矩形是**绕施法者**的，跨图那张连原点都对不上 ⇒ 他没被复活。
    assert_eq!(
        world.players[REVL_FAR].state.action, "dead",
        "跨图队员被误复活了 —— 范围判据里没有「同图」这一半"
    );
    assert_eq!(world.players[REVL_FAR].map_id, REVL_ELSEWHERE);

    // 同图、同队、**但在源矩形之外**：框判定被删掉（退回「同图就收」）的唯一反例。
    assert_eq!(
        world.players[REVL_OUTSIDE].state.action, "dead",
        "框外的同图队员被误复活了 —— `inside_source_box` 没在施法臂里生效"
    );
    assert_eq!(world.players[REVL_OUTSIDE].map_id, home);
    assert!(
        !world.players[REVL_OUTSIDE].death_id.is_empty(),
        "框外的队员连 death_id 都被清了 —— 他根本没进过 `complete_revive`"
    );

    // 同图但不在队里：源说的是「隊員」，他没被复活。
    assert_eq!(
        world.players[REVL_STRANGER].state.action, "dead",
        "同图非队友被误复活了 —— 范围判据不是「队伍」"
    );

    // 健在的同图队员：一点都不许被动。
    assert_eq!(world.players[REVL_ALIVE].state.action, "stand");
    assert_eq!(
        world.players[REVL_ALIVE].state.hp, world.players[REVL_ALIVE].state.max_hp,
        "健在队员被这次复活改动过"
    );

    // 不销碑：自复活也不销碑（`windbell_acceptance.rs`），復甦之光同理。
    assert_eq!(
        world.death_tombstones.len(),
        tombstones_before,
        "复活销了碑 —— 这次复活动到了死亡世界的语义"
    );

    // 無敵只给施法者（源 `time` 秒 × 1000 ÷ TICK_MS，向上取整）。
    let expected_ticks = source_time.saturating_mul(1_000).div_ceil(TICK_MS);
    assert_eq!(
        world.players[REVL_BISHOP].contact_invulnerable_until,
        tick_at_cast.saturating_add(expected_ticks),
        "施法者没有拿到源 `time` 秒無敵（或时长不是从源派生的）"
    );
    assert_eq!(
        world.players[REVL_MATE].contact_invulnerable_until, 0,
        "無敵漏给了被复活的队员 —— 源那句话的主语是主教（员队那半是 subTime）"
    );
    assert_eq!(
        world.players[REVL_ALIVE].contact_invulnerable_until, 0,
        "無敵漏给了同图队友"
    );
}

// ── ③ 目标集合：正是 `party_members_on_map` 结构上看不见的那一批 ──────────────

#[test]
fn revl_target_set_is_the_downed_party_on_the_map() {
    let (mut world, _rx, _store) = revl_world();
    let home = world.players[REVL_BISHOP].map_id.clone();

    let targets = world.downed_party_members_on_map(REVL_BISHOP);
    // 收集器刻意**不做框判定**（框属施法臂）：所以同图但框外的 `REVL_OUTSIDE` **会**
    // 出现在这里，而在施法臂里被 `inside_source_box` 剔掉。两个层次各测各的。
    assert_eq!(
        targets,
        vec![REVL_MATE.to_owned(), REVL_OUTSIDE.to_owned()],
        "同图死亡队员的集合不对 —— 跨图队员 / 健在队员 / 非队友都不该进来"
    );

    // 反证：这正是 `party_members_on_map`（带 `hp > 0`）**看不见**的那一批。
    // 两个访问器若被「合并」，这条立刻红。
    let living = world.party_members_on_map(REVL_BISHOP);
    assert!(
        !living.contains(&REVL_MATE.to_owned()),
        "`party_members_on_map` 竟然收进了死人 —— 两个访问器被合并了，復甦之光再也救不到人"
    );
    assert!(living.contains(&REVL_ALIVE.to_owned()));
    assert!(
        !living.contains(&REVL_FAR.to_owned()),
        "跨图队友不该进 `party_members_on_map`"
    );

    // 把跨图那位挪回**同一张图**（他仍然是死的、仍然是队员）：范围判据里有「同图」
    // 这一半，而不是「队伍里谁都行」。
    world.players.get_mut(REVL_FAR).expect("joined").map_id = home;
    let mut targets = world.downed_party_members_on_map(REVL_BISHOP);
    targets.sort();
    assert_eq!(
        targets,
        vec![
            REVL_FAR.to_owned(),
            REVL_MATE.to_owned(),
            REVL_OUTSIDE.to_owned()
        ],
        "把跨图队员挪回同图之后就该收进来 —— 「同图」是收集器的唯一那条判据"
    );

    // 没有队伍的人：空集（**不是**兜底成自己）。施法者必须活着才放得出这本技能，
    // 所以「同图死亡队员」在没有队伍时必然是空的；兜底成自己会凭空造出一个死人。
    assert!(
        world.downed_party_members_on_map(REVL_STRANGER).is_empty(),
        "没有队伍时目标集合不是空的 —— 有人给它加了 `vec![id]` 兜底"
    );
}

// ── ④ 冷却从源 `cooltime`（秒）派生，且冷却中再放会被拒 ─────────────────────

#[test]
fn revl_cooldown_comes_from_the_source_cooltime() {
    let (mut world, mut rx, _store) = revl_world();
    let level = mech_level(&world, SKILL_REVIVAL_LIGHT);
    let source_cooltime = u64::try_from(level.cooltime.expect("源 cooltime")).unwrap_or(0);

    revl_cast(&mut world, "revl-cd-1");
    let _ = revl_drain(&mut rx);
    assert_eq!(
        world.players[REVL_BISHOP]
            .skill_cooldowns
            .get(&SKILL_REVIVAL_LIGHT)
            .copied(),
        Some(source_cooltime.saturating_mul(1_000)),
        "冷却不是从源 `cooltime`（**秒**）派生的 —— 四转书那一支必须覆盖 2321006"
    );

    // 冷却中再放一次：必须被 `skill_cooldown` 拒（而不是「又复活一次」）。
    revl_cast(&mut world, "revl-cd-2");
    let events = revl_drain(&mut rx);
    assert_eq!(
        revl_codes(&events),
        vec!["skill_cooldown".to_owned()],
        "冷却中的第二次施放没有被拒：{events:?}"
    );
}

// ── ⑤ `subTime` 那半刻意不消费 ⇒ 不挂窗、不动属性 ────────────────────────────

#[test]
fn revl_sub_time_half_leaves_no_trace() {
    let (mut world, mut rx, _store) = revl_world();
    let boss_before = revl_attributes(&world, REVL_BISHOP);
    let mate_before = revl_attributes(&world, REVL_MATE);

    revl_cast(&mut world, "revl-sub");
    let events = revl_drain(&mut rx);
    assert_eq!(revl_codes(&events), Vec::<String>::new());

    // 源里 `subTime` 是 **30 秒**（逐级非零），但它的前提「在有死亡倒數的地圖中」
    // 在本包不存在 ⇒ 不许留下任何痕迹：不挂增益窗、不动属性、不动另一条 232 的窗口。
    assert!(
        !world.players[REVL_BISHOP]
            .status
            .buff_active(SKILL_REVIVAL_LIGHT),
        "復甦之光挂了一个增益窗 —— 源里它是「無敵状态」而不是一个计时增益"
    );
    assert!(
        !world.players[REVL_MATE]
            .status
            .buff_active(SKILL_REVIVAL_LIGHT),
        "復甦之光给被复活的队员挂了增益窗 —— 那属于 subTime 那半"
    );
    assert_eq!(world.players[REVL_BISHOP].advanced_blessing, None);
    assert_eq!(
        revl_attributes(&world, REVL_BISHOP),
        boss_before,
        "施法者的属性被改了 —— subTime 那半（窗口内 +x% 伤害）被偷偷接上了"
    );
    assert_eq!(
        revl_attributes(&world, REVL_MATE),
        mate_before,
        "被复活队员的属性被改了 —— 同上"
    );
}

// ── ⑥ 练习图：必须先按既有顺序结算私有对局，否则被复活的人留在已删除的图上 ────

#[test]
fn revl_practice_member_is_resolved_before_being_revived() {
    let (mut world, mut rx, _store) = revl_world();
    // 把**两个人**一起挪到一张练习图：MATE 在源口径下仍是「同图的死亡队员」，
    // 但复活必须先走 `revive.rs::handle_revive` 的同一顺序（先 `finish_boss_practice`）。
    // 只挪 MATE 是不够的 —— 那样他连目标集合都进不去，测的就不是这条分支了。
    let practice_map = format!("practice:{}:encounter-1", world.players[REVL_BISHOP].map_id);
    world.players.get_mut(REVL_BISHOP).expect("joined").map_id = practice_map.clone();
    world.players.get_mut(REVL_MATE).expect("joined").map_id = practice_map.clone();
    assert_eq!(
        world.downed_party_members_on_map(REVL_BISHOP),
        vec![REVL_MATE.to_owned()],
        "夹具失效：练习图上的死亡队员没进目标集合，测不到练习图那条分支"
    );

    // 没有登记的对局 ⇒ `finish_boss_practice` 返回 false ⇒ 不许复活（继续留在练习图）。
    // 若把练习图那道闸去掉，`complete_revive` 会直接成功 —— 所以这条断言真的在测它。
    revl_cast(&mut world, "revl-practice");
    let events = revl_drain(&mut rx);
    assert_eq!(revl_codes(&events), Vec::<String>::new(), "施放本身不该被拒：{events:?}");
    assert_eq!(
        world.players[REVL_MATE].state.action, "dead",
        "练习图的队员在没有结算私有对局的情况下被复活了 —— 他会留在一张已被删除的图上"
    );
    assert_eq!(world.players[REVL_MATE].map_id, practice_map);
}
