/// 埃德爾斯坦城内 NPC 职能与脚本门验收（2026-09-16，飞行船三期剩余）。经
/// `include!` 进入 `world.rs` 的 `mod tests`，复用 `map()` / `join_test_player`
/// 等既有助手。
///
/// 覆盖：
/// 1. 城内四扇 pt:7 脚本门的内存分支端到端路由（`in00`/`in01`/`in02`/`in03`）；
/// 2. 未接的门（`in05`/`pt_regionMove`/`profession`/`market00`/`inXenonHouse`）
///    不归本模块处置，落到普通查表并因无静态目标而拒绝；
/// 3. 真实装配数据：四扇门的目录暴露（`Graph.json` 授权目标）、落点贴地、
///    两扇静态门与一扇接触门的目标图、城东散步路道链及其**终点边界**（步行只
///    到「去礦山的路2」；`enterBlackMine` 脚本体不在本包 ⇒ 矿山区仍不可达）；
/// 4. **反向断言**：路由目标必须逐条出现在 `Graph.json` 的授权表里（不许凭空
///    造目标）、每个「授权目标未装配」的门都真的指向未装配的图、源自己没给目标
///    的门（授权 `999999999`）目录里必须保持 `null`。
use super::*;

/// `Graph.json` 的 `31/310000000/portal` 全表（门名、`portalNum`、授权目标）。
/// 只作断言用：运行时路由只认 `edelstein.rs::EDELSTEIN_CITY_GATES`，这张表用来
/// 钉住「路由目标不是我编的」和「没装配的目标一条都没漏登记」。
/// `310000000` 的门名与 `Graph.json` 的对应关系取自两边的同序定义（
/// 静态门 `west00`/`east00`/`resi00` 与脚本门按 `scriptPortal` 名一一对上）。
const EDELSTEIN_AUTHORIZED: &[(&str, &str, &str)] = &[
    // (源门名, portalNum, 授权目标)
    ("west00", "14", "310020000"),
    ("east00", "15", "310030000"),
    ("market00", "16", "910000000"),
    ("in01", "17", "310000004"),
    ("in02", "18", "931000600"),
    ("in02", "18", "310000010"),
    ("in03", "19", "310000003"),
    ("in00", "20", "310000001"),
    ("in05", "21", "999999999"),
    ("profession", "22", "910001000"),
    ("pt_regionMove", "23", "999999999"),
    ("inXenonHouse", "24", "931060000"),
    ("resi00", "29", "310010000"),
];

/// 城内四扇 pt:7 脚本门的源脚本名（`Map.wz` 的 `portal/*/script`）。
const EDELSTEIN_GATE_SCRIPTS: &[(&str, &str)] = &[
    ("in00", "in_310000001"),
    ("in01", "enterMansion"),
    ("in02", "enterSecJobResi"),
    ("in03", "enterDangerHair"),
];

