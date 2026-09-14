// 服务端启动契约：`main()` 会按固定顺序加载 `shared/*.json` 并构造世界。fixture 类
// 用例用 `serde_json::from_str` + `include_str!` 绕过了 `*::load()` 这一步，于是
// "只有真正起服务才会失败"的加载错误能一路带着绿灯通过测试。
//
// 2026-09-14 就是这样炸的：36315 转为可执行后，加载校验把"源里没有 NPC"的空
// `npcId` 当成未知 NPC 引用，整个 gameplay.json 被拒绝，3010 起不来（而当时全部
// 单测与 JS 检查都是绿的，因为它们都不走 `Gameplay::load`）。这条用例把启动加载
// 路径钉成断言，并要求災禍篇的场景执行真的在世界上实例化出目标怪。
use std::path::Path;

#[test]
fn shipped_content_boots_through_the_server_load_path() {
    let shared = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared");
    let path = std::env::temp_dir().join(format!("maple-boot-{}.sqlite3", auth::random_id()));
    let service = auth::start(&path).unwrap();

    // 与 main.rs 相同的顺序与入口。
    let map = Map::load(&shared.join("map.json")).expect("shared/map.json must boot");
    let gameplay =
        Gameplay::load(&shared.join("gameplay.json")).expect("shared/gameplay.json must boot");
    let catalog =
        MapCatalog::load(&shared.join("maps.json")).expect("shared/maps.json must boot");
    let quest_text = crate::quest_text::QuestTextCorpus::load(&shared.join("quest-text.json"))
        .expect("shared/quest-text.json must boot");
    let windbell = super::windbell::WindbellConfig::load(&shared.join("windbell.json"))
        .expect("shared/windbell.json must boot");
    let world = World::new_with_store_and_catalog(map, 800, gameplay, service.store.clone(), catalog)
        .expect("the shipped content must construct a world")
        .with_quest_text(quest_text)
        .with_windbell(windbell)
        .expect("the shipped windbell activity must attach");

    // 災禍篇 C02 的最小场景执行必须在世界上真的落地：模板存在、刷怪吸附到地形、
    // 并且站在那张从出生图可达的地图上。任务 36315 的可执行状态依赖于此。
    let calamity = world
        .monsters
        .values()
        .find(|monster| monster.spawn.id == "001010000-calamity-8645261")
        .expect("the calamity kill target must be instantiated on boot");
    assert_eq!(calamity.map_id, "001010000");
    assert_eq!(calamity.template.template_id, "8645261");
    assert!(calamity.state.hp > 0);
    let quest = world
        .gameplay
        .quests
        .iter()
        .find(|quest| quest.quest_id == "36315")
        .expect("shared/gameplay.json must carry quest 36315");
    assert!(quest.executable(), "36315 must stay reachable once its target exists");
    assert!(quest.objectives.iter().any(|objective| {
        objective._kind == "kill" && objective.mob_id == "8645261" && objective.required > 0
    }));
}
