//! 通讯职责：地图聊天（`chatMessage`）、密语（`whisperMessage`）与聊天表情（`emoticonMessage`）。
//!
//! 从 `world.rs` 机械搬出的第一块完整职责（超大文件治理 P2 试点）。搬的是**代码位置**，
//! 不是数据布局：所有 `Player` / `World` 字段仍在原处，协议、存档与 Tick 次序均未改变。
//!
//! ## 负责
//! - 三个聊天面的**入站校验与广播**：房间（发送者当前地图）、正文策略、来源身份、tick
//! - 三套**有界幂等窗口**：同一 `requestId` 重放不回放第二次，同 id 不同内容判冲突
//! - 两套**速率预算**：地图聊天/密语共用一个令牌桶；表情用源自己的 `ChatLimit` 滑动窗口
//! - 黑名单在**服务端扇出处**生效，改版客户端无法自行选择重新听见被屏蔽的人
//!
//! ## 不负责
//! - 连接与认证、快照生成、持久化（三者都不在此文件）
//! - `Player` 上的字段定义、`World` 上的字段定义与构造（状态所有者仍是 `world.rs`）
//! - 好友名录解析本身：`resolve_friend_name` 属于好友职责，本模块只是调用者
//!
//! ## 公开面
//! 只有三个入口是 `pub(super)`（`world.rs` 的命令分派需要调用）：
//! `handle_chat` / `handle_whisper` / `handle_emoticon`。
//! 其余辅助函数保持模块私有；5 个策略常量是 `pub(super)`，因为 `world.rs` 的加入流程与
//! `*_acceptance.rs` 会引用它们。
//!
//! **留在 `world.rs` 的东西**：`EmoticonCatalogue` / `EmoticonLimit` 两个源数据形状。
//! 它们是 `Gameplay.emoticons`（公开字段）的**类型**，搬进私有子模块会让公开接口引用更窄
//! 可见的类型（E0446），而绕开它要么放宽本模块可见性、要么引入循环 glob——两者都是为了
//! 形式对称而支付的净损失。配置形状与配置留在原处，行为搬走，这个切分是可解释的。
//!
//! ## 状态所有者
//! `World`（`chat_sequence` / `whisper_sequence` / `emoticon_sequence` / `emoticon_ids`）
//! 与 `Player`（`chat_recent` / `chat_tokens` / `chat_bucket_tick` / `whisper_recent` /
//! `emoticon_recent` / `emoticon_sends`）。本模块只是这些状态的**唯一写入路径之一**。
//!
//! ## 依赖方向
//! 只依赖祖先模块 `world`（`use super::*`）、`crate::protocol` 与 `tokio::sync::mpsc`。
//! 不依赖网络实现、数据库或文件 I/O。
//!
//! ## 测试入口
//! `chat_acceptance.rs`(6) / `whisper_acceptance.rs`(10) / `emoticon_acceptance.rs`(6)
//! 经 `include!` 进入 `world.rs` 的 `mod tests`，经 `use super::messaging::*;` 取用本模块的常量。
//!
//! ## 代码位置
//! 挂载方式沿用仓库既有先例（同目录兄弟模块 + `#[path]`）：
//! `world.rs` 中 `#[path = "messaging.rs"] mod messaging;`，与实际路径 `server/src/messaging.rs` 一致。

use super::*;

/// Map-chat rate limit (per character): burst of 5 with a 1 token/second
/// refill.  Chat_ops plan §10.3 defaults; a sender cannot re-establish the
/// allowance by switching maps or reconnecting because the bucket lives on
/// the authoritative Player row.
pub(super) const CHAT_TOKEN_BURST: u32 = 5;
pub(super) const CHAT_TOKEN_REFILL_PER_SEC: u32 = 1;
/// Per-session chat request-id idempotency window (bounded; §9.1 ephemeral).
pub(super) const CHAT_RECENT_WINDOW: usize = 64;

