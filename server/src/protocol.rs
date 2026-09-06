use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 6;
pub const CONTENT_VERSION: &str = "gms83-quest-2";

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
            | Self::Pickup { request_id, .. }
            | Self::Revive { request_id } => valid_id(request_id),
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
        }
    }
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub id: String,
    pub username: String,
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
    pub level: u32,
    pub exp: u64,
    pub exp_to_next: u64,
    pub mesos: u64,
    pub inventory: Vec<InventoryItem>,
    pub equipped: Vec<InventoryItem>,
    pub monster_book: BTreeMap<String, u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterState {
    pub id: String,
    pub template_id: String,
    pub x: f64,
    pub y: f64,
    pub facing: i8,
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
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub facing: i8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shop_id: Option<String>,
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
