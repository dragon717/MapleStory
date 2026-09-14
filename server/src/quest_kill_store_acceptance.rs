// 審計 T03 / C01：任务击杀进度必须是**服务端已确认的事实**，不是客户端能声明的字段。
//
// 这些用例打在真正的结算事务上（`Store::resolve_attack_with_party`），逐条覆盖审计
// 点名的例证：未接任务击杀不计数、接取后击杀计数、重复死亡事件不重复计数、
// 不同模板不计数、练习图不计任务进度、离线重登保留。
//
// 计数的推进只跟随"真正确认了这只怪战利品"的那一次击杀（`monster_rewards` 认领
// 成功，即 `reward_claimed`），所以重放的死亡消息或重复的请求都不会再加一次；
// 计数属于击杀落地的那个人，队友的伤害不会替他记账。
//
// 目标怪 8645261 藍色蘑菇王与任务 36315 取自 `references/tms273-data/
// maple-island-calamity-source.json` 的已核定击杀目标（源 QuestInfo
// 「擊殺藍色蘑菇王 #R36315ExkillRef36315#」+ Check.1.infoex kill）。

const KILL_QUEST: &str = "36315";
const KILL_MOB: &str = "8645261";
const KILL_MAP: &str = "001010000";

fn kill_objective() -> Vec<(String, String)> {
    vec![(KILL_QUEST.to_owned(), KILL_MOB.to_owned())]
}

fn kill_count(store: &Store, account: &str, quest_id: &str, mob_id: &str) -> u32 {
    store
        .load_quest_kills(account)
        .unwrap()
        .get(quest_id)
        .and_then(|kills| kills.get(mob_id))
        .copied()
        .unwrap_or(0)
}

/// 走一次完整的"认领请求 + 结算"路径，返回这一次是否**认领了这只怪的奖励**
/// （`reward_claimed`）。任务击杀进度只跟随这个标志，所以它就是"这一发算不算数"：
/// 同一具尸体的第二条死亡消息会返回 false，计数因此不会前进。
fn settle_kill(
    store: &Store,
    account: &str,
    request: &str,
    monster_id: &str,
    map_id: &str,
    targets: &[(String, String)],
) -> bool {
    store
        .claim_attack(account, map_id, request, request, "event")
        .unwrap();
    store
        .resolve_attack_with_party(
            account,
            map_id,
            request,
            Some(monster_id),
            7,
            true,
            17,
            7,
            &[],
            &[1_000],
            &[account.to_owned()],
            &[],
            targets,
        )
        .unwrap()
        .killed
}

#[test]
fn quest_kill_progress_is_store_authoritative_and_never_replayed() {
    let path = std::env::temp_dir().join(format!("maple-quest-kill-{}.sqlite3", random_id()));
    let store = attack_store_open(&path);
    let base = attack_store_profile();
    store.load_profile("kills", &base).unwrap();
    store.load_profile("bystander", &base).unwrap();

    // 未接任务：世界层此时没有任何 active 击杀目标，事务收到空列表。击杀真的
    // 发生了（奖励照常结算），但任务日志不能因此提前欠一笔进度。
    assert!(settle_kill(
        &store,
        "kills",
        "kill-before",
        "mob-before",
        KILL_MAP,
        &[]
    ));
    assert_eq!(kill_count(&store, "kills", KILL_QUEST, KILL_MOB), 0);

    // 接取后击杀：这一次带上了 (36315, 8645261)，计数为 1。
    assert!(settle_kill(
        &store,
        "kills",
        "kill-after",
        "mob-after",
        KILL_MAP,
        &kill_objective()
    ));
    assert_eq!(kill_count(&store, "kills", KILL_QUEST, KILL_MOB), 1);

    // 重放同一个请求（客户端重发、断线重连）：事务认得它，直接回原结果。
    store
        .claim_attack("kills", KILL_MAP, "kill-after", "kill-after", "event")
        .unwrap();
    let replay = store
        .resolve_attack_with_party(
            "kills",
            KILL_MAP,
            "kill-after",
            Some("mob-after"),
            7,
            true,
            17,
            7,
            &[],
            &[1_000],
            &["kills".into()],
            &[],
            &kill_objective(),
        )
        .unwrap();
    assert!(replay.already_resolved);
    assert_eq!(kill_count(&store, "kills", KILL_QUEST, KILL_MOB), 1);

    // 同一具尸体的第二条死亡消息：战利品已经被认领过，这一次不再算数，
    // 计数因此停在 1。
    assert!(
        !settle_kill(
            &store,
            "kills",
            "kill-same-corpse",
            "mob-after",
            KILL_MAP,
            &kill_objective(),
        ),
        "重复的死亡消息不该再认领一次奖励"
    );
    assert_eq!(kill_count(&store, "kills", KILL_QUEST, KILL_MOB), 1);

    // 不同模板：世界层只把"这只怪的模板正好是一个 active 目标"的交上去，
    // 打别的怪只会带空列表结算。
    assert!(settle_kill(
        &store,
        "kills",
        "kill-other-mob",
        "mob-other",
        KILL_MAP,
        &[]
    ));
    assert_eq!(kill_count(&store, "kills", KILL_QUEST, KILL_MOB), 1);

    // 练习图是遭遇战：即使调用方误带了目标也不计任务进度。
    assert!(settle_kill(
        &store,
        "kills",
        "kill-practice",
        "mob-practice",
        "practice:102020500:quest-kill",
        &kill_objective(),
    ));
    assert_eq!(kill_count(&store, "kills", KILL_QUEST, KILL_MOB), 1);

    // 进度只属于击杀落地的那个人。
    assert!(store.load_quest_kills("bystander").unwrap().is_empty());

    // 第二次真实击杀要累加：计数不是"卡在 1"的布尔。
    assert!(settle_kill(
        &store,
        "kills",
        "kill-second",
        "mob-second",
        KILL_MAP,
        &kill_objective()
    ));
    assert_eq!(kill_count(&store, "kills", KILL_QUEST, KILL_MOB), 2);

    // 离线重登：计数来自持久档案，不是进程内镜像。
    drop(store);
    let store = attack_store_open(&path);
    assert_eq!(kill_count(&store, "kills", KILL_QUEST, KILL_MOB), 2);
    assert_eq!(store.load_profile("kills", &base).unwrap().level, base.level);
    drop(store);
    attack_store_cleanup(&path);
}