/// 平地房间：一块地板 + `sp` + 若干同高门（都贴地，供落点断言用）。
fn edelstein_room(id: &str, portals: &[&str]) -> Map {
    let extras: Vec<String> = portals
        .iter()
        .enumerate()
        .map(|(index, name)| {
            format!(r#"{{"name":"{name}","type":7,"x":{},"y":100}}"#, index as i32 * 20 - 40)
        })
        .collect();
    let joined = if extras.is_empty() {
        String::new()
    } else {
        format!(",{}", extras.join(","))
    };
    serde_json::from_str(&format!(
        r#"{{"id":"{id}","bounds":{{"xMin":-800,"xMax":800,"yMin":-1200,"yMax":600}},"spawn":{{"x":0,"y":100}},"footholds":[{{"id":1,"x1":-800,"y1":100,"x2":800,"y2":100,"prev":0,"next":0}}],"ladders":[],"portals":[{{"name":"sp","type":0,"x":0,"y":100}}{joined}]}}"#
    ))
    .unwrap()
}

fn edelstein_world() -> World {
    let mut world = World::new_with_gameplay(map(), 600, Gameplay::default());
    world.maps.insert(
        "310000000".to_owned(),
        edelstein_room(
            "310000000",
            &["in00", "in01", "in02", "in03", "in05", "market00", "profession", "pt_regionMove", "inXenonHouse"],
        ),
    );
    for (id, portals) in [
        ("310000001", vec!["out00"]),
        ("310000003", vec!["out00"]),
        ("310000004", vec!["out00"]),
        ("310000010", vec!["out00"]),
    ] {
        world
            .maps
            .insert(id.to_owned(), edelstein_room(id, &portals));
    }
    world
}

fn edelstein_drain(rx: &mut mpsc::Receiver<String>) -> Vec<String> {
    let mut messages = Vec::new();
    while let Ok(message) = rx.try_recv() {
        messages.push(message);
    }
    messages
}

/// 加入角色 → 安置到城图 → 发起传送意图 → 收回执与最终地图。
fn edelstein_enter_portal(
    world: &mut World,
    id: &str,
    portal_name: &str,
) -> (Vec<String>, String) {
    let mut rx = join_test_player(world, id);
    edelstein_drain(&mut rx);
    {
        let player = world.players.get_mut(id).expect("player joined");
        player.map_id = "310000000".to_owned();
        player.state.x = 0.0;
        player.state.y = 100.0;
        player.state.grounded = true;
        player.state.action = "stand";
    }
    world.handle_portal(id.to_owned(), "req-1".to_owned(), portal_name.to_owned());
    let messages = edelstein_drain(&mut rx);
    let map_id = world.players.get(id).expect("player kept").map_id.clone();
    (messages, map_id)
}

fn edelstein_portal_result<'a>(messages: &'a [String]) -> &'a str {
    messages
        .iter()
        .find(|message| message.contains("portalResult"))
        .expect("portal result")
}

#[test]
fn edelstein_city_gates_route_to_the_authorized_interiors() {
    for (portal_name, target_map) in [
        ("in00", "310000001"),
        ("in01", "310000004"),
        ("in02", "310000010"),
        ("in03", "310000003"),
    ] {
        let mut world = edelstein_world();
        let (messages, map_id) = edelstein_enter_portal(&mut world, "p1", portal_name);
        let result = edelstein_portal_result(&messages);
        assert!(result.contains("\"success\":true"), "{portal_name}: {result}");
        assert!(result.contains(target_map), "{portal_name}: {result}");
        assert_eq!(map_id, target_map, "{portal_name} landed on the wrong map");
    }
}

#[test]
fn edelstein_unrouted_city_gates_stay_unhandled() {
    // 源里没给目标（`in05`/`pt_regionMove`）或目标未装配（`market00`/
    // `profession`/`inXenonHouse`）的门一律不由本模块处置：普通查表因为没有
    // 静态目标而回 `portal_unavailable`，玩家不会被送进任何图。
    for portal_name in ["in05", "pt_regionMove", "market00", "profession", "inXenonHouse"] {
        let mut world = edelstein_world();
        let (messages, map_id) = edelstein_enter_portal(&mut world, "p1", portal_name);
        let result = edelstein_portal_result(&messages);
        assert!(result.contains("\"success\":false"), "{portal_name}: {result}");
        assert_eq!(map_id, "310000000", "{portal_name} must not move the player");
    }
}

