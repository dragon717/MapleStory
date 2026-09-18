use crate::protocol::InventoryItem;
use rand::Rng;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    iter::once,
    sync::OnceLock,
};

/// Every regular MapleStory inventory tab starts with 24 local slots.
/// This is the *default* capacity a fresh character gets before using any
/// TMS273 slot-expansion coupon.
pub const SLOT_LIMIT: u16 = 24;

/// The source ceiling one tab can be expanded to.  TMS273.7's slot-expansion
/// coupons (`Item/Consume/0243` `info.slotExpand`) each add 8 slots and refuse
/// past this bound; the String catalog states "最多可擴增到128格欄位".
pub const MAX_SLOT_LIMIT: u16 = 128;

/// How many slots one TMS273 slot-expansion coupon adds.
pub const SLOT_EXPAND_STEP: u16 = 8;

/// The default per-tab slot capacities for a fresh character.  Cash (type 5)
/// and the four ordinary tabs all begin at `SLOT_LIMIT`.
pub fn default_inventory_slots() -> BTreeMap<u8, u16> {
    (1..=5).map(|kind| (kind, SLOT_LIMIT)).collect()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemDefinition {
    inventory_type: u8,
    slot_max: u32,
    #[serde(default)]
    info: BTreeMap<String, Value>,
    #[serde(default)]
    spec: BTreeMap<String, Value>,
    /// The source display name (`String/*.json`), present for every row the
    /// export resolved.  Only the notebook reads it: the server otherwise
    /// answers with ids and lets the client own the display text, but the
    /// notebook's search is computed *inside* the server's own set (plan
    /// §12.2), so the match has to happen where the rows are filtered.
    #[serde(default)]
    name: Option<String>,
}

/// The **shipped** compile-time item index (`shared/items.json`).
fn shipped_catalog() -> &'static BTreeMap<String, ItemDefinition> {
    static SHIPPED: OnceLock<BTreeMap<String, ItemDefinition>> = OnceLock::new();
    SHIPPED.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/items.json"
        )))
        .expect("shared/items.json must be valid")
    })
}

/// The catalog the inventory engine answers from.
///
/// These entries exercise the inventory engine against source data that
/// is intentionally outside the small runtime catalog.  They are
/// compiled into tests only and never affect the server binary.
fn catalog() -> &'static BTreeMap<String, ItemDefinition> {
    #[cfg(not(test))]
    {
        shipped_catalog()
    }
    #[cfg(test)]
    {
        static TEST_CATALOG: OnceLock<BTreeMap<String, ItemDefinition>> = OnceLock::new();
        TEST_CATALOG.get_or_init(|| {
            let mut catalog = shipped_catalog().clone();
            let fixture: BTreeMap<String, ItemDefinition> = serde_json::from_str(include_str!(
                concat!(env!("CARGO_MANIFEST_DIR"), "/test-fixtures/items.json")
            ))
            .expect("test item fixture must be valid");
            catalog.extend(fixture);
            catalog
        })
    }
}

/// Whether the compile-time catalog itself carries the id (as opposed to the
/// million-group fallback, which accepts source-shaped ids without a row).
///
/// 含骑宠与椅子（GM `/add` 走这里）：它们在源里不进掉落与商店，因此拿到手只能
/// 靠发放，而「可发放」正是这一轮要验证的前提。**不动** `shipped_catalog_contains`
/// ——图鉴与笔记本的可获得分母按那一份算，加进来会改分母。
pub fn catalog_contains(item_id: &str) -> bool {
    catalog().contains_key(item_id)
        || shipped_mounts().contains_key(item_id)
        || shipped_chairs().contains_key(item_id)
}

/// Whether the **shipped** index carries the id, ignoring the test-only
/// fixture rows.
///
/// Integrity checks that compare the item index against a product artifact
/// (the notebook catalog) must use this one: fixtures are deliberately not
/// part of the shipped index, so counting them as "the index has it" would
/// report a data-pipeline defect for items the product does not contain.
pub fn shipped_catalog_contains(item_id: &str) -> bool {
    shipped_catalog().contains_key(item_id)
}

fn item_definition(item_id: &str) -> Option<&'static ItemDefinition> {
    catalog().get(item_id)
}

// ---------------------------------------------------------------------------
// 骑宠与椅子目录（第 30 / 31 项）
//
// 两张表与 `shared/pets.json` 同一先例：它们在源里是 `notSale:1 / only:1`，
// 不进任何掉落或商店行，因此不在**可达性驱动**的 `items.json` 里（那份表同时是
// 图鉴与笔记本的「可获得分母」，塞进去会改动分母）。这里与 `pet_catalog` 一样
// 从发布产物直读，并在 `items.json` 未命中时回落。
// ---------------------------------------------------------------------------

/// 骑宠装备行（源 `Character/TamingMob/<8位id>.json` 的 `info`）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MountItemDefinition {
    #[serde(default)]
    info: BTreeMap<String, Value>,
    /// 源坐骑档 `TamingMob/<n>.json/info` 的内联副本；缺席＝该件没有已核定的
    /// 骑行数值（源引用了一个不存在的坐骑档），此时**不允许**骑乘。
    #[serde(default)]
    ride: Option<RideStats>,
    #[serde(default)]
    name: Option<String>,
}

/// 源 `TamingMob/<n>.json/info` 的骑行数值。
///
/// `speed` / `jump` 是**百分比口径**（100 = 常规）：24 个坐骑档的 `swim` 全部为
/// `100`，`speed` 取值 80..190、`jump` 85..120 也都以 100 为中枢，说明它们是相对
/// 基准的倍率而不是像素速率；像素换算只发生在 `mounts::walk_speed` 一处。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct RideStats {
    pub speed: i64,
    pub jump: i64,
    pub fs: i64,
    pub swim: i64,
    pub fatigue: i64,
}

#[derive(Deserialize)]
struct MountCatalogFile {
    items: BTreeMap<String, MountItemDefinition>,
}

/// 椅子行（源 `Item/Install/<分组>/<8位id>.json` 的 `info` 与 `String/Ins.json` 文案）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChairItemDefinition {
    #[serde(default)]
    info: BTreeMap<String, Value>,
    #[serde(default)]
    name: Option<String>,
    /// 恢复间隔；**缺席**表示该椅子的间隔未核定（源 `info` 没有间隔字段，只有
    /// 描述文案里写「每N秒」），调用方必须按「不恢复」处理（见 `chairs.rs`）。
    #[serde(default)]
    recovery_interval_ms: Option<i64>,
}

#[derive(Deserialize)]
struct ChairCatalogFile {
    items: BTreeMap<String, ChairItemDefinition>,
}

fn shipped_mounts() -> &'static BTreeMap<String, MountItemDefinition> {
    static SHIPPED: OnceLock<BTreeMap<String, MountItemDefinition>> = OnceLock::new();
    SHIPPED.get_or_init(|| {
        serde_json::from_str::<MountCatalogFile>(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/mounts.json"
        )))
        .expect("shared/mounts.json must be valid")
        .items
    })
}

fn shipped_chairs() -> &'static BTreeMap<String, ChairItemDefinition> {
    static SHIPPED: OnceLock<BTreeMap<String, ChairItemDefinition>> = OnceLock::new();
    SHIPPED.get_or_init(|| {
        serde_json::from_str::<ChairCatalogFile>(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/chairs.json"
        )))
        .expect("shared/chairs.json must be valid")
        .items
    })
}

/// 骑宠装备（源 `info.islot` 为 `Tm` / `Sd`）。
///
/// 判定只用源字段 `tamingMob`，**不用** `islot`、物品名或 id 段：`Tm` 槽同时被
/// 機械師的引擎/手臂/腳/身軀/電晶體占用（`Character/Mechanic/0161200x`，同样
/// `islot = Tm`），按 islot 判会把整套機械師装备误认成坐骑。
///
/// 现行源包下 `Sd` 槽 26 件**全部**不带 `tamingMob`（是「馬鞍」这类搭在坐骑上的
/// 饰品），`Tm` 槽另有 21 件非坐骑（现金件）——它们一律返回 `false`，骑乘请求因此
/// 拿到 `no_mount_equipped`，不会套默认速度。
///
/// 注意「有 `tamingMob`」与「真能骑」不是同一个数：`1932057` 的 `tamingMob = 16`
/// 指向源里缺席的坐骑档，它**算**坐骑（本函数为 `true`，所以骑乘请求会被本模块
/// 接手而不是落进通用使用路径），但 `ride_stats` 为 `None` ⇒ `resolve_mount` 取不到
/// 数值，`mount_toggle` 回 `no_mount_equipped`。888 / 887 的差就是这一件。
pub fn is_mount_item(item_id: &str) -> bool {
    mount_taming_mob(item_id).is_some()
}

/// 骑宠的已核定骑行数值。缺席＝源里没有可依的坐骑档，此时不骑，而不是套默认值。
pub fn ride_stats(item_id: &str) -> Option<RideStats> {
    shipped_mounts().get(item_id).and_then(|mount| mount.ride)
}

/// 骑宠指向的源坐骑档 id（`info.tamingMob`）。
pub fn mount_taming_mob(item_id: &str) -> Option<i64> {
    shipped_mounts()
        .get(item_id)
        .and_then(|mount| value_i64(mount.info.get("tamingMob")))
        .filter(|taming_mob| *taming_mob > 0)
}

/// 设置栏物品（`inventoryType 3`）里可坐的那一件：源里带恢复量的椅子。
pub fn is_chair_item(item_id: &str) -> bool {
    chair_definition(item_id).is_some()
}

fn chair_definition(item_id: &str) -> Option<&'static ChairItemDefinition> {
    shipped_chairs().get(item_id).filter(|chair| {
        info_i64_of(&chair.info, "recoveryHP").unwrap_or(0) > 0
            || info_i64_of(&chair.info, "recoveryMP").unwrap_or(0) > 0
    })
}

