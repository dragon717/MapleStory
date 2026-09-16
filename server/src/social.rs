//! 社交职责：组队（party）与好友 / 黑名单（friend）。
//!
//! 从 `world.rs` 机械搬出的第三块完整职责（超大文件治理 P2）。搬的是**代码位置**，
//! 不是数据布局：`Player` / `World` 的字段仍在原处，协议、存档与 Tick 次序均未改变。
//!
//! ## 负责
//! - 组队的**会话内生命周期**：邀请 → 应答 → 加入 / 拒绝 / 踢出 / 转移队长 → 解散。
//!   队伍是"此刻在世界里的这些人"的事实，重启即消散，所以**没有** SQLite 行需要同步。
//! - 组队对外的两个投影：`partyView`（客户端的关系视图）与成员查询
//!   （`party_members_on_map` / `party_exp_members`，按同图与 EXP 共享规则过滤，
//!   供伤害与经验分配方调用）。
//! - 好友 / 黑名单的**内存镜像与增删改**：`friendView`、按名字添加、接受 / 拒绝、删除。
//!   与组队相反，好友是**持久化**关系，落库在 `crate::auth`；本模块只把结果同步进镜像
//!   （`friend_links` 双向反查索引、`friend_roster` 在线名册）并推给关心它的人。
//! - **在线状态的服务端派生**：`online` / `mapId` 每次推送都从活世界现算，
//!   过期的离线快照不可能被当成当前位置展示。
//! - 把黑名单行**装载**进聊天下发侧读的那份 `Player.blocked`（`reload_blocked`）。
//!   真正"让被屏蔽者闭嘴"的扇出过滤在 `super::messaging`，不在这里。
//! - 两套 **requestId 幂等重放**：同一请求重放回放原结论，不产生第二次关系变更。
//!
//! ## 不负责
//! - 好友 / 黑名单的**落库与读取**：`crate::auth`（`Store` / `FriendRow` /
//!   `FriendOutcome` / `FriendOperation`）
//! - 连接与认证、快照生成、聊天正文与速率（后者见 `super::messaging`）
//! - 队伍容量上限等**源规则常量**：留在 `world.rs`，本模块只读

use super::*;

impl World {
    // ----------------------------------------------------------------- party
    //
    // A party is session state owned entirely by the world, in the same sense
    // a reactor's state is: it is a fact about characters that are currently
    // in the world, so a restart legitimately dissolves it and no SQLite row
    // has to be kept in step.  The client only ever names a character to
    // invite, or answers an invitation with yes/no — whether a party exists,
    // who leads it, how many fit and who shares EXP are all decided here.

    /// The party `id` belongs to, if any.
    pub(super) fn party_id_of(&self, id: &str) -> Option<String> {
        self.parties
            .iter()
            .find(|(_, party)| party.members.iter().any(|member| member == id))
            .map(|(party_id, _)| party_id.clone())
    }

    fn next_party_id(&mut self) -> u64 {
        self.party_sequence += 1;
        self.party_sequence
    }

    /// Resolve a typed character name to a character that is in the world.
    /// Matching is exact first and case-insensitive as a fallback, so a name
    /// typed with the wrong capitalisation still reaches its owner without
    /// ever becoming a claim about an identity.
    fn find_player_by_name(&self, name: &str) -> Option<String> {
        let needle = name.trim();
        self.players
            .iter()
            .find(|(_, player)| player.state.username == needle)
            .or_else(|| {
                self.players
                    .iter()
                    .find(|(_, player)| player.state.username.eq_ignore_ascii_case(needle))
            })
            .map(|(id, _)| id.clone())
    }

    /// Party members sharing the map with `id`, always including `id` itself.
    /// Grouping is a same-map fact: being listed in a party is not enough to
    /// share a buff or a kill.
    pub(super) fn party_members_on_map(&self, id: &str) -> Vec<String> {
        let fallback = || vec![id.to_owned()];
        let Some(party_id) = self.party_id_of(id) else {
            return fallback();
        };
        let Some(party) = self.parties.get(&party_id) else {
            return fallback();
        };
        let Some(map_id) = self.players.get(id).map(|player| player.map_id.clone()) else {
            return fallback();
        };
        let members: Vec<String> = party
            .members
            .iter()
            .filter(|member| {
                self.players
                    .get(*member)
                    .is_some_and(|player| player.map_id == map_id && player.state.hp > 0)
            })
            .cloned()
            .collect();
        if members.is_empty() {
            fallback()
        } else {
            members
        }
    }

