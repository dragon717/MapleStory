use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 12;
pub const CONTENT_VERSION: &str = "tms273-9";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BossPracticeAction { Enter, Leave, Retry }

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AbilityStat { Strength, Dexterity, Intelligence, Luck }

impl AbilityStat {
    pub fn as_str(self) -> &'static str {
        match self { Self::Strength => "strength", Self::Dexterity => "dexterity",
            Self::Intelligence => "intelligence", Self::Luck => "luck" }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbilityStats {
    pub strength: i64,
    pub dexterity: i64,
    pub intelligence: i64,
    pub luck: i64,
    pub available_ap: u32,
}

impl Default for AbilityStats {
    fn default() -> Self {
        Self { strength: 12, dexterity: 5, intelligence: 4, luck: 4, available_ap: 0 }
    }
}

impl AbilityStats {
    pub fn add_point(&mut self, stat: AbilityStat) -> bool {
        let value = match stat { AbilityStat::Strength => &mut self.strength,
            AbilityStat::Dexterity => &mut self.dexterity,
            AbilityStat::Intelligence => &mut self.intelligence, AbilityStat::Luck => &mut self.luck };
        // P: one AP per request, with a 9999 base-stat ceiling until source rules replace it.
        if self.available_ap == 0 || *value >= 9999 || *value < 0 { return false; }
        *value += 1;
        self.available_ap -= 1;
        true
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ClientMessage {
    Hello {
        token: String,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "contentVersion")]
        content_version: String,
        /// Preferred display language for server-pushed text
        /// ("zh" default, "en" for the ?lang=en UI).  Absent means zh.
        #[serde(default)]
        lang: Option<String>,
    },
    Input {
        seq: u64,
        direction: i8,
        vertical: i8,
        jump: bool,
    },
    Attack {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    AllocateAp {
        #[serde(rename = "requestId")]
        request_id: String,
        stat: AbilityStat,
    },
    ResetHyper {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "expectedCost")]
        expected_cost: u64,
    },
    LearnSkill {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "skillId")]
        skill_id: u32,
    },
    CastSkill {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "skillId")]
        skill_id: u32,
        #[serde(default)]
        direction: Option<i8>,
        #[serde(default)]
        vertical: Option<i8>,
    },
    BossPractice {
        #[serde(rename = "requestId")]
        request_id: String,
        action: BossPracticeAction,
        #[serde(rename = "encounterId", default)]
        encounter_id: Option<String>,
    },
    ReleaseSkill {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Pickup {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "dropId")]
        drop_id: String,
    },
    Portal {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "portalName")]
        portal_name: String,
    },
    InventoryMove {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "inventoryType")]
        inventory_type: u8,
        #[serde(rename = "sourceSlot")]
        source_slot: i16,
        #[serde(rename = "targetSlot")]
        target_slot: i16,
        quantity: u32,
    },
    DropItem {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "inventoryType")]
        inventory_type: u8,
        #[serde(rename = "sourceSlot")]
        source_slot: i16,
        quantity: u32,
    },
    InventoryGather {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "inventoryType")]
        inventory_type: u8,
    },
    InventorySort {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "inventoryType")]
        inventory_type: u8,
    },
    UseItem {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "inventoryType")]
        inventory_type: u8,
        #[serde(rename = "sourceSlot")]
        source_slot: i16,
        #[serde(rename = "itemId")]
        item_id: String,
        #[serde(rename = "targetSlot")]
        target_slot: Option<i16>,
        #[serde(rename = "targetItemId")]
        target_item_id: Option<String>,
    },
    DropMesos {
        #[serde(rename = "requestId")]
        request_id: String,
        quantity: u32,
    },
    Revive {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    /// Talk to a placed npc.  `step` is absent (or "start") for the opening
    /// message and otherwise selects the button the player pressed.
    QuestInteract {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "questId")]
        quest_id: String,
    },
    NpcTalk {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "npcId")]
        npc_id: String,
        step: Option<String>,
        selection: Option<u32>,
    },
    ShopBuy {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "shopId")]
        shop_id: String,
        #[serde(rename = "itemId")]
        item_id: String,
        quantity: u32,
    },
    /// Intent to strike one authored map reactor.  The client identifies the
    /// prop; the server decides range, whether it is still interactable, and
    /// which state comes next.  No damage, position or state is accepted.
    ReactorHit {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "reactorId")]
        reactor_id: String,
    },
    /// Map-chat intent.  The client only supplies text; the authoritative map
    /// room, sender identity and display name are all resolved server-side.
    ChatSend {
        #[serde(rename = "requestId")]
        request_id: String,
        text: String,
    },
    /// Explicit logout: the player asked to leave, so the authoritative
    /// character must be removed instead of being kept resident.  A socket
    /// that just closes cannot be read as a logout, because a tab switch or a
    /// reload looks identical to one.
    Logout,
    /// Page lifecycle report.  This is a hint for session policy only: it
    /// never grants assets, invulnerability, or any exemption from world
    /// rules, and a forged report cannot shorten or extend an away window
    /// because the server keeps the authoritative start time.
    Lifecycle {
        /// `true` when `document.visibilityState === 'hidden'`.
        hidden: bool,
        /// `true` when the player explicitly asked to stay away.
        #[serde(default)]
        away: Option<bool>,
        /// Client wall clock for diagnostics only; never used for decisions.
        #[serde(default)]
        #[serde(rename = "clientNowMs")]
        client_now_ms: Option<i64>,
    },
}