/// Per-session whisper (密語) idempotency window, bounded like the chat one.
/// A whisper is ephemeral and has no durable record, so this window only
/// protects the common network retry; it is not what makes a replay safe.
pub(super) const WHISPER_RECENT_WINDOW: usize = 32;

/// Per-session chat-emoticon idempotency window, bounded like the other two.
/// An emoticon is ephemeral and has no durable record, so this only protects
/// the common network retry from broadcasting the head animation twice.
pub(super) const EMOTICON_RECENT_WINDOW: usize = 32;

impl World {
    /// Map public chat (P1-C04).  The client submits only a ChatSend intent;
    /// the authoritative room (current map), author identity and display name
    /// are all resolved here.  Control flow stays inside the world tick and
    /// every outbound write is a bounded try_send, so a slow reader or a
    /// spammer cannot stall gameplay on another map or another player.
    pub(super) fn handle_chat(&mut self, id: String, request_id: String, text: String) {
        // 1. Room: the sender's current authoritative map.  The client cannot
        //    widen the audience — protocol parsing denies unknown fields, so a
        //    forged map/channel/realm field never reaches this function.
        let map_id = match self.players.get(&id) {
            Some(player) => player.map_id.clone(),
            None => return,
        };
        // 2. Text policy before any bookkeeping.
        if !crate::protocol::valid_chat_text(&text) {
            let _ = self.chat_reject(
                &id,
                &request_id,
                "invalid_chat_text",
                "消息为空、过长或包含不允许的字符。",
            );
            return;
        }
        let text = text.trim().to_owned();
        // 3. Bounded per-session idempotency (§9.1/§9.2): a retry with the
        //    same request id and body never re-broadcasts; the same id with a
        //    different body is rejected as a conflict.
        enum Duplicate {
            Replay,
            Conflict,
        }
        let duplicate = {
            let Some(player) = self.players.get_mut(&id) else {
                return;
            };
            let mut duplicate = None;
            for (seen_id, seen_text) in player.chat_recent.iter() {
                if seen_id == &request_id {
                    duplicate = Some(if seen_text == &text {
                        Duplicate::Replay
                    } else {
                        Duplicate::Conflict
                    });
                    break;
                }
            }
            if duplicate.is_none() {
                if player.chat_recent.len() >= CHAT_RECENT_WINDOW {
                    player.chat_recent.pop_front();
                }
                player
                    .chat_recent
                    .push_back((request_id.clone(), text.clone()));
            }
            duplicate
        };
        match duplicate {
            Some(Duplicate::Replay) => return,
            Some(Duplicate::Conflict) => {
                let _ = self.chat_reject(
                    &id,
                    &request_id,
                    "idempotency_conflict",
                    "重复请求使用了不同的内容。",
                );
                return;
            }
            None => {}
        }
        // 4. Rate limit: burst 5, refill 1/s.  The bucket lives on the
        //    authoritative Player row, so map changes cannot reset it.
        if !self.chat_consume_token(&id) {
            let _ = self.chat_reject(
                &id,
                &request_id,
                "chat_rate_limited",
                "发言太快，请稍后再试。",
            );
            return;
        }
        // 5. Immutable message fact; the server is the only author.
        self.chat_sequence += 1;
        let message_id = format!("chat-{id}-{}", self.chat_sequence);
        let (author_id, author_name) = match self.players.get(&id) {
            Some(player) => (player.state.id.clone(), player.state.username.clone()),
            None => return,
        };
        let common = serde_json::json!({
            "type": "chatMessage",
            "messageId": message_id,
            "mapId": map_id,
            "authorId": author_id,
            "authorName": author_name,
            "text": text,
            "occurredAtTick": self.tick,
        });
        let mut sender_payload = common.clone();
        sender_payload["requestId"] = serde_json::Value::String(request_id);
        let sender_payload = sender_payload.to_string();
        let peer_payload = common.to_string();
        // 6. Ephemeral fan-out to the current map-room membership.  A full
        //    bounded outbox drops this best-effort message instead of blocking
        //    the tick; the sender merges its own echo by request id.
        let recipients: Vec<(String, mpsc::Sender<String>)> = self
            .players
            .iter()
            .filter(|(player_id, player)| {
                player.map_id == map_id
                    // A blocked sender's map chat never reaches the blocker.
                    // The filter sits at fan-out rather than in the client, so
                    // a modified build cannot opt back into hearing somebody
                    // it blacklisted.  The sender always gets its own echo.
                    && (**player_id == id || !player.blocked.contains(&id))
            })
            .map(|(player_id, player)| (player_id.clone(), player.output.clone()))
            .collect();
        for (player_id, output) in recipients {
            let payload = if player_id == id {
                &sender_payload
            } else {
                &peer_payload
            };
            let _ = output.try_send(payload.clone());
        }
    }

