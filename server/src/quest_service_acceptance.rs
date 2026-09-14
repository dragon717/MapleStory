// 審計 T03 / C02：被阻塞的续章入口必须真的可达，而且入口本身是服务端授权的。
//
// 背景（审计原文）：36315「奧莉維亞的特別修練」的完成条件是一次**已核定的击杀**
// （源 QuestInfo「擊殺藍色蘑菇王」+ Check.1.infoex kill），但它的击杀目标 8645261
// 在原版只出现在本地不可解的专用修練图 993166xxx 里。目标怪不在世界里，任务规格
// 再完整也永远完不成 —— 后面的 36316 因此被堵在门外。
//
// 这条用例把整条链在真实世界上跑一遍：目标怪出现在可达地图 → 任务视窗自助接取
// （入口由服务端判定，客户端伪造不了）→ 真的打死它 → 事务写下击杀计数 → 交付拿
// 奖励 → 重登后状态保留。任何一步退回"规格可执行但不可达"都会在这里失败。

const CALAMITY_QUEST: &str = "36315";
const CALAMITY_MOB: &str = "8645261";
const CALAMITY_SPAWN: &str = "001010000-calamity-8645261";
const CALAMITY_MAP: &str = "001010000";

fn calamity_profile() -> Profile {
    let mut profile = quest_profile();
    profile.hp = 500_000;
    profile.max_hp = 500_000;
    profile.level = 20;
    profile.job = 200;
    // 奖励结算要看得见：把升级曲线抬走，任务 EXP 就是这一条用例里唯一的 exp 变化。
    profile.exp = 0;
    profile.exp_to_next = 100_000;
    profile
}

fn calamity_monster_id(world: &World) -> String {
    world
        .monsters
        .values()
        .find(|monster| monster.spawn.id == CALAMITY_SPAWN && monster.state.hp > 0)
        .map(|monster| monster.state.id.clone())
        .expect("災禍篇 36315 的击杀目标必须在世界里真的存在")
}

#[test]
fn quest_service_entry_is_self_service_only_and_the_calamity_kill_is_reachable() {
    let path = std::env::temp_dir().join(format!("maple-quest-service-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let account = "quest-service";
    let base = calamity_profile();
    service.store.load_profile(account, &base).unwrap();
    // 36315 的源前置是 36314（已完成）。
    service.store.save_quest(account, "36314", "completed").unwrap();
    let mut world = chapter_actual_world(service.store.clone());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);

    // 入口是服务端授权，不是报文字段：36316 的源 Check/0/npc 是 1012100（赫麗娜），
    // 不是自服务任务，从任务视窗发起必须被拒，客户端无法声称"我是任务视窗所以可以"。
    world.handle_quest_service(
        account.into(),
        "service-36316".into(),
        "36316".into(),
        "start".into(),
    );
    assert_eq!(chapter_rejection(&mut rx), "quest_self_service_unavailable");
    assert_eq!(world.players[account].quests.get("36316"), None);

    // 动作名也是白名单：既不是 start 也不是 complete。
    world.handle_quest_service(
        account.into(),
        "service-bad-action".into(),
        CALAMITY_QUEST.into(),
        "cancel".into(),
    );
    assert_eq!(chapter_rejection(&mut rx), "quest_service_invalid");

    // 目标怪必须在世界里，并且站在那张从出生图可达的地图上。
    let spawn_map = world
        .monsters
        .values()
        .find(|monster| monster.spawn.id == CALAMITY_SPAWN)
        .map(|monster| monster.map_id.clone())
        .expect("災禍篇的最小场景执行必须装配出目标怪");
    assert_eq!(spawn_map, CALAMITY_MAP);

    // 未接任务时没有任何 active 击杀目标：此时即使打死它也不该记进度
    // （事务侧的不计数由 quest_kill_store_acceptance 覆盖）。
    assert!(
        world
            .active_kill_objectives(account, CALAMITY_MOB)
            .is_empty(),
        "未接任务时不该存在 active 击杀目标"
    );

    // 自助接取：36315 的来源 selfStart/selfComplete 都是 true（源里根本没有 NPC）。
    world.handle_quest_service(
        account.into(),
        "service-start".into(),
        CALAMITY_QUEST.into(),
        "start".into(),
    );
    assert_eq!(world.players[account].quests[CALAMITY_QUEST], "active");
    assert_eq!(
        world.active_kill_objectives(account, CALAMITY_MOB),
        vec![(CALAMITY_QUEST.to_owned(), CALAMITY_MOB.to_owned())],
        "接取后世界层才把这条已核定目标交给结算事务"
    );

    // 条件未满足就领奖：击杀还没发生，交付必须被拒且状态不变。
    world.handle_quest_service(
        account.into(),
        "service-early".into(),
        CALAMITY_QUEST.into(),
        "complete".into(),
    );
    assert_eq!(chapter_rejection(&mut rx), "quest_requirements_missing");
    assert_eq!(world.players[account].quests[CALAMITY_QUEST], "active");
    assert!(world.players[account].quest_kills.is_empty());

    // 真的打死它：这一发攻击走的是普通攻击结算（attacks.rs），世界在结算里把
    // active 目标交给事务，再把权威计数读回玩家。任何"直接改内存"的捷径都不算。
    let monster_id = calamity_monster_id(&world);
    let (x, y) = {
        let monster = &world.monsters[&monster_id];
        (monster.state.x, monster.state.y)
    };
    chapter_place(&mut world, account, CALAMITY_MAP, x - 30.0, y);
    world.players.get_mut(account).unwrap().state.facing = 1;
    world.monsters.get_mut(&monster_id).unwrap().state.hp = 1;
    for attempt in 0..8 {
        if world.monsters[&monster_id].state.hp == 0 {
            break;
        }
        world.handle_attack(account.into(), format!("calamity-kill-{attempt}"));
        world.tick += world.combat.hit_after_ms.div_ceil(TICK_MS).max(1);
        world.resolve_pending_attacks();
    }
    assert_eq!(
        world.monsters[&monster_id].state.hp, 0,
        "必须走真实的攻击结算打死目标怪"
    );
    assert_eq!(
        world.players[account].quest_kills[CALAMITY_QUEST][CALAMITY_MOB],
        1,
        "击杀必须落到持久击杀计数上"
    );

    // 交付出门：奖励到账，任务状态落定。
    let exp_before = world.players[account].state.exp;
    world.handle_quest_service(
        account.into(),
        "service-complete".into(),
        CALAMITY_QUEST.into(),
        "complete".into(),
    );
    chapter_drain(&mut rx);
    assert_eq!(world.players[account].quests[CALAMITY_QUEST], "completed");
    assert_eq!(world.players[account].state.exp, exp_before + 600);

    // 重登：状态与计数都来自持久档案。
    world.command(Command::Leave {
        id: account.into(),
        connection: format!("{account}-connection"),
    });
    let mut world = chapter_actual_world(service.store.clone());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);
    assert_eq!(world.players[account].quests[CALAMITY_QUEST], "completed");
    assert_eq!(
        world.players[account].quest_kills[CALAMITY_QUEST][CALAMITY_MOB],
        1
    );
}
