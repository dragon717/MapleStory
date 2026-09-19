//! 怪物与掉落职责：生成、AI 步进、受击/仇恨、疾病判定、掉落与重生。
//!
//! 从 `world.rs` 机械搬出的第六块完整职责（超大文件治理 P2）。搬的是**代码位置**，
//! 不是数据布局：`Monster` / `MonsterTemplate` 等类型仍在 `world.rs`，
//! 协议、存档与 Tick 次序均未改变。
//!
//! ## 负责
//! - `MonsterTemplate` 的行为读取（身体矩形 / 移动力 / 站走窗口 / 技能效果）。
//! - 怪物生成：`spawn_configured_monsters` / `spawn_monster_on_map`（boss.rs 也复用）。
//! - 每 tick 怪物步进：`step_monsters` / `step_monster_with_force` / `step_monster_skills`、
//!   接触伤害 `apply_contact_damage`、受击入账 `commit_incoming_damage`（boss.rs 也复用）、
//!   重生 `respawn_monsters`。
//! - 掉落：`choose_drops` / `roll_drop_specs`（reactor 也复用后者）。
//! - 仇恨与疾病辅助：`mark_monster_hit_aggro` / `mob_skill_disease`。
//!
//! ## 不负责
//! - 疾病类型本身（`player_status::Disease` 枚举与免疫/抗性状态留在玩家侧）。
//! - 玩家移动与攻击结算（`step_player` / `resolve_pending_attacks` 留在 `world.rs`，
//!   它们调用本模块的仇恨与步进入口）。
//! - 掉落拾取与背包入包（`inventory_ops.rs`）。

use super::player_status::{mob_skill_effect, Disease, SkillEffect};
use super::*;

impl MonsterTemplate {
    pub(super) fn drops(&self) -> Vec<DropSpec> {
        self.drop.clone().map_or_else(Vec::new, DropInput::into_vec)
    }

    pub(super) fn body_bounds(&self, x: f64, y: f64) -> Option<(f64, f64, f64, f64)> {
        if let (Some(lt), Some(rb)) = (&self.hitbox_lt, &self.hitbox_rb) {
            return Some((x + lt.x, x + rb.x, y + lt.y, y + rb.y));
        }
        let width = self.hitbox_width?;
        let height = self.hitbox_height?;
        Some((x - width / 2.0, x + width / 2.0, y - height, y))
    }

    pub(super) fn movement_step(&self) -> Option<f64> {
        self.move_speed.map(|speed| speed * TICK_MS as f64 / 1000.0)
    }

    /// Raw Mob.wz `info/speed` -> the Mapleweb per-reference-tick horizontal
    /// force `(speed + 100) * 0.001` (Mob.cpp:197-199).
    ///
    /// The source node is optional and `None` here must not be read as "cannot
    /// move": `move_duration_ms` is the exported proof that this mob authored a
    /// `move` animation, so a mob without `speed` walks at the default offset
    /// exactly like the 541 mobs that write `0` explicitly.  Reading only
    /// `source_speed` froze 菇菇寶貝 (1210102, and its `info/link` twin 100004)
    /// in `stand` forever, because both own a three-frame `move` yet omit
    /// `speed`.  A non-positive force is the authored immobile form (`-100`),
    /// which must resolve to no `move` action at all rather than a mob that
    /// animates walking in place (or, below `-100`, creeps backwards).
    pub(super) fn movement_force(&self) -> Option<f64> {
        let speed = match (self.source_speed, self.move_duration_ms) {
            (Some(speed), _) => speed,
            (None, Some(_)) => MOB_DEFAULT_SPEED_OFFSET,
            (None, None) => return None,
        };
        let force = (speed + 100.0) * 0.001;
        (force > 0.0).then_some(force)
    }

    pub(super) fn can_move(&self) -> bool {
        self.movement_force().is_some() || self.movement_step().is_some_and(|step| step > 0.0)
    }

    pub(super) fn stand_delay(&self) -> u64 {
        self.stand_delay_ms
            .unwrap_or(MOB_DEFAULT_STAND_DELAY_MS)
            .max(1)
    }

    pub(super) fn move_duration(&self) -> u64 {
        self.move_duration_ms
            .unwrap_or(MOB_DEFAULT_MOVE_DURATION_MS)
            .max(1)
    }

    /// `Mob::update` waits for both animation end and `counter > 200` before
    /// calling `next_move`.  The source counter is represented by the
    /// calibrated 1700/1800 ms windows for the two authored Snail stances;
    /// custom animation metadata can only extend its corresponding window.
    pub(super) fn ai_decision_ms(&self, action: &str) -> u64 {
        match action {
            "stand" => MOB_STAND_DECISION_MS.max(self.stand_delay()),
            "move" => MOB_MOVE_DECISION_MS.max(self.move_duration()),
            _ => 0,
        }
    }

    /// Resolve the authored level's effect numbers for one authored skill.
    /// `Mob/<id>.img/info/skill` references a level; the exported `effects`
    /// map carries that level's `Skill/MobSkill/<id>.json` numbers.
    pub(super) fn skill_effect<'a>(
        &self,
        skill: &'a MonsterSkillTemplate,
    ) -> Option<&'a MonsterSkillEffect> {
        skill
            .effects
            .get(&skill.level.to_string())
            .or_else(|| skill.effects.values().next())
    }
}

fn random_monster_facing() -> i8 {
    if rand::thread_rng().gen_range(0..2) == 0 {
        -1
    } else {
        1
    }
}

/// Record a player's hit on a mob as an aggro request: remember the attacker,
/// refresh the pursue-withhold window, and cancel a return-home that is still
/// in progress.  Called only for real player attacks (not body contact, which
/// already has the mob on the player).  Taking `&mut Monster` keeps callers
/// free to use `self.monsters.get_mut` first without a self re-borrow.
pub(super) fn mark_monster_hit_aggro(monster: &mut Monster, attacker_id: &str, tick: u64) {
    monster.aggro_target = Some(attacker_id.to_owned());
    monster.aggro_until = tick.saturating_add(MOB_AGGRO_HOLD_TICKS);
    monster.returning_home = false;
}