    /// Whisper (密語): one character talks to one other character.
    ///
    /// This is the missing half of the chat module — map chat is a *room* fact
    /// derived from the sender's map, while a whisper is a *pair* fact resolved
    /// from a typed name.  Everything the client is not allowed to decide is
    /// decided here:
    ///
    ///   * who the typed name belongs to (`resolve_friend_name`, the same
    ///     authoritative lookup the friend and party modules use);
    ///   * whether the pair may talk at all (self, offline, either blacklist);
    ///   * the message body, id and timestamp — the server is the only author;
    ///   * the rate budget, shared with map chat because a whisper is still
    ///     one outgoing line of chat.
    ///
    /// A whisper is session-routed only: it is delivered to a character that is
    /// currently in the world and never stored.  There is deliberately no
    /// offline inbox — pretending to queue a message we cannot later deliver
    /// would be inventing a feature the source does not back.
    pub(super) fn handle_whisper(
        &mut self,
        id: String,
        request_id: String,
        target_name: String,
        text: String,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        // 1. Body policy, before any bookkeeping.  Same rule as map chat so a
        //    whisper cannot smuggle a layout/control payload past the reader.
        if !crate::protocol::valid_chat_text(&text) {
            self.whisper_reject(
                &id,
                &request_id,
                "invalid_chat_text",
                "消息为空、过长或包含不允许的字符。",
            );
            return;
        }
        let text = text.trim().to_owned();
        let typed_name = target_name.trim().to_owned();
        // 2. Resolve the typed name into an identity.  A whisper is addressed
        //    to a character, never to an id, so this is the same authoritative
        //    lookup the friend and party modules use.
        let target_id = match self.resolve_friend_name(&typed_name) {
            Some(target_id) => target_id,
            None => {
                self.whisper_reject(
                    &id,
                    &request_id,
                    "whisper_unknown_player",
                    "找不到这个名字的角色。",
                );
                return;
            }
        };
        if target_id == id {
            self.whisper_reject(&id, &request_id, "whisper_self", "不能给自己发密语。");
            return;
        }
        // 3. Idempotency, keyed by (request id, resolved target, text).  A
        //    retry re-sends the sender's own echo from the recorded fact and
        //    stays silent to the recipient — the recipient already has the
        //    message and must never receive it twice.  The same id with a
        //    different body is a conflict.
        let mut replay = None;
        let mut conflict = false;
        if let Some(player) = self.players.get_mut(&id) {
            for (seen_id, seen_target, seen_text) in player.whisper_recent.iter() {
                if seen_id == &request_id {
                    if *seen_target == target_id && seen_text == &text {
                        replay = Some(seen_text.clone());
                    } else {
                        conflict = true;
                    }
                    break;
                }
            }
        } else {
            return;
        }
        if conflict {
            self.whisper_reject(
                &id,
                &request_id,
                "idempotency_conflict",
                "重复请求使用了不同的内容。",
            );
            return;
        }
        if let Some(recorded_text) = replay {
            self.whisper_echo(&id, &request_id, &target_id, &recorded_text, true);
            return;
        }
        // 4. Presence.  A whisper is routed to a live session; there is no
        //    offline inbox, so "not in the world right now" is a reported
        //    outcome rather than a queued message.
        let Some(target) = self.players.get(&target_id) else {
            self.whisper_reject(&id, &request_id, "whisper_offline", "对方当前不在线。");
            return;
        };
        // 5. Blacklist, both directions.  A blocked sender must not be able to
        //    reach the blocker by switching to a different chat surface, and a
        //    player who blocked somebody should not be able to talk to them
        //    either — the block is a statement about the pair, not about the
        //    channel.
        let target_blocked_sender = target.blocked.contains(&id);
        let sender_blocked_target = self
            .players
            .get(&id)
            .is_some_and(|sender| sender.blocked.contains(&target_id));
        if target_blocked_sender {
            self.whisper_reject(&id, &request_id, "whisper_blocked", "对方已把你加入黑名单。");
            return;
        }
        if sender_blocked_target {
            self.whisper_reject(&id, &request_id, "whisper_ignored", "你已把对方加入黑名单。");
            return;
        }
        // 6. Rate limit — the shared chat bucket, so whispering is not a way
        //    around the map-chat limit.
        if !self.chat_consume_token(&id) {
            self.whisper_reject(&id, &request_id, "chat_rate_limited", "发言太快，请稍后再试。");
            return;
        }
        // 7. Immutable message fact; the server is the only author.
        if let Some(player) = self.players.get_mut(&id) {
            if player.whisper_recent.len() >= WHISPER_RECENT_WINDOW {
                player.whisper_recent.pop_front();
            }
            player
                .whisper_recent
                .push_back((request_id.clone(), target_id.clone(), text.clone()));
        }
        self.whisper_sequence += 1;
        let message_id = format!("whisper-{id}-{}", self.whisper_sequence);
        let (author_id, author_name, target_name) = {
            let Some(sender) = self.players.get(&id) else {
                return;
            };
            let Some(target) = self.players.get(&target_id) else {
                return;
            };
            (
                sender.state.id.clone(),
                sender.state.username.clone(),
                target.state.username.clone(),
            )
        };
        let common = serde_json::json!({
            "type": "whisperMessage",
            "messageId": message_id,
            "fromId": author_id,
            "fromName": author_name,
            "toId": target_id,
            "toName": target_name,
            "text": text,
            "occurredAtTick": self.tick,
        });
        // The sender's echo carries the request id so a pending line can be
        // merged instead of duplicated; the recipient's copy never needs it.
        let mut sender_payload = common.clone();
        sender_payload["requestId"] = serde_json::Value::String(request_id);
        let sender_payload = sender_payload.to_string();
        let peer_payload = common.to_string();
        // 8. Two-party fan-out.  A full outbox drops the message instead of
        //    blocking the tick, exactly as map chat does.
        if let Some(target) = self.players.get(&target_id) {
            let _ = target.output.try_send(peer_payload);
        }
        if let Some(sender) = self.players.get(&id) {
            let _ = sender.output.try_send(sender_payload);
        }
    }

