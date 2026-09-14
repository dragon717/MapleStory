use crate::{auth::Store, protocol::reject};
use std::collections::HashMap;

pub struct Combat {
    pub duration_ms: u64,
    pub hit_after_ms: u64,
    pub next_action: u64,
    // Successful action IDs are bound to the authenticated player and attack operation.
    attacks: HashMap<(String, String), String>,
}

pub enum Attack {
    Started {
        action_id: String,
        event: String,
    },
    Resume {
        action_id: String,
        #[allow(dead_code)]
        event: String,
    },
    Reply(String),
}

impl Combat {
    pub fn new(duration_ms: u64, hit_after_ms: u64) -> Self {
        Self {
            duration_ms,
            hit_after_ms,
            next_action: 0,
            attacks: HashMap::new(),
        }
    }

    pub fn attack(
        &mut self,
        store: Option<&Store>,
        player: &str,
        map_id: &str,
        request: &str,
        tick: u64,
        active_until: u64,
        x: f64,
        y: f64,
        facing: i8,
    ) -> Attack {
        let key = (player.to_owned(), request.to_owned());
        if let Some(prior) = self.attacks.get(&key) {
            return Attack::Reply(prior.clone());
        }
        if tick < active_until {
            return Attack::Reply(reject(
                "cooldown",
                "上一次攻击动作还没结束。",
                Some(request),
            ));
        }
        // ponytail: finite process-lifetime dedup; the SQLite action table carries it across restarts.
        if self.attacks.len() >= 100_000 {
            return Attack::Reply(reject(
                "capacity",
                "服务器暂时无法处理更多动作，请重新登录。",
                Some(request),
            ));
        }
        self.next_action += 1;
        let action_id = format!("action-{}-{}", self.next_action, crate::auth::random_id());
        let event = serde_json::json!({
            "type":"actionStarted",
            "eventId":format!("action-event-{}", action_id),
            "serverTick":tick,
            "playerId":player,
            "actionId":action_id,
            "requestId":request,
            "durationMs":self.duration_ms,
            "x":x,
            "y":y,
            "facing":facing
        })
        .to_string();
        let claim = match store
            .map(|store| store.claim_attack(player, map_id, request, &action_id, &event))
            .unwrap_or_else(|| {
                Ok(crate::auth::AttackClaim {
                    action_id: action_id.clone(),
                    event: event.clone(),
                    resolved: false,
                })
            }) {
            Ok(claim) => claim,
            Err(error) => {
                return Attack::Reply(reject("persistence", &error, Some(request)));
            }
        };
        if claim.action_id != action_id {
            return if claim.resolved {
                Attack::Reply(claim.event)
            } else {
                Attack::Resume {
                    action_id: claim.action_id,
                    event: claim.event,
                }
            };
        }
        self.attacks.insert(key, event.clone());
        Attack::Started { action_id, event }
    }
}
