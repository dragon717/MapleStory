use crate::inventory;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 20;
pub const CONTENT_VERSION: &str = "tms273-22";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BossPracticeAction {
    Enter,
    Leave,
    Retry,
}

/// Windbell activity intents.  The client names only an operation; map
/// identity, coordinates, state transitions, and the resulting path are
/// owned by the authoritative world loop.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WindbellAction {
    EnterIsland,
    EnterBridge,
    Leave,
    CutSupport,
    Ignite,
    DeployLeafwing,
    Talk,
    BraceCart,
    DeliverPlank,
    DeliverRope,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AbilityStat {
    Strength,
    Dexterity,
    Intelligence,
    Luck,
}

/// Direction of one warehouse move.  Kept as its own wire enum so an unknown
/// or misspelled direction is a deserialization error rather than a silently
/// ignored field.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StorageTransferOperation {
    Deposit,
    Withdraw,
}

impl AbilityStat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Strength => "strength",
            Self::Dexterity => "dexterity",
            Self::Intelligence => "intelligence",
            Self::Luck => "luck",
        }
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
        Self {
            strength: 12,
            dexterity: 5,
            intelligence: 4,
            luck: 4,
            available_ap: 0,
        }
    }
}

impl AbilityStats {
    pub fn add_point(&mut self, stat: AbilityStat) -> bool {
        let value = match stat {
            AbilityStat::Strength => &mut self.strength,
            AbilityStat::Dexterity => &mut self.dexterity,
            AbilityStat::Intelligence => &mut self.intelligence,
            AbilityStat::Luck => &mut self.luck,
        };
        // P: one AP per request, with a 9999 base-stat ceiling until source rules replace it.
        if self.available_ap == 0 || *value >= 9999 || *value < 0 {
            return false;
        }
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
    Windbell {
        #[serde(rename = "requestId")]
        request_id: String,
        action: WindbellAction,
        #[serde(rename = "instanceId", default)]
        instance_id: Option<String>,
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
    /// World map (大地图) jump: the client names only the clicked spot's map
    /// id; the map lookup and the landing point stay server-side.
    WorldMapMove {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "mapId")]
        map_id: String,
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
    /// Intent to sell one inventory stack back to an NPC shop.  The client
    /// names the shop, the tab and the slot; the identity of the item, how
    /// many are actually there, whether it may be sold and the mesos paid
    /// are all resolved here.  No item id, quantity or price is accepted.
    ShopSell {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "shopId")]
        shop_id: String,
        #[serde(rename = "inventoryType")]
        inventory_type: u8,
        #[serde(rename = "sourceSlot")]
        source_slot: i16,
        quantity: u32,
    },
    /// Intent to buy one row back from the shop's buy-back tab (the stacks the
    /// character has sold to any merchant).  The client names the item and the
    /// price it was sold for; the row itself, its quantity and the price are
    /// resolved from the character's persisted list, so a forged request can
    /// neither invent an item nor name its own price.
    ShopRebuy {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "shopId")]
        shop_id: String,
        #[serde(rename = "itemId")]
        item_id: String,
        #[serde(rename = "unitPrice")]
        unit_price: u64,
    },
    /// Open (or refresh) the 現金商店 window.  The catalogue itself is static
    /// client data; the server only answers with the authoritative balance.
    CashOpen {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    /// Buy one 現金商店 commodity by its source SN.  The item, its price,
    /// stack count and every sale condition are resolved from the assembled
    /// catalogue here — the client may only name the deal it accepts.
    CashBuy {
        #[serde(rename = "requestId")]
        request_id: String,
        sn: String,
        quantity: u32,
    },
    /// Open (or refresh) the account warehouse at a placed storage keeper.
    /// The client names the npc it is standing at; the server decides whether
    /// that npc is a storage keeper, whether the player is in range, and what
    /// the warehouse actually contains.
    StorageOpen {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "npcId")]
        npc_id: String,
    },
    /// Intent to move one stack between the character inventory and the
    /// account warehouse.  The client names only the direction, the tab and
    /// the slot; the item identity, how many are really there and whether the
    /// destination has room are all resolved server-side.  No item id is
    /// accepted, so a forged request cannot deposit an item the player does
    /// not own.
    StorageTransfer {
        #[serde(rename = "requestId")]
        request_id: String,
        /// `deposit` moves inventory -> warehouse, `withdraw` the reverse.
        operation: StorageTransferOperation,
        #[serde(rename = "inventoryType")]
        inventory_type: u8,
        slot: i16,
        quantity: u32,
    },
    /// Intent to move mesos between the character purse and the warehouse.
    StorageMesos {
        #[serde(rename = "requestId")]
        request_id: String,
        operation: StorageTransferOperation,
        quantity: u32,
    },
    /// Invite one character into a party.  The client names the character and
    /// nothing else: the server resolves the name to a character that is
    /// actually in the world, decides whether a party has to be created, and
    /// owns the pending invitation.
    PartyInvite {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "playerName")]
        player_name: String,
    },
    /// Accept or decline the pending invitation.  The server owns which
    /// invitation exists and who it was addressed to, so a client cannot
    /// answer somebody else's invitation or join a party it was never asked
    /// to join.
    PartyRespond {
        #[serde(rename = "requestId")]
        request_id: String,
        accept: bool,
    },
    /// Leave the party the character currently belongs to.
    PartyLeave {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    /// Remove one member.  Only the leader may do this; the server re-checks
    /// both the leadership and the membership.
    PartyKick {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "playerId")]
        player_id: String,
    },
    /// Hand leadership to another member (source `BtChangeBoss`).
    PartyLeader {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "playerId")]
        player_id: String,
    },
    /// Open (or refresh) the friend & blacklist window (`UserList` tab 0/1).
    /// The client names nothing: friends and blocked characters are account
    /// facts the server already owns, and the online flag is derived from the
    /// live world, so there is nothing here a client could claim.
    FriendOpen {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    /// Add one character as a friend.  The client types a name — the source
    /// context menu only ever carries a name, never an id — and the server
    /// resolves it, owns the cap, and writes the pair in both directions.
    FriendAdd {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "playerName")]
        player_name: String,
    },
    /// Drop one friend.  The client names the row it selected; the server
    /// re-checks that the friendship actually exists before deleting both
    /// directions of it.
    FriendRemove {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "playerId")]
        player_id: String,
    },
    /// Put one character on the blacklist.  Blocking also dissolves an
    /// existing friendship both ways and stops that character's map chat from
    /// reaching the blocker.
    FriendBlock {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "playerName")]
        player_name: String,
    },
    /// Take one character off the blacklist.
    FriendUnblock {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "playerId")]
        player_id: String,
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
    /// Whisper (密語) intent.  Like every other social intent the client only
    /// names the *other* character — never an id, a map, or a channel.  The
    /// server resolves the name, decides whether the pair may talk at all
    /// (blacklist, offline, self) and is the only author of the delivered
    /// message, so no client can whisper as somebody else or reach a player
    /// that blacklisted it.
    WhisperSend {
        #[serde(rename = "requestId")]
        request_id: String,
        /// Display name typed by the player; resolved server-side.
        #[serde(rename = "targetName")]
        target_name: String,
        text: String,
    },
    /// Chat emoticon (表情貼圖) intent.  The client names only a catalogue id
    /// (`<groupId>:<sourceName>`) and never an author, a room or a timestamp.
    /// The server checks the id against the exported `UI/ChatEmoticon.img`
    /// table, owns the source send budget (`ChatLimit`) and is the only author
    /// of the delivered message, so a modified client can neither invent a
    /// sticker nor flood the map.
    EmoticonSend {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "emoticonId")]
        emoticon_id: String,
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
        /// Kept so the Rust contract stays in sync with `shared/protocol.ts`
        /// and the field keeps its documented meaning on the wire.
        #[serde(default)]
        #[serde(rename = "clientNowMs")]
        #[allow(dead_code)]
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
            Self::BossPractice {
                request_id,
                encounter_id,
                ..
            } => {
                valid_id(request_id)
                    && encounter_id.as_deref().is_none_or(|id| {
                        id.len() <= 96
                            && crate::auth::is_practice_map(id)
                        && id
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
                    })
            }
            Self::Windbell {
                request_id,
                instance_id,
                ..
            } => {
                valid_id(request_id)
                    && instance_id.as_deref().is_none_or(|id| {
                        !id.is_empty()
                            && id.len() <= 96
                            && id
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
                    })
            }
            Self::ResetHyper {
                request_id,
                expected_cost,
            } => {
                valid_id(request_id)
                    && matches!(
                        *expected_cost,
                        100_000 | 1_000_000 | 2_000_000 | 5_000_000 | 10_000_000
                    )
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
            Self::WorldMapMove { request_id, map_id } => {
                valid_id(request_id) && valid_id(map_id)
            }
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
            Self::QuestInteract {
                request_id,
                quest_id,
            } => valid_id(request_id) && valid_id(quest_id),
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
            Self::ShopSell {
                request_id,
                shop_id,
                inventory_type,
                source_slot,
                quantity,
            } => {
                valid_id(request_id)
                    && valid_id(shop_id)
                    && inventory::valid_inventory_type(*inventory_type)
                    && inventory::valid_slot(*source_slot)
                    // One slot holds at most 9999 of a stackable (the arrow
                    // catalog cap), so a sell intent can name that many; the
                    // handler still clamps against the stack that is really
                    // there.
                    && (1..=9_999).contains(quantity)
            }
            Self::ShopRebuy {
                request_id,
                shop_id,
                item_id,
                unit_price,
            } => {
                valid_id(request_id)
                    && valid_id(shop_id)
                    && valid_id(item_id)
                    && *unit_price > 0
                    && *unit_price <= 1_000_000_000
            }
            Self::StorageOpen { request_id, npc_id } => valid_id(request_id) && valid_id(npc_id),
            Self::CashOpen { request_id } => valid_id(request_id),
            Self::CashBuy {
                request_id,
                sn,
                quantity,
            } => {
                // SN is the opaque catalogue key (8 or 9 source digits); the
                // real deal is resolved server-side, so only shape and a sane
                // quantity window are checked here.
                valid_id(request_id)
                    && sn.len() <= 9
                    && sn.bytes().all(|c| c.is_ascii_digit())
                    && *quantity >= 1
                    && *quantity <= 99
            }
            Self::StorageTransfer {
                request_id,
                inventory_type,
                slot,
                quantity,
                ..
            } => {
                valid_id(request_id)
                    && inventory::valid_inventory_type(*inventory_type)
                    && inventory::valid_slot(*slot)
                    && (1..=500).contains(quantity)
            }
            Self::StorageMesos {
                request_id,
                quantity,
                ..
            } => valid_id(request_id) && (1..=1_000_000_000).contains(quantity),
            Self::PartyInvite {
                request_id,
                player_name,
            } => valid_id(request_id) && valid_player_name(player_name),
            Self::PartyRespond { request_id, .. } | Self::PartyLeave { request_id } => {
                valid_id(request_id)
            }
            Self::PartyKick {
                request_id,
                player_id,
            }
            | Self::PartyLeader {
                request_id,
                player_id,
            } => valid_id(request_id) && valid_id(player_id),
            Self::FriendOpen { request_id } => valid_id(request_id),
            Self::FriendAdd {
                request_id,
                player_name,
            }
            | Self::FriendBlock {
                request_id,
                player_name,
            } => valid_id(request_id) && valid_player_name(player_name),
            Self::FriendRemove {
                request_id,
                player_id,
            }
            | Self::FriendUnblock {
                request_id,
                player_id,
            } => valid_id(request_id) && valid_id(player_id),
            Self::ChatSend { request_id, text } => valid_id(request_id) && valid_chat_text(text),
            // A whisper carries the same body policy as map chat and the same
            // display-name policy as a party invitation: the target is a typed
            // character name, never an id, so the server stays the only place
            // where a name becomes an identity.
            Self::WhisperSend {
                request_id,
                target_name,
                text,
            } => {
                valid_id(request_id) && valid_player_name(target_name) && valid_chat_text(text)
            }
            // A lifecycle report is only ever a hint; there is nothing to
            // validate beyond the shape, and nothing it can unlock.
            // An emoticon carries a catalogue id, so only the *shape* is
            // checked here — whether that id exists in the exported
            // `UI/ChatEmoticon.img` table is a world question, answered by the
            // authoritative world (`handle_emoticon`).
            Self::EmoticonSend {
                request_id,
                emoticon_id,
            } => valid_id(request_id) && valid_id(emoticon_id),
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

/// Character-name policy for party invitations.  Names are display text, so
/// they may hold any script, but they are still bounded (length + bytes) and
/// free of control characters, which keeps them usable in JSON and in logs
/// without letting an invitation carry layout or terminal escapes.
fn valid_player_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= 24
        && trimmed.len() <= 96
        && !trimmed.chars().any(char::is_control)
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
    /// True while the body is inside an authored water rectangle.  A swimming
    /// body is never `grounded`, so clients need this to tell "swimming" apart
    /// from "airborne": the two must not share the same jump-key routing.
    pub swimming: bool,
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
    /// Character-owned 現金商店 balance (P: a local wallet topped up only by
    /// the GM `/cash` command — no real charging exists).  Server state like
    /// mesos; clients render it and can never submit it.
    pub cash: u64,
    /// Character-owned skill id -> learned level.  This is server state;
    /// clients receive it in snapshots but cannot submit it as input.
    pub skills: BTreeMap<u32, u32>,
    /// Source SP group id -> remaining points.  Group semantics and grants
    /// remain server-side until the matching source rules are verified.
    pub skill_points: BTreeMap<u32, u32>,
    pub hyper_points: BTreeMap<u32, u32>,
    pub hyper_reset_count: u8,
    pub hyper_reset_cost: u64,
    /// Server-owned consumable cooldowns: item id -> remaining ms.  Only items
    /// whose source `spec.time` authors a cooldown appear here, so an ordinary
    /// potion never occupies an entry.  Emitted for display only — the client
    /// cannot set, shorten or clear a cooldown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub potion_cooldowns: Option<BTreeMap<String, u64>>,
    pub inventory: Vec<InventoryItem>,
    pub equipped: Vec<InventoryItem>,
    /// Server-owned per-tab slot capacity: inventory type (1=equip, 2=use,
    /// 3=setup, 4=etc, 5=cash) -> current slot count.  Each tab starts at 24
    /// and is grown by the TMS273 slot-expansion coupons up to 128.  Absent or
    /// empty means every tab is at the default 24.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub inventory_slots: BTreeMap<u8, u16>,
    pub monster_book: BTreeMap<String, u8>,
    /// Server-owned away marker.  Other clients use it to label the character
    /// as 暂离; it grants the marker's owner no protection, no asset and no
    /// exemption from normal world rules.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub away: Option<AwayMarker>,
}