    /// Re-send one recorded whisper to its sender only, used when a network
    /// retry replays a request id.  `recorded` is the text stored with the id,
    /// so a replay can never change what was said.
    fn whisper_echo(
        &self,
        id: &str,
        request_id: &str,
        target_id: &str,
        text: &str,
        replay: bool,
    ) {
        let (Some(sender), Some(target)) = (self.players.get(id), self.players.get(target_id))
        else {
            return;
        };
        let mut payload = serde_json::json!({
            "type": "whisperMessage",
            "messageId": format!("whisper-{id}-replay-{request_id}"),
            "fromId": sender.state.id,
            "fromName": sender.state.username,
            "toId": target.state.id,
            "toName": target.state.username,
            "text": text,
            "occurredAtTick": self.tick,
            "replay": replay,
        });
        payload["requestId"] = serde_json::Value::String(request_id.to_owned());
        let _ = sender.output.try_send(payload.to_string());
    }

    fn whisper_reject(&self, id: &str, request_id: &str, code: &str, message: &str) -> bool {
        match self.players.get(id) {
            Some(player) => player
                .output
                .try_send(reject(code, message, Some(request_id)))
                .is_ok(),
            None => false,
        }
    }

    /// Best-effort private rejection to one sender.  A full outbox drops the
    /// reply; ephemeral chat never blocks on it.
    fn chat_reject(&self, id: &str, request_id: &str, code: &str, message: &str) -> bool {
        match self.players.get(id) {
            Some(player) => player
                .output
                .try_send(reject(code, message, Some(request_id)))
                .is_ok(),
            None => false,
        }
    }

