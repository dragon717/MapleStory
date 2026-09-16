//! 命令入口分发（`World::command`）。
//!
//! 负责：把 `Command` 枚举逐变体分发到各处理方法——Join/重连装配（连接接管、
//! away 窗口续期、进度归一化回写）、Leave/Exit、Input、以及转发到
//! `dialogue` / `growth` / `revive` / `portals` / `inventory_ops` / `trade` / `skills` 等子模块的入口方法。
//! 不负责：tick 主循环（`world.rs` 的 `run` / `step`）、单个命令的业务规则（在各主题子模块）。
//!
//! 注意：`command` 保持 `pub fn`——外部可见性不变；方法调用走类型解析，无需 glob 接线。

use super::*;

impl World {
    pub fn command(&mut self, command: Command) {
        match command {
            Command::Join {
                identity,
                connection,
                output,
                reply,
                lang,
            } => {
                // Take over the resident character instead of building a new
                // one.  A character is only recreated when it is genuinely
                // absent from the world (fresh login or after a completed
                // exit), so reconnecting never produces a second entity and
                // never restarts the away window that is already running.
                let carried_away_sequence = 0;
                if self.players.contains_key(&identity.id) {
                    // A reconnect replaces the stale session.  Resolve its
                    // private Boss instance before rebinding the Player row;
                    // otherwise the old practice entry could move the new
                    // connection into a deleted encounter on the next tick.
                    if !self.prepare_boss_replacement(&identity.id) {
                        let _ = output.try_send(reject(
                            "persistence",
                            "旧连接的练习位置尚未保存，请稍后重连。",
                            None,
                        ));
                        let _ = reply.send(false);
                        return;
                    }
                    if !self.prepare_windbell_replacement(&identity.id) {
                        let _ = output.try_send(reject(
                            "persistence",
                            "旧连接的风铃岛位置尚未保存，请稍后重连。",
                            None,
                        ));
                        let _ = reply.send(false);
                        return;
                    }
                    self.end_conversation(&identity.id);
                    self.pending_attacks
                        .retain(|_, attack| attack.player_id != identity.id);
                    if let Some(existing) = self.players.get_mut(&identity.id) {
                        existing.away_sequence += 1;
                        existing.connection = connection.clone();
                        existing.output = output.clone();
                        existing.detached = false;
                        // Control is handed over clean: no stale held key, no
                        // queued channel release, no resurrected attack.
                        existing.direction = 0;
                        existing.vertical = 0;
                        existing.jump = false;
                        existing.last_input = Instant::now();
                        // The new client starts its input sequence at 1 again.
                        // Keeping the old high-water mark would make every
                        // fresh packet look stale and silently drop it, so the
                        // character would stand frozen and unmovable.
                        existing.state.last_input_seq = 0;
                        // Recovery boundaries restart from now.  Without this,
                        // time spent away would be paid out as recovery on
                        // return, handing the character free HP/MP for doing
                        // nothing.
                        existing.natural_recovery_next_tick =
                            self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
                        existing.beginner_heal_next_tick = 0;
                        existing.beginner_heal_remaining_ticks = 0;
                        let _ = output.try_send(self.snapshot(&identity.id));
                        self.send_quest_list(&identity.id);
                        let _ = reply.send(true);
                        return;
                    }
                }
                let mut profile = match self.store.as_ref() {
                    Some(store) => {
                        match store.load_profile(&identity.id, &self.default_profile()) {
                            Ok(profile) => profile,
                            Err(error) => {
                                let _ = output.try_send(reject("persistence", &error, None));
                                let _ = reply.send(false);
                                return;
                            }
                        }
                    }
                    None => self.default_profile(),
                };
                let progress_before = (
                    profile.level,
                    profile.exp,
                    profile.exp_to_next,
                    profile.ability_stats.clone(),
                    profile.skill_points.clone(),
                );
                Self::normalize_profile_progress(&mut profile, &self.gameplay.exp_table);
                if let Some(store) = self.store.as_ref() {
                    let progress_after = (
                        profile.level,
                        profile.exp,
                        profile.exp_to_next,
                        profile.ability_stats.clone(),
                        profile.skill_points.clone(),
                    );
                    if progress_after != progress_before {
                        if let Err(error) = store.save_profile(&identity.id, &profile) {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    }
                }
                if profile.hp <= 0 && profile.death_id.is_empty() {
                    profile.death_id = auth::random_id();
                    if let Some(store) = self.store.as_ref() {
                        if let Err(error) = store.save_profile(&identity.id, &profile) {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    }
                }
                let (equipped, monster_book) = match self.store.as_ref() {
                    Some(store) => match (
                        store.load_equipped(&identity.id),
                        store.load_monster_book(&identity.id),
                    ) {
                        (Ok(equipped), Ok(monster_book)) => (equipped, monster_book),
                        (Err(error), _) | (_, Err(error)) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    },
                    None => (inventory::starter_equipment(), BTreeMap::new()),
                };
                // Grant the starter backpack coupon (one per account).  Lives
                // on join — not on load_profile — so unit tests that load a
                // profile directly are not surprised by an extra inventory row.
                if let Some(store) = self.store.as_ref() {
                    match store.seed_starter_backpack(&identity.id) {
                        Ok(granted) => {
                            for item in granted {
                                profile.inventory.push(item);
                            }
                        }
                        Err(error) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    }
                }
                let inventory_slots = match self.store.as_ref() {
                    Some(store) => match store.load_inventory_slots(&identity.id) {
                        Ok(slots) => slots,
                        Err(error) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    },
                    None => inventory::default_inventory_slots(),
                };
                let appearance = match self.store.as_ref() {
                    Some(store) => match store.character_appearance(&identity.id) {
                        Ok(appearance) => appearance,
                        Err(error) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    },
                    None => None,
                };
                let id = identity.id.clone();
                if auth::is_practice_map(&profile.map_id) {
                    // Migrate any profile written by an older runtime before
                    // the private-map canonicalization was installed.
                    profile.map_id = BOSS_PRACTICE_FALLBACK_MAP_ID.to_owned();
                }
                // Restore the player's last map + coordinates from the
                // persisted profile.  The map must still exist in the runtime
                // catalog and the persisted point must land inside the map
                // bounds; otherwise fall back to the birth map's authored
                // spawn so the join site never drops a player outside the
                // playable area.
                let persisted_map = self.maps.get(profile.map_id.as_str()).cloned();
                let resolved_map = persisted_map.clone().unwrap_or_else(|| self.map.clone());
                let resolved_map_id = resolved_map.id.clone();
                let (resolved_x, resolved_y) = if persisted_map.is_some()
                    && profile.x.is_finite()
                    && profile.y.is_finite()
                    && resolved_map.bounds.x_min <= profile.x
                    && profile.x <= resolved_map.bounds.x_max
                    && resolved_map.bounds.y_min <= profile.y
                    && profile.y <= resolved_map.bounds.y_max
                {
                    (profile.x, profile.y)
                } else {
                    (resolved_map.spawn.x, resolved_map.spawn.y)
                };
                let foothold_id = resolved_map
                    .ground_near(resolved_x, resolved_y)
                    .map(|(id, _)| id)
                    .unwrap_or(0);
                let windbell_progress = match self.load_windbell_player_progress(&identity.id) {
                    Ok(progress) => progress,
                    Err(error) => {
                        let _ = output.try_send(reject("persistence", &error, None));
                        let _ = reply.send(false);
                        return;
                    }
                };
                let quests = match self.store.as_ref() {
                    Some(store) => match store.load_quests(&identity.id) {
                        Ok(quests) => quests,
                        Err(error) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    },
                    None => BTreeMap::new(),
                };
                // Kill progress is loaded with the status map: a reconnect must
                // never show a hunter their kills reset to zero.
                let quest_kills = match self.store.as_ref() {
                    Some(store) => match store.load_quest_kills(&identity.id) {
                        Ok(kills) => kills,
                        Err(error) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    },
                    None => BTreeMap::new(),
                };
                let adaptation_cooldown_ms = match self.store.as_ref() {
                    Some(store) => {
                        match store.skill_cooldown_remaining_ms(&id, SKILL_ELEMENTAL_ADAPTING) {
                            Ok(remaining) => remaining,
                            Err(error) => {
                                let _ = output.try_send(reject("persistence", &error, None));
                                let _ = reply.send(false);
                                return;
                            }
                        }
                    }
                    None => 0,
                };
                let mut skill_cooldowns = BTreeMap::new();
                if let Some(store) = self.store.as_ref() {
                    for skill_id in [
                        SKILL_RECOVERY,
                        SKILL_NIMBLE_FEET,
                        SKILL_INFINITY,
                        SKILL_BLIZZARD,
                        SKILL_MAPLE_CURE,
                        SKILL_ICE_DRAGON_BREATH,
                        SKILL_FROZEN_ORB,
                        SKILL_HYPER_THUNDER,
                        SKILL_HYPER_ADVENTURER,
                        SKILL_HYPER_VORTEX_HIDDEN,
                    ] {
                        let remaining = match store.skill_cooldown_remaining_ms(&id, skill_id) {
                            Ok(remaining) => remaining,
                            Err(error) => {
                                let _ = output.try_send(reject("persistence", &error, None));
                                let _ = reply.send(false);
                                return;
                            }
                        };
                        if remaining > 0 {
                            skill_cooldowns.insert(skill_id, remaining);
                        }
                    }
                }
                let hyper_points = hyper_points_for_state(profile.level, &profile.skills);
                let hyper_reset_count = match self.store.as_ref() {
                    Some(store) => match store.hyper_reset_count(&id) {
                        Ok(count) => count,
                        Err(error) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    },
                    None => 0,
                };
                let (derived_stats, derived_max_mp) = compute_derived_stats(
                    &self.gameplay,
                    &self.mage_skills,
                    profile.job,
                    profile.max_mp,
                    profile.level,
                    &profile.skills,
                    &profile.ability_stats,
                    &equipped,
                    false,
                    0,
                    None,
                    false,
                    false,
                    false,
                    false,
                    false,
                    0,
                    (adaptation_cooldown_ms > 0).then_some(adaptation_cooldown_ms),
                    0,
                    &skill_cooldowns,
                    &BTreeMap::new(),
                );
                let derived_move_speed = derived_stats.move_speed;
                // The blacklist is read once here instead of inside the chat
                // fan-out: it only ever changes through a friend intent, and
                // every such intent refreshes this cached set.
                let blocked: BTreeSet<String> = self
                    .store
                    .as_ref()
                    .and_then(|store| store.load_blacklist(&id).ok())
                    .unwrap_or_default()
                    .into_iter()
                    .map(|row| row.id)
                    .collect();
                self.players.insert(
                    id.clone(),
                    Player {
                        state: PlayerState {
                            id: id.clone(),
                            username: identity.username,
                            appearance,
                            x: resolved_x,
                            y: resolved_y,
                            vx: 0.,
                            vy: 0.,
                            facing: 1,
                            grounded: false,
                            swimming: false,
                            // A persisted zero-HP profile reconnects into
                            // the same dead state so the source revive flow
                            // remains available after a process restart.
                            action: if profile.hp <= 0 { "dead" } else { "stand" },
                            action_id: None,
                            action_started_tick: self.tick,
                            last_input_seq: 0,
                            climbing: false,
                            ladder_id: None,
                            hp: profile.hp.min(profile.max_hp).max(0),
                            max_hp: profile.max_hp.max(1),
                            mp: profile.mp.min(derived_max_mp).max(0),
                            max_mp: derived_max_mp,
                            derived_stats,
                            ability_stats: profile.ability_stats,
                            level: profile.level.max(1),
                            job: profile.job,
                            exp: profile.exp,
                            exp_to_next: profile.exp_to_next,
                            mesos: profile.mesos,
                            cash: profile.cash,
                            skills: profile.skills,
                            skill_points: profile.skill_points,
                            hyper_points,
                            hyper_reset_count,
                            hyper_reset_cost: auth::hyper_reset_cost(hyper_reset_count),
                            potion_cooldowns: None,
                            inventory: profile.inventory,
                            equipped,
                            inventory_slots,
                            monster_book,
                            away: None,
                        },
                        base_max_mp: profile.max_mp.max(0),
                        map_id: resolved_map_id,
                        death_id: profile.death_id,
                        windbell_progress,
                        windbell_dialogue: Vec::new(),
                        connection,
                        output: output.clone(),
                        away: None,
                        detached: false,
                        away_sequence: carried_away_sequence,
                        direction: 0,
                        vertical: 0,
                        jump: false,
                        swimming: false,
                        windbell_glide_until: 0,
                        windbell_glide_fall_speed: 0.0,
                        windbell_previous_foothold: foothold_id,
                        windbell_arrival_origin_foothold: 0,
                        foothold_id,
                        last_foothold_id: foothold_id,
                        fall_boundary_hold: false,
                        drop_fh: 0,
                        last_input: Instant::now(),
                        attack_until: 0,
                        contact_invulnerable_until: 0,
                        knockback_vx: 0.,
                        knockback_until: 0,
                        move_speed: derived_move_speed,
                        magic_guard: false,
                        magic_wave_used: false,
                        magic_wave_float_used: false,
                        slow_fall_until: 0,
                        meditation_until: 0,
                        meditation_mad: 0,
                        ice_teleport_enabled: false,
                        ice_fields: Vec::new(),
                        teleport_mastery_enabled: false,
                        teleport_boost_enabled: false,
                        adaptation_active: false,
                        adaptation_charges: 0,
                        adaptation_cooldown_ms,
                        skill_cooldowns,
                        skill_buffs: BTreeMap::new(),
                        natural_recovery_next_tick: self
                            .tick
                            .saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS),
                        beginner_heal_next_tick: 0,
                        beginner_heal_remaining_ticks: 0,
                        beginner_heal_per_tick: 0,
                        beginner_speed_percent: 0,
                        summon: None,
                        summons: Vec::new(),
                        pets: BTreeMap::new(),
                        pet_growth_next_tick: 0,
                        channel_request_id: None,
                        channel_skill_id: None,
                        channel_until: 0,
                        channel_level: 0,
                        hyper_channel_prepare_until: 0,
                        hyper_channel_next_pulse: 0,
                        hyper_channel_pulse_index: 0,
                        hyper_vortex: None,
                        hyper_barrier_enabled: false,
                        hyper_barrier_next_mp: 0,
                        hyper_barrier_next_pulse: 0,
                        hyper_teleport_enabled: false,
                        hyper_reset_count,
                        status_immune_until: 0,
                        seal_until: 0,
                        stun_until: 0,
                        curse_until: 0,
                        poison_until: 0,
                        slow_until: 0,
                        poison_next_tick: 0,
                        curse_next_tick: 0,
                        infinity_next_tick: 0,
                        infinity_damage_bonus: 0,
                        mystic_strike_stacks: 0,
                        mystic_strike_until: 0,
                        quests,
                        quest_kills,
                        lang: crate::quest_text::normalize_lang(Some(&lang)),
                        chat_tokens: messaging::CHAT_TOKEN_BURST,
                        chat_bucket_tick: self.tick,
                        chat_recent: VecDeque::new(),
                        whisper_recent: VecDeque::new(),
                        emoticon_recent: VecDeque::new(),
                        emoticon_sends: VecDeque::new(),
                        blocked,
                        potion_cooldowns: BTreeMap::new(),
                        area_reactor_overlaps: BTreeSet::new(),
                    },
                );
                let _ = output.try_send(self.snapshot(&id));
                // Authoritative quest log push follows the join snapshot so a
                // fresh client window always reflects the persisted rows and
                // the client never needs a client-side translation table.
                self.send_quest_list(&id);
                // A login is the one friend-window fact that is not persisted.
                // Rebuild this character's slice of the friend graph and
                // refresh the windows watching it, so an online flag flips at
                // once instead of on the next tick.
                self.refresh_friend_links(&id);
                self.push_friend_state_to_watchers(&id);
                let _ = reply.send(true);
            }
            Command::Detach {
                id,
                connection,
                reason,
            } => {
                // Only the socket that currently owns the character may detach
                // it.  A late close event from a superseded connection is
                // ignored, so it can never delete someone else's character.
                if !self
                    .players
                    .get(&id)
                    .is_some_and(|p| p.connection == connection)
                {
                    return;
                }
                if !self.disconnect_windbell_player(&id) {
                    self.send_reject(
                        &id,
                        "persistence",
                        "旧连接的风铃岛记忆尚未保存，请稍后重试。",
                        None,
                    );
                    return;
                }
                self.disconnect_boss_player(&id);
                self.end_conversation(&id);
                self.pending_attacks
                    .retain(|_, attack| attack.player_id != id);
                // A repeated hide, a reconnect, or a transport Pong never
                // restarts the grace period: the existing window is kept and
                // only a genuinely new absence allocates a new away id.
                let needs_window = self
                    .players
                    .get(&id)
                    .is_some_and(|player| player.away.is_none());
                let away_id = if needs_window { self.next_away_id() } else { 0 };
                let Some(player) = self.players.get_mut(&id) else {
                    return;
                };
                // Stop honouring any held intent immediately; the character
                // must not keep walking or attacking without authorization.
                player.direction = 0;
                player.vertical = 0;
                player.jump = false;
                player.channel_request_id = None;
                player.channel_until = 0;
                // The stale channel is retained but marked dead: residency is
                // modelled by the character row, not by keeping a socket
                // receiver alive, and a later close can never delete the row.
                player.detached = true;
                if player.away.is_none() {
                    player.away = Some(AwayWindow::new(away_id, reason));
                }
            }
            Command::Exit { id, connection } => {
                if let Some(expected) = connection.as_ref() {
                    if !self
                        .players
                        .get(&id)
                        .is_some_and(|p| p.connection == *expected)
                    {
                        return;
                    }
                }
                if !self.disconnect_windbell_player(&id) {
                    return;
                }
                self.disconnect_boss_player(&id);
                self.players.remove(&id);
                self.end_conversation(&id);
                self.pending_attacks
                    .retain(|_, attack| attack.player_id != id);
                self.inventory_requests
                    .retain(|(player_id, _), _| player_id != &id);
                self.shop_buy_requests
                    .retain(|(player_id, _), _| player_id != &id);
                self.shop_sell_requests
                    .retain(|(player_id, _), _| player_id != &id);
                self.shop_rebuy_requests
                    .retain(|(player_id, _), _| player_id != &id);
                self.skill_requests
                    .retain(|(player_id, _), _| player_id != &id);
                self.hyper_reset_quotes
                    .retain(|(player_id, _), _| player_id != &id);
                self.ability_requests
                    .retain(|(player_id, _), _| player_id != &id);
            }
            Command::Leave { id, connection } => {
                if self
                    .players
                    .get(&id)
                    .is_some_and(|p| p.connection == connection)
                {
                    if !self.disconnect_windbell_player(&id) {
                        return;
                    }
                    self.disconnect_boss_player(&id);
                    self.players.remove(&id);
                    self.end_conversation(&id);
                    self.pending_attacks
                        .retain(|_, attack| attack.player_id != id);
                    self.inventory_requests
                        .retain(|(player_id, _), _| player_id != &id);
                    self.shop_buy_requests
                        .retain(|(player_id, _), _| player_id != &id);
                    self.shop_sell_requests
                        .retain(|(player_id, _), _| player_id != &id);
                    self.shop_rebuy_requests
                        .retain(|(player_id, _), _| player_id != &id);
                    self.skill_requests
                        .retain(|(player_id, _), _| player_id != &id);
                    self.hyper_reset_quotes
                        .retain(|(player_id, _), _| player_id != &id);
                    self.ability_requests
                        .retain(|(player_id, _), _| player_id != &id);
                }
            }
            Command::Input {
                id,
                connection,
                message,
            } => {
                let Some(player) = self.players.get(&id).filter(|p| p.connection == connection)
                else {
                    return;
                };
                match message {
                    // An explicit logout removes the character.  This is the
                    // only client message allowed to do so: a socket that
                    // merely closes is a tab switch or a reload, not a
                    // departure, and must keep the character resident.
                    ClientMessage::Logout => {
                        if !self.disconnect_windbell_player(&id) {
                            return;
                        }
                        self.disconnect_boss_player(&id);
                        self.players.remove(&id);
                        self.end_conversation(&id);
                        self.pending_attacks
                            .retain(|_, attack| attack.player_id != id);
                        self.inventory_requests
                            .retain(|(player_id, _), _| player_id != &id);
                        self.skill_requests
                            .retain(|(player_id, _), _| player_id != &id);
                        self.hyper_reset_quotes
                            .retain(|(player_id, _), _| player_id != &id);
                        self.ability_requests
                            .retain(|(player_id, _), _| player_id != &id);
                    }
                    ClientMessage::Lifecycle { hidden, away, .. } => {
                        // A lifecycle report is advisory.  It may open an away
                        // window but it can never close one: only completing a
                        // real takeover ends an absence.  Re-reporting hidden
                        // keeps the original start, so flashing the tab cannot
                        // extend the grace period.
                        if hidden || away.unwrap_or(false) {
                            let reason = if away.unwrap_or(false) {
                                AwayReason::Manual
                            } else {
                                AwayReason::Hidden
                            };
                            let needs_window = self
                                .players
                                .get(&id)
                                .is_some_and(|player| player.away.is_none());
                            let away_id = if needs_window { self.next_away_id() } else { 0 };
                            let Some(player) = self.players.get_mut(&id) else {
                                return;
                            };
                            // Leaving sight must not leave a key held down: the
                            // character stops acting on stale intent at once.
                            player.direction = 0;
                            player.vertical = 0;
                            player.jump = false;
                            if player.away.is_none() {
                                player.away = Some(AwayWindow::new(away_id, reason));
                            }
                        }
                    }
                    ClientMessage::Input {
                        seq,
                        direction,
                        vertical,
                        jump,
                    } => {
                        if seq <= player.state.last_input_seq {
                            return;
                        }
                        let Some(player) = self.players.get_mut(&id) else {
                            return;
                        };
                        let (mut direction, mut vertical, mut jump) = (direction, vertical, jump);
                        player.state.last_input_seq = seq;
                        if player.channel_until > self.tick {
                            // Ice Dragon Breath owns movement for its source
                            // q-window; input heartbeats remain acknowledged
                            // but cannot move or jump the authoritative body.
                            direction = 0;
                            vertical = 0;
                            jump = false;
                        }
                        if player.fall_boundary_hold && (direction == 0 || vertical != 0 || jump) {
                            // Horizontal input alone may be a held-key
                            // heartbeat; a neutral packet is the release
                            // marker. Vertical movement or a jump is an
                            // explicit new action and may leave the boundary.
                            player.fall_boundary_hold = false;
                        }
                        player.direction = direction;
                        player.vertical = vertical;
                        player.jump |= jump;
                        player.last_input = Instant::now();
                    }
                    ClientMessage::Attack { request_id } => self.handle_attack(id, request_id),
                    ClientMessage::AllocateAp { request_id, stat } => {
                        self.handle_allocate_ap(id, request_id, stat)
                    }
                    ClientMessage::LearnSkill {
                        request_id,
                        skill_id,
                    } => self.handle_learn_skill(id, request_id, skill_id),
                    ClientMessage::ResetHyper {
                        request_id,
                        expected_cost,
                    } => self.handle_reset_hyper(id, request_id, expected_cost),
                    ClientMessage::CastSkill {
                        request_id,
                        skill_id,
                        direction,
                        vertical,
                    } => self.handle_cast_skill(id, request_id, skill_id, direction, vertical),
                    ClientMessage::BossPractice {
                        request_id,
                        action,
                        encounter_id,
                    } => self.handle_boss_practice(id, request_id, action, encounter_id),
                    ClientMessage::Windbell {
                        request_id,
                        action,
                        instance_id,
                    } => self.handle_windbell(id, request_id, action, instance_id),
                    ClientMessage::ReleaseSkill { request_id } => {
                        self.handle_release_skill(id, request_id)
                    }
                    ClientMessage::Pickup {
                        request_id,
                        drop_id,
                    } => self.handle_pickup(id, request_id, drop_id),
                    ClientMessage::ReactorHit {
                        request_id,
                        reactor_id,
                    } => self.handle_reactor_hit(id, request_id, reactor_id),
                    ClientMessage::Portal {
                        request_id,
                        portal_name,
                    } => self.handle_portal(id, request_id, portal_name),
                    ClientMessage::WorldMapMove { request_id, map_id } => {
                        self.handle_world_map_move(id, request_id, map_id)
                    }
                    ClientMessage::InventoryMove {
                        request_id,
                        inventory_type,
                        source_slot,
                        target_slot,
                        quantity,
                    } => self.handle_inventory_move(
                        id,
                        request_id,
                        inventory_type,
                        source_slot,
                        target_slot,
                        quantity,
                    ),
                    ClientMessage::DropItem {
                        request_id,
                        inventory_type,
                        source_slot,
                        quantity,
                    } => self.handle_inventory_drop(
                        id,
                        request_id,
                        inventory_type,
                        source_slot,
                        quantity,
                    ),
                    ClientMessage::InventoryGather {
                        request_id,
                        inventory_type,
                    } => self.handle_inventory_gather(id, request_id, inventory_type),
                    ClientMessage::InventorySort {
                        request_id,
                        inventory_type,
                    } => self.handle_inventory_sort(id, request_id, inventory_type),
                    ClientMessage::UseItem {
                        request_id,
                        inventory_type,
                        source_slot,
                        item_id,
                        target_slot,
                        target_item_id,
                    } => self.handle_use_item(
                        id,
                        request_id,
                        inventory_type,
                        source_slot,
                        item_id,
                        target_slot,
                        target_item_id,
                    ),
                    ClientMessage::DropMesos {
                        request_id,
                        quantity,
                    } => self.handle_drop_mesos(id, request_id, quantity),
                    ClientMessage::Revive { request_id } => self.handle_revive(id, request_id),
                    ClientMessage::QuestInteract {
                        request_id,
                        quest_id,
                    } => self.handle_quest_interact(id, request_id, quest_id),
                    ClientMessage::QuestService {
                        request_id,
                        quest_id,
                        action,
                    } => self.handle_quest_service(id, request_id, quest_id, action),
                    ClientMessage::NpcTalk {
                        request_id,
                        npc_id,
                        step,
                        selection,
                    } => self.handle_npc_talk(id, request_id, npc_id, step.as_deref(), selection),
                    ClientMessage::ShopBuy {
                        request_id,
                        shop_id,
                        item_id,
                        quantity,
                    } => self.handle_shop_buy(id, request_id, shop_id, item_id, quantity),
                    ClientMessage::ShopSell {
                        request_id,
                        shop_id,
                        inventory_type,
                        source_slot,
                        quantity,
                    } => self.handle_shop_sell(
                        id,
                        request_id,
                        shop_id,
                        inventory_type,
                        source_slot,
                        quantity,
                    ),
                    ClientMessage::ShopRebuy {
                        request_id,
                        shop_id,
                        item_id,
                        unit_price,
                    } => self.handle_shop_rebuy(id, request_id, shop_id, item_id, unit_price),
                    ClientMessage::CashOpen { request_id } => self.handle_cash_open(id, request_id),
                    ClientMessage::CashBuy {
                        request_id,
                        sn,
                        quantity,
                    } => self.handle_cash_buy(id, request_id, sn, quantity),
                    ClientMessage::StorageOpen { request_id, npc_id } => {
                        self.handle_storage_open(id, request_id, npc_id)
                    }
                    ClientMessage::StorageTransfer {
                        request_id,
                        operation,
                        inventory_type,
                        slot,
                        quantity,
                    } => self.handle_storage_transfer(
                        id,
                        request_id,
                        operation,
                        inventory_type,
                        slot,
                        quantity,
                    ),
                    ClientMessage::StorageMesos {
                        request_id,
                        operation,
                        quantity,
                    } => self.handle_storage_mesos(id, request_id, operation, quantity),
                    ClientMessage::ChatSend { request_id, text } => {
                        self.handle_chat(id, request_id, text)
                    }
                    ClientMessage::WhisperSend {
                        request_id,
                        target_name,
                        text,
                    } => self.handle_whisper(id, request_id, target_name, text),
                    ClientMessage::EmoticonSend {
                        request_id,
                        emoticon_id,
                    } => self.handle_emoticon(id, request_id, emoticon_id),
                    ClientMessage::PartyInvite {
                        request_id,
                        player_name,
                    } => self.handle_party_invite(id, request_id, player_name),
                    ClientMessage::PartyRespond { request_id, accept } => {
                        self.handle_party_respond(id, request_id, accept)
                    }
                    ClientMessage::PartyLeave { request_id } => {
                        self.handle_party_leave(id, request_id)
                    }
                    ClientMessage::PartyKick {
                        request_id,
                        player_id,
                    } => self.handle_party_kick(id, request_id, player_id),
                    ClientMessage::PartyLeader {
                        request_id,
                        player_id,
                    } => self.handle_party_leader(id, request_id, player_id),
                    ClientMessage::FriendOpen { request_id } => {
                        self.handle_friend_open(id, request_id)
                    }
                    ClientMessage::FriendAdd {
                        request_id,
                        player_name,
                    } => self.handle_friend_by_name(
                        id,
                        request_id,
                        auth::FriendOperation::Add,
                        player_name,
                    ),
                    ClientMessage::FriendRemove {
                        request_id,
                        player_id,
                    } => self.apply_friend_edit(
                        id,
                        request_id,
                        auth::FriendOperation::Remove,
                        player_id,
                    ),
                    ClientMessage::FriendBlock {
                        request_id,
                        player_name,
                    } => self.handle_friend_by_name(
                        id,
                        request_id,
                        auth::FriendOperation::Block,
                        player_name,
                    ),
                    ClientMessage::FriendUnblock {
                        request_id,
                        player_id,
                    } => self.apply_friend_edit(
                        id,
                        request_id,
                        auth::FriendOperation::Unblock,
                        player_id,
                    ),
                    ClientMessage::Hello { .. } => {}
                    // 冒险笔记（图鉴）。  查询回答当前角色／账号真正拥有的记录；
                    // 三种操作在规则核定之前一律以「本构建没有核定这套机制」拒绝
                    // （原因见 `notebook.rs`：登记／奖励／探险的规则都还是
                    // `unverified`，所以没有可领取的奖励，也没有可开始的探险）。
                    ClientMessage::NotebookQuery {
                        request_id,
                        section,
                        page,
                        catalog_version,
                        filter,
                        mode,
                    } => self.handle_notebook_query(
                        &id,
                        request_id,
                        section,
                        page,
                        catalog_version,
                        filter,
                        mode,
                    ),
                    // `reward_key` / `row_key` / `run_id` 的真实性、归属与重复领取
                    // 是权威世界的问题，等奖励事务落地时在同一个事务里重算；此刻
                    // 它们连一个可校验的目标都没有，所以拒绝回答里不回显这些键。
                    ClientMessage::CollectionClaim { request_id, .. } => {
                        self.handle_collection_claim(&id, request_id)
                    }
                    ClientMessage::ExplorationStart { request_id, .. } => {
                        self.handle_exploration(&id, request_id, true)
                    }
                    ClientMessage::ExplorationClaim { request_id, .. } => {
                        self.handle_exploration(&id, request_id, false)
                    }
                }
            }
        }
    }
}