impl ClientMessage {
    pub fn valid(&self) -> bool {
        match self {
            Self::Hello {
                token,
                protocol_version,
                content_version,
                lang,
            } => {
                token.len() == 64
                    && token.bytes().all(|c| c.is_ascii_hexdigit())
                    && *protocol_version == PROTOCOL_VERSION
                    && content_version == CONTENT_VERSION
                    && lang.as_deref().is_none_or(|lang| {
                        lang == crate::quest_text::LANG_ZH || lang == crate::quest_text::LANG_EN
                    })
            }
            Self::Input {
                seq,
                direction,
                vertical,
                ..
            } => {
                *seq > 0
                    && *seq <= 9_007_199_254_740_991
                    && (-1..=1).contains(direction)
                    && (-1..=1).contains(vertical)
            }
            Self::Attack { request_id }
            | Self::ReleaseSkill { request_id }
            | Self::AllocateAp { request_id, .. }
            | Self::LearnSkill { request_id, .. }
            | Self::Pickup { request_id, .. }
            | Self::Revive { request_id } => valid_id(request_id),
            Self::ReactorHit {
                request_id,
                reactor_id,
            } => valid_id(request_id) && valid_id(reactor_id),
            Self::BossPractice { request_id, encounter_id, .. } => {
                valid_id(request_id) && encounter_id.as_deref().is_none_or(|id| {
                    id.len() <= 96 && crate::auth::is_practice_map(id)
                        && id.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
                })
            }
            Self::ResetHyper { request_id, expected_cost } => {
                valid_id(request_id) && matches!(*expected_cost, 100_000 | 1_000_000 | 2_000_000 | 5_000_000 | 10_000_000)
            }
            Self::CastSkill {
                request_id,
                direction,
                vertical,
                ..
            } => {
                valid_id(request_id)
                    && direction.is_none_or(|value| (-1..=1).contains(&value))
                    && vertical.is_none_or(|value| (-1..=1).contains(&value))
            }
            Self::Portal {
                request_id,
                portal_name,
            } => valid_id(request_id) && valid_id(portal_name),
            Self::InventoryMove {
                request_id,
                inventory_type,
                source_slot,
                target_slot,
                quantity,
            } => {
                valid_id(request_id)
                    && valid_inventory_move(*inventory_type, *source_slot, *target_slot)
                    && *quantity > 0
            }
            Self::DropItem {
                request_id,
                inventory_type,
                source_slot,
                quantity,
            } => {
                valid_id(request_id)
                    && crate::inventory::valid_inventory_type(*inventory_type)
                    && crate::inventory::valid_slot(*source_slot)
                    && *quantity > 0
            }
            Self::InventoryGather {
                request_id,
                inventory_type,
            }
            | Self::InventorySort {
                request_id,
                inventory_type,
            } => valid_id(request_id) && crate::inventory::valid_inventory_type(*inventory_type),
            Self::UseItem {
                request_id,
                inventory_type,
                source_slot,
                item_id,
                target_slot,
                target_item_id,
            } => {
                let source_valid = if *inventory_type == 1 {
                    crate::inventory::valid_slot(*source_slot)
                        || crate::inventory::valid_equipment_slot(*source_slot)
                } else {
                    crate::inventory::valid_slot(*source_slot)
                };
                valid_id(request_id)
                    && crate::inventory::valid_inventory_type(*inventory_type)
                    && source_valid
                    && valid_id(item_id)
                    && target_slot.is_none_or(|slot| {
                        crate::inventory::valid_slot(slot)
                            || crate::inventory::valid_equipment_slot(slot)
                    })
                    && target_item_id.as_deref().is_none_or(valid_id)
            }
            Self::DropMesos {
                request_id,
                quantity,
            } => valid_id(request_id) && (10..=50_000).contains(quantity),
            Self::QuestInteract { request_id, quest_id } => valid_id(request_id) && valid_id(quest_id),
            Self::NpcTalk {
                request_id,
                npc_id,
                step,
                selection,
            } => {
                valid_id(request_id)
                    && valid_id(npc_id)
                    && step.as_deref().is_none_or(|step| {
                        ["start", "next", "prev", "yes", "no", "select", "end"].contains(&step)
                    })
                    && selection.is_none_or(|selection| selection <= 64)
            }
            Self::ShopBuy {
                request_id,
                shop_id,
                item_id,
                quantity,
            } => {
                valid_id(request_id)
                    && valid_id(shop_id)
                    && valid_id(item_id)
                    && (1..=100).contains(quantity)
            }
            Self::ChatSend { request_id, text } => {
                valid_id(request_id) && valid_chat_text(text)
            }
            // A lifecycle report is only ever a hint; there is nothing to
            // validate beyond the shape, and nothing it can unlock.
            Self::Lifecycle { .. } => true,
            Self::Logout => true,
        }
    }
}