    /// Members that take part in a kill's EXP bonus.  Empty for a solo kill,
    /// which leaves every existing solo EXP number exactly as it is.
    pub(super) fn party_exp_members(&self, id: &str) -> Vec<String> {
        let members = self.party_members_on_map(id);
        if members.len() < 2 {
            Vec::new()
        } else {
            members
        }
    }

    /// One authoritative view of a party.  Members that are no longer in the
    /// world are omitted — the view is rebuilt from `players`, not from a
    /// cached roster.
    fn party_view(&self, party_id: &str) -> Option<serde_json::Value> {
        let party = self.parties.get(party_id)?;
        let members: Vec<serde_json::Value> = party
            .members
            .iter()
            .filter_map(|member| {
                let player = self.players.get(member)?;
                Some(serde_json::json!({
                    "id": player.state.id,
                    "name": player.state.username,
                    "level": player.state.level,
                    "job": player.state.job,
                    "mapId": player.map_id,
                    "hp": player.state.hp,
                    "maxHp": player.state.max_hp,
                    "mp": player.state.mp,
                    "maxMp": player.state.max_mp,
                    "leader": *member == party.leader_id,
                }))
            })
            .collect();
        Some(serde_json::json!({
            "type": "partyState",
            "partyId": party.id,
            "leaderId": party.leader_id,
            "members": members,
        }))
    }

    /// Push the authoritative party view to every listed character.  A
    /// character without a party receives `closed: true`, which is what makes
    /// a removed member's window disappear.
    fn push_party_state(&self, ids: &[String]) {
        for id in ids {
            let message = self
                .party_id_of(id)
                .and_then(|party_id| self.party_view(&party_id))
                .unwrap_or_else(|| serde_json::json!({"type":"partyState","closed":true}))
                .to_string();
            if let Some(player) = self.players.get(id).filter(|player| !player.detached) {
                let _ = player.output.try_send(message);
            }
        }
    }