impl World {
    pub(super) fn spawn_configured_monsters(&mut self) -> Result<(), String> {
        self.gameplay
            .validate()
            .map_err(|error| error.to_string())?;
        self.gameplay
            .validate_spawns_against_maps(&self.maps, &self.map.id)?;
        let spawns = self.gameplay.spawns.clone();
        for spawn in spawns {
            let map_id = if spawn.map_id.is_empty() {
                self.map.id.clone()
            } else {
                spawn.map_id.clone()
            };
            self.spawn_monster_on_map(map_id, spawn)?;
        }
        Ok(())
    }

    pub(super) fn spawn_monster_on_map(
        &mut self,
        map_id: String,
        spawn: MonsterSpawn,
    ) -> Result<(), String> {
        if self
            .monsters
            .values()
            .any(|monster| monster.map_id == map_id && monster.spawn.id == spawn.id)
        {
            return Ok(());
        }
        let Some(template) = self
            .gameplay
            .monsters
            .iter()
            .find(|template| template.template_id == spawn.template_id)
            .cloned()
        else {
            return Err(format!(
                "monster spawn {} references unknown template {}",
                spawn.id, spawn.template_id
            ));
        };
        let map = self.maps.get(&map_id).cloned().ok_or_else(|| {
            format!(
                "monster spawn {} references unknown map {}",
                spawn.id, map_id
            )
        })?;
        let foothold_id = spawn.foothold_id.or_else(|| {
            map.ground_near(spawn.x, spawn.y)
                .map(|(foothold_id, _)| foothold_id)
        });
        let (x, y) = foothold_id
            .and_then(|id| {
                map.get(id)
                    .and_then(|f| f.at(spawn.x).map(|y| (spawn.x, y)))
            })
            .ok_or_else(|| {
                format!(
                    "monster spawn {} has invalid foothold {} on map {}",
                    spawn.id,
                    spawn
                        .foothold_id
                        .map_or_else(|| "<inferred>".to_owned(), |id| id.to_string()),
                    map_id
                )
            })?;
        let monster_mp = template.max_mp.max(0);
        self.next_monster = self.next_monster.wrapping_add(1);
        let id = format!("monster-{}-{}", self.next_monster, auth::random_id());
        let can_move = template.can_move();
        self.monsters.insert(
            id.clone(),
            Monster {
                state: MonsterState {
                    id,
                    template_id: template.template_id.clone(),
                    x,
                    y,
                    // A controlled mob calls next_move immediately when it
                    // spawns in STAND.  For a movable Snail that is MOVE
                    // with a random source direction; immobile templates
                    // remain STAND.
                    facing: spawn.facing,
                    hp: template.max_hp,
                    max_hp: template.max_hp,
                    freeze_stacks: None,
                    action: if can_move { "move" } else { "stand" },
                    action_started_tick: self.tick,
                },
                map_id,
                template,
                spawn,
                foothold_id: foothold_id.unwrap_or(0),
                horizontal_speed: 0.0,
                mp: monster_mp,
                damage_by_player: BTreeMap::new(),
                // A freshly spawned mob has no memory of any prior attacker;
                // aggro only ever appears by taking a hit in this room.
                aggro_target: None,
                aggro_until: 0,
                returning_home: false,
                elemental_weaken_until: 0,
                freeze_until: 0,
                stun_until: 0,
                bind_until: 0,
                bind_immune_until: 0,
                bind_pd_rate_reduction: 0,
                bind_md_rate_reduction: 0,
                death_until: None,
                respawn_at: None,
                next_skill_tick: 0,
                knockback_pixels: 0.0,
            },
        );
        Ok(())
    }

    pub(super) fn choose_drops(
        &self,
        template: &MonsterTemplate,
        x: f64,
        y: f64,
        owner_id: &str,
        quests: &BTreeMap<String, String>,
    ) -> Vec<auth::DropRecord> {
        let specs: Vec<DropSpec> = template
            .drops()
            .into_iter()
            .filter(|spec| match spec.quest_id.as_deref() {
                None => true,
                Some(quest_id) => quests.get(quest_id).is_some_and(|state| state == "active"),
            })
            .collect();
        self.roll_drop_specs(&specs, x, y, owner_id)
    }

    /// Roll a drop table into concrete `DropRecord`s.  Shared by monster
    /// death and reactor use-up so the two produce drops with identical
    /// chance/quantity/ownership semantics — one roll rule, no drift.
    ///
    /// `chance` is a numerator over the runtime `dropChanceDenominator`; a
    /// spec without `chance` always drops.  `quantity_max` widens the amount
    /// into a uniform range.  Meso bundles use `item_id == "0"` and carry the
    /// meso count in `quantity`.
    pub(super) fn roll_drop_specs(
        &self,
        specs: &[DropSpec],
        x: f64,
        y: f64,
        owner_id: &str,
    ) -> Vec<auth::DropRecord> {
        let denominator = self.gameplay.drop_chance_denominator;
        let mut drops = Vec::new();
        for spec in specs {
            if spec.quantity == 0 {
                continue;
            }
            let eligible = match spec.chance {
                None => true,
                Some(chance) => denominator.is_some_and(|denominator| {
                    denominator > 0 && rand::thread_rng().gen_range(0..denominator) < chance
                }),
            };
            if !eligible {
                continue;
            }
            let id = format!("drop-{}", auth::random_id());
            let quantity = spec
                .quantity_max
                .filter(|max| *max >= spec.quantity)
                .map(|max| rand::thread_rng().gen_range(spec.quantity..=max))
                .unwrap_or(spec.quantity);
            // P: user-authorized drop floating — pin drops that land in
            // water to just below the surface so swimmers can reach them.
            let drop_y = self.map.water_float_y(x, y);
            drops.push(auth::DropRecord {
                id,
                item_id: spec.item_id.clone(),
                quantity,
                x,
                y: drop_y,
                owner_id: Some(owner_id.to_owned()),
                protected_until_ms: auth::now_ms() + auth::DROP_PROTECTION_MS,
                ..auth::DropRecord::default()
            });
        }
        drops
    }

