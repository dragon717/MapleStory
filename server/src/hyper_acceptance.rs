fn hyper_profile(skills: &[u32]) -> Profile {
    let mut profile = quest_profile();
    profile.level = 190;
    profile.job = ICE_FOURTH_JOB;
    profile.hp = 5_000;
    profile.max_hp = 5_000;
    profile.mp = 5_000;
    profile.max_mp = 5_000;
    profile.mesos = 10_000_000;
    profile.skills = skills.iter().copied().map(|skill| (skill, 1)).collect();
    profile.skill_points = BTreeMap::from([(FOURTH_BOOK, 100)]);
    profile
}

fn hyper_world(
    store: auth::Store,
    account: &str,
    skills: &[u32],
) -> (World, mpsc::Receiver<String>) {
    store.load_profile(account, &hyper_profile(skills)).unwrap();
    store.save_profile(account, &hyper_profile(skills)).unwrap();
    let mut world = chapter_actual_world(store).with_mage_skills(MageSkills::bundled());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);
    (world, rx)
}

fn hyper_target(world: &mut World, account: &str) -> String {
    let (target_id, map_id) = world
        .monsters
        .values()
        .find(|monster| monster.state.hp > 0)
        .map(|monster| (monster.state.id.clone(), monster.map_id.clone()))
        .expect("shared gameplay target");
    let (x, y) = world
        .monsters
        .get(&target_id)
        .map(|monster| (monster.state.x, monster.state.y))
        .unwrap();
    chapter_place(world, account, &map_id, x, y);
    let (x, y) = {
        let player = &world.players[account];
        (player.state.x, player.state.y)
    };
    let target = world.monsters.get_mut(&target_id).unwrap();
    target.state.x = x;
    target.state.y = y;
    target.state.hp = 1_000_000;
    target.state.max_hp = 1_000_000;
    target.state.action = "stand";
    target_id
}

fn hyper_set_persisted_mp(store: &auth::Store, account: &str, mp: i64) {
    let mut profile = store.load_profile(account, &hyper_profile(&[])).unwrap();
    profile.mp = mp;
    store.save_profile(account, &profile).unwrap();
}

/// 火毒四转（212）的那一档。`hyper_profile` 摆的是冰雷，開關技能那一格是**按职业分支
/// 各一本**，所以这一条要真的换个职业，而不是复用 222 的档案。
const HYPER_FIRE_JOB: u32 = 212;

fn hyper_fire_world(
    store: auth::Store,
    account: &str,
    skills: &[u32],
) -> (World, mpsc::Receiver<String>) {
    let mut profile = hyper_profile(skills);
    profile.job = HYPER_FIRE_JOB;
    store.load_profile(account, &profile).unwrap();
    store.save_profile(account, &profile).unwrap();
    let mut world = chapter_actual_world(store).with_mage_skills(MageSkills::bundled());
    let mut rx = chapter_join(&mut world, account);
    chapter_drain(&mut rx);
    (world, rx)
}

/// 清掉上一次施法留下的动作锁（`attack_until` 是权威的，不清会让下一次施法以
/// `skill_busy` 的形式炸掉，看起来像技能没接线）。
fn hyper_unlock(world: &mut World, account: &str) {
    let player = world.players.get_mut(account).unwrap();
    player.attack_until = 0;
    player.state.action = "stand";
}