    /// Lazy token-bucket consume for map chat: refill 1 token/second up to
    /// burst 5, driven purely by the authoritative tick for deterministic
    /// tests (no wall clock dependency).
    fn chat_consume_token(&mut self, id: &str) -> bool {
        let Some(player) = self.players.get_mut(id) else {
            return false;
        };
        let ticks_per_second = 1_000 / TICK_MS;
        let elapsed = self.tick.saturating_sub(player.chat_bucket_tick);
        let whole_seconds = elapsed / ticks_per_second;
        if whole_seconds > 0 {
            player.chat_bucket_tick = self.tick - elapsed % ticks_per_second;
            player.chat_tokens = (player.chat_tokens
                + whole_seconds as u32 * CHAT_TOKEN_REFILL_PER_SEC)
                .min(CHAT_TOKEN_BURST);
        }
        if player.chat_tokens == 0 {
            return false;
        }
        player.chat_tokens -= 1;
        true
    }

    /// Chat emoticon (表情貼圖) — the third chat surface, and the only one whose
    /// payload is not free text: the client submits one catalogue id and the
    /// server owns everything else.
    ///
    ///   * the id must exist in the exported `UI/ChatEmoticon.img` table, so a
    ///     modified client cannot push an arbitrary key into other clients'
    ///     renderers;
    ///   * the send budget is the source's own `ChatLimit` and lives on the
    ///     authoritative `Player` row, so changing map or reconnecting cannot
    ///     refill it;
    ///   * the room, the author identity and the tick are derived here — none of
    ///     them is on the wire — so a sticker can never be shown as somebody
    ///     else or into a map its author is not standing in;
    ///   * the fan-out honours the blacklist at the server, exactly like map
    ///     chat, so a modified client cannot opt back into seeing a character it
    ///     blocked.
    ///
    /// Control flow stays inside the world tick and every outbound write is a
    /// bounded `try_send`, so a spammer cannot stall gameplay anywhere else.
    pub(super) fn handle_emoticon(&mut self, id: String, request_id: String, emoticon_id: String) {
        // 1. Room: the sender's current authoritative map, exactly as chat does
        //    it.  A forged map/channel field never reaches this function
        //    because protocol parsing denies unknown fields.
        let map_id = match self.players.get(&id) {
            Some(player) => player.map_id.clone(),
            None => return,
        };
        // 2. Catalogue membership before any bookkeeping.  The set is built from
        //    the export at construction, so this is the same table the client
        //    renders from.
        if !self.emoticon_ids.contains(&emoticon_id) {
            let _ = self.chat_reject(&id, &request_id, "emoticon_unknown", "未知的表情贴图。");
            return;
        }
        // 3. Bounded per-session idempotency, same contract as map chat: a retry
        //    with the same id and sticker never plays the animation twice, and
        //    the same id with a different sticker is a conflict.  Recording the
        //    id first (as chat does) means a retry of anything already seen is
        //    idempotent even if it was refused below.
        enum Duplicate {
            Replay,
            Conflict,
        }
        let duplicate = {
            let Some(player) = self.players.get_mut(&id) else {
                return;
            };
            let mut duplicate = None;
            for (seen_id, seen_sticker) in player.emoticon_recent.iter() {
                if seen_id == &request_id {
                    duplicate = Some(if seen_sticker == &emoticon_id {
                        Duplicate::Replay
                    } else {
                        Duplicate::Conflict
                    });
                    break;
                }
            }
            if duplicate.is_none() {
                if player.emoticon_recent.len() >= EMOTICON_RECENT_WINDOW {
                    player.emoticon_recent.pop_front();
                }
                player
                    .emoticon_recent
                    .push_back((request_id.clone(), emoticon_id.clone()));
            }
            duplicate
        };
        match duplicate {
            Some(Duplicate::Replay) => return,
            Some(Duplicate::Conflict) => {
                let _ = self.chat_reject(
                    &id,
                    &request_id,
                    "idempotency_conflict",
                    "重复请求使用了不同的内容。",
                );
                return;
            }
            None => {}
        }
        // 4. Source send budget (`ChatLimit`).  Sharing the chat token bucket
        //    would have been the easy option, but the source authors a separate
        //    sticker limit, so the sticker limit is what is enforced.
        if !self.emoticon_consume_budget(&id) {
            let _ = self.chat_reject(
                &id,
                &request_id,
                "emoticon_rate_limited",
                "表情发送太快，请稍后再试。",
            );
            return;
        }
        // 5. Immutable message fact; the server is the only author.
        self.emoticon_sequence += 1;
        let message_id = format!("emoticon-{id}-{}", self.emoticon_sequence);
        let (author_id, author_name) = match self.players.get(&id) {
            Some(player) => (player.state.id.clone(), player.state.username.clone()),
            None => return,
        };
        let common = serde_json::json!({
            "type": "emoticonMessage",
            "messageId": message_id,
            "mapId": map_id,
            "authorId": author_id,
            "authorName": author_name,
            "emoticonId": emoticon_id,
            "occurredAtTick": self.tick,
        });
        let mut sender_payload = common.clone();
        sender_payload["requestId"] = serde_json::Value::String(request_id);
        let sender_payload = sender_payload.to_string();
        let peer_payload = common.to_string();
        // 6. Ephemeral fan-out to the current map-room membership, with the same
        //    blacklist filter map chat uses.  The sender always gets its own
        //    echo so the animation plays locally from the authoritative fact
        //    rather than from an optimistic local guess.
        let recipients: Vec<(String, mpsc::Sender<String>)> = self
            .players
            .iter()
            .filter(|(player_id, player)| {
                player.map_id == map_id && (**player_id == id || !player.blocked.contains(&id))
            })
            .map(|(player_id, player)| (player_id.clone(), player.output.clone()))
            .collect();
        for (player_id, output) in recipients {
            let payload = if player_id == id {
                &sender_payload
            } else {
                &peer_payload
            };
            let _ = output.try_send(payload.clone());
        }
    }