    /// Advance one monster's authored abnormal-status skills.  A mob only
    /// casts while it has a live pursuit target; each cast advances
    /// `next_skill_tick` by the authored `interval` so it cannot spam.  Only
    /// the modelled disease-skills act (seal/stun/curse/poison/slow); buffs,
    /// heals and summons are source nodes this server leaves inert.
    ///
    /// Kept as its own method so the player-target and `inflict_disease`
    /// borrows never overlap the caller's mutable monster borrow.
    pub(super) fn step_monster_skills(&mut self, id: &str, map_id: &str) {
        let Some(snapshot) = self.monsters.get(id).map(|monster| {
            (
                monster.template.clone(),
                monster.state.id.clone(),
                monster.state.x,
                monster.state.y,
                monster.aggro_target.clone(),
                monster.aggro_until,
                monster.next_skill_tick,
            )
        }) else {
            return;
        };
        let (template, monster_id, monster_x, monster_y, aggro_target, aggro_until, next_tick) =
            snapshot;
        if self.tick < next_tick {
            return;
        }
        let Some(target_id) = aggro_target.filter(|_| self.tick <= aggro_until) else {
            return;
        };
        if template.skills.is_empty() {
            return;
        }
        let Some(target) = self
            .players
            .get(&target_id)
            .filter(|p| p.map_id == map_id && p.state.action != "dead" && p.state.hp > 0)
        else {
            return;
        };
        let target_x = target.state.x;
        let target_y = target.state.y;
        // Drop the target borrow before inflicting so `inflict_disease` can
        // take its own mutable borrow of the player map.
        let mut advanced = false;
        for skill in &template.skills {
            let Some((disease, duration_ms)) = mob_skill_disease(&template, skill) else {
                continue;
            };
            let Some(effect) = template.skill_effect(skill) else {
                continue;
            };
            // Cast chance (`prop`) and authored reach (`lt`/`rb`) gate the
            // hit.  A target outside the authored box is out of range; a
            // failed prop roll wastes the interval without inflicting.
            let in_range = match (effect.lt.as_ref(), effect.rb.as_ref()) {
                (Some(lt), Some(rb)) => {
                    let dx = target_x - monster_x;
                    let dy = target_y - monster_y;
                    dx >= lt.x && dx <= rb.x && dy >= lt.y && dy <= rb.y
                }
                _ => true,
            };
            let prop = effect.prop.unwrap_or(100).clamp(0, 100) as u64;
            let rolled = prop == 100
                || deterministic_percent(&[
                    &monster_id,
                    &target_id,
                    &skill.skill_id.to_string(),
                    &self.tick.to_string(),
                ]) < prop;
            if !in_range || !rolled {
                continue;
            }
            self.inflict_disease(&target_id, disease, duration_ms, &monster_id);
            advanced = true;
            // Advance the interval for the skill that fired (or was blocked)
            // so a mob cannot spam its debuff every tick.  Blocked casts still
            // spend the interval.
            let interval_ms = effect.interval.unwrap_or(10).max(0) as u64 * 1_000;
            let next = self.tick.saturating_add((interval_ms / TICK_MS).max(1));
            if let Some(monster) = self.monsters.get_mut(id) {
                monster.next_skill_tick = next;
                // Enter the authored cast pose so the client plays the mob's
                // skill/attack action for the same window the effect applies.
                monster.state.action = if skill.action == 2 {
                    "attack2"
                } else {
                    "skill1"
                };
                monster.state.action_started_tick = self.tick;
            }
            // Broadcast the cast so clients can play the source action and any
            // effect anchors.
            let event = serde_json::json!({
                "type": "monsterSkill",
                "eventId": format!("monster-skill-{monster_id}-{}", self.tick),
                "serverTick": self.tick,
                "monsterId": monster_id,
                "skillId": skill.skill_id,
                "action": skill.action,
                "effectAfterMs": skill.effect_after_ms,
                "targetId": target_id,
            })
            .to_string();
            self.broadcast_to_map(map_id, &event);
            // One cast per step: exit after the first skill that fired so a
            // multi-skill mob does not chain every authored node in a tick.
            break;
        }
        // If a mob has skills but none fired this step (all out of range or
        // blocked by prop), still advance the interval by the first skill's
        // cadence so it retries instead of stalling forever.
        if !advanced {
            if let (Some(skill), Some(effect)) = (
                template.skills.first(),
                template
                    .skills
                    .first()
                    .and_then(|s| template.skill_effect(s)),
            ) {
                let interval_ms = effect.interval.unwrap_or(10).max(0) as u64 * 1_000;
                let next = self.tick.saturating_add((interval_ms / TICK_MS).max(1));
                if let Some(monster) = self.monsters.get_mut(id) {
                    monster.next_skill_tick = next;
                }
                let _ = skill;
            }
        }
    }

