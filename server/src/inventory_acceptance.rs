use crate::{
    auth::{self, Profile},
    inventory::EquipmentStats,
};
use rusqlite::Connection;
use std::collections::BTreeMap;

#[test]
fn inventory_business_roundtrip_preserves_quantities_and_equipment_instances() {
    let path = std::env::temp_dir().join(format!(
        "maple-inventory-acceptance-{}.sqlite3",
        auth::random_id()
    ));
    let service = auth::start(&path).unwrap();
    let store = service.store.clone();
    let defaults = Profile {
        hp: 10,
        max_hp: 50,
        mp: 1,
        max_mp: 5,
        level: 5,
        job: 0,
        exp: 0,
        exp_to_next: 15,
        mesos: 1000,
        death_id: String::new(),
        map_id: String::new(),
        x: 0.0,
        y: 0.0,
        inventory: Vec::new(),
        skills: BTreeMap::new(),
        skill_points: BTreeMap::new(),
        ability_stats: crate::protocol::AbilityStats::default(),
    };
    store.load_profile("a", &defaults).unwrap();
    let stats = EquipmentStats {
        level: 5,
        ..EquipmentStats::default()
    };
    {
        let db = Connection::open(&path).unwrap();
        db.execute_batch("INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity) VALUES
            ('a',1,1,'1102173',1), ('a',2,1,'2000000',100),
            ('a',2,2,'2041006',2), ('a',2,3,'2040705',1), ('a',4,1,'4000019',200);
            INSERT INTO drops(id,map_id,item_id,quantity,x,y,active) VALUES ('card','map','2380000',1,0,0,1);")
            .unwrap();
    }
    let potion = store
        .use_item("a", "potion", 2, 1, "2000000", None, None, stats)
        .unwrap();
    assert!(potion.success, "{}", potion.code);
    store
        .use_item("a", "potion", 2, 1, "2000000", None, None, stats)
        .unwrap();
    let profile = store.load_profile("a", &defaults).unwrap();
    assert_eq!(profile.hp, 50);
    assert_eq!(
        profile
            .inventory
            .iter()
            .find(|i| i.item_id == "2000000")
            .unwrap()
            .quantity,
        99
    );
    assert_eq!(profile.inventory.iter().filter(|i| i.slot == 1).count(), 3);

    assert!(
        store
            .pickup("a", "map", "card-pickup", "card")
            .unwrap()
            .success
    );
    assert_eq!(
        store.load_monster_book("a").unwrap().get("2380000"),
        Some(&1)
    );
    assert!(!store
        .load_profile("a", &defaults)
        .unwrap()
        .inventory
        .iter()
        .any(|i| i.item_id == "2380000"));

    assert!(
        store
            .use_item("a", "equip", 1, 1, "1102173", None, None, stats)
            .unwrap()
            .success
    );
    let wrong = store
        .use_item(
            "a",
            "wrong-scroll",
            2,
            3,
            "2040705",
            Some(-9),
            Some("1102173"),
            stats,
        )
        .unwrap();
    assert!(!wrong.success);
    assert_eq!(
        store
            .load_equipped("a")
            .unwrap()
            .iter()
            .find(|i| i.slot == 9)
            .unwrap()
            .remaining_slots,
        Some(6)
    );
    assert_eq!(
        store
            .load_profile("a", &defaults)
            .unwrap()
            .inventory
            .iter()
            .find(|i| i.item_id == "2040705")
            .unwrap()
            .quantity,
        1
    );

    let scrolled = store
        .use_item(
            "a",
            "scroll",
            2,
            2,
            "2041006",
            Some(-9),
            Some("1102173"),
            stats,
        )
        .unwrap();
    assert!(scrolled.success, "{}", scrolled.code);
    let upgraded = store
        .load_equipped("a")
        .unwrap()
        .into_iter()
        .find(|i| i.slot == 9)
        .unwrap();
    assert_eq!(upgraded.remaining_slots, Some(5));
    assert_eq!(upgraded.stats.as_ref().unwrap().get("incMHP"), Some(&20));
    store
        .use_item(
            "a",
            "scroll",
            2,
            2,
            "2041006",
            Some(-9),
            Some("1102173"),
            stats,
        )
        .unwrap();
    assert_eq!(
        store
        .load_equipped("a")
            .unwrap()
            .into_iter()
            .find(|i| i.slot == 9)
            .unwrap(),
        upgraded
    );
    assert_eq!(
        store
            .load_profile("a", &defaults)
            .unwrap()
            .inventory
            .iter()
            .find(|i| i.item_id == "2041006")
            .unwrap()
            .quantity,
        1
    );

    assert!(
        store
            .use_item("a", "unequip", 1, -9, "1102173", None, None, stats)
            .unwrap()
            .success
    );
    let removed = store
        .drop_inventory("a", "map", "drop", 1, 1, 1, 0.0, 0.0)
        .unwrap();
    assert!(removed.success);
    assert!(
        store
            .pickup("a", "map", "pickup", removed.drop_id.as_deref().unwrap())
            .unwrap()
            .success
    );
    let recovered = store
        .load_profile("a", &defaults)
        .unwrap()
        .inventory
        .into_iter()
        .find(|i| i.item_id == "1102173")
        .unwrap();
    assert_eq!(recovered, crate::protocol::InventoryItem { slot: 1, ..upgraded.clone() });
    let mesos = store
        .drop_mesos("a", "map", "mesos", 100, 0.0, 0.0)
        .unwrap();
    assert!(mesos.success);
    store
        .drop_mesos("a", "map", "mesos", 100, 0.0, 0.0)
        .unwrap();
    assert_eq!(store.load_profile("a", &defaults).unwrap().mesos, 900);
    drop(store);
    drop(service);
    let reopened = auth::start(&path).unwrap();
    assert_eq!(
        reopened
            .store
            .load_profile("a", &defaults)
            .unwrap()
            .inventory
            .into_iter()
            .find(|i| i.item_id == "1102173")
            .unwrap(),
        recovered
    );
    assert_eq!(
        reopened
            .store
            .load_monster_book("a")
            .unwrap()
            .get("2380000"),
        Some(&1)
    );
    drop(reopened);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}
