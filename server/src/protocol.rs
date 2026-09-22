use crate::inventory;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 34;
pub const CONTENT_VERSION: &str = "tms273-39";

/// 冒险笔记（图鉴）的页签。  服务器只按这个枚举分派，客户端不能提交任意分区名，
/// 也不能用「先拿全量再隐藏」的方式绕过任务页的私有过滤（计划 §12.2）。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NotebookSection {
    Monster,
    Equipment,
    Use,
    Setup,
    Etc,
    Cash,
    Pet,
    /// 骑宠（`Character/TamingMob`，`shared/mounts.json`）。它不在物品树里，
    /// 因此是独立页签而不是装备页的一格——见 `inventory::shipped_mounts`。
    Mount,
    /// 鞍具：同一张 `shared/mounts.json` 里 `islot = Sd` 的那 26 件。  它们挂在
    /// 坐骑身上，却**不带** `tamingMob`，所以骑乘判定从不把它们当坐骑
    /// （`inventory::is_mount_item` 与目录的拆分是同一口径）。
    /// 界面上它是骑宠页里的一个子页签，但在协议里必须是独立分区：
    /// 「一个 id 只属于一页」这条不变式靠分区成立，混进 Mount 会让
    /// 记录归属有两个答案。
    Saddle,
    /// 椅子（`Item/Install/0301*`、`0302`，`shared/chairs.json`）。同骑宠：源把
    /// 它们整族排除在掉落与商店之外，物品树里只带着那一件真的进商店的椅子，
    /// 所以整族归这一页，物品页一件也不留。
    Chair,
    Quest,
}

/// 一次收藏操作的种类。  `rewardKey` 由服务器给出，客户端只回传它收到的那个键。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NotebookOperation {
    /// 领取一处行／分頁／地區完成奖励。
    CollectionClaim,
    /// 开始一次探险。
    ExplorationStart,
    /// 领取已完成的探险。
    ExplorationClaim,
}

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
    Rest,
    DryRecords,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub enum ColossusAction { Enter, Leave, Board, Skip, Travel }

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
        sequence: u64,
        action: WindbellAction,
        #[serde(rename = "instanceId", default)]
        instance_id: Option<String>,
    },
    Colossus {
        #[serde(rename="requestId")]
        request_id:String,
        sequence:u64,
        action:ColossusAction,
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
    /// Accept or hand in a quest from the quest window.  Only the quests whose
    /// source marks the phase self-service (no start/complete NPC) accept this
    /// entry point; the server decides that from its own quest catalog, never
    /// from this message.
    QuestService {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "questId")]
        quest_id: String,
        action: String,
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
    /// 冒险笔记（图鉴）查询。  主体只来自连接：客户端不提交角色或账号 id，
    /// 只提交它要看的分区、页码和一个有限筛选。  任务页的筛选与分页完全在服务器侧
    /// 的「已获得」集合上计算，客户端拿不到任何未获得的任务条目。
    NotebookQuery {
        #[serde(rename = "requestId")]
        request_id: String,
        section: NotebookSection,
        page: u32,
        /// 目录版本回显：不一致时服务器明确拒绝，而不是用旧页码解释新数据。
        #[serde(rename = "catalogVersion")]
        catalog_version: String,
        /// 名称筛选（服务端做包含匹配），长度受限。
        #[serde(default)]
        filter: Option<String>,
        /// 浏览方式（NB-07）。  服务端在自己的集合上解释它，客户端不能靠它多看到
        /// 一条未获得的任务条目；未知取值按默认处理，而不是当成一个新分区。
        #[serde(default)]
        mode: Option<String>,
    },
    /// 领取一处原版完成奖励。  客户端只回传服务器此前给出的 `rewardKey`；
    /// 资格、收件角色与容量全部由服务器重算。
    CollectionClaim {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "rewardKey")]
        reward_key: String,
    },
    /// 开始一次探险。  客户端只命名要派遣的收藏行；组合资格与时长由服务器决定。
    ExplorationStart {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "rowKey")]
        row_key: String,
    },
    /// 领取一次已完成的探险。  `runId` 必须由服务器此前签发。
    ExplorationClaim {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
    /// 原创扩展「死亡世界」：向一座墓碑悼念。  客户端只命名墓碑；是否存在、
    /// 是否到期、是否同图、距离与去重全部由服务器裁决。
    TombstoneMourn {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "tombstoneId")]
        tombstone_id: String,
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
            Self::TombstoneMourn {
                request_id,
                tombstone_id,
            } => valid_id(request_id) && valid_id(tombstone_id),
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
            Self::Colossus {request_id,..} => valid_id(request_id),
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
            Self::WorldMapMove { request_id, map_id } => valid_id(request_id) && valid_id(map_id),
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
            Self::QuestService {
                request_id,
                quest_id,
                action,
            } => {
                valid_id(request_id)
                    && valid_id(quest_id)
                    && (action == "start" || action == "complete")
            }
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
            } => valid_id(request_id) && valid_player_name(target_name) && valid_chat_text(text),
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
            // 图鉴查询只做形状与规模校验：主体身份来自连接，目录版本来自服务器
            // 自己的目录文件，分区是枚举（未知取值在反序列化阶段就失败）。页码与
            // 筛选长度必须在这里挡住，TypeScript 类型不能替代服务器检查。
            Self::NotebookQuery {
                request_id,
                page,
                catalog_version,
                filter,
                mode,
                ..
            } => {
                valid_id(request_id)
                    && *page <= NOTEBOOK_MAX_PAGE
                    && valid_id(catalog_version)
                    && filter.as_deref().is_none_or(|text| {
                        !text.is_empty()
                            && text.chars().count() <= NOTEBOOK_MAX_FILTER_CHARS
                            && !text.chars().any(char::is_control)
                    })
                    // 浏览方式是服务器侧枚举：客户端提交一个没定义过的取值不会
                    // 报错，而是退化成默认筛选（只给当前可获得的条目）。
                    && mode.as_deref().is_none_or(|text| {
                        [
                            NOTEBOOK_MODE_AVAILABLE,
                            NOTEBOOK_MODE_ALL,
                            NOTEBOOK_MODE_OBTAINED,
                            NOTEBOOK_MODE_MISSING,
                        ]
                        .contains(&text)
                    })
            }
            // 收藏操作只校验形状：`rewardKey`/`rowKey`/`runId` 是否真实存在、
            // 是否属于当前主体、是否已领取，全部是权威世界的问题。
            Self::CollectionClaim {
                request_id,
                reward_key,
            } => valid_id(request_id) && valid_id(reward_key),
            Self::ExplorationStart {
                request_id,
                row_key,
            } => valid_id(request_id) && valid_id(row_key),
            Self::ExplorationClaim { request_id, run_id } => {
                valid_id(request_id) && valid_id(run_id)
            }
        }
    }
}