    pub(super) fn step_monsters(&mut self) {
        let ids: Vec<String> = self.monsters.keys().cloned().collect();
        for id in ids {
            let map_id = self
                .monsters
                .get(&id)
                .map(|monster| monster.map_id.clone())
                .unwrap_or_else(|| self.map.id.clone());
            if auth::is_practice_map(&map_id) {
                // Practice Boss timing/control is advanced by the private
                // encounter state machine.  Generic mob AI must not move or
                // clear its source attack/guard action underneath it.
                continue;
            }
            let map = self.map_for(&map_id).clone();
            // Authored abnormal-status skill casting is advanced before the
            // `get_mut` below so it never holds the monster's mutable borrow
            // while resolving the player target (a second `self` borrow).
            self.step_monster_skills(&id, &map_id);
            let Some(monster) = self.monsters.get_mut(&id) else {
                continue;
            };
            if monster.state.hp <= 0 {
                continue;
            }
            // 击退位移**在任何状态分支之前**结算：命中那一刻只登记了「该退多少」，
            // 而只有这里同时握着地图与 foothold 链。放在最前面是为了不被后面
            // 冻结 / 眩晕 / 绑定的 `continue` 吞掉——登记过就该退，退多远由地图决定。
            if monster.knockback_pixels != 0.0 {
                step_monster_knockback(&map, monster);
            }
            if monster.bind_until <= self.tick {
                // Armor melting ends with the bind even when its separate
                // 90-second resistance is still active.
                monster.bind_pd_rate_reduction = 0;
                monster.bind_md_rate_reduction = 0;
            }
            if monster.bind_until > self.tick {
                monster.state.action = "hit";
                monster.horizontal_speed = 0.0;
                continue;
            }
            if monster.stun_until > self.tick {
                monster.state.action = "hit";
                monster.horizontal_speed = 0.0;
                continue;
            }
            if monster.freeze_until > self.tick {
                monster.state.action = "freeze";
                monster.horizontal_speed = 0.0;
                continue;
            }
            if monster.state.freeze_stacks.is_some() {
                monster.state.freeze_stacks = None;
                monster.freeze_until = 0;
                if monster.state.action == "freeze" {
                    monster.state.action = if monster.template.can_move() {
                        "move"
                    } else {
                        "stand"
                    };
                    monster.state.action_started_tick = self.tick;
                }
            }
            let can_move = monster.template.can_move();
            // ---- Aggro / pursuit resolution (server-authoritative) ----
            // Each step a mob re-checks its target once.  A target stays
            // pursueable only while it is still alive on the same map AND
            // within the leash radius of the spawn point AND its last hit is
            // still inside the hold window; break any part and the mob forgets
            // (記恨 lost) and walks back home.  `pursuit` resolves to the
            // facing needed to close on the target or return to spawn, or
            // `None` to fall back to the idle stand/move wander below.
            let pursuit: Option<i8> = if !can_move {
                None
            } else {
                let mobile_target = monster
                    .aggro_target
                    .as_deref()
                    .filter(|_| self.tick <= monster.aggro_until)
                    .and_then(|target| self.players.get(target))
                    .filter(|player| {
                        player.map_id == monster.map_id
                            && player.state.action != "dead"
                            && player.state.hp > 0
                            && {
                                let dx = player.state.x - monster.spawn.x;
                                let dy = player.state.y - monster.spawn.y;
                                dx.hypot(dy) <= MOB_AGGRO_LEASH
                            }
                    });
                if mobile_target.is_none() && monster.aggro_target.take().is_some() {
                    // Interest broke (離脫): the walk home flips on now and a
                    // later hit can flip it back off via mark_monster_hit_aggro.
                    monster.returning_home = true;
                }
                if let Some(target) = mobile_target {
                    monster.returning_home = false;
                    Some(if monster.state.x < target.state.x {
                        1
                    } else {
                        -1
                    })
                } else if monster.returning_home {
                    let dx = monster.spawn.x - monster.state.x;
                    if dx.abs() <= MOB_HOME_RADIUS {
                        // Back on the spawn point: resume idle behaviour.
                        monster.returning_home = false;
                        None
                    } else {
                        Some(if dx < 0.0 { -1 } else { 1 })
                    }
                } else {
                    None
                }
            };
            if monster.state.action == "hit" {
                let recovery_ticks = MOB_HIT_RECOVERY_MS.div_ceil(TICK_MS);
                if self.tick.saturating_sub(monster.state.action_started_tick) < recovery_ticks {
                    continue;
                }
                // Mob::next_move() treats HIT like STAND: a movable mob
                // immediately enters MOVE with a random direction.
                monster.state.action = if can_move { "move" } else { "stand" };
                if can_move {
                    monster.state.facing = random_monster_facing();
                } else {
                    monster.horizontal_speed = 0.0;
                }
                monster.state.action_started_tick = self.tick;
            }

            if monster.state.action == "stand" {
                if !can_move {
                    continue;
                }
                if let Some(direction) = pursuit {
                    // A live target / a pending return-home should not linger
                    // in idle stand: close on it immediately.
                    monster.state.action = "move";
                    monster.state.facing = direction;
                    monster.state.action_started_tick = self.tick;
                } else {
                    let elapsed_ms = self
                        .tick
                        .saturating_sub(monster.state.action_started_tick)
                        .saturating_mul(TICK_MS);
                    if elapsed_ms < monster.template.ai_decision_ms("stand") {
                        continue;
                    }
                    // Mob::next_move(): STAND -> MOVE and randomize direction.
                    monster.state.action = "move";
                    monster.state.facing = random_monster_facing();
                    monster.state.action_started_tick = self.tick;
                }
            }

            if monster.state.action == "move" {
                if !can_move {
                    monster.state.action = "stand";
                    monster.state.action_started_tick = self.tick;
                    monster.horizontal_speed = 0.0;
                    continue;
                }
                if let Some(direction) = pursuit {
                    // Pursuing a target or returning home: keep pressing the
                    // same direction every step, ignoring the wander timer.
                    monster.state.action = "move";
                    monster.state.facing = direction;
                    monster.state.action_started_tick = self.tick;
                } else {
                    let elapsed_ms = self
                        .tick
                        .saturating_sub(monster.state.action_started_tick)
                        .saturating_mul(TICK_MS);
                    if elapsed_ms >= monster.template.ai_decision_ms("move") {
                        // Mob::next_move(): MOVE -> random 0(STAND), 1(MOVE
                        // left), or 2(MOVE right).  Snail has no JUMP action in
                        // its WZ metadata, so the 25% canjump branch is absent.
                        match rand::thread_rng().gen_range(0..3) {
                            0 => {
                                monster.state.action = "stand";
                                monster.horizontal_speed = 0.0;
                            }
                            1 => {
                                monster.state.action = "move";
                                monster.state.facing = -1;
                            }
                            _ => {
                                monster.state.action = "move";
                                monster.state.facing = 1;
                            }
                        }
                        monster.state.action_started_tick = self.tick;
                        if monster.state.action == "stand" {
                            continue;
                        }
                    }
                }
            }

            if let Some(force) = monster.template.movement_force() {
                step_monster_with_force(&map, monster, force);
                continue;
            }
            let Some(step) = monster.template.movement_step() else {
                continue;
            };
            if step <= 0.0 {
                continue;
            }
            // Mapleweb receives a server-selected movement stance/direction.
            // During pursuit (`pursuit.is_some()`) the facing was fixed by the
            // aggro block above to walk toward the target or home; otherwise
            // the walk continues in the current authoritative facing until a
            // linked foothold wall turns it around.
            let direction = if monster.state.facing < 0 { -1 } else { 1 };
            let current_x = monster.state.x;
            let next_x = current_x + direction as f64 * step;
            let wall = map.wall_for(monster.foothold_id, direction < 0, monster.state.y);
            let blocked = if direction < 0 {
                current_x >= wall && next_x <= wall
            } else {
                current_x <= wall && next_x >= wall
            };
            if blocked {
                monster.state.facing = -direction;
                continue;
            }
            let next_x = next_x.clamp(map.bounds.x_min, map.bounds.x_max);
            let Some(current) = map.get(monster.foothold_id) else {
                monster.state.x = next_x;
                monster.state.facing = direction;
                monster.state.action = "move";
                continue;
            };
            if current.contains_x(next_x) {
                monster.state.x = next_x;
                monster.state.y = current.at(next_x).unwrap_or(monster.state.y);
                monster.state.facing = direction;
                monster.state.action = "move";
            } else {
                monster.state.facing = -direction;
            }
        }
    }