#[test]
fn hyper_thunder_prepaid_release_and_damage_guard() {
    let path = std::env::temp_dir().join(format!("maple-hyper-release-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (mut world, mut rx) = hyper_world(service.store.clone(), "hyper-release", &[SKILL_HYPER_THUNDER]);
    let _target = hyper_target(&mut world, "hyper-release");
    world.handle_cast_skill("hyper-release".into(), "thunder".into(), SKILL_HYPER_THUNDER, Some(1), Some(0));
    let cast = chapter_drain(&mut rx);
    assert!(cast.iter().any(|m| m["type"] == "skillResult" && m["success"] == true), "cast rejected: {cast:?}");
    assert_eq!(world.players["hyper-release"].state.mp, 4_970);
    let channel_until = world.players["hyper-release"].channel_until;
    let hp_before = world.players["hyper-release"].state.hp;
    let attack_before = world.players["hyper-release"].attack_until;
    let (hp_damage, _, killed) = world.commit_incoming_damage("hyper-release", 100).unwrap();
    assert_eq!((hp_damage, killed), (50, false));
    assert_eq!(world.players["hyper-release"].state.hp, hp_before - 50);
    assert_eq!(world.players["hyper-release"].attack_until, attack_before);
    assert_eq!(world.players["hyper-release"].knockback_vx, 0.0);

    world.handle_release_skill("hyper-release".into(), "thunder".into());
    let release = chapter_drain(&mut rx);
    assert_eq!(release.iter().filter(|message| message["phase"] == "final").count(), 1);
    assert!(world.players["hyper-release"].channel_skill_id.is_none());
    assert!(world.players["hyper-release"].skill_cooldowns.contains_key(&SKILL_HYPER_THUNDER));
    assert!(channel_until > world.tick);
    world.handle_release_skill("hyper-release".into(), "thunder".into());
    assert!(!chapter_drain(&mut rx).iter().any(|message| message["phase"] == "final"));
}

#[test]
fn hyper_thunder_pulses_keep_source_segments_and_stop_without_free_final() {
    let path = std::env::temp_dir().join(format!("maple-hyper-pulse-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (mut world, mut rx) = hyper_world(service.store.clone(), "hyper-pulse", &[SKILL_HYPER_THUNDER]);
    let target_id = hyper_target(&mut world, "hyper-pulse");
    world.handle_cast_skill("hyper-pulse".into(), "thunder".into(), SKILL_HYPER_THUNDER, Some(1), Some(0));
    chapter_drain(&mut rx);
    let initial_mp = world.players["hyper-pulse"].state.mp;
    world.tick = world.players["hyper-pulse"].hyper_channel_prepare_until;
    world.step_hyper_channels();
    let first = chapter_drain(&mut rx);
    let hits: Vec<_> = first.iter().filter(|m| m["type"] == "damageEvent" && m["targetId"] == target_id).collect();
    assert_eq!(hits.len(), 15, "source attackCount=15: {first:?}");
    assert_eq!(1_000_000 - world.monsters[&target_id].state.hp, hits.iter().map(|m| m["damage"].as_i64().unwrap()).sum::<i64>());
    assert_eq!(world.players["hyper-pulse"].state.mp, initial_mp, "first pulse is prepaid");
    world.tick = world.players["hyper-pulse"].hyper_channel_next_pulse;
    world.step_hyper_channels();
    assert_eq!(world.players["hyper-pulse"].state.mp, initial_mp - 30);

    hyper_set_persisted_mp(&service.store, "hyper-pulse", 0);
    world.players.get_mut("hyper-pulse").unwrap().state.mp = 0;
    world.tick = world.players["hyper-pulse"].hyper_channel_next_pulse;
    world.step_hyper_channels();
    assert!(world.players["hyper-pulse"].channel_skill_id.is_none());
    let stopped = chapter_drain(&mut rx);
    assert!(stopped.iter().any(|message| message["code"] == "hyper_pulse_stopped"));
    assert!(!stopped.iter().any(|message| message["phase"] == "final"));
}

#[test]
fn hyper_adventurer_vortex_scope_upkeep_and_reset_lifecycle() {
    let path = std::env::temp_dir().join(format!("maple-hyper-effects-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let (mut world, mut rx) = hyper_world(
        service.store.clone(),
        "hyper-effects",
        &[SKILL_HYPER_ADVENTURER, SKILL_HYPER_VORTEX],
    );
    let target_id = hyper_target(&mut world, "hyper-effects");
    let base = world.magic_damage_with_passives("hyper-effects", SKILL_COLD_BEAM, &target_id, 100, false, "base", 1);
    assert!(!world.players["hyper-effects"].state.skills.contains_key(&SKILL_MYSTIC_STRIKE));
    world.handle_cast_skill("hyper-effects".into(), "adventurer".into(), SKILL_HYPER_ADVENTURER, Some(1), Some(0));
    chapter_drain(&mut rx);
    let boosted = world.magic_damage_with_passives("hyper-effects", SKILL_COLD_BEAM, &target_id, 100, false, "boosted", 1);
    assert!(boosted > base, "1053 must apply without Mystic Strike: {base} -> {boosted}");

    world.handle_cast_skill("hyper-effects".into(), "barrier".into(), SKILL_HYPER_VORTEX, Some(1), Some(0));
    chapter_drain(&mut rx);
    hyper_set_persisted_mp(&service.store, "hyper-effects", 0);
    world.players.get_mut("hyper-effects").unwrap().state.mp = 0;
    let tick = world.tick;
    {
        let player = world.players.get_mut("hyper-effects").unwrap();
        // 把两个节拍点都拉到当下：本拍应当既收 upkeep、又做周期作用。
        // 開關态只有一处（表里有没有这条技能），所以这里只需重置两个节拍点。
        player.toggle_fields.insert(
            SKILL_HYPER_VORTEX,
            ToggleFieldRuntime {
                next_mp: tick,
                next_pulse: tick,
            },
        );
    }
    world.step_toggle_fields();
    assert!(
        !toggle_field_enabled(&world.players["hyper-effects"], SKILL_HYPER_VORTEX),
        "upkeep 失败必须把開關位关掉"
    );
    assert!(world.monsters[&target_id].state.freeze_stacks.is_none(), "failed upkeep cannot freeze");

    hyper_set_persisted_mp(&service.store, "hyper-effects", 5_000);
    world.players.get_mut("hyper-effects").unwrap().state.mp = 5_000;
    world.handle_cast_skill("hyper-effects".into(), "vortex".into(), SKILL_HYPER_VORTEX, Some(1), Some(1));
    assert!(chapter_drain(&mut rx).iter().any(|message| message["success"] == true));
    let vortex = world.players["hyper-effects"].hyper_vortex.clone().unwrap();
    let cooldown = world.players["hyper-effects"].skill_cooldowns[&SKILL_HYPER_VORTEX_HIDDEN];
    world.tick = vortex.next_pulse_at;
    world.step_hyper_effects();
    assert!(world.monsters[&target_id].state.freeze_stacks.is_some());
    assert_eq!(world.monsters[&target_id].state.hp, 1_000_000, "hidden vortex has no damage");
    world.monsters.get_mut(&target_id).unwrap().state.freeze_stacks = None;
    world.monsters.get_mut(&target_id).unwrap().state.x = vortex.x + 400.0;
    world.tick = world.players["hyper-effects"].hyper_vortex.as_ref().unwrap().next_pulse_at;
    world.step_hyper_effects();
    assert!(world.monsters[&target_id].state.freeze_stacks.is_none(), "vortex range is authoritative");
    world.handle_cast_skill("hyper-effects".into(), "vortex-again".into(), SKILL_HYPER_VORTEX, Some(1), Some(1));
    assert_eq!(chapter_rejection(&mut rx), "skill_cooldown");

    world.handle_reset_hyper("hyper-effects".into(), "reset".into(), 100_000);
    assert!(chapter_drain(&mut rx).iter().any(|message| message["success"] == true));
    let player = &world.players["hyper-effects"];
    assert!(player.hyper_vortex.is_none());
    assert!(!toggle_field_enabled(player, SKILL_HYPER_VORTEX));
    assert_eq!(player.skill_cooldowns.get(&SKILL_HYPER_VORTEX_HIDDEN), Some(&cooldown));
    assert!(player.state.skills.get(&SKILL_HYPER_VORTEX).is_none());
}

/// 火靈結界 `2121054`（火毒四转開關技能）——与冰雷 `2221054 冰雪結界` 是**同一格机制、
/// 不同形态**：机制（「再次使用即关闭」的持久開關位 ＋ 每秒 upkeep ＋ 周期作用）由服务端
/// 一份代码承担；**形态**（周期作用是什么、美术几组、有没有循环音）各按源来。
///
/// 改前 `elemental.rs` 整块按 `SKILL_HYPER_VORTEX` 写死（连每秒 60 MP、周期 2400 ms 都是
/// 字面量）⇒ 火毒这一格连白名单都进不去，施放回的是「该技能尚未开放施放」。
///
/// 钉五件事：① 表与源一致；② 每秒扣的是**源 `mpCon`**；③ 周期拍打出范围伤害并挂上源
/// `dot*`（走与召唤脉冲同一条 `cast_elemental_area_at` 链）；④ 再次施放即关闭；
/// ⑤ **反向**断言：源里火毒这本**没有** ↓ 变体（那是冰雷的隐藏节点 `2221055`），
///    必须显式拒绝，不许静默当成「打开」。
#[test]
fn hyper_fire_ward_toggle_pulse_upkeep_close_and_no_down_variant() {
    let path = std::env::temp_dir().join(format!("maple-hyper-ward-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let account = "hyper-ward";
    let (mut world, mut rx) = hyper_fire_world(service.store.clone(), account, &[SKILL_FIRE_WARD]);
    let target_id = hyper_target(&mut world, account);

    // ① 表与源：两本開關技能；火毒那本的**周期**来自源 `subTime`（3000 ms），
    //    不是改前那个写死的兜底值；而 `time` 字段源里根本没有 ⇒ 别把周期读成自增益窗。
    assert_eq!(TOGGLE_FIELD_SKILLS, [SKILL_HYPER_VORTEX, SKILL_FIRE_WARD]);
    let ward = MageSkills::bundled()
        .level(SKILL_FIRE_WARD, 1)
        .cloned()
        .expect("2121054 的 level 1");
    assert_eq!(ward.mp_con, Some(100), "源 mpCon 是每秒 upkeep 的唯一依据");
    assert_eq!(ward.sub_time, Some(3_000), "源 subTime 是周期脉冲的唯一依据");
    assert!(
        ward.dot.is_some() && ward.dot_interval.is_some() && ward.dot_time.is_some(),
        "源 dot / dotInterval / dotTime 必须齐备"
    );
    assert!(ward.time.is_none(), "火靈結界源里没有 time");
    assert!(ward.cooltime.is_none(), "源里没有 cooltime ⇒ 再次施放不会被冷却挡住");

    // ② 打开：開關位进表、快照里的開關位亮起，且**两格各记各的账**。
    world.handle_cast_skill(
        account.into(),
        "ward-on".into(),
        SKILL_FIRE_WARD,
        Some(1),
        Some(0),
    );
    let cast = chapter_drain(&mut rx);
    assert!(
        cast.iter()
            .any(|m| m["type"] == "skillResult" && m["success"] == true),
        "cast rejected: {cast:?}"
    );
    assert!(toggle_field_enabled(&world.players[account], SKILL_FIRE_WARD));
    assert!(world.players[account].state.derived_stats.fire_ward_active);
    assert!(
        !world.players[account].state.derived_stats.hyper_barrier_active,
        "冰雷那一格不受火毒那本影响"
    );

    // ③ 周期拍：范围伤害 ＋ 挂上源 `dot*`。这一拍**不该**收 upkeep（`next_mp` 还没到）。
    let mp_after_cast = world.players[account].state.mp;
    let target_hp_before = world.monsters[&target_id].state.hp;
    world.tick = world.players[account].toggle_fields[&SKILL_FIRE_WARD].next_pulse;
    world.step_toggle_fields();
    assert!(
        world.monsters[&target_id].state.hp < target_hp_before,
        "周期拍必须打出范围伤害"
    );
    let dot = world
        .mechanics
        .dot(account, SKILL_FIRE_WARD, &target_id)
        .cloned()
        .expect("源 dot/dotInterval/dotTime 必须在周期拍挂上");
    assert!(dot.per_tick > 0);
    assert_eq!(
        world.players[account].state.mp, mp_after_cast,
        "upkeep 只在每秒那一拍收，不跟脉冲走"
    );

    // ④ upkeep：每秒扣**源 `mpCon`**（100），不是改前写死的 60。
    world.tick = world.players[account].toggle_fields[&SKILL_FIRE_WARD].next_mp;
    world.step_toggle_fields();
    assert_eq!(
        world.players[account].state.mp,
        mp_after_cast.saturating_sub(100),
        "每秒扣的是源 mpCon"
    );
    assert!(toggle_field_enabled(&world.players[account], SKILL_FIRE_WARD));

    // ⑤ upkeep 失败（MP 见底）⇒ 開關位必须关掉，并给玩家一条中文回执。
    // ⚠️ 先把 tick 往前推：upkeep 的幂等键是 `toggle-field:{id}:{skill}:{tick}`，
    // 复用同一个 tick 会被当成**重放**、直接回放上一次的结果（这正是那条守卫该做的事）。
    world.tick += 20;
    hyper_set_persisted_mp(&service.store, account, 0);
    world.players.get_mut(account).unwrap().state.mp = 0;
    let tick = world.tick;
    world
        .players
        .get_mut(account)
        .unwrap()
        .toggle_fields
        .get_mut(&SKILL_FIRE_WARD)
        .unwrap()
        .next_mp = tick;
    world.step_toggle_fields();
    assert!(
        !toggle_field_enabled(&world.players[account], SKILL_FIRE_WARD),
        "MP 不足必须把開關位关掉"
    );
    assert!(!world.players[account].state.derived_stats.fire_ward_active);
    let stopped = chapter_drain(&mut rx);
    assert!(
        stopped.iter().any(|m| m["code"] == "toggle_field_stopped"),
        "MP 不足要回一条玩家看得懂的拒绝：{stopped:?}"
    );

    // ⑥ 再次施放即关闭（这一格 `maxLevel = 1`，不靠等级切换）。
    hyper_set_persisted_mp(&service.store, account, 5_000);
    world.players.get_mut(account).unwrap().state.mp = 5_000;
    hyper_unlock(&mut world, account);
    world.handle_cast_skill(
        account.into(),
        "ward-reopen".into(),
        SKILL_FIRE_WARD,
        Some(1),
        Some(0),
    );
    chapter_drain(&mut rx);
    assert!(
        toggle_field_enabled(&world.players[account], SKILL_FIRE_WARD),
        "MP 恢复后能重新打开"
    );
    hyper_unlock(&mut world, account);
    world.handle_cast_skill(
        account.into(),
        "ward-off".into(),
        SKILL_FIRE_WARD,
        Some(1),
        Some(0),
    );
    chapter_drain(&mut rx);
    assert!(
        !toggle_field_enabled(&world.players[account], SKILL_FIRE_WARD),
        "再次使用即关闭"
    );
    assert!(!world.players[account].state.derived_stats.fire_ward_active);

    // ⑦ 反向：↓ 变体只对冰雷那本成立（源隐藏节点 `2221055`）。火毒这本必须**显式拒绝**，
    //    不许静默当成「打开」——那会让玩家按一下下键就白开一次结界。
    hyper_unlock(&mut world, account);
    world.handle_cast_skill(
        account.into(),
        "ward-down".into(),
        SKILL_FIRE_WARD,
        Some(1),
        Some(1),
    );
    let rejected = chapter_drain(&mut rx);
    assert!(
        rejected
            .iter()
            .any(|m| m["message"].as_str() == Some("invalid_toggle_field_variant")),
        "↓ 变体对火毒那本不成立，必须显式拒绝：{rejected:?}"
    );
    assert!(
        !toggle_field_enabled(&world.players[account], SKILL_FIRE_WARD),
        "被拒的 ↓ 变体不许静默打开開關位"
    );
    assert!(
        world.players[account].hyper_vortex.is_none(),
        "火毒那本源里没有隐藏漩涡节点 2221055"
    );
}