#[test]
fn edelstein_city_gate_table_covers_exactly_the_authorized_assembled_targets() {
    // 四条路由逐条必须在授权表里（不许凭空造目标），且落点门名非空。
    for (from, name, target, landing) in edelstein::EDELSTEIN_CITY_GATES {
        assert_eq!(*from, "310000000", "{name} must start in the city");
        assert!(!landing.is_empty(), "{name} needs a landing portal");
        assert!(
            EDELSTEIN_AUTHORIZED
                .iter()
                .any(|(authorized_name, _, authorized_target)| authorized_name == name
                    && authorized_target == target),
            "{name} -> {target} is not in the Graph.json authorization table"
        );
    }
    // 反过来（按**门**而非按条目）：授权表里出现的每一扇门要么进了路由表，
    // 要么逐条落在下面两组有记录的不接理由里。`in02` 是双授权目标，路由到
    // 已装配的 `310000010`，另一条 `931000600` 随目标未装配一并拒绝，故它
    // 属于「已路由」而非「不接」。
    let is_routed = |name: &str| {
        edelstein::EDELSTEIN_CITY_GATES
            .iter()
            .any(|entry| entry.1 == name)
    };
    let mut gates: Vec<&str> = EDELSTEIN_AUTHORIZED.iter().map(|entry| entry.0).collect();
    gates.sort_unstable();
    gates.dedup();
    for name in gates {
        let targets: Vec<&str> = EDELSTEIN_AUTHORIZED
            .iter()
            .filter(|entry| entry.0 == name)
            .map(|entry| entry.2)
            .collect();
        // 源自己没给目标（授权 `999999999`）的门**不许**进路由表。
        if targets.iter().all(|target| *target == "999999999") {
            assert!(!is_routed(name), "{name} has no authorized target and must stay unrouted");
            continue;
        }
        if is_routed(name) {
            continue;
        }
        // 未路由且有实质授权的门只有两类：源自带 `tm/tn` 的静态/接触门（不需要
        // 钩子），以及授权目标未装配、改由客户端说明的三扇。
        assert!(
            matches!(
                name,
                "west00" | "east00" | "resi00" | "market00" | "profession" | "inXenonHouse"
            ),
            "{name} -> {targets:?} left the route table without a documented reason"
        );
    }
    // 源脚本名逐条与 `Map.wz` 对得上（表里的四扇门就是这四个脚本）。
    for (name, script) in EDELSTEIN_GATE_SCRIPTS {
        assert!(
            edelstein::EDELSTEIN_CITY_GATES
                .iter()
                .any(|(_, route_name, _, _)| route_name == name),
            "{name} bound to source script {script} is missing from the route table"
        );
    }
}