/// Player-side abnormal-status presentation state.  Emitted in snapshots; the
/// server owns the deadlines and the client only renders what is left.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbnormalStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seal_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stun_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub curse_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poison_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slow_ms: Option<u64>,
}

impl AbnormalStatus {
    pub fn is_empty(&self) -> bool {
        self.seal_ms.is_none()
            && self.stun_ms.is_none()
            && self.curse_ms.is_none()
            && self.poison_ms.is_none()
            && self.slow_ms.is_none()
    }
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

/// One full view of a character's account warehouse, sent only to the owner.
/// Storage is private, so this is never placed in a map snapshot.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageState {
    /// Warehouse rows, ordered by slot.  Equipment keeps its instance stats.
    pub items: Vec<InventoryItem>,
    /// Warehouse mesos, a balance separate from the character's purse.
    pub mesos: u64,
    /// How many rows the warehouse can hold in total.
    pub slot_limit: u16,
    /// The storage keeper this window belongs to, so a stale window can be
    /// closed when the player walks away from it.
    pub npc_id: String,
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
    fn shop_sell_accepts_a_full_drop_stack() {
        // 113 幼魔精靈的角 is a real stack a player sells at once; the old
        // 1..=100 shape bound rejected it as invalid_message before the
        // handler ever saw it.  9999 is the arrow catalog's slotMax ceiling,
        // and the handler still clamps against the real stack.
        let stack: ClientMessage = serde_json::from_str(
            r#"{"type":"shopSell","requestId":"sell-1","shopId":"shop-1","inventoryType":4,"sourceSlot":7,"quantity":113}"#,
        )
        .unwrap();
        assert!(stack.valid());
        let ceiling: ClientMessage = serde_json::from_str(
            r#"{"type":"shopSell","requestId":"sell-2","shopId":"shop-1","inventoryType":2,"sourceSlot":1,"quantity":9999}"#,
        )
        .unwrap();
        assert!(ceiling.valid());
        let over: ClientMessage = serde_json::from_str(
            r#"{"type":"shopSell","requestId":"sell-3","shopId":"shop-1","inventoryType":2,"sourceSlot":1,"quantity":10000}"#,
        )
        .unwrap();
        assert!(!over.valid());
        let zero: ClientMessage = serde_json::from_str(
            r#"{"type":"shopSell","requestId":"sell-4","shopId":"shop-1","inventoryType":2,"sourceSlot":1,"quantity":0}"#,
        )
        .unwrap();
        assert!(!zero.valid());
    }

    #[test]
    fn ability_allocation_accepts_only_one_known_stat_intent() {
        let valid: ClientMessage = serde_json::from_str(
            r#"{"type":"allocateAp","requestId":"ap-1","stat":"intelligence"}"#,
        )
        .unwrap();
        assert!(valid.valid());
        for bad in [
            r#"{"type":"allocateAp","requestId":"ap-1","stat":"hp"}"#,
            r#"{"type":"allocateAp","requestId":"ap-1","stat":"intelligence","amount":999}"#,
            r#"{"type":"allocateAp","requestId":"ap-1","stat":"intelligence","playerId":"other"}"#,
            r#"{"type":"allocateAp","requestId":"ap-1","stat":"intelligence","abilityStats":{"availableAp":999}}"#,
        ] {
            assert!(serde_json::from_str::<ClientMessage>(bad).is_err());
        }
        let empty: ClientMessage =
            serde_json::from_str(r#"{"type":"allocateAp","requestId":"","stat":"strength"}"#)
                .unwrap();
        assert!(!empty.valid());
        let mut capped = AbilityStats {
            strength: 9999,
            available_ap: 1,
            ..AbilityStats::default()
        };
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
