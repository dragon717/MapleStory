// 转职任务的定向检查（计划「完成一条业务后的最小验证」）。
//
// 分两层，各自盯自己会坏的地方：
// - **事务层**（真实 SQLite）：转场只发生一次、职业 CAS、等级闸、伪造候选、
//   奖励只加不覆盖。
// - **对话层**（store-less World）：命中规则、条件不足、目标未齐不给交付入口、
//   交付后材料被扣且职业切换。断言直接读推给客户端的报文，不走「我以为它会发什么」。
//
// 不重复覆盖已经在 `job_advance.rs` 单测里钉住的纯判定（等级/前置/计数口径）。

// ---------------------------------------------------------------------------
// 事务层
// ---------------------------------------------------------------------------

/// 起一个真实的账号库。`Store::init` 是 auth 私有的，测试统一走与服务启动
/// 相同的 `auth::start`，因此建表口径与线上完全一致。
///
/// 返回 `AuthService` 是为了让调用方能显式 drop 它——SQLite 文件在连接关闭前
/// 不能删，否则 `cleanup` 会留下锁文件。
fn job_advance_open_store(path: &std::path::Path) -> (auth::AuthService, Store) {
    let service = auth::start(&path.to_path_buf()).unwrap();
    let store = service.store.clone();
    (service, store)
}

