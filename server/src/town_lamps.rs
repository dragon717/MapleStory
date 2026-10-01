//! P: 初弦地原创灯具，独立JSON事实、一次入镇赠灯和守卫交易。
//! 复用Store的JSON/SQLite事务边界，不伪造WZ物品、不触原背包或装备。
use super::*;
use crate::protocol::{TownLampAction, TownLampState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rules { schema_version: u32, source_class: String, map_id: String, guard: Guard, tiers: Vec<Tier> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Guard { npc_id: String, template_id: String, name: String, spawn_offset_pixels: f64, interaction_range_metres: f64, vertical_range_metres: f64 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tier { tier: u8, range_metres: f64, intensity_candela: f64, decay: u8, required_level: u32, buy_price: u64, upgrade_price: u64 }
fn rules() -> &'static Rules {
    static DATA: OnceLock<Rules> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(include_str!("../../shared/town-lamps.json")).expect("town lamp rules"))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LampIntent { pub action: TownLampAction, pub tier: u8, pub expected_cost: u64, pub npc_id: Option<String> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LampReceipt {
    #[serde(rename = "type")]
    message_type: String,
    request_id: String,
    action: TownLampAction,
    pub success: bool,
    pub code: String,
    pub town_lamp: TownLampState,
    pub mesos: u64,
    mesos_spent: u64,
}

fn validate_state(state: &TownLampState) -> Result<(), String> {
    if state.tier > 3 || state.revision > 9_007_199_254_740_991
        || (!state.issued && (state.tier != 0 || state.revision != 0))
        || (state.issued && state.revision == 0) {
        return Err("town lamp state is invalid".into());
    }
    Ok(())
}

fn receipt(request_id: &str, intent: &LampIntent, state: &TownLampState, level: u32, mesos: u64, gate: Option<&str>) -> LampReceipt {
    let mut result = LampReceipt { message_type: "townLampResult".into(), request_id: request_id.into(), action: intent.action, success: false, code: String::new(), town_lamp: state.clone(), mesos, mesos_spent: 0 };
    let target = rules().tiers.iter().find(|tier| tier.tier == intent.tier);
    let (cost, code) = if let Some(code) = gate { (0, code) }
    else if state.revision >= 9_007_199_254_740_991 { (0, "lamp_revision_limit") }
    else if intent.action == TownLampAction::Discard {
        (0, if intent.tier != 0 || intent.expected_cost != 0 { "invalid_lamp_cost" } else if state.tier == 0 { "lamp_missing" } else { "" })
    } else if let Some(target) = target {
        let cost = if intent.action == TownLampAction::Buy { target.buy_price } else { target.upgrade_price };
        let code = if level < target.required_level { "lamp_level_required" }
            else if intent.action == TownLampAction::Upgrade && (state.tier == 0 || intent.tier != state.tier + 1) { "invalid_lamp_upgrade" }
            else if intent.action == TownLampAction::Buy && intent.tier <= state.tier { "lamp_not_better" }
            else if intent.expected_cost != cost { "invalid_lamp_cost" }
            else if mesos < cost { "insufficient_mesos" } else { "" };
        (cost, code)
    } else { (0, "invalid_lamp_tier") };
    result.code = code.into();
    if code.is_empty() {
        result.success = true;
        result.town_lamp = TownLampState { issued: true, tier: intent.tier, revision: state.revision + 1 };
        result.mesos -= cost;
        result.mesos_spent = cost;
    }
    result
}

fn read_state(db: &Connection, id: &str) -> Result<TownLampState, String> {
    let raw: Option<String> = db.query_row("SELECT state_json FROM town_lamp_state WHERE account_id=?1", [id], |row| row.get(0)).optional().map_err(|_| "account persistence failed")?;
    let state = raw.map(|raw| serde_json::from_str::<TownLampState>(&raw).map_err(|_| "town lamp state is invalid".to_owned())).transpose()?.unwrap_or_default();
    validate_state(&state)?;
    Ok(state)
}
fn write_state(db: &Connection, id: &str, state: &TownLampState) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|_| "account persistence failed")?;
    db.execute("INSERT INTO town_lamp_state(account_id,state_json) VALUES(?1,?2) ON CONFLICT(account_id) DO UPDATE SET state_json=excluded.state_json", params![id,json]).map_err(|_| "account persistence failed")?;
    Ok(())
}

impl Store {
    fn load_town_lamp(&self, id: &str) -> Result<TownLampState, String> { self.with_db(|db| read_state(db,id)) }
    fn issue_town_lamp(&self, id: &str) -> Result<(TownLampState, bool), String> {
        self.with_db(|db| {
            let tx = db.transaction().map_err(|_| "account persistence failed")?;
            tx.query_row("SELECT account_id FROM player_stats WHERE account_id=?1", [id], |row| row.get::<_,String>(0)).map_err(|_| "account persistence failed")?;
            let mut state = read_state(&tx,id)?;
            let issued = !state.issued;
            if issued { state = TownLampState { tier: 1, issued: true, revision: 1 }; write_state(&tx,id,&state)?; }
            tx.commit().map_err(|_| "account persistence failed")?;
            Ok((state,issued))
        })
    }
    fn transact_town_lamp(&self, id: &str, request_id: &str, intent: &LampIntent, gate: Option<&str>) -> Result<LampReceipt, String> {
        self.with_db(|db| {
            let tx = db.transaction().map_err(|_| "account persistence failed")?;
            let intent_json = serde_json::to_string(intent).map_err(|_| "account persistence failed")?;
            let saved: Option<(String,String)> = tx.query_row("SELECT intent_json,result_json FROM town_lamp_actions WHERE account_id=?1 AND request_id=?2",params![id,request_id],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "account persistence failed")?;
            if let Some((old_intent,json)) = saved {
                if intent_json != old_intent { return Err("idempotency_conflict".into()); }
                return serde_json::from_str(&json).map_err(|_| "account persistence failed".into());
            }
            let (level,mesos): (u32,u64) = tx.query_row("SELECT level,mesos FROM player_stats WHERE account_id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|_| "account persistence failed")?;
            let state = read_state(&tx,id)?;
            let result = receipt(request_id,intent,&state,level,mesos,gate);
            if result.success {
                // Lamp, charge and replay receipt cross this one commit; no profile/inventory replacement.
                write_state(&tx,id,&result.town_lamp)?;
                if tx.execute("UPDATE player_stats SET mesos=?2 WHERE account_id=?1 AND mesos=?3",params![id,result.mesos,mesos]).map_err(|_| "account persistence failed")? != 1 { return Err("account persistence failed".into()); }
            }
            let json = serde_json::to_string(&result).map_err(|_| "account persistence failed")?;
            // Keep durable receipts: without a client sequence, pruning would make an old retry charge again.
            tx.execute("INSERT INTO town_lamp_actions(account_id,request_id,intent_json,result_json) VALUES(?1,?2,?3,?4)",params![id,request_id,intent_json,json]).map_err(|_| "account persistence failed")?;
            tx.commit().map_err(|_| "account persistence failed")?;
            Ok(result)
        })
    }
}

impl World {
    pub(super) fn spawn_town_lamp_guard(&mut self) -> Result<(), String> {
        let r = rules();
        if r.schema_version != 1 || r.source_class != "P" || r.tiers.len() != 3 || r.map_id != "100000000"
            || r.tiers.iter().enumerate().any(|(i,t)| t.tier as usize != i+1 || !t.range_metres.is_finite() || !(1.0..=10.0).contains(&t.range_metres) || !t.intensity_candela.is_finite() || !(1.0..=100.0).contains(&t.intensity_candela) || t.decay != 2 || t.required_level == 0 || t.buy_price == 0 || t.buy_price > 100_000 || t.upgrade_price > 100_000)
            || !r.guard.spawn_offset_pixels.is_finite() || !r.guard.interaction_range_metres.is_finite() || !(0.5..=5.0).contains(&r.guard.interaction_range_metres) || !(0.5..=5.0).contains(&r.guard.vertical_range_metres) {
            return Err("invalid original town lamp rules".into());
        }
        let Some(map) = self.maps.get(&r.map_id).filter(|map| henesys::active(map)).cloned() else { return Ok(()); };
        let x = map.spawn.x + r.guard.spawn_offset_pixels;
        let (foothold,y) = map.ground_near(x,map.spawn.y).ok_or("town lamp guard has no road foothold")?;
        self.spawn_npc_on_map(map.id.clone(), NpcSpawn { id:r.guard.npc_id.clone(), template_id:r.guard.template_id.clone(), x,y,facing:-1,map_id:map.id,foothold_id:Some(foothold) })?;
        let guard = self.npcs.get_mut(&r.guard.npc_id).ok_or("town lamp guard spawn failed")?;
        guard.state.name = "Village Guard".into();
        guard.state.name_zh = Some(r.guard.name.clone());
        guard.state.shop_id = None;
        Ok(())
    }
    pub(super) fn load_or_issue_town_lamp(&self, id: &str, map: &Map) -> Result<(TownLampState,bool),String> {
        match self.store.as_ref() {
            Some(store) if henesys::active(map) => store.issue_town_lamp(id),
            Some(store) => Ok((store.load_town_lamp(id)?,false)),
            None if henesys::active(map) => Ok((TownLampState {tier:1,issued:true,revision:1},true)),
            None => Ok((TownLampState::default(),false)),
        }
    }
    /// Entry events only. Never called from the simulation tick or snapshot path.
    pub(super) fn ensure_town_lamp_on_entry(&mut self, id: &str) -> Result<(),String> {
        let Some(player) = self.players.get(id) else { return Ok(()); };
        if player.town_lamp.issued || player.map_id != rules().map_id || !henesys::active(self.map_for(&player.map_id)) { return Ok(()); }
        let (state,issued) = self.load_or_issue_town_lamp(id,self.map_for(&player.map_id))?;
        if let Some(player) = self.players.get_mut(id) { player.town_lamp = state; }
        if issued { self.send_town_lamp_welcome(id); }
        Ok(())
    }
    pub(super) fn send_town_lamp_welcome(&self,id: &str) {
        if let Some(player) = self.players.get(id) {
            let _ = player.output.try_send(serde_json::json!({"type":"townLampResult","requestId":"town-lamp-welcome","action":"issued","success":true,"code":"","townLamp":player.town_lamp,"mesos":player.state.mesos,"mesosSpent":0}).to_string());
        }
    }
    fn town_lamp_gate(&self,id: &str,intent: &LampIntent) -> Option<&'static str> {
        let player = self.players.get(id)?;
        if player.colossus.is_some() || player.map_id != rules().map_id || !henesys::active(self.map_for(&player.map_id)) { return Some("lamp_town_only"); }
        if player.state.hp <= 0 || player.state.action == "dead" { return Some("dead"); }
        if intent.action == TownLampAction::Discard { return None; }
        if intent.npc_id.as_deref() != Some(rules().guard.npc_id.as_str()) { return Some("lamp_guard_required"); }
        let Some(guard) = self.npcs.get(&rules().guard.npc_id).filter(|npc| npc.map_id == player.map_id) else { return Some("lamp_guard_required"); };
        let ppm = henesys::pixels_per_metre();
        if (player.state.x-guard.state.x).abs() > rules().guard.interaction_range_metres*ppm || (player.state.y-guard.state.y).abs() > rules().guard.vertical_range_metres*ppm { return Some("npc_too_far"); }
        None
    }
    pub(super) fn handle_town_lamp(&mut self,id:String,request_id:String,intent:LampIntent) {
        let Some(player) = self.players.get(&id) else { return; };
        let gate = self.town_lamp_gate(&id,&intent);
        let outcome = if let Some(store) = self.store.as_ref() { store.transact_town_lamp(&id,&request_id,&intent,gate) }
        else if let Some((prior_intent,result)) = self.town_lamp_requests.get(&(id.clone(),request_id.clone())) {
            if *prior_intent != intent { Err("idempotency_conflict".into()) } else { Ok(result.clone()) }
        } else {
            let result = receipt(&request_id,&intent,&player.town_lamp,player.state.level,player.state.mesos,gate);
            self.town_lamp_requests.insert((id.clone(),request_id.clone()),(intent,result.clone()));
            Ok(result)
        };
        match outcome {
            Ok(result) => {
                // A replay is an old receipt, not a request to restore its old lamp or money.
                if let Some(player) = self.players.get_mut(&id) {
                    if result.success && result.town_lamp.revision > player.town_lamp.revision {
                        player.town_lamp = result.town_lamp.clone(); player.state.mesos = result.mesos;
                    }
                    let _ = player.output.try_send(serde_json::to_string(&result).expect("lamp receipt"));
                }
                self.send_snapshot(&id);
            }
            Err(error) => self.send_reject(&id,if error == "idempotency_conflict" { "idempotency_conflict" } else { "persistence" },&error,Some(&request_id)),
        }
    }
    pub(super) fn talk_town_lamp_guard(&mut self,id:&str,request_id:&str,npc_id:&str,step:Option<&str>) -> bool {
        if npc_id != rules().guard.npc_id { return false; }
        self.end_conversation(id);
        let Some(guard) = self.npcs.get(npc_id) else { return true; };
        self.send_npc_dialogue(id,serde_json::json!({"type":"npcResult","requestId":request_id,"success":true,"code":"","npcId":npc_id,"name":guard.state.name,"nameZh":guard.state.name_zh,"ended":true,"openTownLamp":step != Some("end")}));
        true
    }
    pub(super) fn town_npc_lamp(&self,map_id:&str,npc_id:&str) -> Option<serde_json::Value> {
        (map_id == rules().map_id && henesys::active(self.map_for(map_id))).then(|| serde_json::json!({"tier":1,"kind":if npc_id == rules().guard.npc_id { "torch" } else { "lantern" }}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestStore(std::path::PathBuf);
    impl TestStore {
        fn new() -> Self { Self(std::env::temp_dir().join(format!("maple-town-lamp-{}.sqlite3",auth::random_id()))) }
        fn open(&self) -> Store { auth::start(&self.0).unwrap().store }
    }
    impl Drop for TestStore { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }
    fn lamp_world(store: Store) -> World {
        let mut map: Map = serde_json::from_str(r#"{"id":"100000000","bounds":{"xMin":90000,"xMax":300000,"yMin":-5000,"yMax":1000},"spawn":{"x":101710.80331535098,"y":-208.37694296732525},"footholds":[{"id":920001,"x1":100000,"y1":-208.37694296732525,"x2":105000,"y2":-208.37694296732525,"prev":0,"next":0}],"ladders":[]}"#).unwrap();
        // The production guard uses a template that is already exported, not a fabricated asset id.
        let source: serde_json::Value = serde_json::from_str(include_str!("../../shared/gameplay.json")).unwrap();
        let guard = source["npcs"].as_array().unwrap().iter().find(|npc| npc["templateId"] == rules().guard.template_id).unwrap();
        let npc: NpcTemplate = serde_json::from_value(guard.clone()).unwrap(); assert!(!npc.stand.is_empty());
        map.portals.clear();
        let gameplay = Gameplay { npcs: vec![npc], ..Gameplay::default() };
        let world = World::new_with_store(map,600,gameplay,store.clone()).unwrap();
        let mut profile = world.default_profile(); profile.level = 10; profile.mesos = 2000;
        // Do not reset an existing character when this helper reopens the same file.
        store.load_profile("lamp-a",&profile).unwrap();
        world
    }
    fn join(world: &mut World) -> mpsc::Receiver<String> {
        let (output,rx) = mpsc::channel(128); let (reply,_) = oneshot::channel();
        world.command(Command::Join { identity: Identity {id:"lamp-a".into(),username:"lamp-a".into()},connection:"lamp-connection".into(),output,reply,lang:"zh".into() });
        assert!(world.players.contains_key("lamp-a")); rx
    }
    fn act(world: &mut World,rx: &mut mpsc::Receiver<String>,request: &str,action:TownLampAction,tier:u8,cost:u64,npc:Option<&str>) -> serde_json::Value {
        while rx.try_recv().is_ok() {}
        world.command(Command::Input { id:"lamp-a".into(),connection:"lamp-connection".into(),message:ClientMessage::TownLamp {request_id:request.into(),action,tier,expected_cost:cost,npc_id:npc.map(str::to_owned)} });
        let mut result = None;
        while let Ok(raw) = rx.try_recv() { let value:serde_json::Value=serde_json::from_str(&raw).unwrap(); if value["type"] == "townLampResult" || value["type"] == "rejected" { result=Some(value); } }
        result.expect("a lamp request must return a receipt or refusal")
    }
    fn near_guard(world:&mut World) { let guard=world.npcs[&rules().guard.npc_id].state.clone(); let p=world.players.get_mut("lamp-a").unwrap();p.state.x=guard.x;p.state.y=guard.y; }

    #[test]
    fn town_lamp_authority_replay_discard_and_reopen() {
        let temp=TestStore::new(); let store=temp.open(); let mut world=lamp_world(store.clone()); let mut rx=join(&mut world); near_guard(&mut world);
        assert_eq!(world.players["lamp-a"].town_lamp,TownLampState{tier:1,issued:true,revision:1});
        let inventory_before=store.load_profile("lamp-a",&world.default_profile()).unwrap().inventory;
        let guard=rules().guard.npc_id.clone();
        let bad=act(&mut world,&mut rx,"fake-price",TownLampAction::Upgrade,2,0,Some(&guard)); assert_eq!(bad["code"],"invalid_lamp_cost");
        let missing=act(&mut world,&mut rx,"missing-guard",TownLampAction::Buy,2,600,None); assert_eq!(missing["code"],"lamp_guard_required");
        let wrong=act(&mut world,&mut rx,"wrong-guard",TownLampAction::Buy,2,600,Some("100000000-life-1"));assert_eq!(wrong["code"],"lamp_guard_required");
        let skip=act(&mut world,&mut rx,"skip-tier",TownLampAction::Upgrade,3,1000,Some(&guard));assert_eq!(skip["code"],"invalid_lamp_upgrade");
        world.players.get_mut("lamp-a").unwrap().state.x+=200.;
        let far=act(&mut world,&mut rx,"far-guard",TownLampAction::Buy,2,600,Some(&guard));assert_eq!(far["code"],"npc_too_far");
        near_guard(&mut world);let far_replay=act(&mut world,&mut rx,"far-guard",TownLampAction::Buy,2,600,Some(&guard));assert_eq!(far,far_replay,"a previously refused request stays refused");
        world.players.get_mut("lamp-a").unwrap().map_id="outside-town".into();
        assert_eq!(act(&mut world,&mut rx,"outside",TownLampAction::Discard,0,0,None)["code"],"lamp_town_only");
        world.players.get_mut("lamp-a").unwrap().map_id=rules().map_id.clone();
        store.with_db(|db|{db.execute("UPDATE player_stats SET level=1 WHERE account_id='lamp-a'",[]).map_err(|e|e.to_string())?;Ok(())}).unwrap();
        assert_eq!(act(&mut world,&mut rx,"low-level",TownLampAction::Buy,3,1600,Some(&guard))["code"],"lamp_level_required");
        store.with_db(|db|{db.execute("UPDATE player_stats SET level=10 WHERE account_id='lamp-a'",[]).map_err(|e|e.to_string())?;Ok(())}).unwrap();
        let upgrade=act(&mut world,&mut rx,"upgrade",TownLampAction::Upgrade,2,500,Some(&guard));assert_eq!(upgrade["success"],true);assert_eq!(upgrade["mesosSpent"],500);
        assert_eq!(act(&mut world,&mut rx,"upgrade",TownLampAction::Upgrade,2,500,Some(&guard)),upgrade);
        assert_eq!(world.players["lamp-a"].state.mesos,1500);
        assert_eq!(act(&mut world,&mut rx,"upgrade",TownLampAction::Upgrade,3,1000,Some(&guard))["code"],"idempotency_conflict");
        assert_eq!(act(&mut world,&mut rx,"discard",TownLampAction::Discard,0,0,None)["success"],true);
        for _ in 0..8 { world.step(); } world.ensure_town_lamp_on_entry("lamp-a").unwrap();
        assert_eq!(world.players["lamp-a"].town_lamp.tier,0);assert!(world.players["lamp-a"].town_lamp.issued);
        assert_eq!(act(&mut world,&mut rx,"upgrade",TownLampAction::Upgrade,2,500,Some(&guard)),upgrade);
        assert_eq!(world.players["lamp-a"].town_lamp.tier,0,"old success must not restore a discarded lamp");
        world.command(Command::Detach{id:"lamp-a".into(),connection:"lamp-connection".into(),reason:AwayReason::TransportLost});let _reconnect_rx=join(&mut world);assert_eq!(world.players["lamp-a"].town_lamp.tier,0);
        world.command(Command::Exit{id:"lamp-a".into(),connection:Some("lamp-connection".into())});assert!(!world.players.contains_key("lamp-a"));rx=join(&mut world);assert_eq!(world.players["lamp-a"].town_lamp.tier,0);
        assert_eq!(act(&mut world,&mut rx,"replace",TownLampAction::Buy,1,100,Some(&guard))["success"],true);assert_eq!(world.players["lamp-a"].state.mesos,1400);
        assert_eq!(act(&mut world,&mut rx,"discard-again",TownLampAction::Discard,0,0,None)["success"],true);
        assert_eq!(store.load_profile("lamp-a",&world.default_profile()).unwrap().inventory,inventory_before,"lamp business must not rewrite the original inventory");
        let snapshot:serde_json::Value=serde_json::from_str(&world.snapshot("lamp-a")).unwrap();assert_eq!(snapshot["players"][0]["townLamp"]["tier"],0);assert_eq!(snapshot["npcs"][0]["townLamp"]["kind"],"torch");
        drop(rx);drop(world);drop(store);
        let mut reopened=lamp_world(temp.open());let _rx=join(&mut reopened);assert_eq!(reopened.players["lamp-a"].town_lamp.tier,0);assert_eq!(reopened.players["lamp-a"].state.mesos,1400);
        for bad in [r#"{"type":"townLamp","requestId":"bad","action":"buy","tier":2,"expectedCost":-1}"#,r#"{"type":"townLamp","requestId":"bad","action":"buy","tier":2,"expectedCost":600,"price":0}"#,r#"{"type":"townLamp","requestId":"bad","action":"free","tier":2,"expectedCost":600}"#] {assert!(serde_json::from_str::<ClientMessage>(bad).is_err());}
        for bad in [r#"{"type":"townLamp","requestId":"","action":"buy","tier":2,"expectedCost":600}"#,r#"{"type":"townLamp","requestId":"bad","action":"buy","tier":4,"expectedCost":600}"#,r#"{"type":"townLamp","requestId":"bad","action":"discard","tier":0,"expectedCost":1}"#] {assert!(!serde_json::from_str::<ClientMessage>(bad).unwrap().valid());}
    }

    #[test]
    fn town_lamp_transaction_failure_keeps_money_lamp_and_receipt_atomic() {
        let temp=TestStore::new();let store=temp.open();let mut world=lamp_world(store.clone());let mut rx=join(&mut world);near_guard(&mut world);let guard=rules().guard.npc_id.clone();
        store.with_db(|db|db.execute_batch("CREATE TRIGGER lamp_fail_receipt BEFORE INSERT ON town_lamp_actions BEGIN SELECT RAISE(ABORT,'lamp failure'); END;").map_err(|e|e.to_string())).unwrap();
        assert_eq!(act(&mut world,&mut rx,"atomic",TownLampAction::Upgrade,2,500,Some(&guard))["code"],"persistence");
        assert_eq!(store.load_town_lamp("lamp-a").unwrap().tier,1);assert_eq!(world.players["lamp-a"].town_lamp.tier,1);assert_eq!(world.players["lamp-a"].state.mesos,2000);
        store.with_db(|db|{let n:i64=db.query_row("SELECT count(*) FROM town_lamp_actions WHERE request_id='atomic'",[],|r|r.get(0)).map_err(|e|e.to_string())?;assert_eq!(n,0);let mesos:u64=db.query_row("SELECT mesos FROM player_stats WHERE account_id='lamp-a'",[],|r|r.get(0)).map_err(|e|e.to_string())?;assert_eq!(mesos,2000);db.execute_batch("DROP TRIGGER lamp_fail_receipt").map_err(|e|e.to_string())}).unwrap();
        assert_eq!(act(&mut world,&mut rx,"atomic",TownLampAction::Upgrade,2,500,Some(&guard))["success"],true);assert_eq!(store.load_town_lamp("lamp-a").unwrap().tier,2);
    }
}
