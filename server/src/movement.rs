//! 玩家移动模拟（tick 热路径）。
//!
//! 负责：`step_player`——每 tick 的权威移动（输入去重、走/跳/落/下跳、爬绳、
//! 链墙与外 wall 碰撞、水域浮力、坠落边界回收），以及其落点辅助
//! （`land_at_ladder_top` / `recover_at_fall_boundary` / `reset_player_to_spawn` /
//! `detach_at_ladder_end`）。
//! 不负责：地形几何判定本体（`geometry.rs` 的 `Map` / `Foothold` / `Ladder` 方法）、
//! 怪物移动（`monsters.rs`）、命令入口与输入去重窗口的建立（`commands.rs`）。
//! 接线：自由函数裸名调用靠 `world.rs` 的 `use self::movement::*;` 恢复，
//! 并经各兄弟子模块与 tests 的 `use super::*;` 透传（auth/db.rs 同模式）。

use super::*;

pub(super) fn step_player(map: &Map, gameplay: &Gameplay, player: &mut Player, tick: u64) {
    if player.last_input.elapsed() > Duration::from_millis(500) {
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
    }
    if player.state.action == "dead" {
        return;
    }
    // Stun locks the body: no walk, no jump, and the body is held in place
    // until the deadline passes.  It is applied here, in the authoritative
    // movement step, so a stunned body cannot be moved by a held key.
    if player.stun_until > tick {
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        player.state.vx = 0.0;
        return;
    }
    if player.channel_until > tick {
        // Ice Dragon Breath owns the body for its q-window.  Holding the
        // channel must not let residual jump velocity or a stale input packet
        // move the authoritative position.
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        player.state.vx = 0.0;
        player.state.vy = 0.0;
        player.state.action = "attack";
        player.state.action_started_tick = tick;
        return;
    }

    // Knockback hop set by a monster's contact hit: while the body is airborne
    // the server keeps the horizontal push instead of honouring walk/jump
    // input.  Landing ends the hop immediately; the tick window is only an
    // upper guard for hops that leave the map.  `knockback_active` stays in
    // scope for the horizontal override and the final action decision.
    if player.state.grounded && player.knockback_until > 0 {
        player.knockback_until = 0;
        player.knockback_vx = 0.0;
    }
    let knockback_active = tick < player.knockback_until && player.knockback_vx != 0.0;
    if knockback_active {
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        if player.state.climbing {
            // Defensive only: the contact hit already detaches climbing bodies.
            player.state.climbing = false;
            player.state.ladder_id = None;
            player.state.grounded = false;
            player.foothold_id = 0;
        }
    }

    // Keep the source current-foothold handle before climbing, jumping, or
    // stepping over an authored edge clears the active foothold id.
    if player.state.grounded {
        if let Some(current) = map.get(player.foothold_id) {
            if !current.is_wall() {
                player.last_foothold_id = current.id;
            }
        }
    }
    if player.fall_boundary_hold {
        if player.vertical != 0 || player.jump {
            player.fall_boundary_hold = false;
        } else {
            // A held horizontal key is suppressed until the command path
            // observes a neutral release packet.
            player.direction = 0;
        }
    }

    if player.swimming && !knockback_active {
        if let Some(water) = map.water_at(player.state.x, player.state.y).cloned() {
            if player.jump {
                // Jump while swimming is a stroke upward.  Clearing
                // `swimming` unconditionally made the key unusable
                // underwater: the body popped out of the rectangle with full
                // land-jump speed and fell straight back in, so the player
                // could never actually rise.  The body now stays in the water
                // and rises; only when the stroke carries it to the surface
                // does it leave the water on the normal ballistic path, which
                // is what lets a player climb out onto a bank.
                //
                // `SWIM_JUMP_SPEED` is a P value: no TMS273 source number for
                // an in-water jump impulse was found, so it is tuned to lift
                // the body a useful distance per press.
                const SWIM_JUMP_SPEED: f64 = 260.0;
                const SURFACE_EXIT_MARGIN: f64 = 4.0;
                let surface = water.y_min;
                let body_at_surface = player.state.y <= surface + SURFACE_EXIT_MARGIN;
                if body_at_surface {
                    // Explicit swim-to-land transition at the surface: leave
                    // the rectangle and let the normal path find a bank.
                    player.swimming = false;
                    player.state.grounded = false;
                    player.state.climbing = false;
                    player.state.ladder_id = None;
                    player.state.vy = -JUMP_SPEED;
                    player.foothold_id = 0;
                    player.last_foothold_id = 0;
                    player.drop_fh = 0;
                    player.vertical = 0;
                    if tick >= player.attack_until {
                        player.state.action_id = None;
                        player.state.action = "jump";
                        player.state.action_started_tick = tick;
                    }
                    return;
                }
                player.state.vy = -SWIM_JUMP_SPEED;
                player.state.grounded = false;
                player.state.climbing = false;
                player.state.ladder_id = None;
                player.foothold_id = 0;
                player.drop_fh = 0;
                player.vertical = 0;
                player.state.y = (player.state.y + player.state.vy * (TICK_MS as f64 / 1000.0))
                    .clamp(water.y_min, water.floor_at(player.state.x));
                if player.state.y <= water.y_min {
                    player.state.vy = 0.0;
                }
                player.jump = false;
                if tick >= player.attack_until {
                    player.state.action_id = None;
                    if player.state.action != "jump" {
                        player.state.action_started_tick = tick;
                    }
                    player.state.action = "jump";
                }
                return;
            } else {
                const SWIM_SPEED: f64 = 140.0;
                player.state.vx = player.direction as f64 * SWIM_SPEED;
                player.state.vy = player.vertical as f64 * SWIM_SPEED;
                if player.direction != 0 {
                    player.state.facing = player.direction;
                }
                player.state.x = (player.state.x + player.state.vx * (TICK_MS as f64 / 1000.0))
                    .clamp(water.x_min, water.x_max);
                player.state.y = (player.state.y + player.state.vy * (TICK_MS as f64 / 1000.0))
                    .clamp(water.y_min, water.floor_at(player.state.x));
                if player.state.x <= water.x_min || player.state.x >= water.x_max {
                    player.state.vx = 0.0;
                }
                if player.state.y <= water.y_min || player.state.y >= water.floor_at(player.state.x)
                {
                    player.state.vy = 0.0;
                }
                player.state.grounded = false;
                player.state.climbing = false;
                player.state.ladder_id = None;
                player.foothold_id = 0;
                player.drop_fh = 0;
                player.jump = false;
                if tick >= player.attack_until {
                    player.state.action_id = None;
                    if player.state.action != "jump" {
                        player.state.action_started_tick = tick;
                    }
                    // No dedicated swimming sprite is part of the current
                    // avatar contract; keep the existing jump pose.
                    player.state.action = "jump";
                }
                return;
            }
        } else {
            player.swimming = false;
        }
    }

    if player.state.climbing {
        if player.jump && player.direction != 0 {
            player.jump = false;
            player.state.climbing = false;
            player.state.ladder_id = None;
            player.state.vx = player.direction as f64 * player.move_speed * 8.0;
            player.state.vy = -JUMP_SPEED / 1.5;
            player.state.grounded = false;
            player.drop_fh = 0;
            player.state.action = "jump";
            player.state.action_started_tick = tick;
            return;
        } else {
            player.state.vx = 0.0;
            player.state.vy =
                player.vertical as f64 * gameplay.player.climb_speed.unwrap_or(0.0).max(0.0);
            player.state.y += player.state.vy * (TICK_MS as f64 / 1000.0);
            let ladder = player
                .state
                .ladder_id
                .and_then(|id| map.ladders.iter().find(|ladder| ladder.id == id));
            if let Some(ladder) = ladder {
                if player.state.y <= ladder.top() {
                    if ladder.allows_top_exit() && player.vertical <= 0 {
                        if let Some((foothold_id, ground)) = map.ladder_top_ground(ladder) {
                            land_at_ladder_top(player, ladder, foothold_id, ground, tick);
                        } else if player.vertical < 0 {
                            // There is no authored foothold at this end. Keep
                            // the source endpoint behaviour and let normal
                            // falling resolve the map rather than inventing a
                            // platform or an offset.
                            player.state.y = ladder.top();
                            detach_at_ladder_end(player, ladder, true, tick);
                        } else {
                            player.state.y = ladder.top();
                            player.state.vy = 0.0;
                            player.state.action = ladder.action();
                        }
                    } else {
                        // A forbidden top (uf=0), or a downwards input at the
                        // top of an allowed ladder, remains fixed on the
                        // ladder.  In particular, Down+horizontal input must
                        // not pass through this boundary.
                        player.state.y = ladder.top();
                        player.state.vy = 0.0;
                        player.state.action = ladder.action();
                    }
                } else if player.state.y >= ladder.bottom() {
                    player.state.y = ladder.bottom();
                    if player.vertical > 0 {
                        detach_at_ladder_end(player, ladder, false, tick);
                    } else {
                        player.state.vy = 0.0;
                        player.state.action = ladder.action();
                    }
                } else {
                    player.state.action = ladder.action();
                }
            } else {
                player.state.climbing = false;
                player.state.ladder_id = None;
            }
            player.jump = false;
            return;
        }
    }

    if !knockback_active && !player.state.climbing && player.vertical != 0 {
        if let Some(ladder) = map.ladder_for(player.state.x, player.state.y, player.vertical < 0) {
            player.state.x = ladder.x;
            player.state.y = player.state.y.clamp(ladder.top(), ladder.bottom());
            player.state.vx = 0.0;
            player.state.vy = 0.0;
            player.state.grounded = false;
            player.state.climbing = true;
            player.state.ladder_id = Some(ladder.id);
            player.state.action = ladder.action();
            player.state.action_started_tick = tick;
            player.jump = false;
            return;
        }
    }

    let old_x = player.state.x;
    let old_y = player.state.y;
    let mut ignored_fh = player.drop_fh;
    if player.state.grounded {
        let down_jump_intent = player.vertical > 0 && player.jump;
        let down_jump = down_jump_intent
            && (map
                .downjump_target(player.foothold_id, player.state.x)
                .is_some()
                || map.water_below(player.foothold_id, player.state.x));
        if down_jump {
            // Match the v83 down-jump sequence: leave the current foothold by
            // one pixel, then use the short upward hop while ignoring that
            // foothold until the body has passed it.
            if let Some(current) = map.get(player.foothold_id) {
                player.state.y = current.at(player.state.x).unwrap_or(player.state.y) - 1.0;
            }
            player.drop_fh = player.foothold_id;
            ignored_fh = player.drop_fh;
            player.state.vy = -DOWNJUMP_LAUNCH;
            player.state.grounded = false;
            player.foothold_id = 0;
        } else if !down_jump_intent && player.jump {
            player.state.vy = -JUMP_SPEED;
            player.state.grounded = false;
            player.foothold_id = 0;
            player.drop_fh = 0;
        }
    }
    player.jump = false;
    // Slow (缓速) scales the walk speed while it lasts.  MobSkill `x` carries
    // the authored move percent (e.g. 85 keeps 85% of normal speed); the
    // runtime folds it into the walk so a slowed body genuinely lags rather
    // than only displaying a marker.
    let slow_factor = if player.slow_until > tick {
        // P: no per-source slow percent is re-read here; 50% is the adapter
        // stand-in for the unmodelled `x` denominator until a slow skill is
        // actually wired onto a placed mob.
        0.5
    } else {
        1.0
    };
    player.state.vx = if knockback_active {
        // Body-hit slide: keep the authoritative push even when the player
        // holds the opposite direction key.
        player.knockback_vx
    } else {
        player.direction as f64 * player.move_speed * slow_factor
    };
    if player.direction != 0 {
        player.state.facing = player.direction;
    }
    // Airborne jumps inherit the same chain-neighbour side wall check as
    // grounded walking: the previous step left the body at the edge of its
    // stable foothold, and the next reachable segment on that chain (e.g. an
    // ascending platform step) is the same hazard that walking already
    // blocks. Fall back to `last_foothold_id` when the jump cleared the
    // active id so the body cannot tunnel horizontally across the platform
    // edge it just left. Only physical chain walls block the jump — the
    // FootholdTree `outer_wall` fallback must not pin the body at the
    // take-off point because the next falling sweep intentionally leaves
    // that authored edge to recover past the map fall boundary.
    let chain_anchor = if player.state.grounded || player.foothold_id != 0 {
        player.foothold_id
    } else {
        player.last_foothold_id
    };
    let intended_x = player.state.x + player.state.vx * (TICK_MS as f64 / 1000.0);
    let projected_vy = (player.state.vy + GRAVITY * (TICK_MS as f64 / 1000.0)).min(FALL_SPEED);
    let water_entry_ahead = map
        .water_entry(
            old_x,
            intended_x,
            player.state.y,
            player.state.y + projected_vy * (TICK_MS as f64 / 1000.0),
        )
        .is_some();
    // Test the wall where the body actually reaches the wall plane, not at the
    // tick-start foot position: a fast fall can cross the plane after dropping
    // past the wall top inside a single tick, which the point-only test
    // tunnels straight through.
    let swept_y = player.state.y + projected_vy * (TICK_MS as f64 / 1000.0);
    let chain_wall =
        (!water_entry_ahead && player.state.vx != 0.0 && chain_anchor != 0).then(|| {
            map.chain_wall_on_sweep(
                chain_anchor,
                player.state.vx < 0.0,
                player.state.x,
                intended_x,
                player.state.y,
                swept_y,
            )
        });
    if let Some(Some(wall)) = chain_wall {
        let crossed = if player.state.vx < 0.0 {
            player.state.x >= wall && intended_x <= wall
        } else {
            player.state.x <= wall && intended_x >= wall
        };
        player.state.x = if crossed { wall } else { intended_x };
        if crossed {
            player.state.vx = 0.0;
        }
    } else {
        player.state.x = intended_x;
    }
    player.state.x = player.state.x.clamp(map.bounds.x_min, map.bounds.x_max);

    if player.state.grounded {
        let current = map.get(player.foothold_id);
        let next_id = current.and_then(|f| {
            if player.state.x > f.right() + 0.001 {
                Some(f.next)
            } else if player.state.x < f.left() - 0.001 {
                Some(f.prev)
            } else {
                Some(f.id)
            }
        });
        if let Some(next_id) = next_id.filter(|id| *id != 0) {
            if let Some(next) = map.get(next_id) {
                if let Some(ground) = next.at(player.state.x) {
                    let travel_direction = if player.state.x >= old_x { 1 } else { -1 };
                    let continuous = map
                        .contiguous_neighbor(player.foothold_id, travel_direction)
                        .is_some_and(|neighbor| neighbor.id == next.id);
                    if next.id != player.foothold_id && ground > old_y + 1.0 && !continuous {
                        player.state.grounded = false;
                    } else {
                        player.foothold_id = next.id;
                        player.state.y = ground;
                        player.state.vy = 0.0;
                    }
                } else {
                    player.state.grounded = false;
                }
            } else {
                player.state.grounded = false;
            }
        } else {
            player.state.grounded = false;
        }
        if !player.state.grounded {
            // The player has deliberately left the current foothold at an
            // authored edge. Do not let the falling sweep re-land at its
            // t=0 endpoint; the source physics likewise advances to a new
            // below foothold after leaving the current one.
            ignored_fh = player.foothold_id;
            player.foothold_id = 0;
        }
    }
    if !player.state.grounded {
        let next_vy = (player.state.vy + GRAVITY * (TICK_MS as f64 / 1000.0)).min(FALL_SPEED);
        if tick < player.slow_fall_until {
            // P: the hidden companion's source v=95 is treated as the
            // downward-speed cap for its time window.  魔力波动 itself now
            // uses the same cap so the float is visible on the casted skill.
            player.state.vy = next_vy.min(MAGIC_WAVE_SLOW_FALL_SPEED);
        } else {
            player.slow_fall_until = 0;
            player.state.vy = next_vy;
        }
        let next_y = player.state.y + player.state.vy * (TICK_MS as f64 / 1000.0);
        if player.state.vy >= 0.0 {
            if let Some((water_x, water_y)) =
                map.water_entry(old_x, player.state.x, player.state.y, next_y)
            {
                player.state.x = water_x;
                player.state.y = water_y;
                player.state.vx = 0.0;
                player.state.vy = 0.0;
                player.state.grounded = false;
                player.swimming = true;
                player.foothold_id = 0;
                player.last_foothold_id = 0;
                player.fall_boundary_hold = false;
                player.drop_fh = 0;
            } else if let Some((foothold_id, landing_x, ground)) =
                map.landing_on_sweep(old_x, player.state.x, player.state.y, next_y, ignored_fh)
            {
                player.state.x = landing_x;
                player.state.y = ground;
                player.state.vy = 0.0;
                player.state.grounded = true;
                player.swimming = false;
                player.foothold_id = foothold_id;
                player.last_foothold_id = foothold_id;
                player.drop_fh = 0;
            } else {
                player.state.y = next_y;
            }
        } else {
            player.state.y = next_y;
        }
        if !player.swimming && player.state.vy >= 0.0 && player.state.y > map.fall_boundary() {
            recover_at_fall_boundary(map, player, tick);
        }
        if player.state.y < map.bounds.y_min {
            player.state.y = map.bounds.y_min;
            player.state.vy = player.state.vy.max(0.0);
        }
    }
    if tick >= player.attack_until {
        player.state.action_id = None;
        let action = if knockback_active {
            // Knockback hop pose: airborne bodies show the jump frames and
            // stand again on the tick they land; no walk cycle is played.
            if player.state.grounded {
                "stand"
            } else {
                "jump"
            }
        } else if player.state.climbing {
            player
                .state
                .ladder_id
                .and_then(|id| map.ladders.iter().find(|ladder| ladder.id == id))
                .map_or("climb", Ladder::action)
        } else if !player.state.grounded {
            "jump"
        } else if player.state.vx != 0.0 {
            "walk"
        } else {
            "stand"
        };
        if player.state.action != action {
            player.state.action_started_tick = tick;
        }
        player.state.action = action;
    }
}