fn job_advance_cleanup(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

fn job_advance_profile(job: u32, level: u32) -> Profile {
    Profile {
        hp: 50,
        max_hp: 50,
        mp: 120,
        max_mp: 120,
        level,
        job,
        exp: 0,
        exp_to_next: 15,
        mesos: 0,
        cash: 0,
        death_id: String::new(),
        map_id: "101000003".into(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: AbilityStats::default(),
    }
}

/// 与 `shared/job-advance.json` 里 job-220 一致的事务契约。
fn job_220_plan() -> auth::JobAdvancePlan {
    auth::JobAdvancePlan {
        quest_id: "job-220".to_owned(),
        from_job: 200,
        to_job: 220,
        level_at_least: 30,
        skill_points: vec![(220, 5)],
        skills: vec![(2200011, 1)],
        max_mp_floor: 100,
    }
}

#[test]
fn job_advance_commit_is_once_guarded_by_status_and_job() {
    let path = std::env::temp_dir().join(format!("job-advance-{}.sqlite3", auth::random_id()));
    let (service, store) = job_advance_open_store(&path);
    let base = job_advance_profile(200, 30);
    store.load_profile("mage", &base).unwrap();

    // ① 没接取就想交付：事务拒绝（不是错误，是「不该发生」），档案不动。
    let mut forged = base.clone();
    forged.job = 220;
    forged.skill_points.insert(220, 5);
    forged.skills.insert(2200011, 1);
    assert!(!store
        .commit_job_advance("mage", &job_220_plan(), &forged, &[])
        .unwrap());
    assert_eq!(store.load_profile("mage", &base).unwrap().job, 200);

    // ② 接取（复用通用任务的状态转场与同一张表）。
    let active = base.clone();
    assert!(store
        .commit_quest("mage", "job-220", "active", &active, &[])
        .unwrap());

    // ③ 交付：职业切换 + SP + 固定技能。
    let mut candidate = active.clone();
    auth::apply_job_advance_grant(&mut candidate, &job_220_plan());
    assert!(store
        .commit_job_advance("mage", &job_220_plan(), &candidate, &[])
        .unwrap());
    let promoted = store.load_profile("mage", &base).unwrap();
    assert_eq!(promoted.job, 220);
    assert_eq!(promoted.skill_points.get(&220), Some(&5));
    assert_eq!(promoted.skills.get(&2200011), Some(&1));
    assert_eq!(promoted.max_mp, 120, "已有 MP 高于下限，不动");
    assert_eq!(store.load_quests("mage").unwrap()["job-220"], "completed");

    // ④ 重放：第二道闸（职业已不是 from_job）挡下，SP 不再加。
    assert!(!store
        .commit_job_advance("mage", &job_220_plan(), &candidate, &[])
        .unwrap());
    assert_eq!(
        store
            .load_profile("mage", &base)
            .unwrap()
            .skill_points
            .get(&220),
        Some(&5),
        "重放不得二次发放 SP"
    );

    drop(store);
    drop(service);
    job_advance_cleanup(&path);
}

#[test]
fn job_advance_commit_rejects_wrong_job_level_and_forged_candidate() {
    let path = std::env::temp_dir().join(format!("job-advance-{}.sqlite3", auth::random_id()));
    let (service, store) = job_advance_open_store(&path);

    // 职业不对：已经三转的角色不能走二转任务。
    let base = job_advance_profile(221, 70);
    store.load_profile("wrong-job", &base).unwrap();
    assert!(store
        .commit_quest("wrong-job", "job-220", "active", &base, &[])
        .unwrap());
    let mut candidate = base.clone();
    auth::apply_job_advance_grant(&mut candidate, &job_220_plan());
    assert!(!store
        .commit_job_advance("wrong-job", &job_220_plan(), &candidate, &[])
        .unwrap());
    assert_eq!(store.load_profile("wrong-job", &base).unwrap().job, 221);

    // 等级不足：世界侧判过了，事务里的等级闸仍要独立成立。
    let low = job_advance_profile(200, 29);
    store.load_profile("low", &low).unwrap();
    assert!(store
        .commit_quest("low", "job-220", "active", &low, &[])
        .unwrap());
    let mut low_candidate = low.clone();
    auth::apply_job_advance_grant(&mut low_candidate, &job_220_plan());
    assert!(!store
        .commit_job_advance("low", &job_220_plan(), &low_candidate, &[])
        .unwrap());
    assert_eq!(store.load_profile("low", &low).unwrap().job, 200);
    assert_eq!(
        store.load_quests("low").unwrap()["job-220"],
        "active",
        "失败的交付不得把任务推走"
    );

    // 伪造候选：职业没按计划改，或 SP 与落库算出来的不一致，都是 Err。
    let ready = job_advance_profile(200, 30);
    store.load_profile("forged", &ready).unwrap();
    assert!(store
        .commit_quest("forged", "job-220", "active", &ready, &[])
        .unwrap());
    let mut no_job = ready.clone();
    assert!(store
        .commit_job_advance("forged", &job_220_plan(), &no_job, &[])
        .is_err());
    no_job.job = 220;
    assert!(store
        .commit_job_advance("forged", &job_220_plan(), &no_job, &[])
        .is_err());
    // 计划本身不自洽（from == to）。
    let mut broken_plan = job_220_plan();
    broken_plan.to_job = broken_plan.from_job;
    let mut ok = ready.clone();
    auth::apply_job_advance_grant(&mut ok, &job_220_plan());
    assert!(store
        .commit_job_advance("forged", &broken_plan, &ok, &[])
        .is_err());
    assert_eq!(store.load_quests("forged").unwrap()["job-220"], "active");
    assert_eq!(store.load_profile("forged", &ready).unwrap().job, 200);

    // 上面的失败路径没有污染事务：真实候选仍然可用。
    assert!(store
        .commit_job_advance("forged", &job_220_plan(), &ok, &[])
        .unwrap());
    assert_eq!(store.load_profile("forged", &ready).unwrap().job, 220);

    drop(store);
    drop(service);
    job_advance_cleanup(&path);
}

/// 奖励只加不覆盖：老档攒下的 SP / 已学技能不能被转职洗掉。
#[test]
fn job_advance_grant_keeps_progress_already_earned() {
    let mut veteran = job_advance_profile(200, 55);
    veteran.skill_points = BTreeMap::from([(200_u32, 3_u32), (220_u32, 17_u32)]);
    veteran.skills = BTreeMap::from([(2200011_u32, 6_u32)]);
    auth::apply_job_advance_grant(&mut veteran, &job_220_plan());
    assert_eq!(veteran.job, 220);
    assert_eq!(veteran.skill_points.get(&220), Some(&22), "17 + 5");
    assert_eq!(veteran.skill_points.get(&200), Some(&3), "一转书不动");
    assert_eq!(veteran.skills.get(&2200011), Some(&6), "已学等级不被打回 1");

    // MP 低于下限时补满（与一转补發同源）。
    let mut weak = job_advance_profile(200, 30);
    weak.max_mp = 20;
    weak.mp = 3;
    auth::apply_job_advance_grant(&mut weak, &job_220_plan());
    assert_eq!(weak.max_mp, 100);
    assert_eq!(weak.mp, 100);
}

// ---------------------------------------------------------------------------
// 对话层（store-less World）
// ---------------------------------------------------------------------------

const HANS_TEMPLATE: &str = "1032001";
const HANS_MAP: &str = "101000003";
const HANS_NPC: &str = "hans-ellinia";
const MAGE_ID: &str = "job-advance-mage";

/// 直接用仓库里真正会发布的那份配置，顺带钉住「配置本身能通过启动校验」。
fn job_advance_shipped_catalog() -> job_advance::JobAdvanceCatalog {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("shared/job-advance.json");
    job_advance::JobAdvanceCatalog::load(&path).unwrap()
}

fn job_advance_world() -> (World, mpsc::Receiver<String>) {
    // 二转的前置是源一转任务 1402，默认视为已补完。
    job_advance_world_with(Gameplay::default(), true)
}

fn job_advance_world_with(gameplay: Gameplay, story_done: bool) -> (World, mpsc::Receiver<String>) {
    let mut world = World::new_with_gameplay(map(), 600, gameplay)
        .with_job_advance(job_advance_shipped_catalog());
    world.npcs.insert(
        HANS_NPC.to_owned(),
        NpcInstance {
            state: NpcState {
                id: HANS_NPC.to_owned(),
                template_id: HANS_TEMPLATE.to_owned(),
                name: "Hans".to_owned(),
                name_zh: Some("漢斯".to_owned()),
                x: 0.0,
                y: 0.0,
                facing: 1,
                shop_id: None,
                job_advancement_available: None,
                quest_available: None,
            },
            map_id: HANS_MAP.to_owned(),
            template_id: HANS_TEMPLATE.to_owned(),
            conversation: BTreeMap::new(),
        },
    );
    let mut rx = join_test_player(&mut world, MAGE_ID);
    while rx.try_recv().is_ok() {}
    let player = world.players.get_mut(MAGE_ID).unwrap();
    player.map_id = HANS_MAP.to_owned();
    player.state.job = 200;
    player.state.level = 30;
    player.state.hp = player.state.max_hp.max(1);
    player.state.action = "stand";
    player.base_max_mp = 120;
    player.state.max_mp = 120;
    player.state.mp = 120;
    if story_done {
        player
            .quests
            .insert("1402".to_owned(), "completed".to_owned());
    }
    (world, rx)
}

fn job_advance_talk(
    world: &mut World,
    step: Option<&str>,
    selection: Option<u32>,
) -> bool {
    world.handle_job_advance_talk(
        MAGE_ID,
        &format!("job-advance-{}", auth::random_id()),
        HANS_NPC,
        HANS_TEMPLATE,
        HANS_MAP,
        "Hans",
        Some("漢斯"),
        "zh",
        step,
        selection,
    )
}

fn job_advance_messages(rx: &mut mpsc::Receiver<String>) -> Vec<serde_json::Value> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .filter_map(|message| serde_json::from_str(&message).ok())
        .collect()
}

/// 最后一次 `npcResult` 的对话框内容。
fn job_advance_say(rx: &mut mpsc::Receiver<String>) -> serde_json::Value {
    let messages = job_advance_messages(rx);
    messages
        .into_iter()
        .rev()
        .find(|message| message["type"] == "npcResult")
        .unwrap_or_else(|| panic!("没有 npcResult 报文"))
}

fn job_advance_option_texts(view: &serde_json::Value) -> Vec<String> {
    view["dialog"]["options"]
        .as_array()
        .map(|options| {
            options
                .iter()
                .filter_map(|option| option["text"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn job_advance_reject_code(rx: &mut mpsc::Receiver<String>) -> Option<String> {
    job_advance_messages(rx)
        .into_iter()
        .rev()
        .find_map(|message| message["code"].as_str().map(str::to_owned))
}

#[test]
fn job_advance_is_only_offered_to_the_matching_job_and_npc() {
    let (mut world, mut rx) = job_advance_world();
    let _ = job_advance_messages(&mut rx);

    // 新手不命中：一转由源 1402 的通用任务菜单接手，本模块必须让路。
    world.players.get_mut(MAGE_ID).unwrap().state.job = 0;
    assert!(!job_advance_talk(&mut world, None, None));

    // 二转职业命中，并写下绑定具体任务的会话节点（避免跨任务串台）。
    world.players.get_mut(MAGE_ID).unwrap().state.job = 200;
    assert!(job_advance_talk(&mut world, None, None));
    assert_eq!(
        world.npcs[HANS_NPC]
            .conversation
            .get(MAGE_ID)
            .map(String::as_str),
        Some("job-advance:job-220")
    );

    // 站错 NPC（快捷转职的漢斯，10201 / 001020000）不命中——那条入口有自己的判据。
    assert!(!world.handle_job_advance_talk(
        MAGE_ID,
        "r-shortcut",
        HANS_NPC,
        "10201",
        "001020000",
        "Hans",
        Some("漢斯"),
        "zh",
        None,
        None,
    ));
    // 站错地图同样不命中。
    assert!(!world.handle_job_advance_talk(
        MAGE_ID,
        "r-wrong-map",
        HANS_NPC,
        HANS_TEMPLATE,
        "001020000",
        "Hans",
        Some("漢斯"),
        "zh",
        None,
        None,
    ));
}

#[test]
fn job_advance_dialogue_gates_on_level_then_accepts() {
    let (mut world, mut rx) = job_advance_world();

    // ① 等级不足：命中但锁住，只给「結束對話」。
    world.players.get_mut(MAGE_ID).unwrap().state.level = 29;
    assert!(job_advance_talk(&mut world, None, None));
    let locked = job_advance_say(&mut rx);
    assert!(
        locked["dialog"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("還不夠資格")),
        "条件不足必须说出原因，实际：{locked}"
    );
    assert_eq!(job_advance_option_texts(&locked), vec!["結束對話"]);

    // ② 达标后出现「接受試煉」。
    world.players.get_mut(MAGE_ID).unwrap().state.level = 30;
    assert!(job_advance_talk(&mut world, None, None));
    let offer = job_advance_say(&mut rx);
    assert_eq!(
        job_advance_option_texts(&offer),
        vec!["接受試煉", "結束對話"]
    );
    // 目标行带着 0/30、0/10 下发，客户端直接可渲染。
    assert_eq!(offer["objectives"][0]["current"], 0);
    assert_eq!(offer["objectives"][0]["required"], 30);
    assert_eq!(offer["objectives"][1]["required"], 10);

    // ③ 接取。
    assert!(job_advance_talk(&mut world, Some("select"), Some(0)));
    assert_eq!(
        world.players[MAGE_ID].quests.get("job-220").map(String::as_str),
        Some("active")
    );

    // ④ 已经接了就不再给「接受試煉」。
    assert!(job_advance_talk(&mut world, None, None));
    let progress = job_advance_say(&mut rx);
    assert_eq!(job_advance_option_texts(&progress), vec!["結束對話"]);
}

#[test]
fn job_advance_completion_needs_every_objective_and_consumes_items() {
    let (mut world, mut rx) = job_advance_world();
    assert!(job_advance_talk(&mut world, None, None));
    assert!(job_advance_talk(&mut world, Some("select"), Some(0)));
    let _ = job_advance_messages(&mut rx);

    // 击杀齐了、材料差一个：不给「完成轉職」，硬选 0 也被拒。
    world.players.get_mut(MAGE_ID).unwrap().quest_kills =
        BTreeMap::from([("job-220".to_owned(), BTreeMap::from([("2130100".to_owned(), 30)]))]);
    inventory::add_items(
        &mut world.players.get_mut(MAGE_ID).unwrap().state.inventory,
        "4000215".to_owned(),
        9,
        inventory::SLOT_LIMIT,
    )
    .unwrap();
    assert!(job_advance_talk(&mut world, None, None));
    let progress = job_advance_say(&mut rx);
    assert_eq!(job_advance_option_texts(&progress), vec!["結束對話"]);
    assert!(job_advance_talk(&mut world, Some("select"), Some(0)));
    assert_eq!(
        job_advance_reject_code(&mut rx).as_deref(),
        Some("job_advance_unavailable"),
        "目标未齐时交付必须被拒"
    );
    assert_eq!(world.players[MAGE_ID].state.job, 200);

    // 材料补齐：出现「完成轉職」。
    inventory::add_items(
        &mut world.players.get_mut(MAGE_ID).unwrap().state.inventory,
        "4000215".to_owned(),
        1,
        inventory::SLOT_LIMIT,
    )
    .unwrap();
    assert!(job_advance_talk(&mut world, None, None));
    let ready = job_advance_say(&mut rx);
    assert_eq!(
        job_advance_option_texts(&ready),
        vec!["完成轉職", "結束對話"]
    );

    // 交付：切职业、发 SP、扣材料、置 completed。
    assert!(job_advance_talk(&mut world, Some("select"), Some(0)));
    let done = job_advance_say(&mut rx);
    assert_eq!(done["trainingResult"]["kind"], "jobAdvance");
    assert_eq!(done["trainingResult"]["job"], 220);
    assert_eq!(done["openSkills"], true);
    assert_eq!(world.players[MAGE_ID].state.job, 220);
    assert_eq!(world.players[MAGE_ID].state.skill_points.get(&220), Some(&5));
    assert_eq!(world.players[MAGE_ID].state.skills.get(&2200011), Some(&1));
    assert_eq!(
        world.players[MAGE_ID]
            .state
            .inventory
            .iter()
            .filter(|item| item.item_id == "4000215")
            .map(|item| item.quantity)
            .sum::<u32>(),
        0,
        "收集材料必须在交付时扣除"
    );
    assert_eq!(
        world.players[MAGE_ID].quests.get("job-220").map(String::as_str),
        Some("completed")
    );

    // 已转职：职业变成 220，job-220 不再命中，**不可能二次交付二转**。
    // 此时命中三转任务（fromJob 220），但等级只有 30 ⇒ 锁住、不给接取入口。
    assert!(job_advance_talk(&mut world, None, None));
    assert_eq!(
        world.npcs[HANS_NPC]
            .conversation
            .get(MAGE_ID)
            .map(String::as_str),
        Some("job-advance:job-221"),
        "二转完成后同一 NPC 转向三转任务"
    );
    let third = job_advance_say(&mut rx);
    assert_eq!(
        job_advance_option_texts(&third),
        vec!["結束對話"],
        "等级不足不得出现接受入口"
    );
    assert_eq!(world.players[MAGE_ID].state.job, 220);
    assert_eq!(
        world.players[MAGE_ID].state.skill_points.get(&220),
        Some(&5),
        "交付只结算一次"
    );
}

/// 漢斯同时是源一转任务 1402 的 NPC。走「選擇岔道」快捷转职过来的角色职业已经是
/// 200，如果转职任务先接手，他们就再也没有入口把一转剧情补完——那条支线是用户
/// 明确要求保留的原版冒险家剧情。所以**通用剧情任务优先**。
#[test]
fn job_advance_defers_to_the_source_story_quest_at_the_same_npc() {
    let mut gameplay = Gameplay::default();
    // 加载校验要求任务引用的 NPC 模板真实存在（否则 gameplay.json 起不来）。
    gameplay.npcs.push(NpcTemplate {
        template_id: HANS_TEMPLATE.to_owned(),
        name: "Hans".to_owned(),
        func: String::new(),
        shop_id: None,
        script: None,
        stand: Vec::new(),
    });
    gameplay.quests.push(QuestSpec {
        quest_id: "1402".to_owned(),
        executable: Some(true),
        start: QuestPhase {
            npc_id: Some(HANS_TEMPLATE.to_owned()),
            ..QuestPhase::default()
        },
        complete: QuestPhase {
            npc_id: Some(HANS_TEMPLATE.to_owned()),
            ..QuestPhase::default()
        },
        ..QuestSpec::default()
    });
    // 1402 尚未完成 ⇒ 这位 NPC 此刻还有剧情任务要给。
    let (mut world, mut rx) = job_advance_world_with(gameplay, false);
    let _ = job_advance_messages(&mut rx);
    assert!(
        !job_advance_talk(&mut world, None, None),
        "还有剧情任务时转职任务必须让路"
    );
    assert!(
        world.npcs[HANS_NPC].conversation.get(MAGE_ID).is_none(),
        "让路时不得占用会话节点"
    );

    // 剧情补完之后，同一位 NPC 才转回转职任务。
    world
        .players
        .get_mut(MAGE_ID)
        .unwrap()
        .quests
        .insert("1402".to_owned(), "completed".to_owned());
    // 1402 已完成 ⇒ 通用菜单没有可给的选项了。
    assert!(world.quest_menu_choices(MAGE_ID, HANS_TEMPLATE).is_empty());
    assert!(job_advance_talk(&mut world, None, None));
}

#[test]
fn job_advance_rejects_while_dead_and_requires_prerequisite() {
    let (mut world, mut rx) = job_advance_world();

    // 死亡角色：命中（是这个职业）但被拒绝，不会悄悄落到别的分支。
    world.players.get_mut(MAGE_ID).unwrap().state.hp = 0;
    world.players.get_mut(MAGE_ID).unwrap().state.action = "dead";
    assert!(job_advance_talk(&mut world, None, None));
    assert_eq!(
        job_advance_reject_code(&mut rx).as_deref(),
        Some("job_advance_unavailable")
    );
    assert_eq!(world.players[MAGE_ID].state.job, 200);

    // 前置未完成（1402 没做完）：等级够了也接不了。
    let player = world.players.get_mut(MAGE_ID).unwrap();
    player.state.hp = player.state.max_hp.max(1);
    player.state.action = "stand";
    player.quests.remove("1402");
    assert!(job_advance_talk(&mut world, None, None));
    let _ = job_advance_messages(&mut rx);
    assert!(job_advance_talk(&mut world, Some("select"), Some(0)));
    assert_eq!(
        job_advance_reject_code(&mut rx).as_deref(),
        Some("job_advance_unavailable")
    );
    assert_eq!(
        world.players[MAGE_ID].quests.get("job-220"),
        None,
        "前置不满足时接取必须无效"
    );
}

#[test]
fn job_advance_kill_targets_feed_the_shared_counter() {
    let (mut world, _rx) = job_advance_world();
    // 未接取：杀了也不记（先杀后接不补记）。
    assert!(world
        .job_advance_kill_targets(MAGE_ID, "2130100")
        .is_empty());
    world
        .players
        .get_mut(MAGE_ID)
        .unwrap()
        .quests
        .insert("job-220".to_owned(), "active".to_owned());
    assert_eq!(
        world.job_advance_kill_targets(MAGE_ID, "2130100"),
        vec![("job-220".to_owned(), "2130100".to_owned())]
    );
    // 别的目标怪物不计。
    assert!(world
        .job_advance_kill_targets(MAGE_ID, "2230110")
        .is_empty());
}

#[test]
fn job_advance_log_entries_expose_progress_and_job_boundary() {
    let (mut world, _rx) = job_advance_world();
    let player = world.players.get_mut(MAGE_ID).unwrap();
    player.state.job = 220;
    player.state.level = 60;
    player
        .quests
        .insert("job-220".to_owned(), "completed".to_owned());
    let entries = world.job_advance_log_entries(MAGE_ID);
    let ids: Vec<&str> = entries
        .iter()
        .filter_map(|entry| entry["questId"].as_str())
        .collect();
    assert_eq!(ids, vec!["job-220", "job-221"], "已完成的那条 + 当前职业那条");
    assert_eq!(entries[0]["status"], "completed");
    assert_eq!(entries[0]["jobAdvance"]["toJob"], 220);
    assert_eq!(
        entries[0]["jobAdvance"]["provenance"], "P",
        "来源边界必须透到 UI，不能被时间冲掉"
    );
    // 等级 60 且前置（job-220）已完成 ⇒ 可接。
    assert_eq!(entries[1]["status"], "available");
    assert_eq!(entries[1]["objectives"][0]["required"], 30);
}