/// 坐姿的恢复量与间隔。`interval_ms` 为 `None` ＝ 源文案没写「每N秒」⇒ 间隔未核定，
/// 调用方必须**不恢复**（见 `chairs.rs`）。
pub fn chair_recovery(item_id: &str) -> Option<(i64, i64, Option<i64>)> {
    let chair = chair_definition(item_id)?;
    Some((
        info_i64_of(&chair.info, "recoveryHP").unwrap_or(0),
        info_i64_of(&chair.info, "recoveryMP").unwrap_or(0),
        chair.recovery_interval_ms,
    ))
}

/// `info` 是**已经读进来**的平表；不能借 `info_i64(item_id, key)`——那个函数查的是
/// `items.json`，而骑宠/椅子根本不在那份表里。
fn info_i64_of(info: &BTreeMap<String, Value>, key: &str) -> Option<i64> {
    value_i64(info.get(key))
}

/// The source display name of one item, or `None` when the index carries no
/// name for it.
///
/// Rooted in the **shipped** index on purpose: the notebook classifies against
/// `shipped_catalog_contains`, so a name resolved through the test-augmented
/// catalog could name a row the shipped product does not contain.
pub fn item_name(item_id: &str) -> Option<&'static str> {
    shipped_catalog()
        .get(item_id)
        .and_then(|item| item.name.as_deref())
        .filter(|name| !name.is_empty())
        // 骑宠与椅子不在 items.json（不可达驱动的表，见 `shipped_mounts` 的注释），
        // 但它们的名字是源 `String/Eqp.json` / `String/Ins.json` 的实值，
        // 图鉴与 GM 回执都要用；回落顺序与客户端 `itemName` 逐字同序。
        .or_else(|| {
            shipped_mounts()
                .get(item_id)
                .and_then(|mount| mount.name.as_deref())
                .filter(|name| !name.is_empty())
        })
        .or_else(|| {
            shipped_chairs()
                .get(item_id)
                .and_then(|chair| chair.name.as_deref())
                .filter(|name| !name.is_empty())
        })
}

/// One TMS273 pet row (`shared/pets.json`, generated by
/// `scripts/export_tms273_pet.cjs` from `Item/Pet` + `String/Pet.json`).
/// `life` is the source lifespan in days (GMS/TMS pets live 90 days before
/// reverting to a doll) and `hungry` is the per-pet hunger pace.  Both feed
/// the growth loop in `pets.rs`; the display name drives the snapshot.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetDefinition {
    name: String,
    #[serde(default)]
    life: Option<i64>,
    #[serde(default)]
    hungry: Option<i64>,
}

/// Source hunger pace fallback: fullness -1 per this many minutes while the
/// pet is summoned.  P: the TMS273 `info.hungry` field ships the per-pet
/// value (2 or 3 for the starter family) but no unit; minutes per point keeps
/// a 90-fullness cycle in the 2-3 hour window the classic feeding loop
/// implies and matches the uniform 1/minute community measurement for
/// `hungry == 1`.
pub const PET_HUNGRY_MINUTES_DEFAULT: i64 = 1;
/// Source lifespan fallback in days for rows whose `info.life` is absent.
pub const PET_LIFE_DAYS_DEFAULT: i64 = 90;
/// Pet food (`String/Consume.json` 2120000 寵物食品).  Its effect fields are
/// T facts read from the catalog: `spec.incRepleteness` (+30 fullness) and
/// `spec.incTameness` (+1 closeness); the four assembled general shops sell
/// it at their source price.
pub const PET_FOOD_ITEM: &str = "2120000";

fn pet_catalog() -> &'static BTreeMap<String, PetDefinition> {
    static CATALOG: OnceLock<BTreeMap<String, PetDefinition>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/pets.json"
        )))
        .expect("shared/pets.json must be valid")
    })
}

/// Whether the id belongs to the TMS273 pet family (5000000+ with a source
/// record).  Pet items resolve their tab through the million-group fallback
/// (cash, type 5) already; this check is the source-backed identity gate.
pub fn is_pet(item_id: &str) -> bool {
    pet_catalog().contains_key(item_id.trim_start_matches('0'))
}

/// The source display name of one pet (e.g. `5000000` -> `褐色小貓`).
pub fn pet_name(item_id: &str) -> Option<&'static str> {
    pet_catalog()
        .get(item_id.trim_start_matches('0'))
        .map(|pet| pet.name.as_str())
}

/// The source hunger pace of one pet: fullness -1 per this many minutes.
pub fn pet_hungry_minutes(item_id: &str) -> i64 {
    pet_catalog()
        .get(item_id.trim_start_matches('0'))
        .and_then(|pet| pet.hungry)
        .filter(|minutes| *minutes > 0)
        .unwrap_or(PET_HUNGRY_MINUTES_DEFAULT)
}

/// The source lifespan of one pet in days.
pub fn pet_life_days(item_id: &str) -> i64 {
    pet_catalog()
        .get(item_id.trim_start_matches('0'))
        .and_then(|pet| pet.life)
        .filter(|days| *days > 0)
        .unwrap_or(PET_LIFE_DAYS_DEFAULT)
}

/// Whether the id is the pet food consumable (`2120000` 寵物食品).
pub fn is_pet_food(item_id: &str) -> bool {
    item_id.trim_start_matches('0') == PET_FOOD_ITEM
}

/// Fullness restored by one pet food, straight from `spec.incRepleteness`.
pub fn pet_food_fullness(item_id: &str) -> i64 {
    spec_i64(item_id, "incRepleteness").unwrap_or(30).max(0)
}

/// Closeness granted by one pet food, straight from `spec.incTameness`.
pub fn pet_food_closeness(item_id: &str) -> i64 {
    spec_i64(item_id, "incTameness").unwrap_or(0)
}

/// Private instance metadata carried by a non-stackable cash-pet inventory
/// row.  Keeping it in the existing instance map avoids widening the wire
/// inventory shape; pets have no item-catalog stat tooltip that could expose
/// these keys.
const PET_INSTANCE_ID_KEY: &str = "_petInstanceId";
pub const PET_ACTIVE_KEY: &str = "_petActive";
/// Private per-instance rental deadline (unix seconds).  Cash-shop rows with
/// a source `Period` deliver their items with this key; `World`'s rental
/// sweep removes the whole stack once the wall clock passes it.  Stored in
/// the existing instance map (same pattern as the pet keys) so neither the
/// wire shape nor the inventory table needs a new column.
pub const EXPIRES_AT_KEY: &str = "_expiresAt";
/// One rental day in seconds (`Commodity.img` `Period` unit).
pub const RENTAL_DAY_SECONDS: i64 = 86_400;
const PET_INSTANCE_ID_MAX: i64 = 9_007_199_254_740_991; // JavaScript MAX_SAFE_INTEGER
pub const MAX_ACTIVE_PETS: usize = 3;

/// Private per-instance growth state, carried in the same stats map as the
/// identity keys.  All values are event-driven writes (summon, feed, retire);
/// *displayed* fullness is derived from `_petFullness` + `_petFullnessAt`
/// with the pet's source pace, so a crash or logout never loses minutes of
/// hunger accounting and no periodic write exists.
pub const PET_FULLNESS_KEY: &str = "_petFullness";
pub const PET_FULLNESS_AT_KEY: &str = "_petFullnessAt";
pub const PET_CLOSENESS_KEY: &str = "_petCloseness";
/// Unix seconds when the pet's source lifespan runs out.  Set on first
/// summon; after it passes the pet reverts to a doll (P presentation of the
/// source 90-day rule; 生命水 revival is a future module).
pub const PET_LIFESPAN_END_KEY: &str = "_petLifespanEnd";
pub const PET_DEAD_KEY: &str = "_petDead";
/// Fullness ceiling.  P: the classic cap; the source only authors restores.
pub const PET_FULLNESS_MAX: i64 = 100;
/// At or below this fullness the pet shows its source hungry animation.
/// P display threshold (GMS guide: weakness signs from 50 down; the classic
/// client balloons at the low third).
pub const PET_WEAK_FULLNESS: i64 = 30;
/// Closeness ceiling = the level-30 cumulative requirement of the growth
/// table below, so a maxed pet stops accruing.
pub const PET_CLOSENESS_MAX: i64 = 30_000;
/// Cumulative closeness required for each pet level 1..=30.  P: cross-version
/// community table (52pk 寵物手冊), matching GMS "level 30 needs 30000";
/// TMS273 ships no per-level growth node for pets.
const PET_LEVEL_THRESHOLDS: [i64; 30] = [
    0, 1, 3, 6, 14, 31, 60, 108, 181, 287, 434, 632, 891, 1224, 1642, 2161, 2794, 3555, 4467, 5542,
    6798, 8250, 9950, 11900, 14100, 16600, 19400, 22600, 26100, 30000,
];

/// Pet level (1..=30) reached by a cumulative closeness value.
pub fn pet_level(closeness: i64) -> i64 {
    let mut level = 1;
    for (index, threshold) in PET_LEVEL_THRESHOLDS.iter().enumerate() {
        if closeness >= *threshold {
            level = index as i64 + 1;
        }
    }
    level
}

/// Closeness still needed for the next level; 0 at the level-30 cap.
pub fn pet_closeness_to_next(closeness: i64) -> i64 {
    let level = pet_level(closeness);
    if level >= 30 {
        return 0;
    }
    PET_LEVEL_THRESHOLDS[level as usize] - closeness
}

/// The private stats map of one pet row, if it is a pet.
fn pet_stats(item: &InventoryItem) -> Option<&BTreeMap<String, i64>> {
    is_pet(&item.item_id)
        .then_some(item.stats.as_ref()?)
        .filter(|stats| !stats.is_empty())
}

/// Stored fullness checkpoint (the value at `_petFullnessAt`).  Missing keys
/// mean a brand-new pet: full and starting the clock now.
pub fn pet_stored_fullness(item: &InventoryItem) -> i64 {
    pet_stats(item)
        .and_then(|stats| stats.get(PET_FULLNESS_KEY))
        .copied()
        .unwrap_or(PET_FULLNESS_MAX)
        .clamp(0, PET_FULLNESS_MAX)
}