pub(super) fn land_at_ladder_top(
    player: &mut Player,
    ladder: &Ladder,
    foothold_id: u64,
    ground: f64,
    tick: u64,
) {
    player.state.x = ladder.x;
    player.state.y = ground;
    player.state.vx = 0.0;
    player.state.vy = 0.0;
    player.state.grounded = true;
    player.foothold_id = foothold_id;
    player.last_foothold_id = foothold_id;
    player.fall_boundary_hold = false;
    player.drop_fh = 0;
    player.state.climbing = false;
    player.state.ladder_id = None;
    player.state.action = "stand";
    player.state.action_started_tick = tick;
}

pub(super) fn recover_at_fall_boundary(map: &Map, player: &mut Player, tick: u64) {
    // HeavenClient's Footholdtree::update_fh first restores a retained,
    // non-wall current foothold at the lower border, clamping x to that
    // authored segment.  The active server fhid is intentionally cleared
    // during a jump/down-jump, so use the internal last id for that source
    // current-fh semantics.  A stale or wall id falls back to the authored
    // spawn support.
    if let Some(foothold) = map
        .get(player.last_foothold_id)
        .filter(|foothold| !foothold.is_wall())
    {
        let x = player.state.x.clamp(foothold.left(), foothold.right());
        if let Some(ground) = foothold.at(x) {
            player.state.x = x;
            player.state.y = ground;
            player.state.vx = 0.0;
            player.state.vy = 0.0;
            player.state.grounded = true;
            player.foothold_id = foothold.id;
            player.last_foothold_id = foothold.id;
            player.state.climbing = false;
            player.state.ladder_id = None;
            player.fall_boundary_hold = true;
            player.drop_fh = 0;
            player.direction = 0;
            player.vertical = 0;
            player.jump = false;
            player.state.action = "stand";
            player.state.action_started_tick = tick;
            return;
        }
    }
    reset_player_to_spawn(map, player, tick);
}