#[test]
fn edelstein_real_catalog_wires_the_city_and_the_road_east() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    let by_id = |id: &str| {
        catalog
            .maps
            .iter()
            .find(|map| map.id == id)
            .unwrap_or_else(|| panic!("map {id} must be assembled"))
    };
    let assembled = |id: &str| catalog.maps.iter().any(|map| map.id == id);
    fn portal<'a>(map: &'a Map, name: &str) -> &'a Portal {
        map.portals
            .iter()
            .find(|portal| portal.name == name)
            .unwrap_or_else(|| panic!("map {} needs portal {name}", map.id))
    }

    // 城内四扇脚本门：目录里必须带上服务端钩子按同一目标处置的落点，否则
    // `world.ts::tryPortal` 只受理带 `targetMapId` 的门 ⇒ 玩家按 ↑ 发不出请求，
    // `edelstein.rs` 的路由永远收不到消息（与 `helios.rs` 2026-09-15 同因修复）。
    for (name, target, landing) in [
        ("in00", "310000001", "out00"),
        ("in01", "310000004", "out00"),
        ("in02", "310000010", "out00"),
        ("in03", "310000003", "out00"),
    ] {
        let gate = portal(by_id("310000000"), name);
        assert_eq!(gate.target_map_id.as_deref(), Some(target), "{name}");
        assert_eq!(gate.target_portal_name.as_deref(), Some(landing), "{name}");
        // 落点门必须存在且贴地（`warp_player_at` 的 24px 窗口）。
        let interior = by_id(target);
        let spot = portal(interior, landing);
        let ground = interior.ground_near(spot.x, spot.y);
        let distance = ground.map_or(f64::INFINITY, |(_, y)| (y - spot.y).abs());
        assert!(distance <= 24.0, "{target}/{landing} lands {distance:?}px off the ground");
        // 源内配对：内景的源静态回门正对本门。
        let back = portal(interior, "out00");
        assert_eq!(back.target_map_id.as_deref(), Some("310000000"), "{target}/out00");
        assert_eq!(back.target_portal_name.as_deref(), Some(name), "{target}/out00");
    }

    // 两扇静态门与一扇接触门：目标图随本片装配，源里本来就带 `tm`。
    for (name, target, landing) in [
        ("west00", "310020000", "east00"),
        ("east00", "310030000", "west00"),
        ("resi00", "310010000", "out00"),
    ] {
        let gate = portal(by_id("310000000"), name);
        assert_eq!(gate.target_map_id.as_deref(), Some(target), "{name}");
        assert_eq!(gate.target_portal_name.as_deref(), Some(landing), "{name}");
    }

    // 城东全静态门链：散步路道1 → 2 → 3 → 4 → 去礦山的路1 → 去礦山的路2
    // （后者 2026-09-15 就已装配，但当时唯一的入边来自「礦山入口」自己，
    // 而礦山入口也没有可达入边 ⇒ 整簇是孤岛；本片让它第一次可达）。
    for (from, name, to, back_name) in [
        ("310030000", "east00", "310030100", "west00"),
        ("310030100", "east00", "310030200", "west00"),
        ("310030200", "east00", "310030300", "west00"),
        ("310030300", "east00", "310040000", "west00"),
        ("310040000", "east00", "310040100", "west00"),
    ] {
        let gate = portal(by_id(from), name);
        assert_eq!(gate.target_map_id.as_deref(), Some(to), "{from}/{name}");
        assert_eq!(gate.target_portal_name.as_deref(), Some(back_name), "{from}/{name}");
        let back = portal(by_id(to), back_name);
        assert_eq!(back.target_map_id.as_deref(), Some(from), "{to}/{back_name}");
    }
    // **步行链到去礦山的路2 为止**（不许把边界写成「打通矿山」）：
    // `310040100.east00` 是 pt:7 脚本门 `enterBlackMine`（脚本体不在本包，
    // 源 `tm` 为 `999999999`）⇒ 目录里没有静态目标；`310040100.in00`（pt:1）
    // 指向 `310040110`，而那张图**不在目录里**。两条都进不去，所以
    // `310040200 礦山入口` 及其簇（HEAD 就已装配）仍然没有可达入边。反向断言
    // 钉死这两条，任何人「顺手给 east00 编一个目标」或「把 310040110 装进来」
    // 都会让这条边界失效并被抓。
    let mine_gate = portal(by_id("310040100"), "east00");
    assert_eq!(mine_gate.portal_type, 7, "去礦山的路2 east00 must stay a source script gate");
    assert!(
        mine_gate.target_map_id.is_none(),
        "east00 must stay unrouted: enterBlackMine has no body in this package"
    );
    let hidden_entrance = portal(by_id("310040100"), "in00");
    assert_eq!(hidden_entrance.target_map_id.as_deref(), Some("310040110"));
    assert!(
        !assembled("310040110"),
        "310040110 must stay unassembled for the 礦山 boundary record to hold"
    );
    // 矿山入口自己仍然是孤岛：**簇外**没有任何图（含本片新增的 10 张）指向它。
    // 簇内互指（`310040210.side00..03 → 310040200`、`310040300.out00 →
    // 310040200`）是源里本来就有的图内通路，不算可达入边。
    for source in &catalog.maps {
        if matches!(source.id.as_str(), "310040200" | "310040210" | "310040300") {
            continue;
        }
        for gate in &source.portals {
            assert_ne!(
                gate.target_map_id.as_deref(),
                Some("310040200"),
                "{}/{} must not open the mine from outside: the only entry is the missing enterBlackMine script",
                source.id,
                gate.name
            );
        }
    }
}