/// Displayed fullness at `now_seconds`, derived from the stored checkpoint
/// and the pet's source pace.  Fullness only decays while the row is
/// summoned: summon/unsummon rebases the checkpoint, so bag time is free.
pub fn pet_fullness(item: &InventoryItem, now_seconds: i64) -> i64 {
    let stored = pet_stored_fullness(item);
    let at = pet_stats(item)
        .and_then(|stats| stats.get(PET_FULLNESS_AT_KEY))
        .copied()
        .unwrap_or(now_seconds);
    let elapsed = (now_seconds - at).max(0);
    let pace_seconds = pet_hungry_minutes(&item.item_id).max(1) * 60;
    (stored - elapsed / pace_seconds).max(0)
}

/// Cumulative closeness of one pet row.
pub fn pet_closeness(item: &InventoryItem) -> i64 {
    pet_stats(item)
        .and_then(|stats| stats.get(PET_CLOSENESS_KEY))
        .copied()
        .unwrap_or(0)
        .clamp(0, PET_CLOSENESS_MAX)
}

/// Unix seconds when the pet reverts to a doll, if already scheduled.
pub fn pet_lifespan_end(item: &InventoryItem) -> Option<i64> {
    pet_stats(item)
        .and_then(|stats| stats.get(PET_LIFESPAN_END_KEY))
        .copied()
        .filter(|end| *end > 0)
}

/// Whether the pet's lifespan has run out and it is now a doll.
pub fn pet_dead(item: &InventoryItem) -> bool {
    pet_stats(item)
        .and_then(|stats| stats.get(PET_DEAD_KEY))
        .copied()
        == Some(1)
}

/// Write one pet growth key into a row's private stats map.  No-op for
/// non-pet rows; callers decide the value, this only centralises the write.
pub fn set_pet_stat(item: &mut InventoryItem, key: &str, value: i64) {
    if !is_pet(&item.item_id) {
        return;
    }
    item.stats
        .get_or_insert_with(BTreeMap::new)
        .insert(key.to_owned(), value);
}

/// Rebase the fullness checkpoint of one pet row to `fullness` at
/// `now_seconds`.  Callers: summon/unsummon (freeze while bagged) and feed.
pub fn set_pet_fullness(item: &mut InventoryItem, fullness: i64, now_seconds: i64) {
    let clamped = fullness.clamp(0, PET_FULLNESS_MAX);
    set_pet_stat(item, PET_FULLNESS_KEY, clamped);
    set_pet_stat(item, PET_FULLNESS_AT_KEY, now_seconds);
}

/// Add closeness (which may be negative for neglect/overfeed), clamped to
/// the level-30 ceiling and zero.
pub fn add_pet_closeness(item: &mut InventoryItem, delta: i64) {
    let next = (pet_closeness(item) + delta).clamp(0, PET_CLOSENESS_MAX);
    set_pet_stat(item, PET_CLOSENESS_KEY, next);
}

/// Whether the item is the pet food consumable that feeds a summoned pet.
/// Kept next to `is_pet_food` for call sites that branch on both.
#[allow(dead_code)]
pub fn pet_food_item() -> &'static str {
    PET_FOOD_ITEM
}

fn new_pet_instance_id() -> i64 {
    rand::thread_rng().gen_range(1..=PET_INSTANCE_ID_MAX)
}

/// Return the stable identity of one pet item row.
pub fn pet_instance_id(item: &InventoryItem) -> Option<i64> {
    is_pet(&item.item_id)
        .then(|| item.stats.as_ref()?.get(PET_INSTANCE_ID_KEY).copied())
        .flatten()
        .filter(|id| *id > 0)
}

/// The rental deadline (unix seconds) of one inventory row, if it is a
/// time-limited cash purchase.  `None` means the row is permanent.
pub fn item_expires_at(item: &InventoryItem) -> Option<i64> {
    item.stats
        .as_ref()?
        .get(EXPIRES_AT_KEY)
        .copied()
        .filter(|deadline| *deadline > 0)
}

/// Whether one row is a rental whose deadline has passed at wall-clock
/// `now_seconds`.  Permanent rows are never expired.
pub fn rental_expired(item: &InventoryItem, now_seconds: i64) -> bool {
    item_expires_at(item).is_some_and(|deadline| deadline <= now_seconds)
}

/// Whether this persisted pet row is currently summoned.
pub fn pet_active(item: &InventoryItem) -> bool {
    pet_instance_id(item).is_some()
        && item
            .stats
            .as_ref()
            .and_then(|stats| stats.get(PET_ACTIVE_KEY))
            .copied()
            == Some(1)
}

/// Ensure a pet row has private identity metadata. Existing id and active bit
/// always win, so this is safe to call during every auth read/write pass.
pub fn ensure_pet_instance(item: &mut InventoryItem) {
    if !is_pet(&item.item_id) || item.quantity != 1 {
        return;
    }
    let mut stats = item.stats.take().unwrap_or_default();
    let instance_id = stats
        .get(PET_INSTANCE_ID_KEY)
        .copied()
        .filter(|id| *id > 0)
        .unwrap_or_else(new_pet_instance_id);
    stats.insert(PET_INSTANCE_ID_KEY.to_owned(), instance_id);
    let active = stats.get(PET_ACTIVE_KEY).copied().unwrap_or(0);
    stats.insert(PET_ACTIVE_KEY.to_owned(), i64::from(active == 1));
    item.stats = Some(stats);
}

/// Repair missing/duplicated pet identities in one inventory snapshot. A
/// duplicate can only come from a legacy or manually edited save; assigning a
/// fresh id keeps each physical row independently addressable.
pub fn normalize_pet_instances(items: &mut [InventoryItem]) {
    let mut seen = HashSet::new();
    let mut active_count = 0;
    for item in items.iter_mut().filter(|item| is_pet(&item.item_id)) {
        ensure_pet_instance(item);
        let duplicate = pet_instance_id(item).is_some_and(|id| !seen.insert(id));
        if duplicate {
            let mut stats = item.stats.take().unwrap_or_default();
            let mut id = new_pet_instance_id();
            while !seen.insert(id) {
                id = new_pet_instance_id();
            }
            stats.insert(PET_INSTANCE_ID_KEY.to_owned(), id);
            item.stats = Some(stats);
        }
        if pet_active(item) {
            active_count += 1;
            if active_count > MAX_ACTIVE_PETS {
                item.stats
                    .get_or_insert_with(BTreeMap::new)
                    .insert(PET_ACTIVE_KEY.to_owned(), 0);
            }
        }
    }
}

/// Toggle one authoritative pet row. The caller decides how to persist the
/// resulting inventory; this helper only mutates a matching cash-tab row.
/// `now_seconds` rebases the fullness checkpoint: hunger only runs while the
/// pet is summoned, so both transitions freeze the displayed value, and the
/// first summon schedules the source lifespan deadline.
pub fn toggle_pet(
    items: &mut Vec<InventoryItem>,
    source_slot: i16,
    item_id: &str,
    now_seconds: i64,
) -> Result<(), String> {
    if !valid_slot(source_slot) {
        return Err("invalid_slot".to_owned());
    }
    normalize_pet_instances(items);
    let Some(index) = items.iter().position(|item| {
        item.slot == u16::try_from(source_slot).unwrap_or(0)
            && inventory_type(&item.item_id) == Some(5)
            && item.item_id == item_id
            && is_pet(&item.item_id)
    }) else {
        return Err("source_empty".to_owned());
    };
    if pet_active(&items[index]) {
        // Freeze hunger at the current displayed value while the pet waits
        // in the bag; the next summon continues from exactly there.
        let fullness = pet_fullness(&items[index], now_seconds);
        set_pet_fullness(&mut items[index], fullness, now_seconds);
        let stats = items[index].stats.get_or_insert_with(BTreeMap::new);
        stats.insert(PET_ACTIVE_KEY.to_owned(), 0);
        return Ok(());
    }
    if pet_dead(&items[index]) {
        return Err("pet_dead".to_owned());
    }
    let active_count = items.iter().filter(|item| pet_active(item)).count();
    if active_count >= MAX_ACTIVE_PETS {
        return Err("pet_limit".to_owned());
    }
    // Summoning: hunger resumes from the frozen bag checkpoint (bag time is
    // never decayed, the anchor just moves to now) and the source lifespan
    // is scheduled on the first summon ever.
    let fullness = pet_stored_fullness(&items[index]);
    set_pet_fullness(&mut items[index], fullness, now_seconds);
    if pet_lifespan_end(&items[index]).is_none() {
        let days = pet_life_days(&items[index].item_id);
        set_pet_stat(
            &mut items[index],
            PET_LIFESPAN_END_KEY,
            now_seconds + days * 86_400,
        );
    }
    let stats = items[index].stats.get_or_insert_with(BTreeMap::new);
    stats.insert(PET_ACTIVE_KEY.to_owned(), 1);
    Ok(())
}

/// Resolve an item tab from the WZ/catalog identifier.  Development saves can
/// contain IDs not yet present in the small catalog, so retain the source's
/// million-group fallback for those rows.
pub fn inventory_type(item_id: &str) -> Option<u8> {
    if let Some(definition) = item_definition(item_id) {
        return Some(definition.inventory_type);
    }
    let group = item_id.parse::<u32>().ok()?.checked_div(1_000_000)? as u8;
    // T: 910xxxx are 現金商店 consumables (Item/Special/0910.img), which live
    // in the cash tab (5), not a ninth tab; the prefix arithmetic alone would
    // refuse them.  Other 9xxxxxx ids stay unknown.
    if group == 9 {
        let value = item_id.parse::<u32>().ok()?;
        return ((910_0000..=919_9999).contains(&value)).then_some(5);
    }
    valid_inventory_type(group).then_some(group)
}

pub fn valid_inventory_type(inventory_type: u8) -> bool {
    (1..=5).contains(&inventory_type)
}

pub fn valid_slot(slot: i16) -> bool {
    (1..=MAX_SLOT_LIMIT as i16).contains(&slot)
}