pub(super) fn reset_player_to_spawn(map: &Map, player: &mut Player, tick: u64) {
    let spawn_ground = map.ground_near(map.spawn.x, map.spawn.y);
    player.state.x = map.spawn.x;
    player.state.y = spawn_ground.map_or(map.spawn.y, |(_, ground)| ground);
    player.state.vx = 0.0;
    player.state.vy = 0.0;
    player.state.grounded = spawn_ground.is_some();
    player.foothold_id = spawn_ground.map_or(0, |(foothold_id, _)| foothold_id);
    player.last_foothold_id = player.foothold_id;
    player.fall_boundary_hold = true;
    player.state.climbing = false;
    player.state.ladder_id = None;
    player.drop_fh = 0;
    player.direction = 0;
    player.vertical = 0;
    player.jump = false;
    player.swimming = false;
    player.state.action = if player.state.grounded {
        "stand"
    } else {
        "jump"
    };
    player.state.action_started_tick = tick;
}

pub(super) fn detach_at_ladder_end(player: &mut Player, ladder: &Ladder, top: bool, tick: u64) {
    let y = if top { ladder.top() } else { ladder.bottom() };
    // Mapleweb's PlayerClimbState cancels the fixed ladder state at the
    // endpoint; normal foothold resolution on the next frame decides whether
    // the feet land. It does not teleport to the nearest unrelated platform.
    player.state.x = ladder.x;
    player.state.y = y;
    player.state.grounded = false;
    player.foothold_id = 0;
    player.state.climbing = false;
    player.state.ladder_id = None;
    player.state.vy = 0.0;
    player.state.action = "jump";
    player.state.action_started_tick = tick;
}