    /// Commit incoming player damage through the same profile transaction used
    /// by contact hits and Boss practice attacks.  The runtime state is only
    /// changed after SQLite accepts the candidate, so a persistence failure
    /// cannot leave the client damaged while the profile still has old HP/MP.
    pub(super) fn commit_incoming_damage(
        &mut self,
        id: &str,
        raw_damage_after_weapon_defense: i64,
    ) -> Option<(i64, i64, bool)> {
        let Some(snapshot) = self.players.get(id).map(|player| {
            (
                player.state.clone(),
                player.death_id.clone(),
                player.base_max_mp,
                player.magic_guard,
                player.contact_invulnerable_until,
                player.channel_until,
                player.channel_skill_id,
            )
        }) else {
            return None;
        };
        if snapshot.0.action == "dead"
            || snapshot.0.hp <= 0
            || snapshot.4 > self.tick
            || (snapshot.5 > self.tick && snapshot.6 == Some(SKILL_ICE_DRAGON_BREATH))
        {
            return None;
        }
        let shield_level = snapshot
            .0
            .skills
            .get(&SKILL_MAGIC_SHIELD)
            .copied()
            .unwrap_or(0);
        let shield_bonus = self
            .mage_skills
            .level(SKILL_MAGIC_SHIELD, shield_level)
            .and_then(|level| level.pdd_x)
            .unwrap_or(0)
            .max(0);
        let barrier_percent = self
            .players
            .get(id)
            .filter(|player| hyper_barrier_active(player))
            .map(|_| 20_i64)
            .unwrap_or(0);
        let barrier_damage = (raw_damage_after_weapon_defense.max(1) as i128
            * i128::from(100_i64.saturating_sub(barrier_percent.clamp(0, 100)))
            / 100)
            .max(1) as i64;
        // Thunder's sustained channel is damageable, unlike Ice Dragon's
        // source q-window.  It halves incoming damage and keeps the channel
        // from being interrupted by contact/boss damage.
        let channel_damage = if snapshot.5 > self.tick && snapshot.6 == Some(SKILL_HYPER_THUNDER) {
            (barrier_damage as i128 * 50 / 100).max(1) as i64
        } else {
            barrier_damage
        };
        let reduced_damage = channel_damage.saturating_sub(shield_bonus).max(1);
        let guard_level = snapshot
            .0
            .skills
            .get(&SKILL_MAGIC_GUARD)
            .copied()
            .unwrap_or(0);
        // 用户指定规则（2026-09-12）：受伤的 99% 由护罩接下、转由 MP 承受，逐级的
        // 「MP 抵偿率」决定接下部分里多少真能被魔力化去；化不去的差额由护盾消解，
        // 既不扣 HP 也不扣 MP。未被接下的那 1% 始终落回 HP。
        // 未启用魔心防禦时整段不生效：伤害全由 HP 承担。
        // 整数一律向下取整，乘法走 i128 避免溢出。
        let (mp_damage, hp_damage) = if snapshot.3 {
            let guard_price = self
                .mage_skills
                .level(SKILL_MAGIC_GUARD, guard_level)
                .and_then(|level| level.mp_substitute_percent)
                .unwrap_or(0)
                .clamp(0, 100);
            let covered_damage =
                reduced_damage as i128 * i128::from(MAGIC_GUARD_COVERED_PERCENT) / 100;
            let intended_mp = (covered_damage * i128::from(guard_price) / 100)
                .clamp(0, i128::from(reduced_damage));
            // 魔力不足时，欠缺的部分回落 HP（技能窗文案的承诺）。
            let mp = intended_mp.min(snapshot.0.mp.max(0) as i128) as i64;
            let mp_shortfall = (intended_mp - i128::from(mp)).max(0);
            // 未被接下的那 1% 始终由 HP 承担。
            let hp = (reduced_damage as i128 * i128::from(100 - MAGIC_GUARD_COVERED_PERCENT) / 100
                + mp_shortfall)
                .clamp(0, i128::from(reduced_damage)) as i64;
            (mp, hp)
        } else {
            (0, reduced_damage)
        };
        let mut candidate = snapshot.0.clone();
        candidate.mp = candidate.mp.saturating_sub(mp_damage).max(0);
        candidate.hp = candidate.hp.saturating_sub(hp_damage).max(0);
        let killed = candidate.hp == 0;
        let death_id = if killed {
            auth::random_id()
        } else {
            snapshot.1.clone()
        };
        if let Some(store) = self.store.as_ref() {
            let map_id = self
                .players
                .get(id)
                .map(|player| player.map_id.clone())
                .unwrap_or_default();
            let mut persisted_state = candidate.clone();
            if auth::is_practice_map(&map_id) {
                let source_map = self.map_for(BOSS_PRACTICE_FALLBACK_MAP_ID).clone();
                let mut x = candidate
                    .x
                    .clamp(source_map.bounds.x_min, source_map.bounds.x_max);
                let mut y = candidate
                    .y
                    .clamp(source_map.bounds.y_min, source_map.bounds.y_max);
                if let Some((_, ground)) = source_map.ground_near(x, y) {
                    y = ground;
                } else {
                    x = source_map.spawn.x;
                    y = source_map
                        .ground_near(x, source_map.spawn.y)
                        .map(|(_, ground)| ground)
                        .unwrap_or(source_map.spawn.y);
                }
                persisted_state.x = x;
                persisted_state.y = y;
            }
            let profile = profile_from_state(&persisted_state, &map_id, &death_id, snapshot.2);
            if let Err(error) = store.save_profile(id, &profile) {
                self.send_reject(id, "persistence", &error, None);
                return None;
            }
        }
        let Some(player) = self.players.get_mut(id) else {
            return None;
        };
        player.state = candidate;
        player.death_id = death_id;
        player.contact_invulnerable_until = self.tick
            + self
                .gameplay
                .player
                .contact_invulnerability_ms
                .unwrap_or(0)
                .div_ceil(TICK_MS)
                .max(1);
        if killed {
            player.state.action = "dead";
            player.state.action_started_tick = self.tick;
            player.state.action_id = None;
            player.swimming = false;
            player.natural_recovery_next_tick =
                self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
            player.state.climbing = false;
            player.state.ladder_id = None;
            player.attack_until = 0;
            player.magic_guard = false;
            clear_beginner_buffs(player);
            player.ice_teleport_enabled = false;
            player.ice_fields.clear();
            player.teleport_mastery_enabled = false;
            player.teleport_boost_enabled = false;
            player.adaptation_active = false;
            player.adaptation_charges = 0;
            player.summon = None;
            player.knockback_vx = 0.0;
            player.knockback_until = 0;
            // 死亡即下马、即起立（这里是唯一能当场收口的地方：`player` 已经是
            // `&mut` 借用，`self.dismount(&id)` 会撞借用检查器）。死后的快照因此
            // 不会再带着 `mount` / `chair`，客户端不需要靠 action 反推。
            player.mount = None;
            player.chair = None;
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        } else {
            if snapshot.6 != Some(SKILL_HYPER_THUNDER) {
                player.attack_until = 0;
                player.state.action_id = None;
            }
        }
        if killed {
            // 原创扩展「死亡世界」：正式死亡后留一座墓碑（练习图/实例图不落，
            // 见 death_world.rs）。放在借用结束之后调用，不影响上面的收口；
            // death_id 此时已落到 player 上，从权威处读回。
            let death_id = self
                .players
                .get(id)
                .map(|player| player.death_id.clone())
                .unwrap_or_default();
            self.spawn_death_tombstone(id, &death_id);
        }
        Some((hp_damage, mp_damage, killed))
    }