/// 页码上限：一个分区最多几千条，这个上限只是为了让越界请求在协议层就失败，
/// 而不是让服务器去做一次无意义的巨大偏移。
pub const NOTEBOOK_MAX_PAGE: u32 = 4096;
/// 搜索框上限：与聊天正文一起构成「输入型字段必须有界」的同一约定。
pub const NOTEBOOK_MAX_FILTER_CHARS: usize = 32;
/// 浏览方式：目录里「当前可获得」的条目（默认，计划 §5.5 的分母）。
pub const NOTEBOOK_MODE_AVAILABLE: &str = "available";
/// 浏览方式：整个分区，含目录判定为不可获得的条目。
pub const NOTEBOOK_MODE_ALL: &str = "all";
/// 浏览方式：只看这个角色真的获得过的条目。
pub const NOTEBOOK_MODE_OBTAINED: &str = "obtained";
/// 浏览方式：只看「当前可获得但还没获得」的条目。
pub const NOTEBOOK_MODE_MISSING: &str = "missing";

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

    /// 冒险笔记（图鉴）的消息形状。
    ///
    /// 这一层只回答「能不能解析、形状对不对」：某个 `rewardKey` / `rowKey` /
    /// `runId` 是否真实存在、是否属于当前主体、是否已经领过，是权威世界的问题
    /// （`notebook.rs` 与将来的奖励事务），不是这里能判定的。
    #[test]
    fn notebook_messages_only_police_their_shape() {
        let query: ClientMessage = serde_json::from_str(
            r#"{"type":"notebookQuery","requestId":"nb-1","section":"monster","page":0,"catalogVersion":"notebook-catalog-1"}"#,
        )
        .unwrap();
        assert!(query.valid());
        // 分区是枚举：拼错或凭空造一个分区在反序列化阶段就失败，不会退化成
        // 「服务端悄悄忽略这个字段」。
        assert!(
            serde_json::from_str::<ClientMessage>(
                r#"{"type":"notebookQuery","requestId":"nb-2","section":"monsters","page":0,"catalogVersion":"notebook-catalog-1"}"#,
            )
            .is_err()
        );
        // 页码与筛选长度是服务器侧的上限，TypeScript 类型不能替代这里。
        let over_page: ClientMessage = serde_json::from_str(
            r#"{"type":"notebookQuery","requestId":"nb-3","section":"use","page":4097,"catalogVersion":"notebook-catalog-1"}"#,
        )
        .unwrap();
        assert!(!over_page.valid());
        let long_filter: ClientMessage = serde_json::from_str(&format!(
            r#"{{"type":"notebookQuery","requestId":"nb-4","section":"use","page":0,"catalogVersion":"notebook-catalog-1","filter":"{}"}}"#,
            "搜".repeat(NOTEBOOK_MAX_FILTER_CHARS + 1)
        ))
        .unwrap();
        assert!(!long_filter.valid());
        let empty_request: ClientMessage = serde_json::from_str(
            r#"{"type":"notebookQuery","requestId":"","section":"use","page":0,"catalogVersion":"notebook-catalog-1"}"#,
        )
        .unwrap();
        assert!(!empty_request.valid());

        let claim: ClientMessage = serde_json::from_str(
            r#"{"type":"collectionClaim","requestId":"nb-5","rewardKey":"mc-0-0-0"}"#,
        )
        .unwrap();
        assert!(claim.valid());
        // 客户端不能自己声明操作种类：它只回传服务器给出的键，操作名由消息类型决定。
        for bad in [
            r#"{"type":"collectionClaim","requestId":"nb-6","rewardKey":""}"#,
            r#"{"type":"explorationStart","requestId":"nb-7","rowKey":""}"#,
            r#"{"type":"explorationClaim","requestId":"nb-8","runId":""}"#,
        ] {
            let parsed = serde_json::from_str::<ClientMessage>(bad);
            assert!(
                parsed.map(|message| !message.valid()).unwrap_or(true),
                "{bad} must not reach a handler"
            );
        }
    }
}
