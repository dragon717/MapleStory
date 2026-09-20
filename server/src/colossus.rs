//! The third activity uses the same authenticated player and World queue.
//! Only its spatial representation differs; inventory/identity are not copied.
use super::*;
use crate::protocol;
use serde::Serialize;
#[path = "colossus_motion.rs"]
pub mod motion;
#[path = "colossus_rig.rs"]
pub mod rig;
use motion::{length, sub, Body, Config, Frame};
pub const MAP_ID: &str = "colossus-harbor";

impl World {
    // Existing NPC protocol/window; these read-only responses have no quest or reward effects.
    pub(super) fn talk_colossus(&self, id: &str, request: &str, npc_id: &str, step: Option<&str>) {
        let person = npc_id
            .strip_prefix("colossus-person-")
            .and_then(|s| s.parse::<usize>().ok());
        let target = self
            .colossus
            .as_ref()
            .and_then(|r| person.and_then(|i| r.people.get(i)));
        let player = self.players.get(id).and_then(|p| p.colossus.as_ref());
        let valid = player.zip(target).is_some_and(|(p, n)| {
            p.body.track == n.track && length(sub(p.body.position, n.position)) <= 6.0
        });
        if target.is_none()
            || (step != Some("end") && !valid)
            || !matches!(step, None | Some("start" | "end"))
        {
            self.send_reject(
                id,
                "colossus_action",
                "请靠近港口人物后交谈。",
                Some(request),
            );
            return;
        }
        let r = self.colossus.as_ref().unwrap();
        let (name, line) = match person.unwrap() {
            5 => (
                "港口孩子",
                if r.seconds >= 65.0 {
                    "那不是礁石。那是一只手！"
                } else {
                    "小石头人跑上去了！我们也去高台看看吧。"
                },
            ),
            6 => (
                "补网人",
                if r.seconds >= 65.0 {
                    "我知道。先把网梭捡起来，别掉进海里。"
                } else {
                    "蓝旗那边是高台。下面的坡道也能上去，慢慢走。"
                },
            ),
            _ => (
                "船工",
                if r.bridge_age.is_none() {
                    "我把绞盘稳住，你打断那根藤。桥放下来，大家就能过去了。"
                } else if !r.bridge() {
                    "藤断了。等桥落稳再走。"
                } else {
                    "桥稳了，沿蓝旗上高台。"
                },
            ),
        };
        let ended = step == Some("end");
        self.send_npc_dialogue(id, serde_json::json!({"type":"npcResult","requestId":request,"success":true,"code":"ok","npcId":npc_id,"name":name,"nameZh":name,"ended":ended,"dialog":if ended { serde_json::Value::Null } else { serde_json::json!({"kind":"ok","text":line}) }}));
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub started_ms: Option<i64>,
    #[serde(default)]
    pub awakening_started_ms: Option<i64>,
    pub bridge_opened_ms: Option<i64>,
    pub opened_by: Option<String>,
    #[serde(default)]
    pub awakened: bool,
    #[serde(default)]
    pub discoveries: std::collections::BTreeMap<String,u8>,
}
#[derive(Clone)]
pub struct Rider {
    pub body: Body,
    pub return_map: String,
    pub return_x: f64,
    pub return_y: f64,
    pub return_fh: u64,
    pub attack_until: u64,
    pub passage_after: u64,
    pub arrival_until: u64,
}
pub struct Runtime {
    pub config: Config,
    pub facts: Facts,
    pub seconds: f64,
    // Remaining bridge animation uses World ticks, never a reversible wall clock.
    pub bridge_age: Option<f64>,
    pub previous: Frame,
    pub frame: Frame,
    pub people: Vec<Body>,
    pub stones: Vec<Body>,
}
impl Runtime {
    fn new(facts: Facts) -> Self {
        let c = Config::shipped();
        let seconds = if facts.awakened { 65.0 } else if let Some(t)=facts.awakening_started_ms {
            30.0+(unix_now_ms()-t).max(0) as f64/1000.0
        } else { facts.started_ms.map_or(0.0,|t|((unix_now_ms()-t).max(0) as f64/1000.0).min(29.9)) };
        let f = Frame::at(seconds, 0);
        let people = (0..7)
            .map(|i| {
                Body::new(
                    &c,
                    "harbor",
                    if i == 6 {
                        100.0
                    } else if facts.awakened || seconds > 120.0 {
                        if facts.bridge_opened_ms.is_some() {
                            90.0 + i as f64 * 2.0
                        } else {
                            44.0 - i as f64 * 1.7
                        }
                    } else {
                        5.0 + i as f64 * 1.7
                    },
                    &f,
                )
            })
            .collect();
        let stones = (0..2)
            .map(|i| {
                let mut b = Body::new(
                    &c,
                    "harbor",
                    if facts.awakened || seconds > 90.0 {
                        104.0 - i as f64 * 4.0
                    } else {
                        3.0
                    },
                    &f,
                );
                b.pace = if i == 0 { 7.0 } else { 1.65 };
                b
            })
            .collect();
        Self {
            config: c,
            // A persisted cut resumes with the bridge settled; it cannot close again.
            bridge_age: facts.bridge_opened_ms.map(|_| 1.5),
            facts,
            seconds,
            previous: f.clone(),
            frame: f,
            people,
            stones,
        }
    }
    pub(super) fn bridge(&self) -> bool {
        self.bridge_age.is_some_and(|age| age >= 1.5)
    }
}
impl World {
    pub fn with_colossus(mut self) -> Result<Self, String> {
        let facts = match self
            .store
            .as_ref()
            .map(|s| s.load_colossus())
            .transpose()?
            .flatten()
        {
            Some(s) => serde_json::from_str::<Facts>(&s).map_err(|_| "invalid colossus save")?,
            None => Facts::default(),
        };
        if facts.started_ms.is_some_and(|t| t < 0) || facts.bridge_opened_ms.is_some_and(|t| t < 0)
        {
            return Err("invalid colossus timestamps".into());
        }
        self.colossus = Some(Runtime::new(facts));
        Ok(self)
    }
    fn commit_colossus(&mut self, facts: Facts) -> Result<(), String> {
        if let Some(store) = &self.store {
            store.save_colossus(
                &serde_json::to_string(&facts).map_err(|_| "colossus encoding failed")?,
            )?;
        }
        let runtime = self.colossus.as_mut().ok_or("colossus unavailable")?;
        if runtime.facts.bridge_opened_ms.is_none() && facts.bridge_opened_ms.is_some() {
            runtime.bridge_age = Some(0.0);
        }
        runtime.facts = facts;
        Ok(())
    }
    pub(super) fn handle_colossus(
        &mut self,
        id: String,
        request: String,
        sequence: u64,
        action: protocol::ColossusAction,
    ) {
        use protocol::ColossusAction::*;
        let Some(p) = self.players.get(&id) else {
            return;
        };
        if sequence <= p.colossus_sequence
            || sequence > p.colossus_sequence.saturating_add(1024)
            || sequence > 9_007_199_254_740_991
        {
            self.send_reject(
                &id,
                "colossus_sequence",
                "行动已过期，请按最新状态再试。",
                Some(&request),
            );
            self.send_snapshot(&id);
            return;
        }
        if self.colossus.is_none() {
            self.send_reject(
                &id,
                "colossus_unavailable",
                "港口还没有开放。",
                Some(&request),
            );
            return;
        }
        let result: Result<(), String> = (|| {
            if action == Enter {
                if self.players[&id].colossus.is_some() {
                    return Ok(());
                }
                let p = &self.players[&id];
                if p.state.hp <= 0
                    || p.state.action == "dead"
                    || p.map_id.starts_with("windbell")
                    || p.map_id.starts_with("practice:")
                {
                    return Err("请先回到原来的地图，并在复活后登岸。".into());
                }
                let mut facts = self.colossus.as_ref().unwrap().facts.clone();
                if facts.started_ms.is_none() {
                    facts.started_ms = Some(unix_now_ms());
                    self.commit_colossus(facts)?;
                }
                self.persist_player(&id)?;
                let r = self.colossus.as_ref().unwrap();
                let p = self.players.get_mut(&id).unwrap();
                p.colossus = Some(Rider {
                    body: Body::new(&r.config, if r.facts.awakened {"harbor"} else {"arrival"}, if r.facts.awakened {2.0} else {0.0}, &r.frame),
                    return_map: p.map_id.clone(),
                    return_x: p.state.x,
                    return_y: p.state.y,
                    return_fh: p.foothold_id,
                    attack_until: 0,
                    passage_after: 0,
                    arrival_until: if r.facts.awakened {0} else {self.tick+160},
                });
                p.map_id = MAP_ID.into();
                p.direction = 0;
                p.vertical = 0;
                p.jump = false;
                p.attack_until = 0;
                p.channel_until = 0;
                p.channel_request_id = None;
                p.mount = None;
                p.chair = None;
                self.end_conversation(&id);
                self.pending_attacks.retain(|_, a| a.player_id != id);
            } else if action == Leave {
                let p = self.players.get_mut(&id).unwrap();
                if let Some(r) = p.colossus.take() {
                    p.map_id = r.return_map;
                    p.state.x = r.return_x;
                    p.state.y = r.return_y;
                    p.foothold_id = r.return_fh;
                    p.state.vx = 0.0;
                    p.state.vy = 0.0;
                    p.state.grounded = r.return_fh != 0;
                    p.state.action = "stand";
                    p.direction = 0;
                    p.jump = false;
                }
            } else {
                let runtime = self.colossus.as_ref().unwrap();
                let p = self.players.get_mut(&id).unwrap();
                let rider = p.colossus.as_mut().ok_or("请先登岸。")?;
                match action {
                    Board => {
                        if runtime.config.tracks[&rider.body.track].anchor.as_deref() != Some("harbor") {
                            return Ok(());
                        }
                        let hand = runtime.frame.world_on(
                            &runtime.config.tracks["climb"],
                            runtime.config.tracks["climb"].points[0],
                        );
                        if rider.body.track != "harbor"
                            || runtime.seconds < 65.0
                            || length(sub(rider.body.position, hand)) > 12.0
                        {
                            return Err("沿蓝旗到高台尽头，靠近石壁后攀爬。".into());
                        }
                        rider.body = Body::new(&runtime.config, "climb", 0.0, &runtime.frame);
                    }
                    Skip => {
                        if matches!(rider.body.track.as_str(), "arrival" | "harbor" | "lower") {
                            rider.arrival_until=0;
                            rider.body = Body::new(
                                &runtime.config,
                                "harbor",
                                runtime.config.tracks["harbor"].len() - 3.0,
                                &runtime.frame,
                            );
                        }
                    }
                    Travel => {
                        if self.tick < rider.passage_after {
                            return Ok(());
                        }
                        let passage = runtime
                            .config
                            .passage(&rider.body)
                            .ok_or("走近路口，再沿路牌前行。")?;
                        if runtime.config.tracks[&passage.to_track].anchor.as_deref() != Some("harbor")
                            && runtime.seconds < 65.0
                        {
                            return Err("石壁还在震动，等落脚处稳定后再攀爬。".into());
                        }
                        // Up on a climbing wall keeps climbing; Down at its foot returns to the pier.
                        if rider.body.track == "climb" && passage.to_track == "harbor" {
                            return Ok(());
                        }
                        let speed = rider.body.speed;
                        let facing = rider.body.facing;
                        rider.body = Body::new(
                            &runtime.config,
                            &passage.to_track,
                            passage.to_s,
                            &runtime.frame,
                        );
                        rider.body.speed = speed;
                        rider.body.facing = facing;
                        rider.passage_after = self.tick + 20;
                        p.vertical = 0;
                    }
                    _ => {}
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.players.get_mut(&id).unwrap().colossus_sequence = sequence;
                self.send_snapshot(&id);
            }
            Err(e) => self.send_reject(&id, "colossus_action", &e, Some(&request)),
        }
    }
    pub(super) fn attack_colossus(&mut self, id: &str, request: &str) -> bool {
        let Some(r) = self.players.get(id).and_then(|p| p.colossus.as_ref()) else {
            return false;
        };
        if self.tick < r.attack_until || r.arrival_until > self.tick {
            return true;
        }
        let runtime = self.colossus.as_ref().unwrap();
        let hit = runtime.config.tracks[&r.body.track].region == "harbor"
            && length(sub(r.body.position, runtime.frame.world_on(&runtime.config.tracks["harbor"],runtime.config.vine))) < 4.0
            && runtime.facts.bridge_opened_ms.is_none();
        if hit {
            let mut facts = runtime.facts.clone();
            facts.bridge_opened_ms = Some(unix_now_ms());
            facts.opened_by = Some(id.into());
            if let Err(e) = self.commit_colossus(facts) {
                self.send_reject(id, "persistence", &e, Some(request));
                return true;
            }
        }
        let p = self.players.get_mut(id).unwrap();
        p.colossus.as_mut().unwrap().attack_until = self.tick + 9;
        p.state.action_started_tick = self.tick;
        self.send_snapshot(id);
        true
    }
    pub(super) fn step_colossus(&mut self) {
        let Some(r) = self.colossus.as_ref() else {
            return;
        };
        let Some(start) = r.facts.started_ms else {
            return;
        };
        if r.facts.awakening_started_ms.is_none() && !r.facts.awakened
            && self.players.values().filter_map(|p|p.colossus.as_ref()).any(|r|r.body.track=="harbor"&&r.body.s>88.0) {
            let mut facts=r.facts.clone();facts.awakening_started_ms=Some(unix_now_ms());
            if self.commit_colossus(facts).is_err(){return;}
        }
        let r=self.colossus.as_ref().unwrap();
        let seconds=if r.facts.awakened {r.seconds.max(65.0)+0.05}
            else if let Some(t)=r.facts.awakening_started_ms {30.0+(unix_now_ms()-t).max(0) as f64/1000.0}
            else {((unix_now_ms()-start).max(0) as f64/1000.0).min(29.9)};
        if !r.facts.awakened && seconds>=65.0 {
            let mut facts=r.facts.clone();facts.awakened=true;
            if self.commit_colossus(facts).is_err(){return;}
        }
        let r=self.colossus.as_ref().unwrap();
        let mut facts=r.facts.clone();
        for (id,p) in &self.players {
            let Some(rider)=&p.colossus else {continue;};
            let phase=if matches!(rider.body.track.as_str(),"climb"|"shoulder"|"shoulder-lane"|"gardens"|"gardens-aqueduct") {4}
                else if seconds>=65.0 && rider.body.track=="harbor" && rider.body.s>88.0 {3}
                else if rider.body.track!="arrival" && rider.body.s>15.0 {2} else {1};
            let known=facts.discoveries.entry(id.clone()).or_default();*known=(*known).max(phase);
        }
        if facts.discoveries!=r.facts.discoveries && self.commit_colossus(facts).is_err(){return;}
        let r = self.colossus.as_mut().unwrap();
        r.seconds=r.seconds.max(seconds);
        // Reconstruct a tick-sized interval even after a wall-clock jump.
        r.previous = Frame::at((r.seconds - 0.05).max(0.0), self.tick.saturating_sub(1));
        r.frame = Frame::at(r.seconds, self.tick);
        if let Some(age) = &mut r.bridge_age {
            *age = (*age + 0.05).min(1.5);
        }
        let bridge = r.bridge();
        for (i, p) in r.stones.iter_mut().enumerate() {
            let go = r.seconds > 9.0 + i as f64 * 3.0 && p.s < 108.0;
            let jump = p.grounded && p.track == "harbor" && p.s > 18.0 && p.s < 20.0;
            p.step(
                &r.config,
                &r.previous,
                &r.frame,
                bridge,
                if go { 1 } else { 0 },
                go && jump,
                0.05,
            );
        }
        for (i, p) in r.people.iter_mut().enumerate() {
            let go = i < 6
                && r.seconds > 16.0 + i as f64 * 0.6
                && p.s < 92.0 + i as f64 * 1.4
                && (bridge || p.s < 44.0 - i as f64 * 1.7 || p.track == "lower");
            let jump = p.track == "harbor" && p.s > 18.0 && p.s < 20.0;
            p.step(
                &r.config,
                &r.previous,
                &r.frame,
                bridge,
                if go { 1 } else { 0 },
                go && jump,
                0.05,
            );
        }
    }
    pub(super) fn step_colossus_player(&mut self, id: &str) -> bool {
        let Some(p) = self.players.get_mut(id) else {
            return false;
        };
        let Some(rider) = p.colossus.as_mut() else {
            return false;
        };
        let r = self.colossus.as_ref().unwrap();
        if p.last_input.elapsed() > Duration::from_millis(500) {
            p.direction = 0;
            p.vertical = 0;
            p.jump = false;
        }
        if rider.arrival_until > self.tick {
            let fraction=1.0-(rider.arrival_until-self.tick) as f64/160.0;
            rider.body=Body::new(&r.config,"arrival",r.config.tracks["arrival"].len()*fraction,&r.frame);
            p.jump=false;
        } else {
        if rider.body.track=="arrival" {rider.body=Body::new(&r.config,"harbor",2.0,&r.frame);}
        let locked=p.state.hp<=0 || p.state.action=="dead" || p.status.locks_controls() || p.channel_until>self.tick;
        if locked {p.direction=0;p.vertical=0;p.jump=false;rider.body.speed=0.0;}
        rider.body.pace=5.5*p.move_speed/WALK_SPEED;
        if p.slow_fall_until>self.tick && rider.body.vertical_speed<0.0 {rider.body.vertical_speed=rider.body.vertical_speed.max(-MAGIC_WAVE_SLOW_FALL_SPEED/60.0+18.0*0.05);}
        rider.body.step(
            &r.config,
            &r.previous,
            &r.frame,
            r.bridge(),
            if r.config.tracks[&rider.body.track].climb {
                -p.vertical
            } else {
                p.direction
            },
            p.jump,
            0.05,
        );
        }
        if rider.body.grounded {p.magic_wave_used=false;p.magic_wave_float_used=false;}
        p.jump = false;
        let b = &rider.body;
        p.state.x = b.s * 60.0;
        p.state.y = -b.position[1] * 60.0;
        p.state.grounded = b.grounded;
        p.state.vx = b.speed*60.0;
        p.state.vy = -b.vertical_speed*60.0;
        p.state.facing = b.facing;
        p.state.climbing = r.config.tracks[&b.track].climb && b.grounded;
        p.state.swimming = false;
        p.state.action = if p.state.hp<=0 || p.state.action=="dead" { "dead" } else if rider.attack_until > self.tick {
            "swingO1"
        } else if !b.grounded {
            "jump"
        } else if b.speed.abs() > 0.1 {
            "walk"
        } else {
            "stand"
        };
        true
    }
    pub(super) fn colossus_relevant(&self, id: &str, target: &Player) -> bool {
        let Some(observer) = self.players.get(id).and_then(|p| p.colossus.as_ref()) else {
            return true;
        };
        // The current two outdoor zones: local view plus >8 seconds of fastest approach.
        // Giant/bridge/NPC facts remain global; culling never pauses simulation.
        target.colossus.as_ref().is_some_and(|r| {
            let c = &self.colossus.as_ref().unwrap().config;
            c.tracks[&observer.body.track].region == c.tracks[&r.body.track].region
                && length(sub(observer.body.position, r.body.position)) <= 128.0
        })
    }
    pub(super) fn colossus_snapshot(&self, id: &str) -> Option<serde_json::Value> {
        let self_player = self.players.get(id)?;
        self_player.colossus.as_ref()?;
        let r = self.colossus.as_ref()?;
        let actors=self.players.iter().filter(|(_,p)|self.colossus_relevant(id,p)).filter_map(|(id,p)|p.colossus.as_ref().map(|b|serde_json::json!({"id":id,"name":p.state.username,"body":b.body,"attacking":b.attack_until>self.tick}))).collect::<Vec<_>>();
        let body = &self_player.colossus.as_ref()?.body;
        let region = &r.config.tracks[&body.track].region;
        Some(
            serde_json::json!({"mapStage":r.facts.discoveries.get(id).copied().unwrap_or(1),"region":region,"passage":r.config.passage(body),"seconds":r.seconds,"frame":r.frame,"bridgeOpen":r.bridge(),"bridgeAge":r.bridge_age,"helped":r.facts.opened_by.as_deref()==Some(id),"actors":actors,"people":r.people,"stones":r.stones,"seaLevel":r.config.sea_level,"sequence":self_player.colossus_sequence}),
        )
    }
}