    pub(super) fn apply_contact_damage(&mut self) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        for id in ids {
            let Some(player) = self.players.get(&id) else {
                continue;
            };
            if player.state.action == "dead"
                || self.tick < player.contact_invulnerable_until
                || (player.channel_until > self.tick
                    && player.channel_skill_id == Some(SKILL_ICE_DRAGON_BREATH))
            {
                // Ice Dragon Breath's q-window is a sourced self-invincible
                // channel; Hyper Thunder remains damageable but halves
                // damage and resists the contact knockback below.
                continue;
            }
            let map_id = player.map_id.clone();
            if auth::is_practice_map(&map_id) {
                // The private Boss state machine owns its source attack
                // windows; generic body contact must not add a second hit.
                continue;
            }
            let hit = self
                .monsters
                .values()
                .filter(|monster| {
                    if monster.map_id != map_id
                        || monster.state.hp <= 0
                        || !monster.template.body_attack
                        || monster.template.pa_damage.is_none()
                    {
                        return false;
                    }
                    let Some((mob_left, mob_right, mob_top, mob_bottom)) = monster
                        .template
                        .body_bounds(monster.state.x, monster.state.y)
                    else {
                        return false;
                    };
                    // Mapleweb's collision probe uses the player's current
                    // movement span and a -50..0 body rectangle.
                    player.state.x >= mob_left
                        && player.state.x <= mob_right
                        && player.state.y - 50.0 <= mob_bottom
                        && player.state.y >= mob_top
                })
                .min_by(|a, b| {
                    (a.state.x - player.state.x)
                        .abs()
                        .total_cmp(&(b.state.x - player.state.x).abs())
                })
                .and_then(|monster| {
                    monster.template.pa_damage.map(|damage| {
                        (
                            monster.state.id.clone(),
                            monster.state.x,
                            damage.max(1),
                            monster.template.body_disease,
                            monster.template.body_disease_level,
                        )
                    })
                });
            let Some((monster_id, monster_x, raw_damage, body_disease, body_disease_level)) = hit
            else {
                continue;
            };
            let stance_prop = self
                .players
                .get(&id)
                .and_then(|player| player.state.skills.get(&SKILL_MASTER_MAGIC))
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_MASTER_MAGIC, level))
                .and_then(|level| level.stance_prop)
                .unwrap_or(0)
                .clamp(0, 100) as u64;
            // 承伤防御是**装备侧**的 `weapon_defense`（`incPDD`）：魔力之盾的 `pddX`
            // 由 `commit_incoming_damage` 在内部再减一次（`shield_bonus`），所以这里
            // **不能**用聚合的 `defense()`——它已含 `pddX`，会变成同一击扣两次。
            // 面板口径（含 pddX）与实战抵偿总量因此仍是一致的，只是拆在两处。
            // 承伤防御是**装备侧**的 `weapon_defense`（`incPDD`）：魔力之盾的 `pddX`
            // 由 `commit_incoming_damage` 在内部再减一次（`shield_bonus`），所以这里
            // **不能**用聚合的 `defense()`——它已含 `pddX`，会变成同一击扣两次。
            // 面板口径（含 pddX）与实战抵偿总量因此仍是一致的，只是拆在两处。
            let defense = self
                .gameplay
                .player
                .with_ability_stats(
                    &player.state.ability_stats,
                    &player.state.equipped,
                    player.state.job,
                )
                .weapon_defense
                .unwrap_or(0)
                .max(0);
            let Some((hp_damage, mp_damage, killed)) =
                self.commit_incoming_damage(&id, raw_damage.saturating_sub(defense).max(1))
            else {
                continue;
            };
            if !killed {
                let Some(player) = self.players.get_mut(&id) else {
                    continue;
                };
                let hyper_thunder_channel = player.channel_until > self.tick
                    && player.channel_skill_id == Some(SKILL_HYPER_THUNDER);
                if hyper_thunder_channel {
                    // The sustained Hyper channel keeps its action and lock;
                    // the damage transaction above already applied its 50%
                    // reduction and the hit must not add a knockback hop.
                } else {
                    // Body hit: interrupt the current attack and start the
                    // knockback hop.  The body leaves its foothold with a small
                    // upward launch plus a short horizontal push away from the
                    // monster centre, both scaled by tenacity.  step_player owns
                    // the ballistic arc and stands the player again on landing;
                    // clients render the white flash from the damage event below
                    // and follow the authoritative position from snapshots.
                    //
                    // 受击同时结束骑乘与坐姿：击退把身体抛出立足点，两者都挂在
                    // 「站着/骑着的那块地」上（专题文档的结束条件矩阵）。
                    mounts::dismount(player, self.tick, "contact_hit");
                    chairs::stand_up(player, self.tick, "contact_hit");
                    player.attack_until = 0;
                    player.state.action_id = None;
                    if player.state.climbing {
                        player.state.climbing = false;
                        player.state.ladder_id = None;
                    }
                    let resists_knockback = stance_prop > 0
                        && deterministic_percent(&[
                            &id,
                            &monster_id,
                            &self.tick.to_string(),
                            "teleport-mastery-stance",
                        ]) < stance_prop;
                    if resists_knockback {
                        player.state.action = if player.state.grounded {
                            "stand"
                        } else {
                            "jump"
                        };
                        player.state.action_started_tick = self.tick;
                    } else {
                        player.state.grounded = false;
                        player.foothold_id = 0;
                        player.drop_fh = 0;
                        let away = if player.state.x >= monster_x {
                            1.0
                        } else {
                            -1.0
                        };
                        let tenacity = self
                            .gameplay
                            .player
                            .tenacity
                            .unwrap_or(0.0)
                            .clamp(0.0, TENACITY_CAP);
                        let factor = 1.0 - tenacity;
                        player.knockback_vx = away * KNOCKBACK_SPEED * factor;
                        player.knockback_until = self.tick + KNOCKBACK_TICKS;
                        player.state.vy = -KNOCKBACK_JUMP * factor;
                        player.state.action = "jump";
                        player.state.action_started_tick = self.tick;
                    }
                }
            }
            // Contact disease (`info/bodyDisease`).  The mob's body touch can
            // also inflict a disease on top of the damage; the id is resolved
            // through the same MapleDisease space and honours the same defence
            // layers.  Only modelled diseases apply.
            if !killed {
                if let Some(disease) = body_disease.and_then(Disease::from_mob_skill_id) {
                    let level = body_disease_level.unwrap_or(1).max(1);
                    // P: no per-level disease duration is exported; the contact
                    // window is a fixed adapter value scaled by the source level.
                    let duration_ms = MOB_DISEASE_CONTACT_BASE_MS.saturating_mul(level as u64);
                    self.inflict_disease(&id, disease, duration_ms, &monster_id);
                }
            }

            let damage_event = serde_json::json!({
                "type": "damageEvent",
                "eventId": format!("damage-event-contact-{}-{}", id, self.tick),
                "serverTick": self.tick,
                "attackerId": monster_id,
                "targetId": id,
                "x": self.players.get(&id).map(|player| player.state.x).unwrap_or(monster_x),
                "y": self.players.get(&id).map(|player| player.state.y).unwrap_or(0.0),
                "damage": hp_damage,
                "mpDamage": mp_damage,
                "killed": killed,
            })
            .to_string();
            self.pending_attacks
                .retain(|_, attack| attack.player_id != id);
            self.broadcast_to_map(&map_id, &damage_event);
        }
    }

    pub(super) fn respawn_monsters(&mut self) {
        // MapManager only updates maps that currently have players.  Keep a
        // finished death pending while its own map is empty; the next
        // occupied cycle can then recreate it with a fresh object id.
        let occupied_maps: BTreeSet<String> = self
            .players
            .values()
            .map(|player| player.map_id.clone())
            .collect();
        if occupied_maps.is_empty() {
            return;
        }
        let remove: Vec<String> = self
            .monsters
            .iter()
            .filter_map(|(id, monster)| {
                if !occupied_maps.contains(&monster.map_id) {
                    return None;
                }
                monster
                    .death_until
                    .is_some_and(|death_until| {
                        // The map-wide Cosmic respawn task only asks a map to
                        // refill eligible spawn points.  A dead mob still
                        // has to finish its die animation before it can be
                        // replaced; the two gates are independent.
                        self.tick >= death_until
                            && monster
                                .respawn_at
                                .is_none_or(|respawn_at| self.tick >= respawn_at)
                    })
                    .then_some(id.clone())
            })
            .collect();
        for id in remove {
            let Some(monster) = self.monsters.remove(&id) else {
                continue;
            };
            if monster.respawn_at.is_some() {
                self.spawn_monster_on_map(monster.map_id, monster.spawn)
                    .expect("validated monster spawn became invalid");
            }
        }
    }
}