pub fn valid_equipment_slot(slot: i16) -> bool {
    (-50..=-1).contains(&slot)
}

/// Whether a local slot is inside the character's *current* tab capacity.
/// Slot-expansion coupons raise a tab's capacity above the 24-slot default,
/// so the protocol shape check (`valid_slot`, up to `MAX_SLOT_LIMIT`) must be
/// narrowed by the world-level capacity before accepting a move/unequip.
pub fn slot_within_capacity(slot: i16, slot_limit: u16) -> bool {
    slot > 0
        && u16::try_from(slot)
            .map(|s| s <= slot_limit)
            .unwrap_or(false)
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).or_else(|| {
        value
            .and_then(Value::as_u64)
            .and_then(|v| i64::try_from(v).ok())
    })
}

fn info_i64(item_id: &str, key: &str) -> Option<i64> {
    item_definition(item_id).and_then(|item| value_i64(item.info.get(key)))
}

pub fn equipment_upgrade_slots(item_id: &str) -> u32 {
    info_i64(item_id, "tuc").unwrap_or(0).max(0) as u32
}

/// T: the source `Item/ItemSellPriceStandard.json` prices Etc items by their
/// `lv` — category 400 is a flat `lv * 2`, so a lv-1 drop is worth 2 mesos.
/// Etc drops carry `info.autoPrice` instead of an authored `price`, and the
/// export that rewrites `items.json` does not backfill it, so the fallback
/// lives here where no re-export can drop it again.
fn auto_price(item_id: &str) -> Option<u64> {
    info_i64(item_id, "autoPrice").filter(|flag| *flag > 0)?;
    let level = info_i64(item_id, "lv").filter(|level| *level > 0)?;
    u64::try_from(level)
        .ok()
        .map(|level| level.saturating_mul(2))
}

/// The catalog `price` of one item, i.e. the same WZ field the NPC shop
/// entries are authored in.  `None` means the item has no recorded value and
/// therefore cannot be sold back to a shop for mesos.
pub fn item_price(item_id: &str) -> Option<u64> {
    info_i64(item_id, "price")
        .and_then(|price| u64::try_from(price.max(0)).ok())
        .filter(|price| *price > 0)
        .or_else(|| auto_price(item_id))
}

/// The arrow family (206xxxx 箭矢/弩箭矢).  The catalog authors `price: 0`
/// for it, so the ordinary percent-of-price payout would round to zero and
/// refuse the sale outright.
pub fn is_arrow(item_id: &str) -> bool {
    item_id
        .parse::<u32>()
        .ok()
        .map(|id| id / 10_000 == 206)
        .unwrap_or(false)
}

/// Flat per-unit shop payout overrides.  Arrows carry no catalog price yet
/// must stay sellable: a shop pays a flat 1 meso per arrow (player-specified
/// rule).  `None` means "no override — use the ordinary price-based payout".
pub fn flat_sell_payout(item_id: &str) -> Option<u64> {
    is_arrow(item_id).then_some(1)
}

/// Whether an item may be handed to an NPC shop.  Source `tradeBlock` /
/// `dropBlock` mark quest and cash items the original never lets a player
/// move out of the inventory, so those stay unsellable.  The WZ `quest` flag
/// marks quest props the same way: a shop never buys them back, even when a
/// data refresh authors a nominal price on one.
pub fn is_unsellable(item_id: &str) -> bool {
    is_drop_restricted(item_id) || is_only(item_id) || info_i64(item_id, "quest").unwrap_or(0) != 0
}

/// Cash items carry no shop value in the original: they are bought with NX,
/// not mesos, so a shop must never pay mesos out for one.
pub fn is_cash_item(item_id: &str) -> bool {
    info_i64(item_id, "cash").unwrap_or(0) != 0
}

/// Return the absolute WZ attributes for a freshly-created equipment
/// instance.  Persisting these values on the instance lets a scroll update
/// survive an equip/unequip or a server restart without re-applying the
/// catalog values on every read.
pub fn equipment_attributes(item_id: &str) -> BTreeMap<String, i64> {
    let Some(definition) = item_definition(item_id) else {
        return BTreeMap::new();
    };
    let mut attributes = BTreeMap::new();
    for key in [
        "incPAD", "incPDD", "incMAD", "incMDD", "incACC", "incEVA", "incHP", "incMP", "incMHP",
        "incMMP", "incSTR", "incDEX", "incINT", "incLUK", "incJump", "incSpeed",
    ] {
        if let Some(value) = value_i64(definition.info.get(key)) {
            attributes.insert(key.to_owned(), value);
        }
    }
    attributes
}

/// Read one final equipment attribute.  Instance stats are authoritative;
/// catalog values are only the fallback for legacy instances.
pub fn equipment_attribute(item: &InventoryItem, key: &str) -> i64 {
    item.stats
        .as_ref()
        .and_then(|stats| stats.get(key).copied())
        .or_else(|| info_i64(&item.item_id, key))
        .unwrap_or(0)
}

/// Fill instance metadata for equipment loaded from a legacy row or created
/// by a reward.  Existing values always win so this helper is safe for
/// already-scrolled equipment.
pub fn ensure_equipment_instance(item: &mut InventoryItem) {
    if !is_equipment(&item.item_id) {
        return;
    }
    let legacy_defaults = item.stats.as_ref().is_none_or(BTreeMap::is_empty)
        && item.upgrade_count.unwrap_or(0) == 0
        && item.remaining_slots.unwrap_or(0) == 0;
    if item.stats.is_none() || legacy_defaults {
        item.stats = Some(equipment_attributes(&item.item_id));
    }
    if item.remaining_slots.is_none() || legacy_defaults {
        item.remaining_slots = Some(equipment_upgrade_slots(&item.item_id));
    }
    if item.upgrade_count.is_none() {
        item.upgrade_count = Some(0);
    }
}

/// The starter items used by the reference beginner profile.  Callers use
/// this only during first-account initialization; unequipping later removes
/// the persisted rows and must never call this helper again.
pub fn starter_equipment() -> Vec<InventoryItem> {
    [(-11_i16, "1302000"), (-5_i16, "1040002")]
        .into_iter()
        .map(|(slot, item_id)| {
            let mut item = InventoryItem {
                slot: slot.unsigned_abs(),
                item_id: item_id.to_owned(),
                quantity: 1,
                ..InventoryItem::default()
            };
            ensure_equipment_instance(&mut item);
            item
        })
        .collect()
}

/// The starter *backpack* items granted once on first account initialization,
/// alongside `starter_equipment`.  These land in the ordinary inventory (not
/// the equipped rows).  A single equip-tab slot-expansion coupon gives a fresh
/// beginner a concrete way to exercise the slot-expansion path and keeps the
/// "use" tab non-empty from the very first login.
pub fn starter_items() -> Vec<InventoryItem> {
    // 2430768 = 裝備欄 8格擴充券 (inventoryType 2, slotExpand 1).  Placed at
    // the *end* of the default 24-slot use tab so it does not collide with
    // unit-test fixtures that fill slot 1 of the use tab.  Quantity 1; not
    // equipment, so no instance metadata.
    [("2430768", SLOT_LIMIT)]
        .into_iter()
        .map(|(item_id, slot)| InventoryItem {
            slot,
            item_id: item_id.to_owned(),
            quantity: 1,
            ..InventoryItem::default()
        })
        .collect()
}

pub fn item_success_rate(item_id: &str) -> Option<u32> {
    info_i64(item_id, "success").and_then(|value| u32::try_from(value.max(0)).ok())
}

fn spec_i64(item_id: &str, key: &str) -> Option<i64> {
    item_definition(item_id).and_then(|item| value_i64(item.spec.get(key)))
}

pub fn item_slot_max(item_id: &str) -> u32 {
    // Cash pets are physical instances.  They may share an item id, but each
    // row carries its own persistent identity and must never be merged.
    if is_pet(item_id) {
        return 1;
    }
    item_definition(item_id)
        .map(|item| item.slot_max)
        .unwrap_or_else(|| if is_equipment(item_id) { 1 } else { 100 })
        .max(1)
}

pub fn is_equipment(item_id: &str) -> bool {
    inventory_type(item_id) == Some(1)
}

/// Only the throwing-star family (207xxxx 海星鏢/木製陀螺) keeps the source's
/// recharge shape: one non-merging stack per slot.  彈丸 (233xxxx) used to sit
/// in this set too, which is why it could never bundle in the inventory; the
/// player-specified rule stacks it like arrows instead, and the catalog's
/// authored `slotMax: 800` still caps each merged stack.
pub fn is_rechargeable(item_id: &str) -> bool {
    item_id
        .parse::<u32>()
        .ok()
        .map(|id| id / 10_000 == 207)
        .unwrap_or(false)
}

pub fn is_drop_restricted(item_id: &str) -> bool {
    catalog_info_i64(item_id, "tradeBlock").unwrap_or(0) != 0
        || catalog_info_i64(item_id, "dropBlock").unwrap_or(0) != 0
}

pub fn consume_on_pickup(item_id: &str) -> bool {
    spec_i64(item_id, "consumeOnPickup").unwrap_or(0) != 0
}

pub fn is_only(item_id: &str) -> bool {
    catalog_info_i64(item_id, "only").unwrap_or(0) != 0
}

/// `info` 字段的统一读取口径：`items.json` → 骑宠 → 椅子。
///
/// 三张表都是源目录、同名字段同一含义；少了这一层，`is_only` 与
/// `is_drop_restricted` 会对着骑宠/椅子读空——而 `only:1 / tradeBlock:1` 就在源里
/// 写着——于是同一件东西会在「能不能再拿一份、能不能丢」上给出与源相反的答案。
fn catalog_info_i64(item_id: &str, key: &str) -> Option<i64> {
    info_i64(item_id, key)
        .or_else(|| {
            shipped_mounts()
                .get(item_id)
                .and_then(|mount| info_i64_of(&mount.info, key))
        })
        .or_else(|| {
            shipped_chairs()
                .get(item_id)
                .and_then(|chair| info_i64_of(&chair.info, key))
        })
}