#[test]
fn edelstein_unassembled_authorized_targets_are_named_but_not_assembled() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    let by_id = |id: &str| catalog.maps.iter().find(|map| map.id == id);
    let portal = |map_id: &str, name: &str| {
        by_id(map_id)
            .unwrap_or_else(|| panic!("map {map_id} must be assembled"))
            .portals
            .iter()
            .find(|portal| portal.name == name)
            .unwrap_or_else(|| panic!("map {map_id} needs portal {name}"))
            .clone()
    };

    // 「有授权、目标未装配」的三扇城图门：目录里**写上**授权目标，让客户端按
    // 既有规则给「此路线尚未开放：目标地图 X 尚未收录」，而不是按 ↑ 毫无反应。
    for (name, target) in [
        ("market00", "910000000"),
        ("profession", "910001000"),
        ("inXenonHouse", "931060000"),
    ] {
        let gate = portal("310000000", name);
        assert_eq!(gate.target_map_id.as_deref(), Some(target), "{name}");
        assert!(by_id(target).is_none(), "{target} must stay unassembled for this record to hold");
    }
    // 耶雷弗簇的两扇（同一片核定，同一处置）。
    let bridge = portal("130030006", "east00");
    assert_eq!(bridge.target_map_id.as_deref(), Some("130030005"));
    assert!(by_id("130030005").is_none());
    let palace_gate = portal("130000200", "in01");
    assert_eq!(palace_gate.target_map_id.as_deref(), Some("913060000"));
    assert!(by_id("913060000").is_none());

    // 源自己没给目标的门（授权 `999999999`）**必须**保持 `null`：给它们编一个
    // 目标就是把「原版无路」写成「有路」（与 `ufo.rs` 的 `col00` 同口径）。
    for (map_id, name) in [
        ("310000000", "in05"),
        ("310000000", "pt_regionMove"),
        ("130000200", "pt_regionMove"),
    ] {
        let gate = portal(map_id, name);
        assert!(gate.target_map_id.is_none(), "{map_id}/{name} must stay closed");
    }
    // 耶雷弗城本身没有脚本门：两扇源静态门的两个目标图都在目录里。
    for (name, target) in [("west00", "130000101"), ("east00", "130030006")] {
        let gate = portal("130000000", name);
        assert_eq!(gate.target_map_id.as_deref(), Some(target), "{name}");
        assert!(by_id(target).is_some(), "{target} must be assembled");
    }
}

#[test]
fn edelstein_new_maps_return_to_the_city() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
    let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
    for (id, town) in [
        ("310000001", "310000000"),
        ("310000003", "310000000"),
        ("310000004", "310000000"),
        ("310020000", "310000000"),
        ("310030000", "310000000"),
        ("310030100", "310000000"),
        ("310030200", "310000000"),
        ("310030300", "310000000"),
        ("310040000", "310000000"),
        // 秘密廣場 310010000 的源 returnMap 指向自己（末日反抗軍本部内景），
        // 与 `310000000` 不同，如实照抄源。
        ("310010000", "310010000"),
    ] {
        assert_eq!(
            catalog.return_maps.get(id).map(String::as_str),
            Some(town),
            "{id} returnMap"
        );
    }
}

#[test]
fn edelstein_city_npcs_carry_their_source_functions() {
    // 城内 NPC 职能核定：三家源商店与一名仓库管理员随目录装配后**本来就能用**
    // （商店走 `shopId`，仓库走 `func` 含「倉庫」），本片不改它们；其余带
    // `info/script` 的 NPC 脚本体不在本包——城 310000000 的 34 名 NPC 里 16 条
    // 脚本引用只有 kasandra / unityPortal / NPC_unionShop / mParkShuttle 四个在
    // 包内（且分属全局系统），城内簇 10 图的 7 条（`hair_edel1`/`hair_royal`/
    // `henrite`/`bell`/`jaguar_in`/`cheki`/`illex`，即发廊与五名教官）**一条都
    // 不在** ⇒ 如实登记为边界，不在这条断言里假装它们能用。
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/gameplay.json");
    let gameplay: Gameplay =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("shared/gameplay.json"))
            .expect("gameplay parses");
    let in_city: Vec<&crate::world::NpcTemplate> = gameplay
        .npcs
        .iter()
        .filter(|npc| {
            gameplay
                .npc_spawns
                .iter()
                .any(|spawn| spawn.map_id == "310000000" && spawn.template_id == npc.template_id)
        })
        .collect();
    let shop_ids: Vec<&str> = in_city
        .iter()
        .filter_map(|npc| npc.shop_id.as_deref())
        .collect();
    assert_eq!(
        {
            let mut ids = shop_ids.clone();
            ids.sort_unstable();
            ids
        },
        ["2150001", "2150002", "9072100"],
        "埃德爾斯坦城的源商店集变了"
    );
    let keepers: Vec<&str> = in_city
        .iter()
        .filter(|npc| npc.func.contains(STORAGE_KEEPER_FUNC))
        .map(|npc| npc.template_id.as_str())
        .collect();
    assert_eq!(keepers, ["2150000"], "埃德爾斯坦城的仓库管理员集变了");
}
