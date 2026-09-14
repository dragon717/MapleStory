// 審計 T04：高频操作被拒时，玩家要能分清**是什么挡住了他**。
//
// 以前 `handle_attack` 对「爬绳中 / 死亡 / 技能引导中」三种完全不同的情况一律回
// `invalid_state` + 一句英文 "Cannot attack while climbing or dead"，客户端表格
// 里没有这个码，于是中文界面上出现的是一行英文加一个裸错误码。玩家按下去没反应，
// 得到的答案是开发者日志 —— 这正是任务卡里"不能用相同的反馈覆盖所有情况"的反面。
//
// 这里钉住的是"三种原因给三个码 + 每个码在客户端都有中文文案"这个契约，不是数值：
// 攻击冷却、伤害、范围一个都不许动。

const CLIMBING: &str = "attack_while_climbing";
const DEAD: &str = "attack_while_dead";
const CHANNELING: &str = "attack_while_channeling";
const COOLDOWN: &str = "cooldown";

fn feedback_world(account: &str) -> (World, mpsc::Receiver<String>) {
    let path = std::env::temp_dir().join(format!("maple-feedback-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();
    let mut profile = quest_profile();
    profile.hp = 5_000;
    profile.max_hp = 5_000;
    profile.level = 20;
    profile.job = 200;
    service.store.load_profile(account, &profile).unwrap();
    let mut world = chapter_actual_world(service.store.clone());
    let rx = chapter_join(&mut world, account);
    (world, rx)
}

/// Every code the server can hand a player must have a line in the client's
/// table, or carry its own Chinese message.  The repository check
/// (`scripts/check_protocol_errors.cjs`) enforces it from the outside; this
/// pins the combat half from the inside so a rename cannot slip through a
/// refactor that only runs Rust.
fn client_error_table() -> BTreeSet<String> {
    let text = include_str!("../../client/src/app/i18n.ts");
    let start = text.find("PROTOCOL_ERRORS").expect("PROTOCOL_ERRORS 表");
    let end = text.find("MINIMAP_TEXT").expect("MINIMAP_TEXT 表");
    text[start..end]
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let name = trimmed.split_once(':')?.0.trim();
            let valid = !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
            // Only entries: the table body lines start at two spaces and end
            // in a `},` object, never a comment or the closing `});`.
            (valid && trimmed.contains("{ zh:")).then(|| name.to_owned())
        })
        .collect()
}

#[test]
fn each_attack_blocker_reports_its_own_reason() {
    let table = client_error_table();
    for code in [CLIMBING, DEAD, CHANNELING, COOLDOWN] {
        assert!(
            table.contains(code),
            "{code} 必须在 client/src/app/i18n.ts 的 PROTOCOL_ERRORS 里有中文文案"
        );
    }

    // 爬绳中：站在绳子上按攻击，得知道自己是因为在绳子上，而不是"不能攻击"。
    let account = "feedback-climb";
    let (mut world, mut rx) = feedback_world(account);
    chapter_drain(&mut rx);
    world.players.get_mut(account).unwrap().state.climbing = true;
    world.handle_attack(account.into(), "attack-climb".into());
    assert_eq!(chapter_rejection(&mut rx), CLIMBING);

    // 死亡：同一个动作，不同的挡路原因。
    let account = "feedback-dead";
    let (mut world, mut rx) = feedback_world(account);
    chapter_drain(&mut rx);
    {
        let player = world.players.get_mut(account).unwrap();
        player.state.hp = 0;
        player.state.action = "dead";
    }
    world.handle_attack(account.into(), "attack-dead".into());
    assert_eq!(chapter_rejection(&mut rx), DEAD);

    // 技能引导中：channel_until 还没到。
    let account = "feedback-channel";
    let (mut world, mut rx) = feedback_world(account);
    chapter_drain(&mut rx);
    world.players.get_mut(account).unwrap().channel_until = world.tick + 30;
    world.handle_attack(account.into(), "attack-channel".into());
    assert_eq!(chapter_rejection(&mut rx), CHANNELING);
}

#[test]
fn a_second_attack_inside_one_swing_says_the_swing_is_still_going() {
    // 连点攻击是被吞掉的（动作还没结束），这跟"你在绳子上"是完全不同的反馈。
    let account = "feedback-cooldown";
    let (mut world, mut rx) = feedback_world(account);
    chapter_drain(&mut rx);
    world.handle_attack(account.into(), "attack-first".into());
    chapter_drain(&mut rx);
    assert_eq!(world.players[account].state.action, "attack");
    // 第一次攻击已经把 attack_until 推到未来，此时再按一下必须给出"动作还没结束"。
    world.handle_attack(account.into(), "attack-second".into());
    assert_eq!(chapter_rejection(&mut rx), COOLDOWN);
}

#[test]
fn the_attack_blockers_stay_distinct_from_each_other() {
    // 三个码必须真的不同 —— 哪天有人把它们合并回一个 invalid_state，
    // 玩家就又分不清自己为什么按不动了。
    let mut codes = BTreeSet::new();
    codes.insert(CLIMBING);
    codes.insert(DEAD);
    codes.insert(CHANNELING);
    assert_eq!(codes.len(), 3);
    assert!(!codes.contains("invalid_state"), "攻击阻塞不再用 invalid_state 一码包打天下");
}