/// The TMS273 slot-expansion coupon family.  `info.slotExpand` names the tab a
/// coupon grows (1=equip, 2=use, 3=setup, 4=etc); a plain consumable has no
/// such field and returns `None`.  The source also authors `info.notConsume`
/// to keep a coupon in the inventory after use, but those are script-driven
/// (an NPC runs `consume_243xxxx`); the runtime executes only the direct
/// double-click form, which is consumed on use.
pub fn slot_expand_target(item_id: &str) -> Option<u8> {
    let kind = inventory_type(item_id)?;
    if kind != 2 {
        return None;
    }
    info_i64(item_id, "slotExpand")
        .and_then(|value| u8::try_from(value).ok())
        .filter(|value| (1..=4).contains(value))
}

/// The source's `EquipSlot` values, kept as the negative slots used by the
/// inventory protocol for an equipped item.
///
/// 骑宠的 `islot` 只在 `mounts.json` 里（它们不在 `items.json`），因此这里多一层
/// **查找回落**。回落**不新建槽位口径**：`Tm`/`Sd` 仍在下面这同一张 match 里解析，
/// 与 `1612000` 这类从 `items.json` 走进来的機械師部件共用同一句。
pub fn equipment_slot(item_id: &str) -> Option<i16> {
    let slot = item_definition(item_id)
        .and_then(|item| item.info.get("islot"))
        .and_then(Value::as_str)
        .or_else(|| {
            shipped_mounts()
                .get(item_id)
                .and_then(|mount| mount.info.get("islot"))
                .and_then(Value::as_str)
        })?;
    let slot = match slot {
        "Cp" | "HrCp" => -1,
        "Af" => -2,
        "Ay" => -3,
        "Ae" => -4,
        "Ma" | "MaPn" => -5,
        "Pn" => -6,
        "So" => -7,
        "GlGw" | "Gv" => -8,
        "Sr" => -9,
        "Si" => -10,
        "Wp" | "WpSi" | "WpSp" => -11,
        "Ri" => -12,
        "Ri2" => -13,
        "Ri3" => -15,
        "Ri4" => -16,
        "Pe" => -17,
        "Tm" => -18,
        "Sd" => -19,
        "Me" => -49,
        // TMS273 Accessory ships both badge spellings (Be 233 rows, Ba 156 rows).
        "Ba" | "Be" => -50,
        _ => return None,
    };
    Some(slot)
}

fn is_longcoat(item_id: &str) -> bool {
    item_definition(item_id)
        .and_then(|item| item.info.get("islot"))
        .and_then(Value::as_str)
        == Some("MaPn")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EquipmentStats {
    pub level: u32,
    pub job: u32,
    pub strength: i64,
    pub dexterity: i64,
    pub intelligence: i64,
    pub luck: i64,
}

fn meets_requirements(item_id: &str, stats: EquipmentStats) -> bool {
    let req_job = info_i64(item_id, "reqJob").unwrap_or(0).max(0) as u32;
    let req_level = info_i64(item_id, "reqLevel").unwrap_or(0).max(0) as u32;
    let req_strength = info_i64(item_id, "reqSTR").unwrap_or(0).max(0);
    let req_dexterity = info_i64(item_id, "reqDEX").unwrap_or(0).max(0);
    let req_intelligence = info_i64(item_id, "reqINT").unwrap_or(0).max(0);
    let req_luck = info_i64(item_id, "reqLUK").unwrap_or(0).max(0);
    (req_job == 0
        || (stats.job != 0
            && ((stats.job / 100) % 10) >= 1
            && (req_job & (1 << (((stats.job / 100) % 10) - 1))) != 0))
        && stats.level >= req_level
        && stats.strength >= req_strength
        && stats.dexterity >= req_dexterity
        && stats.intelligence >= req_intelligence
        && stats.luck >= req_luck
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InventoryError {
    InvalidInventoryType,
    InvalidSlot,
    InvalidEquipmentSlot,
    SourceEmpty,
    QuantityMissing,
    QuantityMismatch,
    QuantityOverflow,
    InventoryFull,
    UnknownItem,
    /// `is_only` 物品（唯一装备/坐骑类）在背包、装备栏或怪物卡册里已经
    /// 有一份时再发放。此前这个拒绝只存在于 `add_inventory_tx` 的
    /// `&'static str` 通道里（审查 §7 增量 3 前置：拒绝必须先有类型），
    /// 增量 4 把它收进本枚举，wire 码保持 `item_unavailable` 不变。
    ItemUnavailable,
    ItemNotUsable,
    RequirementsNotMet,
    LegendarySpiritRequired,
    SlotExpandMax,
    /// 骑乘与坐姿是**会话状态**：没有可落库的字段，因此不存在「持久化事务里的
    /// 使用分支」。世界侧在事务之前就拦截并答复（`inventory_ops.rs`），走到这里
    /// 说明有调用方绕过了世界侧——此时必须回一个**具名**结果：末尾那个
    /// `InvalidInventoryType` 的含义是「栏位非法」，而设置栏(3)与装备槽(−18/−19)
    /// 都是合法栏位，用它回答等于把合法说成非法。
    SessionStateOnly,
}

impl InventoryError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidInventoryType => "invalid_inventory_type",
            Self::InvalidSlot => "invalid_slot",
            Self::InvalidEquipmentSlot => "invalid_equipment_slot",
            Self::SourceEmpty => "source_empty",
            Self::QuantityMissing => "invalid_quantity",
            Self::QuantityMismatch => "quantity_mismatch",
            Self::QuantityOverflow => "quantity_overflow",
            Self::InventoryFull => "inventory_full",
            Self::UnknownItem => "unknown_item",
            Self::ItemUnavailable => "item_unavailable",
            Self::ItemNotUsable => "item_not_usable",
            Self::RequirementsNotMet => "requirements_not_met",
            Self::LegendarySpiritRequired => "legendary_spirit_required",
            Self::SlotExpandMax => "slot_expand_max",
            Self::SessionStateOnly => "session_state_only",
        }
    }
}

fn item_index(items: &[InventoryItem], kind: u8, slot: i16) -> Option<usize> {
    items.iter().position(|item| {
        item.slot == u16::try_from(slot).unwrap_or(0) && inventory_type(&item.item_id) == Some(kind)
    })
}

fn occupied(items: &[InventoryItem], kind: u8, slot: u16) -> bool {
    items
        .iter()
        .any(|item| item.slot == slot && inventory_type(&item.item_id) == Some(kind))
}

fn stackable(kind: u8, item_id: &str) -> bool {
    kind != 1 && kind != 5 && !is_rechargeable(item_id)
}

/// Move one complete source stack.  For a regular tab, equal stackable IDs
/// merge up to the catalog slotMax; overflow remains in the source slot.  The
/// equip transition is handled by `equip_items`/`unequip_items` below.
///
/// 增量 4（审查 §7）：这批 `&mut Vec` 原语从 `pub` 收窄为 `pub(crate)`——
/// 它们是「内存权威」的内部构件，不是仓库对外契约；crate 外不存在消费者，
/// 由 `scripts/check_inventory_surface.cjs` 连同调用点名单一起钉住。
pub(crate) fn move_items(
    items: &mut Vec<InventoryItem>,
    kind: u8,
    from_slot: i16,
    to_slot: i16,
    quantity: u32,
) -> Result<(), InventoryError> {
    if !valid_inventory_type(kind) {
        return Err(InventoryError::InvalidInventoryType);
    }
    if !valid_slot(from_slot) || !valid_slot(to_slot) {
        return Err(InventoryError::InvalidSlot);
    }
    let Some(source_index) = item_index(items, kind, from_slot) else {
        return Err(InventoryError::SourceEmpty);
    };
    let source_quantity = items[source_index].quantity;
    if source_quantity == 0 {
        return Err(InventoryError::SourceEmpty);
    }
    if quantity == 0 {
        return Err(InventoryError::QuantityMissing);
    }
    if quantity != source_quantity {
        return Err(InventoryError::QuantityMismatch);
    }
    if from_slot == to_slot {
        return Ok(());
    }

    let target_index = item_index(items, kind, to_slot);
    match target_index {
        None => items[source_index].slot = u16::try_from(to_slot).unwrap_or(0),
        Some(target_index)
            if items[target_index].item_id == items[source_index].item_id
                && stackable(kind, &items[source_index].item_id) =>
        {
            let target_quantity = items[target_index].quantity;
            let max = item_slot_max(&items[source_index].item_id);
            let room = max.saturating_sub(target_quantity);
            let moved = room.min(source_quantity);
            if moved == 0 {
                return Ok(());
            }
            items[target_index].quantity = target_quantity
                .checked_add(moved)
                .ok_or(InventoryError::QuantityOverflow)?;
            if moved == source_quantity {
                items.remove(source_index);
            } else {
                items[source_index].quantity -= moved;
            }
        }
        Some(target_index) => {
            items[source_index].slot = u16::try_from(to_slot).unwrap_or(0);
            items[target_index].slot = u16::try_from(from_slot).unwrap_or(0);
        }
    }
    sort_items(items);
    Ok(())
}

pub(crate) fn remove_items(
    items: &mut Vec<InventoryItem>,
    kind: u8,
    slot: i16,
    quantity: u32,
) -> Result<(String, u32), InventoryError> {
    if !valid_inventory_type(kind) {
        return Err(InventoryError::InvalidInventoryType);
    }
    if !valid_slot(slot) {
        return Err(InventoryError::InvalidSlot);
    }
    if quantity == 0 {
        return Err(InventoryError::QuantityMissing);
    }
    let Some(index) = item_index(items, kind, slot) else {
        return Err(InventoryError::SourceEmpty);
    };
    let item = &items[index];
    if item.quantity == 0 {
        return Err(InventoryError::SourceEmpty);
    }
    if quantity > item.quantity {
        return Err(InventoryError::QuantityMismatch);
    }
    let item_id = item.item_id.clone();
    if quantity == item.quantity {
        items.remove(index);
    } else {
        items[index].quantity -= quantity;
    }
    sort_items(items);
    Ok((item_id, quantity))
}