/// Map/player chat body policy: non-empty after trimming, bounded by characters
/// and UTF-8 bytes, and free of C0/C1 control characters (chat is a one-line
/// body; control characters cannot carry layout or terminal commands).
///
/// P: the 200 limit counts Unicode scalar values, not extended grapheme
/// clusters.  The 1 KiB byte cap keeps surrogate-safe CJK/emoji within the
/// wire budget; precise grapheme accounting can move to unicode-segmentation
/// if a source rule ever needs it.
pub fn valid_chat_text(text: &str) -> bool {
    if text.trim().is_empty() {
        return false;
    }
    if text.chars().count() > 200 || text.len() > 1024 {
        return false;
    }
    !text.chars().any(char::is_control)
}

fn valid_inventory_move(inventory_type: u8, source_slot: i16, target_slot: i16) -> bool {
    if !crate::inventory::valid_inventory_type(inventory_type) {
        return false;
    }
    if inventory_type == 1
        && ((crate::inventory::valid_slot(source_slot)
            && crate::inventory::valid_equipment_slot(target_slot))
            || (crate::inventory::valid_equipment_slot(source_slot)
                && crate::inventory::valid_slot(target_slot)))
    {
        return true;
    }
    crate::inventory::valid_slot(source_slot) && crate::inventory::valid_slot(target_slot)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItem {
    pub slot: u16,
    pub item_id: String,
    pub quantity: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<BTreeMap<String, i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_slots: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgrade_count: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegenerationPassive {
    pub id: &'static str,
    pub book_id: u32,
    pub hp_per_second: i64,
    pub mp_per_second: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedStats {
    pub magic_attack: i64,
    pub defense: i64,
    pub move_speed: f64,
    pub magic_guard: bool,
    pub hyper_barrier_active: bool,
    pub hyper_teleport_enabled: bool,
    pub damage_reduction_percent: i64,
    pub regeneration_passives: Vec<RegenerationPassive>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meditation_remaining_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_cooldowns: Option<BTreeMap<u32, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_buffs: Option<BTreeMap<u32, u64>>,
    #[serde(default)]
    pub infinity_enhanced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ice_teleport: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teleport_mastery: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teleport_boost: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adaptation_charges: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adaptation_cooldown_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_resistance: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_resistance: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strength: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dexterity: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intelligence: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub luck: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub id: String,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<crate::lobby::Appearance>,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub facing: i8,
    pub grounded: bool,
    pub action: &'static str,
    pub action_id: Option<String>,
    pub action_started_tick: u64,
    pub last_input_seq: u64,
    pub climbing: bool,
    pub ladder_id: Option<u64>,
    pub hp: i64,
    pub max_hp: i64,
    pub mp: i64,
    pub max_mp: i64,
    pub derived_stats: DerivedStats,
    pub ability_stats: AbilityStats,
    pub level: u32,
    /// Character-owned job id, emitted in snapshots and never accepted as input.
    pub job: u32,
    pub exp: u64,
    pub exp_to_next: u64,
    pub mesos: u64,
    /// Character-owned skill id -> learned level.  This is server state;
    /// clients receive it in snapshots but cannot submit it as input.
    pub skills: BTreeMap<u32, u32>,
    /// Source SP group id -> remaining points.  Group semantics and grants
    /// remain server-side until the matching source rules are verified.
    pub skill_points: BTreeMap<u32, u32>,
    pub hyper_points: BTreeMap<u32, u32>,
    pub hyper_reset_count: u8,
    pub hyper_reset_cost: u64,
    pub inventory: Vec<InventoryItem>,
    pub equipped: Vec<InventoryItem>,
    pub monster_book: BTreeMap<String, u8>,
    /// Server-owned away marker.  Other clients use it to label the character
    /// as 暂离; it grants the marker's owner no protection, no asset and no
    /// exemption from normal world rules.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub away: Option<AwayMarker>,
}

/// Away presentation state attached to a snapshot player row.  Present only
/// while the character has an open away window; `residency` distinguishes the
/// grace stage from basic residency.  Durations are display-only — the server
/// re-derives the stage from its own clock on every decision.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwayMarker {
    /// True once continuous absence reached the full-retention threshold.
    pub residency: bool,
    /// Milliseconds until the normal exit path runs.  Display only.
    pub remaining_ms: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterState {
    pub id: String,
    pub template_id: String,
    pub x: f64,
    pub y: f64,
    pub facing: i8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freeze_stacks: Option<u32>,
    pub hp: i64,
    pub max_hp: i64,
    pub action: &'static str,
    pub action_started_tick: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpcState {
    pub id: String,
    pub template_id: String,
    /// Authoritative English display name (reference v83).
    pub name: String,
    /// Chinese display name (shared/npc-names.json).  Additive optional field;
    /// clients that do not know it simply keep rendering `name`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_zh: Option<String>,
    pub x: f64,
    pub y: f64,
    pub facing: i8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shop_id: Option<String>,
    /// Set only for the observer who can use the authored Hans job entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_advancement_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quest_available: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropState {
    pub id: String,
    pub item_id: String,
    pub quantity: u32,
    pub x: f64,
    pub y: f64,
}

pub fn reject(code: &str, message: &str, request_id: Option<&str>) -> String {
    let mut v = serde_json::json!({"type":"rejected","code":code,"message":message});
    if let Some(id) = request_id {
        v["requestId"] = id.into();
    }
    v.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ability_allocation_accepts_only_one_known_stat_intent() {
        let valid: ClientMessage = serde_json::from_str(r#"{"type":"allocateAp","requestId":"ap-1","stat":"intelligence"}"#).unwrap();
        assert!(valid.valid());
        for bad in [
            r#"{"type":"allocateAp","requestId":"ap-1","stat":"hp"}"#,
            r#"{"type":"allocateAp","requestId":"ap-1","stat":"intelligence","amount":999}"#,
            r#"{"type":"allocateAp","requestId":"ap-1","stat":"intelligence","playerId":"other"}"#,
            r#"{"type":"allocateAp","requestId":"ap-1","stat":"intelligence","abilityStats":{"availableAp":999}}"#,
        ] { assert!(serde_json::from_str::<ClientMessage>(bad).is_err()); }
        let empty: ClientMessage = serde_json::from_str(r#"{"type":"allocateAp","requestId":"","stat":"strength"}"#).unwrap();
        assert!(!empty.valid());
        let mut capped = AbilityStats { strength: 9999, available_ap: 1, ..AbilityStats::default() };
        assert!(!capped.add_point(AbilityStat::Strength));
        assert_eq!(capped.available_ap, 1);
    }

    #[test]
    fn client_job_field_is_not_an_authoritative_input() {
        let message = r#"{"type":"hello","token":"0000000000000000000000000000000000000000000000000000000000000000","protocolVersion":6,"contentVersion":"tms273-5","job":200}"#;
        assert!(serde_json::from_str::<ClientMessage>(message).is_err());
    }

    #[test]
    fn client_skill_state_fields_are_not_authoritative_inputs() {
        for message in [
            r#"{"type":"hello","token":"0000000000000000000000000000000000000000000000000000000000000000","protocolVersion":6,"contentVersion":"tms273-5","skills":{"2001008":1}}"#,
            r#"{"type":"hello","token":"0000000000000000000000000000000000000000000000000000000000000000","protocolVersion":6,"contentVersion":"tms273-5","skillPoints":{"1":5}}"#,
        ] {
            assert!(serde_json::from_str::<ClientMessage>(message).is_err());
        }
    }
}