/// Resolve a MobSkill id plus its authored level effect into the disease and
/// the duration it should apply for.
///
/// 「这个源 id 算不算疾病」不再由注释或另一张名单决定：它走
/// [`mob_skill_effect`] 的处置表，所以**没建模的那几个 id 也有名字与理由**，
/// 而不是落进 `None` 的静默黑洞。门禁 `check_tms273_player_status.cjs` 对着
/// 真实内容逐 id 重算这张表（名单过期要失败）。
pub(super) fn mob_skill_disease(
    template: &MonsterTemplate,
    skill: &MonsterSkillTemplate,
) -> Option<(Disease, u64)> {
    let disease = match mob_skill_effect(skill.skill_id) {
        SkillEffect::Disease(disease) => disease,
        // 源里属于 MapleDisease、本仓库没建模：如实不放，理由登记在表里。
        SkillEffect::Unmodelled(_) => return None,
        // 怪物自身的增益 / 召唤 / 治疗，本来就不是玩家疾病。
        SkillEffect::NotADisease => return None,
    };
    let effect = template.skill_effect(skill)?;
    // Debuff skills author `time` in seconds.  Seal uses `x` (ms) as its
    // hold length instead of `time`; Slow uses `x` as the move percent but
    // still authors a `time`.  Normalise to milliseconds.
    let duration_ms = match disease {
        Disease::Seal => effect.x.unwrap_or(0).max(0) as u64,
        _ => effect.time.unwrap_or(0).max(0) as u64 * 1_000,
    };
    (duration_ms >= MOB_SKILL_MIN_DISEASE_MS).then_some((disease, duration_ms))
}