    /// Lazily prune and consume the source emoticon budget.
    ///
    /// `ChatLimit` is a sliding window — at most `count` stickers inside any
    /// `time_ms` — not a refilling bucket, so the accepted send ticks are kept
    /// oldest-first and pruned against the authoritative tick.  That keeps the
    /// limit exactly reproducible in tests without reading a wall clock.
    fn emoticon_consume_budget(&mut self, id: &str) -> bool {
        // `EmoticonLimit` is `Copy`, so the immutable borrow of `gameplay` ends
        // with this statement and the mutable borrow of `players` is free.
        let Some(limit) = self
            .gameplay
            .emoticons
            .as_ref()
            .map(|catalogue| catalogue.limit)
        else {
            return false;
        };
        let window_ticks = (limit.time_ms + TICK_MS - 1) / TICK_MS;
        let window_ticks = window_ticks.max(1);
        let tick = self.tick;
        let Some(player) = self.players.get_mut(id) else {
            return false;
        };
        while let Some(oldest) = player.emoticon_sends.front() {
            if tick.saturating_sub(*oldest) >= window_ticks {
                player.emoticon_sends.pop_front();
            } else {
                break;
            }
        }
        if player.emoticon_sends.len() >= limit.count as usize {
            return false;
        }
        player.emoticon_sends.push_back(tick);
        true
    }
}
