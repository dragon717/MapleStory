//! Authentication owns lease validity; only World terminates control and clears intent.
use super::*;

pub(super) struct Control {
    pub authorization: auth::Authorization,
    pub connection: String,
    pub terminate: oneshot::Sender<&'static str>,
}

impl World {
    pub(super) fn bind_control(&mut self, id: &str, control: Option<Control>) -> bool {
        if control
            .as_ref()
            .is_some_and(|c| !c.authorization.lease.valid())
        {
            return false;
        }
        if let Some(old) = self.controls.remove(id) {
            let _ = old.terminate.send("session_replaced");
        }
        self.gm_players.remove(id);
        if let Some(control) = control {
            if control.authorization.gm {
                self.gm_players.insert(id.to_owned());
            }
            self.controls.insert(id.to_owned(), control);
        }
        true
    }

    pub(super) fn revoke_control(&mut self, id: &str) {
        self.gm_players.remove(id);
        if let Some(control) = self.controls.remove(id) {
            control.authorization.lease.revoke();
            let _ = control.terminate.send("unauthenticated");
            self.clear_control_intent(id, &control.connection);
        }
    }

    // ponytail: scan live leases per command/tick; add revoked-id notifications only if profiling warrants it.
    pub(super) fn expire_controls(&mut self) {
        let expired: Vec<_> = self
            .controls
            .iter()
            .filter(|(_, c)| !c.authorization.lease.valid())
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            let Some(control) = self.controls.remove(&id) else {
                continue;
            };
            self.gm_players.remove(&id);
            let connection = control.connection;
            let _ = control.terminate.send("unauthenticated");
            self.command(Command::Detach {
                id: id.clone(),
                connection: connection.clone(),
                reason: AwayReason::TransportLost,
            });
            self.clear_control_intent(&id, &connection);
        }
    }
    fn clear_control_intent(&mut self, id: &str, connection: &str) {
        // Authorization must stop even when saving the activity return point fails.
        if let Some(player) = self
            .players
            .get_mut(id)
            .filter(|p| p.connection == connection)
        {
            player.connection.clear();
            player.detached = true;
            player.direction = 0;
            player.vertical = 0;
            player.jump = false;
            player.channel_request_id = None;
            player.channel_until = 0;
        }
        self.pending_attacks
            .retain(|_, attack| attack.player_id != id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn world() -> World {
        let map: Map = serde_json::from_value(serde_json::json!({
            "id":"session-map", "bounds":{"xMin":0,"xMax":500,"yMin":0,"yMax":500},
            "spawn":{"x":100,"y":100}, "footholds":[], "ladders":[], "portals":[]
        }))
        .unwrap();
        World::new(map, 600)
    }
    fn grant(gm: bool) -> auth::Authorization {
        auth::Authorization {
            identity: Identity {
                id: "role".into(),
                username: "name".into(),
            },
            gm,
            lease: Arc::new(auth::SessionLease::new(
                Instant::now() + Duration::from_secs(60),
            )),
        }
    }
    fn join(
        w: &mut World,
        grant: auth::Authorization,
        connection: &str,
    ) -> (bool, oneshot::Receiver<&'static str>) {
        let (output, _rx) = mpsc::channel(128);
        let (reply, mut result) = oneshot::channel();
        let (terminate, terminal) = oneshot::channel();
        w.command(Command::JoinAuthorized {
            authorization: grant,
            connection: connection.into(),
            output,
            reply,
            lang: "zh".into(),
            terminate,
        });
        (result.try_recv().unwrap(), terminal)
    }
    fn input(w: &mut World, connection: &str) {
        w.command(Command::Input {
            id: "role".into(),
            connection: connection.into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 1,
                vertical: 0,
                jump: false,
                view: None,
            },
        });
    }
    #[test]
    fn revoked_inflight_join_cannot_bind_or_receive_gm() {
        let mut w = world();
        let grant = grant(true);
        grant.lease.revoke();
        let (accepted, mut terminal) = join(&mut w, grant, "late");
        assert!(!accepted);
        assert_eq!(terminal.try_recv().unwrap(), "unauthenticated");
        assert!(w.players.is_empty());
        assert!(w.gm_players.is_empty());
    }
    #[test]
    fn revoke_stops_old_intent_and_preserves_resident_position() {
        let mut w = world();
        let grant = grant(true);
        let (_, mut terminal) = join(&mut w, grant.clone(), "old");
        input(&mut w, "old");
        assert_eq!(w.players["role"].direction, 1);
        let point = (w.players["role"].state.x, w.players["role"].state.y);
        grant.lease.revoke();
        input(&mut w, "old");
        assert_eq!(terminal.try_recv().unwrap(), "unauthenticated");
        assert_eq!(w.players["role"].direction, 0);
        assert!(w.players["role"].detached);
        assert_eq!(
            (w.players["role"].state.x, w.players["role"].state.y),
            point
        );
        assert!(!w.gm_players.contains("role"));
        assert!(w.controls.is_empty());
        assert!(!join(&mut w, grant, "replay").0);
    }
    #[test]
    fn deadline_ends_an_idle_controller_on_world_tick() {
        let mut w = world();
        let (_, mut terminal) = join(&mut w, grant(false), "old");
        w.controls.get_mut("role").unwrap().authorization.lease =
            Arc::new(auth::SessionLease::new(Instant::now()));
        w.step();
        assert_eq!(terminal.try_recv().unwrap(), "unauthenticated");
        assert!(w.players["role"].connection.is_empty());
        assert!(w.players["role"].detached);
    }
    #[test]
    fn takeover_notifies_old_controller_and_ignores_its_late_events() {
        let mut w = world();
        let grant = grant(false);
        let (_, mut old) = join(&mut w, grant.clone(), "old");
        let (_, mut new) = join(&mut w, grant.clone(), "new");
        assert_eq!(old.try_recv().unwrap(), "session_replaced");
        input(&mut w, "old");
        assert_eq!(w.players["role"].direction, 0);
        w.command(Command::Detach {
            id: "role".into(),
            connection: "old".into(),
            reason: AwayReason::TransportLost,
        });
        assert!(!w.players["role"].detached);
        assert!(grant.lease.valid());
        input(&mut w, "new");
        assert_eq!(w.players["role"].direction, 1);
        assert!(matches!(
            new.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
    }
    #[test]
    fn logout_stops_authorization_even_when_activity_cleanup_cannot_complete() {
        let mut w = world();
        let grant = grant(true);
        let (_, mut terminal) = join(&mut w, grant.clone(), "old");
        input(&mut w, "old");
        // A missing private runtime makes disconnect_windbell_player return false.
        w.players.get_mut("role").unwrap().map_id = "windbell:island:missing-runtime".into();
        w.command(Command::Input {
            id: "role".into(),
            connection: "old".into(),
            message: ClientMessage::Logout,
        });
        assert!(!grant.lease.valid());
        assert_eq!(terminal.try_recv().unwrap(), "unauthenticated");
        assert!(w.players["role"].detached);
        assert!(w.players["role"].connection.is_empty());
        assert_eq!(w.players["role"].direction, 0);
        assert!(w.gm_players.is_empty());
        input(&mut w, "old");
        assert_eq!(w.players["role"].direction, 0);
    }
    #[test]
    fn role_logout_revokes_permission_but_transport_detach_allows_reconnect() {
        let mut w = world();
        let grant = grant(true);
        let (_, mut terminal) = join(&mut w, grant.clone(), "old");
        w.command(Command::Detach {
            id: "role".into(),
            connection: "old".into(),
            reason: AwayReason::TransportLost,
        });
        assert!(grant.lease.valid());
        assert!(join(&mut w, grant.clone(), "new").0);
        assert_eq!(terminal.try_recv().unwrap(), "session_replaced");
        w.command(Command::Input {
            id: "role".into(),
            connection: "new".into(),
            message: ClientMessage::Logout,
        });
        assert!(!grant.lease.valid());
        assert!(w.players.is_empty());
        assert!(w.gm_players.is_empty());
        assert!(!join(&mut w, grant, "after-logout").0);
    }
}
