use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 2;
pub const CONTENT_VERSION: &str = "gms83-gameplay-2";

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ClientMessage {
    Hello {
        token: String,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "contentVersion")]
        content_version: String,
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
    Revive {
        #[serde(rename = "requestId")]
        request_id: String,
    },
}

impl ClientMessage {
    pub fn valid(&self) -> bool {
        match self {
            Self::Hello {
                token,
                protocol_version,
                content_version,
            } => {
                token.len() == 64
                    && token.bytes().all(|c| c.is_ascii_hexdigit())
                    && *protocol_version == PROTOCOL_VERSION
                    && content_version == CONTENT_VERSION
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
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItem {
    pub item_id: String,
    pub quantity: u32,
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