    /// Inform a character about a party event its own request did not cause —
    /// a declined invitation, a kick.  Display only: the authoritative state
    /// still arrives as a `partyState` view, so a lost notice cannot desync a
    /// window.
    fn send_party_notice(&self, recipient: &str, code: &str, actor_id: &str) {
        let Some(player) = self.players.get(recipient) else {
            return;
        };
        let actor_name = self
            .players
            .get(actor_id)
            .map(|player| player.state.username.clone())
            .unwrap_or_default();
        let message = serde_json::json!({
            "type":"partyNotice",
            "code":code,
            "playerId":actor_id,
            "playerName":actor_name,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    fn send_party_result(&self, id: &str, request_id: &str, success: bool, code: &str) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"partyResult",
            "requestId":request_id,
            "success":success,
            "code":code,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// Bounded request-id idempotency for party intents: a retried invite or
    /// kick replays the recorded outcome instead of acting a second time.
    fn remember_party_request(&mut self, id: &str, request_id: &str, success: bool, code: &str) {
        if self.party_requests.len() >= PARTY_REQUEST_WINDOW * self.players.len().max(1) {
            self.party_requests
                .retain(|(player_id, _), _| self.players.contains_key(player_id));
        }
        self.party_requests.insert(
            (id.to_owned(), request_id.to_owned()),
            PartyOutcome {
                success,
                code: code.to_owned(),
            },
        );
    }

    fn replayed_party_request(&self, id: &str, request_id: &str) -> Option<(bool, String)> {
        self.party_requests
            .get(&(id.to_owned(), request_id.to_owned()))
            .map(|outcome| (outcome.success, outcome.code.clone()))
    }

    /// Everything that can make an invitation impossible, checked in the
    /// order a player would notice it.
    fn party_invite_target(&self, id: &str, player_name: &str) -> Result<String, String> {
        let Some(target) = self.find_player_by_name(player_name) else {
            return Err("party_unknown_player".to_owned());
        };
        if target == id {
            return Err("party_self".to_owned());
        }
        if self.party_invites.contains_key(&target) {
            return Err("party_busy".to_owned());
        }
        if let Some(party) = self
            .party_id_of(id)
            .and_then(|party_id| self.parties.get(&party_id))
        {
            if party.leader_id != id {
                return Err("party_not_leader".to_owned());
            }
            if party.members.contains(&target) {
                return Err("party_already".to_owned());
            }
            if party.members.len() >= PARTY_MAX_MEMBERS {
                return Err("party_full".to_owned());
            }
        }
        if self.party_id_of(&target).is_some() {
            return Err("party_already".to_owned());
        }
        Ok(target)
    }

    fn create_party(&mut self, leader_id: &str) -> String {
        let id = format!("party-{}", self.next_party_id());
        self.parties.insert(
            id.clone(),
            Party {
                id: id.clone(),
                leader_id: leader_id.to_owned(),
                members: vec![leader_id.to_owned()],
            },
        );
        self.push_party_state(&[leader_id.to_owned()]);
        id
    }

    /// Drop one member and hand leadership on when the leader is the one
    /// leaving.  Returns every character whose party view changed.
    fn remove_from_party(&mut self, id: &str) -> Vec<String> {
        let Some(party_id) = self.party_id_of(id) else {
            return vec![id.to_owned()];
        };
        let mut affected = vec![id.to_owned()];
        let mut disbanded = false;
        if let Some(party) = self.parties.get_mut(&party_id) {
            party.members.retain(|member| member != id);
            affected.extend(party.members.iter().cloned());
            if party.members.len() < 2 {
                disbanded = true;
            } else if party.leader_id == id {
                party.leader_id = party.members.first().cloned().unwrap_or_default();
            }
        }
        if disbanded {
            self.parties.remove(&party_id);
            // An invitation into a party that no longer exists cannot be
            // accepted, so it is dropped instead of failing later.
            self.party_invites
                .retain(|_, invite| invite.party_id != party_id);
        }
        affected
    }

    /// Invite one character.  When the inviter has no party yet, the first
    /// invitation creates it — that is what the authored `BtCreate` button
    /// stands for in the original window.
    pub(super) fn handle_party_invite(
        &mut self,
        id: String,
        request_id: String,
        player_name: String,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some((success, code)) = self.replayed_party_request(&id, &request_id) {
            self.send_party_result(&id, &request_id, success, &code);
            return;
        }
        let target = match self.party_invite_target(&id, &player_name) {
            Ok(target) => target,
            Err(code) => {
                self.remember_party_request(&id, &request_id, false, &code);
                self.send_party_result(&id, &request_id, false, &code);
                return;
            }
        };
        let party_id = self
            .party_id_of(&id)
            .unwrap_or_else(|| self.create_party(&id));
        let invitation_id = format!("party-invite-{}", self.next_party_id());
        let inviter_name = self
            .players
            .get(&id)
            .map(|player| player.state.username.clone())
            .unwrap_or_default();
        self.party_invites.insert(
            target.clone(),
            PartyInvite {
                inviter_id: id.clone(),
                party_id,
            },
        );
        self.remember_party_request(&id, &request_id, true, "");
        self.send_party_result(&id, &request_id, true, "");
        if let Some(player) = self.players.get(&target) {
            let message = serde_json::json!({
                "type":"partyInvite",
                "invitationId":invitation_id,
                "fromId":id,
                "fromName":inviter_name,
            })
            .to_string();
            let _ = player.output.try_send(message);
        }
    }

    /// Accept or decline the pending invitation.
    pub(super) fn handle_party_respond(&mut self, id: String, request_id: String, accept: bool) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some((success, code)) = self.replayed_party_request(&id, &request_id) {
            self.send_party_result(&id, &request_id, success, &code);
            return;
        }
        let Some(invite) = self.party_invites.remove(&id) else {
            self.remember_party_request(&id, &request_id, false, "party_no_invite");
            self.send_party_result(&id, &request_id, false, "party_no_invite");
            return;
        };
        if !accept {
            // Declining closes the "create, then invite" window immediately:
            // the party only existed for this invitation.  Prune now instead of
            // waiting for the next tick so the inviter's window cannot linger.
            self.step_parties();
            // The inviter is told as well, so its window does not sit waiting
            // on an answer that will never come.
            self.send_party_notice(&invite.inviter_id, "party_declined", &id);
            self.remember_party_request(&id, &request_id, false, "party_declined");
            self.send_party_result(&id, &request_id, false, "party_declined");
            return;
        }
        // Every fact is re-checked at answer time: the party may have been
        // disbanded, filled by someone else, or the inviter may have left
        // while the invitation was pending.
        let joinable = self.parties.get(&invite.party_id).is_some_and(|party| {
            party.members.len() < PARTY_MAX_MEMBERS
                && !party.members.contains(&id)
                && self.players.contains_key(&invite.inviter_id)
        }) && self.party_id_of(&id).is_none();
        if !joinable {
            let code = "party_unavailable";
            self.remember_party_request(&id, &request_id, false, code);
            self.send_party_result(&id, &request_id, false, code);
            return;
        }
        let mut affected = vec![id.clone()];
        if let Some(party) = self.parties.get_mut(&invite.party_id) {
            party.members.push(id.clone());
            affected.extend(party.members.iter().cloned());
        }
        self.remember_party_request(&id, &request_id, true, "");
        self.send_party_result(&id, &request_id, true, "");
        affected.sort();
        affected.dedup();
        self.push_party_state(&affected);
    }

    pub(super) fn handle_party_leave(&mut self, id: String, request_id: String) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some((success, code)) = self.replayed_party_request(&id, &request_id) {
            self.send_party_result(&id, &request_id, success, &code);
            return;
        }
        if self.party_id_of(&id).is_none() {
            let code = "party_not_member";
            self.remember_party_request(&id, &request_id, false, code);
            self.send_party_result(&id, &request_id, false, code);
            return;
        }
        let mut affected = self.remove_from_party(&id);
        self.remember_party_request(&id, &request_id, true, "");
        self.send_party_result(&id, &request_id, true, "");
        affected.sort();
        affected.dedup();
        self.push_party_state(&affected);
    }

    /// Remove one member.  Only the leader may, and only from its own party.
    pub(super) fn handle_party_kick(&mut self, id: String, request_id: String, player_id: String) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some((success, code)) = self.replayed_party_request(&id, &request_id) {
            self.send_party_result(&id, &request_id, success, &code);
            return;
        }
        let code = self.party_leader_action_code(&id, &player_id);
        if let Some(code) = code {
            self.remember_party_request(&id, &request_id, false, &code);
            self.send_party_result(&id, &request_id, false, &code);
            return;
        }
        let mut affected = self.remove_from_party(&player_id);
        self.send_party_notice(&player_id, "party_kicked", &id);
        self.remember_party_request(&id, &request_id, true, "");
        self.send_party_result(&id, &request_id, true, "");
        affected.sort();
        affected.dedup();
        self.push_party_state(&affected);
    }