/// Add a server-authoritative reward/drop.  Existing stacks are filled to
/// slotMax, then additional stacks are allocated in the first free local
/// slots.  The clone makes a full-tab failure atomic for the caller.
pub(crate) fn add_items(
    items: &mut Vec<InventoryItem>,
    item_id: String,
    quantity: u32,
    slot_limit: u16,
) -> Result<u16, InventoryError> {
    add_items_expiring(items, item_id, quantity, slot_limit, None)
}

/// Add a reward carrying a rental deadline (unix seconds).  Expiring stacks
/// only merge into stacks with the *same* deadline, so a 7-day rental never
/// tops up a permanent stack of the same item, and each delivery keeps its
/// own deadline.  `None` behaves exactly like [`add_items`].
pub(crate) fn add_items_expiring(
    items: &mut Vec<InventoryItem>,
    item_id: String,
    quantity: u32,
    slot_limit: u16,
    expires_at: Option<i64>,
) -> Result<u16, InventoryError> {
    if item_id.is_empty() || quantity == 0 {
        return Err(InventoryError::QuantityMissing);
    }
    let kind = inventory_type(&item_id).ok_or(InventoryError::UnknownItem)?;
    if item_id == "0" {
        return Err(InventoryError::UnknownItem);
    }
    let mut next = items.clone();
    let mut remaining = quantity;
    let mut first_slot = None;
    let can_stack = stackable(kind, &item_id);
    if can_stack {
        let max = item_slot_max(&item_id);
        for item in next
            .iter_mut()
            .filter(|item| item.item_id == item_id && item_expires_at(item) == expires_at)
        {
            if remaining == 0 {
                break;
            }
            let moved = max.saturating_sub(item.quantity).min(remaining);
            if moved > 0 {
                item.quantity = item
                    .quantity
                    .checked_add(moved)
                    .ok_or(InventoryError::QuantityOverflow)?;
                remaining -= moved;
                first_slot.get_or_insert(item.slot);
            }
        }
    }
    let max = if can_stack {
        item_slot_max(&item_id)
    } else {
        1
    };
    while remaining > 0 {
        let slot = (1..=slot_limit)
            .find(|slot| !occupied(&next, kind, *slot))
            .ok_or(InventoryError::InventoryFull)?;
        let amount = remaining.min(max);
        let mut added = InventoryItem {
            slot,
            item_id: item_id.clone(),
            quantity: amount,
            ..InventoryItem::default()
        };
        ensure_equipment_instance(&mut added);
        ensure_pet_instance(&mut added);
        // Stamped after the instance repairs so an expiring rental equipment
        // keeps its catalog attribute defaults alongside the deadline.
        if let Some(deadline) = expires_at {
            let stats = added.stats.get_or_insert_with(BTreeMap::new);
            stats.insert(EXPIRES_AT_KEY.to_owned(), deadline);
        }
        next.push(added);
        first_slot.get_or_insert(slot);
        remaining -= amount;
    }
    normalize_pet_instances(&mut next);
    sort_items(&mut next);
    *items = next;
    first_slot.ok_or(InventoryError::InventoryFull)
}

/// Add a reward while retaining metadata belonging to one equipment
/// instance.  Ordinary stackable items deliberately ignore the metadata;
/// equipment uses it for final attributes and remaining scroll slots.
pub fn add_item_instance(
    items: &mut Vec<InventoryItem>,
    item_id: String,
    quantity: u32,
    slot_limit: u16,
    stats: Option<&BTreeMap<String, i64>>,
    remaining_slots: Option<u32>,
    upgrade_count: Option<u32>,
) -> Result<u16, InventoryError> {
    let slot = add_items(items, item_id.clone(), quantity, slot_limit)?;
    if is_equipment(&item_id) || is_pet(&item_id) {
        if let Some(item) = items.iter_mut().find(|item| {
            item.slot == slot
                && inventory_type(&item.item_id) == inventory_type(&item_id)
                && item.item_id == item_id
        }) {
            if let Some(stats) = stats {
                item.stats = Some(stats.clone());
            }
            if is_equipment(&item_id) {
                if let Some(remaining_slots) = remaining_slots {
                    item.remaining_slots = Some(remaining_slots);
                }
                if let Some(upgrade_count) = upgrade_count {
                    item.upgrade_count = Some(upgrade_count);
                }
                ensure_equipment_instance(item);
            } else {
                ensure_pet_instance(item);
            }
        }
    }
    normalize_pet_instances(items);
    Ok(slot)
}

/// Gather merges compatible stacks and compacts only one local inventory tab.
pub fn gather_items(items: &mut Vec<InventoryItem>, kind: u8) -> Result<(), InventoryError> {
    if !valid_inventory_type(kind) {
        return Err(InventoryError::InvalidInventoryType);
    }
    let mut next = items.clone();
    sort_category(&mut next, kind);
    let mut index = 0;
    while index < next.len() {
        if inventory_type(&next[index].item_id) != Some(kind)
            || !stackable(kind, &next[index].item_id)
        {
            index += 1;
            continue;
        }
        let item_id = next[index].item_id.clone();
        let index_deadline = item_expires_at(&next[index]);
        let max = item_slot_max(&item_id);
        let mut other = index + 1;
        while other < next.len() {
            // Rental stacks never merge across deadlines: a 7-day stack must
            // not top up a permanent one (or a different rental window).
            if next[other].item_id == item_id && item_expires_at(&next[other]) == index_deadline {
                let room = max.saturating_sub(next[index].quantity);
                let moved = room.min(next[other].quantity);
                next[index].quantity += moved;
                next[other].quantity -= moved;
                if next[other].quantity == 0 {
                    next.remove(other);
                    continue;
                }
            }
            other += 1;
        }
        index += 1;
    }
    compact_category(&mut next, kind);
    *items = next;
    Ok(())
}

/// Sort one tab by numeric item ID, retaining stable slot order for equal IDs.
pub fn sort_category(items: &mut Vec<InventoryItem>, kind: u8) {
    let positions: Vec<usize> = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| (inventory_type(&item.item_id) == Some(kind)).then_some(index))
        .collect();
    let mut category: Vec<InventoryItem> = positions
        .iter()
        .map(|&index| items[index].clone())
        .collect();
    category.sort_by(|a, b| {
        a.item_id
            .parse::<u32>()
            .unwrap_or(u32::MAX)
            .cmp(&b.item_id.parse::<u32>().unwrap_or(u32::MAX))
            .then_with(|| a.slot.cmp(&b.slot))
    });
    for (slot, item) in category.iter_mut().enumerate() {
        item.slot = u16::try_from(slot + 1).unwrap_or(SLOT_LIMIT);
    }
    for (position, item) in positions.into_iter().zip(category) {
        items[position] = item;
    }
    sort_items(items);
}

fn compact_category(items: &mut Vec<InventoryItem>, kind: u8) {
    let mut slot = 1u16;
    for item in items
        .iter_mut()
        .filter(|item| inventory_type(&item.item_id) == Some(kind))
    {
        item.slot = slot;
        slot += 1;
    }
    sort_items(items);
}

/// Sort all tabs while retaining each category's local slot numbers.
pub fn sort_items(items: &mut Vec<InventoryItem>) {
    items.sort_by_key(|item| (inventory_type(&item.item_id).unwrap_or(0), item.slot));
}

/// One authored consumable-recovery effect.
///
/// The original has two independent recovery forms and an item may use either
/// or both at once (T, read from the TMS273.7 `Item/Consume` `spec` node):
///   * **flat**  — `spec.hp` / `spec.mp`, an absolute amount (紅色藥水 hp=50);
///   * **rate**  — `spec.hpR` / `spec.mpR`, a percentage of the character's
///     own maximum pool (超級藥水 hpR=100).  A percentage heal is why the
///     same potion is worth using at level 1 and at level 200, and it is also
///     why the original puts those specific items behind a cooldown.
///
/// Percentages are resolved against the caller's maximum pool rather than
/// being baked into the catalog, so equipment and skill bonuses that raise
/// max HP/MP are honoured without re-exporting any item data.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UseEffect {
    /// Flat HP restored, always >= 0.
    pub hp: i64,
    /// Flat MP restored, always >= 0.
    pub mp: i64,
    /// HP restored as a whole-percent share of max HP (`hpR` = 100 → full).
    pub hp_percent: i64,
    /// MP restored as a whole-percent share of max MP.
    pub mp_percent: i64,
    /// Authored use cooldown in milliseconds; `None` means the item has none.
    pub cooldown_ms: Option<u64>,
}

impl UseEffect {
    /// Resolve the effect into concrete amounts for one body.
    ///
    /// `rounding` is deliberately floor-with-a-minimum-of-1 for the percentage
    /// part: a positive percentage must always restore at least 1 point, so a
    /// low-level character is never handed a potion that silently does
    /// nothing.  Flat and percentage parts are added, and the caller clamps
    /// the total to the maximum pool.
    pub fn resolve(&self, max_hp: i64, max_mp: i64) -> (i64, i64) {
        let percent_hp = if self.hp_percent > 0 {
            (max_hp.max(0) * self.hp_percent / 100).max(1)
        } else {
            0
        };
        let percent_mp = if self.mp_percent > 0 {
            (max_mp.max(0) * self.mp_percent / 100).max(1)
        } else {
            0
        };
        (self.hp + percent_hp, self.mp + percent_mp)
    }

    /// True when the item restores anything at all.
    pub fn recovers(&self) -> bool {
        self.hp > 0 || self.mp > 0 || self.hp_percent > 0 || self.mp_percent > 0
    }
}