/// 登记一次击退：本次命中的伤害达到了源 `info/pushed` 的阈值时，把怪物标记成
/// 「该沿远离攻击者的方向退开 `MOB_KNOCKBACK_PIXELS`」。
///
/// 只登记、不位移。位移要沿 foothold 走并可能撞墙，那需要地图与段链，只有
/// `step_monsters` 拿得到；那里在怪物步进的**最开头**结算，早于冻结/眩晕/绑定的
/// `continue`，所以登记过就一定会退。
///
/// 阈值缺失按「推不动」处理——凭空给 0 会造出一条比源更强的规则（源里 `0` 的语义
/// 恰恰是「任何伤害都能击退」）。已经打死（`hp == 0`）的怪也不再退：它马上要播
/// 死亡动作，位置不该再动。`from_x` 是攻击者位置，拿不到时同样不登记——宁可少退
/// 一次，也不凭空挑一个方向。
pub(super) fn register_monster_knockback(monster: &mut Monster, damage: i64, from_x: Option<f64>) {
    if damage <= 0 || monster.state.hp <= 0 {
        return;
    }
    let Some(threshold) = monster.template.pushed else {
        return;
    };
    if damage < threshold {
        return;
    }
    let Some(from_x) = from_x else {
        return;
    };
    let direction = if monster.state.x >= from_x { 1.0 } else { -1.0 };
    monster.knockback_pixels = MOB_KNOCKBACK_PIXELS * direction;
}

/// 把登记好的击退位移一次走完。
///
/// 沿当前 foothold 直线退开：目标点仍在同一段上就整体移动，越出段边界则停在边界
/// ——**不跨段、不换段**。击退是一步之内的表现，跨段会牵出「掉下平台 / 撞墙掉头」
/// 一整套决策，那属于常规移动，不该由击退顺带触发。
fn step_monster_knockback(map: &Map, monster: &mut Monster) {
    let distance = std::mem::take(&mut monster.knockback_pixels);
    monster.horizontal_speed = 0.0;
    let Some(foothold) = map.get(monster.foothold_id) else {
        monster.state.x = (monster.state.x + distance).clamp(map.bounds.x_min, map.bounds.x_max);
        return;
    };
    let target_x = (monster.state.x + distance).clamp(map.bounds.x_min, map.bounds.x_max);
    let clamped = if distance > 0.0 {
        target_x.min(foothold.right())
    } else {
        target_x.max(foothold.left())
    };
    monster.state.x = clamped;
    monster.state.y = foothold.at(clamped).unwrap_or(monster.state.y);
}

pub(super) fn step_monster_with_force(map: &Map, monster: &mut Monster, force: f64) {
    // Mapleweb Physics.cpp on a flat foothold: hacc = force -
    // (FRICTION + SLOPEFACTOR) * hspeed / GROUNDSLIP. Keep its 8 ms
    // integration step and use a short fractional step for the final 2 ms
    // of this server's 50 ms tick.
    const FRICTION: f64 = 0.3;
    const SLOPE_FACTOR: f64 = 0.1;
    const GROUND_SLIP: f64 = 3.0;
    let mut remaining = TICK_MS as f64;
    while remaining > 0.0 {
        let slice = remaining.min(REFERENCE_TICK_MS);
        let ratio = slice / REFERENCE_TICK_MS;
        let direction = if monster.state.facing < 0 { -1.0 } else { 1.0 };
        let acceleration =
            force * direction - (FRICTION + SLOPE_FACTOR) * monster.horizontal_speed / GROUND_SLIP;
        monster.horizontal_speed += acceleration * ratio;
        let mut distance = monster.horizontal_speed * ratio;
        if distance.abs() <= f64::EPSILON {
            remaining -= slice;
            continue;
        }

        // A source physics step can cross more than one very short segment.
        // Keep consuming the same distance through linked continuous
        // footholds instead of treating every `contains_x` boundary as a
        // wall.  The guard is only defensive for malformed cyclic map data.
        let mut transitions = 0;
        while distance.abs() > f64::EPSILON {
            transitions += 1;
            if transitions > map.footholds.len().max(1) {
                monster.horizontal_speed = 0.0;
                remaining = 0.0;
                break;
            }
            let travel_direction = if distance < 0.0 { -1 } else { 1 };
            let Some(current) = map.get(monster.foothold_id) else {
                monster.state.x =
                    (monster.state.x + distance).clamp(map.bounds.x_min, map.bounds.x_max);
                monster.state.action = "move";
                distance = 0.0;
                continue;
            };
            if current.is_wall() {
                monster.horizontal_speed = 0.0;
                monster.state.facing = -travel_direction;
                remaining = 0.0;
                break;
            }

            let edge = if travel_direction > 0 {
                current.right()
            } else {
                current.left()
            };
            let wall = map.wall_for(monster.foothold_id, travel_direction < 0, monster.state.y);
            let current_left = current.left();
            let current_right = current.right();
            let stop = if wall >= current_left - 0.001 && wall <= current_right + 0.001 {
                wall
            } else {
                edge
            };
            let to_stop = stop - monster.state.x;
            let reaches_stop = if travel_direction > 0 {
                distance >= to_stop - 0.001
            } else {
                distance <= to_stop + 0.001
            };
            if !reaches_stop {
                let next_x = monster.state.x + distance;
                monster.state.x = next_x;
                monster.state.y = current.at(next_x).unwrap_or(monster.state.y);
                monster.state.action = "move";
                distance = 0.0;
                continue;
            }

            // Consume the part of this reference step up to the edge/wall.
            monster.state.x = stop;
            monster.state.y = current.at(stop).unwrap_or(monster.state.y);
            distance -= to_stop;
            if (stop - edge).abs() > 0.001 {
                // A vertical chain neighbour reached the body span: this is
                // an actual wall, so turn at it and discard the remainder.
                monster.horizontal_speed = 0.0;
                monster.state.facing = -travel_direction;
                remaining = 0.0;
                break;
            }

            let next_id = map
                .contiguous_neighbor(monster.foothold_id, travel_direction)
                .map(|next| next.id);
            let Some(next_id) = next_id else {
                // No continuous prev/next segment means a real chain end.
                monster.horizontal_speed = 0.0;
                monster.state.facing = -travel_direction;
                remaining = 0.0;
                break;
            };
            monster.foothold_id = next_id;
            // The shared endpoint is valid on both segments.  The next loop
            // applies the remaining distance and updates the slope y.
        }
        remaining -= slice;
    }
}