    /// Hand leadership to another member of the same party.
    pub(super) fn handle_party_leader(
        &mut self,
        id: String,
        request_id: String,
        player_id: String,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some((success, code)) = self.replayed_party_request(&id, &request_id) {
            self.send_party_result(&id, &request_id, success, &code);
            return;
        }
        let code = self.party_leader_action_code(&id, &player_id);
        if let Some(code) = code {
            self.remember_party_request(&id, &request_id, false, &code);
            self.send_party_result(&id, &request_id, false, &code);
            return;
        }
        let party_id = self.party_id_of(&id).unwrap_or_default();
        let mut affected = vec![player_id.clone()];
        if let Some(party) = self.parties.get_mut(&party_id) {
            party.leader_id = player_id.clone();
            affected.extend(party.members.iter().cloned());
        }
        self.remember_party_request(&id, &request_id, true, "");
        self.send_party_result(&id, &request_id, true, "");
        affected.sort();
        affected.dedup();
        self.push_party_state(&affected);
    }

    /// Shared guards for the two leader-only actions: the actor must be in a
    /// party and be its leader, and the target must be another member of it.
    fn party_leader_action_code(&self, id: &str, player_id: &str) -> Option<&'static str> {
        if player_id == id {
            return Some("party_self");
        }
        let party = self
            .party_id_of(id)
            .and_then(|party_id| self.parties.get(&party_id))?;
        if party.leader_id != id {
            return Some("party_not_leader");
        }
        if !party.members.iter().any(|member| member == player_id) {
            return Some("party_not_party_member");
        }
        None
    }

    /// Prune membership every tick so no removal site has to know about
    /// parties: a character that left the world simply stops being a member,
    /// leadership moves on, and a party with one member stops existing.
    pub(super) fn step_parties(&mut self) {
        let mut affected: Vec<String> = Vec::new();
        let mut dissolved: Vec<String> = Vec::new();
        for (party_id, party) in self.parties.iter_mut() {
            let before = party.members.len();
            party
                .members
                .retain(|member| self.players.contains_key(member));
            if party.members.len() != before {
                affected.extend(party.members.iter().cloned());
            }
            if !party
                .members
                .iter()
                .any(|member| *member == party.leader_id)
            {
                if let Some(next) = party.members.first().cloned() {
                    party.leader_id = next;
                    affected.extend(party.members.iter().cloned());
                }
            }
            if party.members.len() < 2 {
                // A party of one is only meaningful while an invitation it
                // just sent is still pending — that is the "create, then
                // invite" window.  Once the answer arrives (or the inviter is
                // gone) the roster has nothing left to hold together.
                let pending = self
                    .party_invites
                    .values()
                    .any(|invite| invite.party_id == *party_id);
                if party.members.is_empty() || !pending {
                    dissolved.push(party_id.clone());
                    affected.extend(party.members.iter().cloned());
                }
            }
        }
        for party_id in &dissolved {
            self.parties.remove(party_id);
        }
        if !dissolved.is_empty() {
            self.party_invites
                .retain(|_, invite| !dissolved.contains(&invite.party_id));
        }
        // An invitation is meaningless once either side is gone.
        let stale: Vec<String> = self
            .party_invites
            .iter()
            .filter(|(invitee, invite)| {
                !self.players.contains_key(*invitee)
                    || !self.players.contains_key(&invite.inviter_id)
            })
            .map(|(invitee, _)| invitee.clone())
            .collect();
        for invitee in stale {
            self.party_invites.remove(&invitee);
        }
        if affected.is_empty() {
            return;
        }
        affected.sort();
        affected.dedup();
        self.push_party_state(&affected);
    }

    // ---------------------------------------------------------------- friends
    //
    // A friend row is the opposite of a party: it is an account fact, so it
    // survives a restart and every transition is written to SQLite by
    // `auth::friend_edit`.  What the world owns is the half that cannot be
    // persisted — whether a listed character is in the world right now and
    // which map it is on — plus the enforcement that turns a blacklist row
    // into silence.  The client only ever says "add this name", "remove this
    // row", "block this name" or "unblock this row"; the caps, the symmetry of
    // the relation and the actual membership are all decided here and in
    // auth.

    /// Persisted friend and blacklist rows for one account.  An absent store
    /// (test worlds) simply yields two empty lists, which is the honest answer
    /// for a world that has no accounts.
    fn friend_rows(&self, id: &str) -> (Vec<auth::FriendRow>, Vec<auth::FriendRow>) {
        let Some(store) = self.store.as_ref() else {
            return (Vec::new(), Vec::new());
        };
        (
            store.load_friends(id).unwrap_or_default(),
            store.load_blacklist(id).unwrap_or_default(),
        )
    }

    /// Rebuild `friend_links[id]` from the persisted rows, and register `id`
    /// on every row it points at.  Because `Add` writes the pair in both
    /// directions, one pass gives both halves of the reverse index.
    pub(super) fn refresh_friend_links(&mut self, id: &str) {
        let friends: Vec<String> = self
            .friend_rows(id)
            .0
            .into_iter()
            .map(|row| row.id)
            .collect();
        for friend in &friends {
            self.friend_links
                .entry(friend.clone())
                .or_default()
                .insert(id.to_owned());
        }
        self.friend_links
            .insert(id.to_owned(), friends.into_iter().collect());
    }

    /// Re-read the blacklist into the Player row that the chat fan-out uses.
    fn reload_blocked(&mut self, id: &str) {
        let blocked: BTreeSet<String> = self
            .friend_rows(id)
            .1
            .into_iter()
            .map(|row| row.id)
            .collect();
        if let Some(player) = self.players.get_mut(id) {
            player.blocked = blocked;
        }
    }

    /// Authoritative view of one character's friend & blacklist window.  The
    /// persisted half (id, name, level, job) comes from SQLite; `online` and
    /// `mapId` are derived from the live world on every push, so a stale
    /// offline snapshot can never be presented as a live location.
    fn friend_view(&self, id: &str) -> serde_json::Value {
        let (friends, blocked) = self.friend_rows(id);
        let render = |rows: Vec<auth::FriendRow>| -> Vec<serde_json::Value> {
            rows.into_iter()
                .map(|row| {
                    let online = self.players.get(&row.id);
                    serde_json::json!({
                        "id": row.id,
                        "name": row.name,
                        "level": row.level,
                        "job": row.job,
                        "online": online.is_some(),
                        "mapId": online.map(|player| player.map_id.clone()).unwrap_or_default(),
                    })
                })
                .collect()
        };
        serde_json::json!({
            "type": "friendState",
            "friends": render(friends),
            "blocked": render(blocked),
        })
    }

    /// Push one character's window.  A detached character has no socket to
    /// write to, so its view is simply rebuilt on the next open.
    fn push_friend_state(&self, id: &str) {
        let Some(player) = self.players.get(id).filter(|player| !player.detached) else {
            return;
        };
        let message = self.friend_view(id).to_string();
        let _ = player.output.try_send(message);
    }

    /// Refresh this character's window and the window of everybody who lists
    /// it.  `friend_links` holds both directions of the relation, so one hop
    /// covers every observer.
    pub(super) fn push_friend_state_to_watchers(&self, id: &str) {
        let mut targets: Vec<String> = vec![id.to_owned()];
        if let Some(links) = self.friend_links.get(id) {
            targets.extend(links.iter().cloned());
        }
        targets.sort();
        targets.dedup();
        for target in targets {
            self.push_friend_state(&target);
        }
    }

    fn send_friend_result(&self, id: &str, request_id: &str, success: bool, code: &str) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"friendResult",
            "requestId":request_id,
            "success":success,
            "code":code,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// Bounded request-id idempotency for friend intents: a retried add or
    /// block replays the recorded outcome instead of acting a second time.
    fn remember_friend_request(&mut self, id: &str, outcome: &auth::FriendOutcome) {
        if self.friend_requests.len() >= FRIEND_REQUEST_WINDOW * self.players.len().max(1) {
            self.friend_requests
                .retain(|(player_id, _), _| self.players.contains_key(player_id));
        }
        self.friend_requests
            .insert((id.to_owned(), outcome.request_id.clone()), outcome.clone());
    }

    fn replayed_friend_request(&self, id: &str, request_id: &str) -> Option<auth::FriendOutcome> {
        self.friend_requests
            .get(&(id.to_owned(), request_id.to_owned()))
            .cloned()
    }

    /// Record and report a refusal that never reached SQLite, so the same
    /// request id cannot be retried into a different answer.
    fn friend_reject(
        &mut self,
        id: &str,
        request_id: &str,
        operation: auth::FriendOperation,
        code: &str,
    ) {
        let outcome = auth::FriendOutcome {
            request_id: request_id.to_owned(),
            operation,
            target_id: String::new(),
            success: false,
            code: code.to_owned(),
        };
        self.remember_friend_request(id, &outcome);
        self.send_friend_result(id, request_id, false, code);
    }

    /// Open (or refresh) the window.  Nothing is mutated: the answer is
    /// whatever the account already has, plus the live online flags.
    pub(super) fn handle_friend_open(&mut self, id: String, request_id: String) {
        if !self.players.contains_key(&id) {
            return;
        }
        self.refresh_friend_links(&id);
        self.send_friend_result(&id, &request_id, true, "");
        self.push_friend_state(&id);
    }

    /// Resolve a typed name, then run the edit.  Names come from the source
    /// context menu, which carries no id; the resolution happens here so a
    /// client cannot hand the server an id it guessed.
    pub(super) fn handle_friend_by_name(
        &mut self,
        id: String,
        request_id: String,
        operation: auth::FriendOperation,
        player_name: String,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some(outcome) = self.replayed_friend_request(&id, &request_id) {
            self.send_friend_result(&id, &request_id, outcome.success, &outcome.code);
            return;
        }
        let target = match self.resolve_friend_name(&player_name) {
            Some(target) => target,
            None => {
                self.friend_reject(&id, &request_id, operation, "friend_unknown_player");
                return;
            }
        };
        self.apply_friend_edit(id, request_id, operation, target);
    }

    /// Look a typed character name up in the account store.  Exact match
    /// first, case-insensitive as a fallback, so a name typed with the wrong
    /// capitalisation still reaches its owner without the client ever being
    /// able to claim an identity.
    pub(super) fn resolve_friend_name(&self, player_name: &str) -> Option<String> {
        let store = self.store.as_ref()?;
        let needle = player_name.trim();
        store
            .find_character_by_name(needle)
            .ok()
            .flatten()
            .map(|row| row.id)
            .or_else(|| {
                let players = self
                    .players
                    .iter()
                    .find(|(_, player)| player.state.username.eq_ignore_ascii_case(needle))
                    .map(|(id, _)| id.clone());
                players
            })
    }

    /// One authoritative friend / blacklist transaction.  Every guard lives in
    /// `auth::friend_edit`, which also persists the outcome so a replayed
    /// request id survives a restart; this layer only resolves the target and
    /// re-publishes what changed.
    pub(super) fn apply_friend_edit(
        &mut self,
        id: String,
        request_id: String,
        operation: auth::FriendOperation,
        target_id: String,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some(outcome) = self.replayed_friend_request(&id, &request_id) {
            self.send_friend_result(&id, &request_id, outcome.success, &outcome.code);
            return;
        }
        let Some(store) = self.store.clone() else {
            self.friend_reject(&id, &request_id, operation, "persistence");
            return;
        };
        match store.friend_edit(&id, &request_id, operation, &target_id) {
            Ok(outcome) => {
                let success = outcome.success;
                let code = outcome.code.clone();
                self.remember_friend_request(&id, &outcome);
                self.send_friend_result(&id, &request_id, success, &code);
                if !success {
                    return;
                }
                // Membership or the blacklist changed, so both sides of the
                // relation and the cached block set have to be rebuilt
                // before the windows are re-published.
                self.reload_blocked(&id);
                self.refresh_friend_links(&id);
                self.refresh_friend_links(&target_id);
                self.push_friend_state(&id);
                self.push_friend_state(&target_id);
            }
            Err(error) => {
                if let Some(player) = self.players.get(&id) {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                }
            }
        }
    }

    /// Notice that a character entered or left the world and refresh the
    /// friend windows that show it.  The roster is compared as a whole so the
    /// pass costs one allocation on the overwhelming majority of ticks and
    /// nothing at all when nobody joined or left.
    pub(super) fn step_friends(&mut self) {
        let roster: Vec<String> = self.players.keys().cloned().collect();
        if roster == self.friend_roster {
            return;
        }
        let mut changed: BTreeSet<String> = roster.iter().cloned().collect();
        for id in &self.friend_roster {
            changed.insert(id.clone());
        }
        self.friend_roster = roster;
        for id in changed {
            self.push_friend_state_to_watchers(&id);
        }
    }
}