/// Read the authored recovery effect of a consumable.
///
/// Returns `ItemNotUsable` when the item restores nothing — that is the
/// original's behaviour for arrows, bullets, and other Use-tab items that
/// are consumed by the attack system rather than by a drink.
pub fn use_effect(item_id: &str) -> Result<UseEffect, InventoryError> {
    if inventory_type(item_id) != Some(2) {
        return Err(InventoryError::ItemNotUsable);
    }
    let effect = UseEffect {
        hp: spec_i64(item_id, "hp").unwrap_or(0).max(0),
        mp: spec_i64(item_id, "mp").unwrap_or(0).max(0),
        hp_percent: spec_i64(item_id, "hpR").unwrap_or(0).max(0),
        mp_percent: spec_i64(item_id, "mpR").unwrap_or(0).max(0),
        cooldown_ms: spec_i64(item_id, "time")
            .and_then(|value| u64::try_from(value.max(0)).ok())
            .filter(|value| *value > 0),
    };
    if !effect.recovers() {
        return Err(InventoryError::ItemNotUsable);
    }
    Ok(effect)
}

/// The `spec.moveTo` sentinel the source uses for 回家卷軸: "send me to this
/// map's own `returnMap`".  The original never writes a town id into that item,
/// so its destination cannot be read off the catalog — only off the map the
/// character is standing on when the scroll is used.
pub const RETURN_MAP_SENTINEL: i64 = 999_999_999;

/// Where a map-move consumable sends the body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MapMoveTarget {
    /// `spec.moveTo = 999999999` — the current map's authored `returnMap`.
    ReturnMap,
    /// `spec.moveTo = <id>` — the town the item names outright, in the
    /// 9-digit form the rest of the runtime speaks.
    Map(String),
}

/// Read the authored destination of a map-move consumable.
///
/// Only `spec.moveTo` marks this family (2030000 回家卷軸, 2030001
/// 維多利亞港卷軸, …).  A recovery item authors `hp`/`mp` and an upgrade scroll
/// authors `incPAD`-style keys, so the three families stay mutually exclusive
/// and an item can never be both "drinkable" and "a teleport".
pub fn move_target(item_id: &str) -> Option<MapMoveTarget> {
    if inventory_type(item_id) != Some(2) {
        return None;
    }
    let value = spec_i64(item_id, "moveTo")?;
    if value <= 0 {
        return None;
    }
    if value == RETURN_MAP_SENTINEL {
        return Some(MapMoveTarget::ReturnMap);
    }
    // A fixed destination is an ordinary map id.  Anything at or above the
    // sentinel is not a map the runtime could ever load, so it is not offered
    // as a destination at all rather than being padded into a fake map id.
    (value < RETURN_MAP_SENTINEL).then(|| MapMoveTarget::Map(format!("{value:09}")))
}

pub fn scroll_effect(item_id: &str) -> Option<BTreeMap<String, i64>> {
    if inventory_type(item_id) != Some(2) {
        return None;
    }
    let definition = item_definition(item_id)?;
    let mut effects = BTreeMap::new();
    for key in [
        "incPAD", "incPDD", "incMAD", "incMDD", "incACC", "incEVA", "incHP", "incMP", "incMHP",
        "incMMP", "incSTR", "incDEX", "incINT", "incLUK", "incJump", "incSpeed",
    ] {
        if let Some(value) = value_i64(definition.info.get(key)) {
            effects.insert(key.to_owned(), value);
        }
    }
    (!effects.is_empty()).then_some(effects)
}

/// Return the equipment family encoded in an ordinary scroll ID.  GMS83
/// stores the target family in `(scrollId / 100) % 100 + 100` (for example,
/// 2040002 targets category 100 headwear).
pub fn scroll_target_category(scroll_id: &str) -> Option<u32> {
    let id = scroll_id.parse::<u32>().ok()?;
    Some((id / 100) % 100 + 100)
}

pub fn scroll_applies_to_item(scroll_id: &str, item_id: &str) -> bool {
    let Some(target_category) = scroll_target_category(scroll_id) else {
        return false;
    };
    item_id
        .parse::<u32>()
        .map(|id| id / 10_000 == target_category)
        .unwrap_or(false)
}

/// Apply one scroll to an equipped item in memory.  This mirrors the
/// persistent `Store::use_item` path so worlds that run without SQLite keep
/// the same target validation, Legendary Spirit rule, success/failure result,
/// and instance metadata updates.
pub fn apply_scroll(
    equipped: &mut Vec<InventoryItem>,
    scroll_id: &str,
    target_slot: Option<i16>,
    target_item_id: Option<&str>,
) -> Result<bool, InventoryError> {
    let Some(target_slot) = target_slot else {
        return Err(InventoryError::InvalidEquipmentSlot);
    };
    if valid_slot(target_slot) {
        return Err(InventoryError::LegendarySpiritRequired);
    }
    if !valid_equipment_slot(target_slot) {
        return Err(InventoryError::InvalidEquipmentSlot);
    }
    let Some(target_item_id) = target_item_id else {
        return Err(InventoryError::UnknownItem);
    };
    let Some(target_index) = equipped_index(equipped, target_slot) else {
        return Err(InventoryError::SourceEmpty);
    };
    if equipped[target_index].item_id != target_item_id {
        return Err(InventoryError::RequirementsNotMet);
    }
    if !scroll_applies_to_item(scroll_id, target_item_id) {
        return Err(InventoryError::RequirementsNotMet);
    }
    let Some(effects) = scroll_effect(scroll_id) else {
        return Err(InventoryError::ItemNotUsable);
    };

    let mut target = equipped[target_index].clone();
    ensure_equipment_instance(&mut target);
    let remaining = target.remaining_slots.unwrap_or(0);
    if remaining == 0 {
        return Err(InventoryError::RequirementsNotMet);
    }
    let success_rate = item_success_rate(scroll_id).unwrap_or(0);
    let success = rand::thread_rng().gen_range(0..100) < success_rate;
    if success {
        let attributes = target.stats.get_or_insert_with(BTreeMap::new);
        for (key, value) in effects {
            *attributes.entry(key).or_insert(0) += value;
        }
        target.upgrade_count = Some(target.upgrade_count.unwrap_or(0).saturating_add(1));
    }
    target.remaining_slots = Some(remaining.saturating_sub(1));
    equipped[target_index] = target;
    Ok(success)
}

fn equipped_index(equipped: &[InventoryItem], slot: i16) -> Option<usize> {
    equipped
        .iter()
        .position(|item| item.slot == slot.unsigned_abs())
}

pub fn equip_items(
    inventory: &mut Vec<InventoryItem>,
    equipped: &mut Vec<InventoryItem>,
    stats: EquipmentStats,
    from_slot: i16,
    to_slot: i16,
    slot_limit: u16,
) -> Result<(String, u32), InventoryError> {
    if !valid_slot(from_slot) {
        return Err(InventoryError::InvalidSlot);
    }
    if !valid_equipment_slot(to_slot) {
        return Err(InventoryError::InvalidEquipmentSlot);
    }
    let Some(source_index) = inventory.iter().position(|item| {
        item.slot == u16::try_from(from_slot).unwrap_or(0) && is_equipment(&item.item_id)
    }) else {
        return Err(InventoryError::SourceEmpty);
    };
    let source = inventory[source_index].clone();
    if source.quantity != 1 {
        return Err(InventoryError::QuantityMismatch);
    }
    let expected_slot = equipment_slot(&source.item_id).ok_or(InventoryError::UnknownItem)?;
    if expected_slot != to_slot {
        return Err(InventoryError::InvalidEquipmentSlot);
    }
    if !meets_requirements(&source.item_id, stats) {
        return Err(InventoryError::RequirementsNotMet);
    }
    let mut next_inventory = inventory.clone();
    let mut next_equipped = equipped.clone();
    next_inventory.remove(source_index);
    let extra_slot = if is_longcoat(&source.item_id) {
        Some(-6)
    } else if to_slot == -6 {
        equipped_index(&next_equipped, -5)
            .filter(|&index| is_longcoat(&next_equipped[index].item_id))
            .map(|_| -5)
    } else {
        None
    };
    // P interaction adapter: return conflicts to the source/free slots atomically.
    for slot in once(to_slot).chain(extra_slot) {
        if let Some(index) = equipped_index(&next_equipped, slot) {
            let mut displaced = next_equipped.remove(index);
            let destination = once(u16::try_from(from_slot).unwrap_or(0))
                .chain(1..=slot_limit)
                .find(|slot| !occupied(&next_inventory, 1, *slot))
                .ok_or(InventoryError::InventoryFull)?;
            displaced.slot = destination;
            next_inventory.push(displaced);
        }
    }
    let mut equipped_source = source.clone();
    ensure_equipment_instance(&mut equipped_source);
    equipped_source.slot = to_slot.unsigned_abs();
    equipped_source.quantity = 1;
    next_equipped.push(equipped_source);
    sort_items(&mut next_inventory);
    next_equipped.sort_by_key(|item| item.slot);
    *inventory = next_inventory;
    *equipped = next_equipped;
    Ok((source.item_id, 1))
}

pub fn unequip_items(
    inventory: &mut Vec<InventoryItem>,
    equipped: &mut Vec<InventoryItem>,
    from_slot: i16,
    to_slot: i16,
    slot_limit: u16,
) -> Result<(String, u32), InventoryError> {
    if !valid_equipment_slot(from_slot) {
        return Err(InventoryError::InvalidEquipmentSlot);
    }
    if !slot_within_capacity(to_slot, slot_limit) {
        return Err(InventoryError::InvalidSlot);
    }
    let Some(source_index) = equipped_index(equipped, from_slot) else {
        return Err(InventoryError::SourceEmpty);
    };
    let source = equipped[source_index].clone();
    let mut next_inventory = inventory.clone();
    let mut next_equipped = equipped.clone();
    next_equipped.remove(source_index);
    if item_index(&next_inventory, 1, to_slot).is_some() {
        return Err(InventoryError::InventoryFull);
    }
    let mut inventory_source = source.clone();
    inventory_source.slot = u16::try_from(to_slot).unwrap_or(0);
    inventory_source.quantity = 1;
    next_inventory.push(inventory_source);
    sort_items(&mut next_inventory);
    next_equipped.sort_by_key(|item| item.slot);
    *inventory = next_inventory;
    *equipped = next_equipped;
    Ok((source.item_id, 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn item(slot: u16, item_id: &str, quantity: u32) -> InventoryItem {
        InventoryItem {
            slot,
            item_id: item_id.into(),
            quantity,
            ..InventoryItem::default()
        }
    }

    #[test]
    fn category_local_move_does_not_cross_tabs() {
        let mut items = vec![item(1, "4000019", 3), item(1, "2000000", 4)];
        move_items(&mut items, 4, 1, 2, 3).unwrap();
        assert!(items
            .iter()
            .any(|item| item.item_id == "4000019" && item.slot == 2));
        assert!(items
            .iter()
            .any(|item| item.item_id == "2000000" && item.slot == 1));
    }

    #[test]
    fn move_respects_catalog_stack_max_and_add_splits() {
        let mut items = vec![item(1, "4000019", 190), item(2, "4000019", 10)];
        move_items(&mut items, 4, 1, 2, 190).unwrap();
        assert_eq!(items.iter().find(|i| i.slot == 2).unwrap().quantity, 200);
        assert!(items.iter().all(|i| i.slot != 1));

        let mut items = vec![item(1, "2041006", 90)];
        let slot = add_items(&mut items, "2041006".into(), 25, SLOT_LIMIT).unwrap();
        assert_eq!(slot, 1);
        assert_eq!(items.iter().find(|i| i.slot == 1).unwrap().quantity, 100);
        assert_eq!(items.iter().find(|i| i.slot == 2).unwrap().quantity, 15);
    }

    #[test]
    fn bullets_stack_like_arrows_up_to_slot_max() {
        // 彈丸 (2330000, slotMax 800) must bundle like arrows instead of
        // keeping the recharge one-stack-per-slot shape of throwing stars.
        let mut items = vec![item(1, "2330000", 500)];
        let slot = add_items(&mut items, "2330000".into(), 300, SLOT_LIMIT).unwrap();
        assert_eq!(slot, 1, "fills the existing stack first");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].quantity, 800, "catalog slotMax caps the merge");

        // Overflow opens a fresh slot rather than exceeding slotMax.
        let slot = add_items(&mut items, "2330000".into(), 1, SLOT_LIMIT).unwrap();
        assert_eq!(slot, 2);
        assert_eq!(items.iter().find(|i| i.slot == 2).unwrap().quantity, 1);

        // Moving one stack onto the other merges only up to slotMax.
        let mut items = vec![item(1, "2330000", 780), item(2, "2330000", 40)];
        move_items(&mut items, 2, 2, 1, 40).unwrap();
        assert_eq!(items.iter().find(|i| i.slot == 1).unwrap().quantity, 800);
        assert_eq!(items.iter().find(|i| i.slot == 2).unwrap().quantity, 20);
    }

    #[test]
    fn arrows_sell_flat_and_stars_stay_recharge_shaped() {
        assert!(is_arrow("2060000"));
        assert!(is_arrow("2061000"));
        assert!(!is_arrow("2330000"));
        // Arrow rows author price 0, so the flat override is what keeps the
        // family sellable.
        assert_eq!(item_price("2060000"), None);
        assert_eq!(flat_sell_payout("2060000"), Some(1));
        assert_eq!(flat_sell_payout("2000000"), None);
        // 彈丸 keeps its catalog price; throwing stars keep the old shape.
        assert_eq!(flat_sell_payout("2330000"), None);
        assert!(is_rechargeable("2070000"));
        assert!(!is_rechargeable("2330000"));
    }

    #[test]
    fn gather_and_sort_compact_only_requested_tab() {
        let mut items = vec![
            item(1, "4000019", 100),
            item(4, "4000019", 100),
            item(1, "2000000", 3),
        ];
        gather_items(&mut items, 4).unwrap();
        assert_eq!(
            items
                .iter()
                .filter(|i| inventory_type(&i.item_id) == Some(4))
                .count(),
            1
        );
        assert_eq!(
            items.iter().find(|i| i.item_id == "4000019").unwrap().slot,
            1
        );
        assert_eq!(
            items.iter().find(|i| i.item_id == "2000000").unwrap().slot,
            1
        );
        items.push(item(7, "4000011", 1));
        sort_category(&mut items, 4);
        assert_eq!(
            items.iter().find(|i| i.item_id == "4000011").unwrap().slot,
            1
        );
        assert_eq!(
            items.iter().find(|i| i.item_id == "4000019").unwrap().slot,
            2
        );
    }

    #[test]
    fn potion_effect_and_equip_requirements() {
        // 紅色藥水 authors a flat 50 HP recovery in the TMS273 `spec` node.
        // Before the spec backfill this returned ItemNotUsable for every
        // potion in the catalog, so this assertion pins the data contract.
        let red = use_effect("2000000").expect("紅色藥水 must be drinkable");
        assert_eq!(red.hp, 50);
        assert_eq!(red.mp, 0);
        assert_eq!(red.cooldown_ms, None, "a plain potion has no cooldown");
        assert_eq!(use_effect("2041006"), Err(InventoryError::ItemNotUsable));

        let mut inventory = vec![item(1, "1002067", 1)];
        let mut equipped = Vec::new();
        assert_eq!(
            equip_items(
                &mut inventory,
                &mut equipped,
                EquipmentStats::default(),
                1,
                -1,
                SLOT_LIMIT,
            ),
            Err(InventoryError::RequirementsNotMet)
        );
        let stats = EquipmentStats {
            level: 5,
            ..EquipmentStats::default()
        };
        equip_items(&mut inventory, &mut equipped, stats, 1, -1, SLOT_LIMIT).unwrap();
        assert!(inventory.is_empty());
        assert_eq!(
            equipped,
            vec![InventoryItem {
                slot: 1,
                item_id: "1002067".into(),
                quantity: 1,
                stats: Some(equipment_attributes("1002067")),
                remaining_slots: Some(8),
                upgrade_count: Some(0),
            }]
        );
        let expected = equipped[0].clone();
        unequip_items(&mut inventory, &mut equipped, -1, 1, SLOT_LIMIT).unwrap();
        assert_eq!(inventory, vec![expected]);
        assert_eq!(inventory[0].slot, 1);
        assert!(equipped.is_empty());
    }

    #[test]
    fn only_a_move_to_consumable_is_a_map_move() {
        // 回家卷軸 authors the 999999999 sentinel: "this map's returnMap".  The
        // id is deliberately impossible as a map, so a naive parse would pad it
        // into a nonexistent town instead of routing through the catalog.
        assert_eq!(move_target("2030000"), Some(MapMoveTarget::ReturnMap));
        assert_eq!(
            move_target("2030001"),
            Some(MapMoveTarget::Map("104000000".into())),
            "an explicit town id must be normalized to the 9-digit form"
        );
        // The three consumable families are mutually exclusive: a potion
        // recovers, an upgrade scroll enhances, and neither may teleport.
        assert_eq!(move_target("2000000"), None);
        assert_eq!(move_target("2009003"), None);
        assert_eq!(move_target("2041006"), None);
        assert_eq!(move_target("2060000"), None);
        assert_eq!(move_target("1002067"), None, "equipment is never usable");
    }

    #[test]
    fn longcoat_and_pants_share_body_slots_atomically() {
        let stats = EquipmentStats {
            level: 10,
            job: 500,
            ..EquipmentStats::default()
        };
        let instance =
            |slot: u16, item_id: &str, pdd: i64, remaining_slots: u32, upgrade_count: u32| {
                InventoryItem {
                    slot,
                    item_id: item_id.into(),
                    quantity: 1,
                    stats: Some(BTreeMap::from([(String::from("incPDD"), pdd)])),
                    remaining_slots: Some(remaining_slots),
                    upgrade_count: Some(upgrade_count),
                }
            };

        let longcoat = instance(1, "1052095", 31, 2, 4);
        let coat = instance(5, "1040002", 7, 4, 1);
        let pants = instance(6, "1060002", 9, 5, 2);
        let mut inventory = vec![longcoat.clone()];
        let mut equipped = vec![coat.clone(), pants.clone()];
        equip_items(&mut inventory, &mut equipped, stats, 1, -5, SLOT_LIMIT).unwrap();

        assert_eq!(
            equipped
                .iter()
                .map(|item| item.item_id.as_str())
                .collect::<Vec<_>>(),
            vec!["1052095"]
        );
        assert_eq!(
            inventory.iter().find(|item| item.item_id == "1040002"),
            Some(&InventoryItem {
                slot: 1,
                ..coat.clone()
            })
        );
        assert_eq!(
            inventory.iter().find(|item| item.item_id == "1060002"),
            Some(&InventoryItem {
                slot: 2,
                ..pants.clone()
            })
        );
        assert_eq!(equipped[0].stats, longcoat.stats);

        let pants_slot = inventory
            .iter()
            .find(|item| item.item_id == "1060002")
            .unwrap()
            .slot;
        equip_items(
            &mut inventory,
            &mut equipped,
            stats,
            pants_slot as i16,
            -6,
            SLOT_LIMIT,
        )
        .unwrap();
        assert_eq!(
            inventory.iter().find(|item| item.item_id == "1052095"),
            Some(&InventoryItem {
                slot: pants_slot,
                ..longcoat.clone()
            })
        );
        assert_eq!(equipped[0].item_id, "1060002");
        assert_eq!(equipped[0].stats, pants.stats);

        let mut full_inventory = vec![instance(1, "1052095", 31, 2, 4)];
        full_inventory.extend((2..=SLOT_LIMIT).map(|slot| instance(slot, "1040002", 7, 4, 1)));
        let mut full_equipped = vec![coat.clone(), pants.clone()];
        let original_inventory = full_inventory.clone();
        let original_equipped = full_equipped.clone();
        assert_eq!(
            equip_items(
                &mut full_inventory,
                &mut full_equipped,
                stats,
                1,
                -5,
                SLOT_LIMIT
            ),
            Err(InventoryError::InventoryFull)
        );
        assert_eq!(full_inventory, original_inventory);
        assert_eq!(full_equipped, original_equipped);
    }
}
