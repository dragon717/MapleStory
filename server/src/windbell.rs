//! Windbell bridge/island activity.
//!
//! This module is intentionally a small, data-backed state machine rather
//! than a general quest or behaviour-tree runtime.  The server owns every
//! state transition; the client only submits one of the finite intents in
//! `ClientMessage::Windbell` and renders the resulting snapshot block.

use super::*;
use crate::protocol::WindbellAction;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

pub(super) const WIND_BELL_ISLAND_MAP_ID: &str = "windbell-island";
pub(super) const WIND_BELL_BRIDGE_MAP_ID: &str = "windbell-bridge";
const WIND_BELL_INSTANCE_PREFIX: &str = "windbell:island:";
const WIND_BELL_SHARED_INSTANCE_ID: &str = "shared:windbell-bridge";
const WIND_BELL_WORLD_ID: &str = "windbell";
const WIND_BELL_TALK_RANGE_X: f64 = 180.0;
const WIND_BELL_TALK_RANGE_Y: f64 = 120.0;
const WIND_BELL_HEAT_LIFT_ACCEL: f64 = 2_400.0;
// P: after leaving the authored heat column, leafwing carries the player
// across the authored 900px gap before the ordinary 75px/s fall cap reaches
// foothold 6.  It still uses the normal `step_player` sweep and collision
// chain; this is only the movement speed while the finite flight is active.
pub(super) const WIND_BELL_LEAFWING_SPEED_FACTOR: f64 = 2.0;
// P: public-NPC rhythm.  Derive every interval from the canonical server tick
// instead of duplicating its current millisecond value: the first autonomous
// rescue is one minute after the first public visit, each later supply/build
// wake is ten seconds, and the final cart run lasts twelve seconds.  This
// leaves a real first-entry window for player help while still allowing an
// unattended bridge to finish.
const WIND_BELL_NPC_STEP_TICKS: u64 = 10_000 / TICK_MS;
const WIND_BELL_CART_SELF_RESCUE_TICK: u64 = 60_000 / TICK_MS;
const WIND_BELL_SHIPMENT_TICKS: u64 = 12_000 / TICK_MS;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellConfig {
    pub schema_version: u32,
    pub content_version: String,
    pub source_class: String,
    pub maps: WindbellMaps,
    pub island: WindbellIslandRules,
    pub bridge: WindbellBridgeRules,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellMaps {
    pub island: WindbellMapFile,
    pub bridge: WindbellMapFile,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellMapFile {
    pub id: String,
    pub map_id: String,
    #[allow(dead_code)]
    pub name: String,
    pub bounds: Bounds,
    pub spawn: Point,
    pub footholds: Vec<Foothold>,
    #[serde(default)]
    pub ladders: Vec<Ladder>,
    #[serde(default)]
    pub portals: Vec<Portal>,
    #[serde(default)]
    pub water: Vec<WaterRect>,
    #[serde(default)]
    pub reactors: Vec<ReactorPlacement>,
}

impl WindbellMapFile {
    fn to_map(&self, expected_id: &str) -> Result<Map, String> {
        if self.id != self.map_id || self.id != expected_id {
            return Err(format!(
                "windbell map id mismatch: expected {expected_id}, got {}/{}",
                self.id, self.map_id
            ));
        }
        let mut map = Map {
            id: self.id.clone(),
            bounds: self.bounds.clone(),
            spawn: self.spawn.clone(),
            footholds: self.footholds.clone(),
            ladders: self.ladders.clone(),
            portals: self.portals.clone(),
            water: self.water.clone(),
            reactors: self.reactors.clone(),
        };
        map.footholds.sort_by_key(|foothold| foothold.id);
        map.validate()?;
        Ok(map)
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellIslandRules {
    pub root_path: WindbellRootPath,
    pub tree_bridge: WindbellTreeBridgeRules,
    pub heat: WindbellHeatRules,
    pub npc_spawns: Vec<WindbellNpcSpawn>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellRootPath {
    pub start_foothold_id: u64,
    pub arrival_foothold_id: u64,
    pub arrival_x_min: f64,
    pub arrival_x_max: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellTreeBridgeRules {
    pub support: WindbellInteractionPoint,
    pub dynamic_foothold: Foothold,
    pub landing: WindbellLandingPoint,
    pub falling_ticks: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellHeatRules {
    pub branch: WindbellInteractionPoint,
    pub zone: WindbellZone,
    pub arrival: WindbellArrivalZone,
    pub active_ticks: u64,
    pub launch_vy: f64,
    pub fuel: u32,
    pub glide_ticks: u64,
    pub glide_fall_speed: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellInteractionPoint {
    pub x: f64,
    pub y: f64,
    pub range_x: f64,
    pub range_y: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellZone {
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellArrivalZone {
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
    pub foothold_id: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellLandingPoint {
    #[allow(dead_code)]
    pub x: f64,
    #[allow(dead_code)]
    pub y: f64,
    pub foothold_id: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellBridgeRules {
    pub cart: WindbellInteractionPoint,
    pub material: WindbellMaterialPoint,
    pub segment_ids: Vec<u64>,
    pub segments: Vec<Foothold>,
    pub npc_spawns: Vec<WindbellNpcSpawn>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellMaterialPoint {
    pub x: f64,
    pub y: f64,
    pub source_planks: u32,
    pub source_ropes: u32,
    pub handoff_range_x: f64,
    pub handoff_range_y: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindbellNpcSpawn {
    pub id: String,
    pub template_id: String,
    pub x: f64,
    pub y: f64,
    pub foothold_id: u64,
    #[serde(default = "default_facing")]
    pub facing: i8,
}

fn default_facing() -> i8 {
    1
}

impl WindbellConfig {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let config: Self = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 || self.source_class != "P" {
            return Err("unsupported Windbell schema/source".to_owned());
        }
        let island = self.maps.island.to_map(WIND_BELL_ISLAND_MAP_ID)?;
        let bridge = self.maps.bridge.to_map(WIND_BELL_BRIDGE_MAP_ID)?;
        if self.content_version.is_empty() {
            return Err("Windbell contentVersion is empty".to_owned());
        }
        let root = &self.island.root_path;
        if island.get(root.start_foothold_id).is_none()
            || island.get(root.arrival_foothold_id).is_none()
            || root.arrival_foothold_id != 4
            || !finite_range(
                root.arrival_x_min,
                root.arrival_x_max,
                island.bounds.x_min,
                island.bounds.x_max,
            )
        {
            return Err("invalid Windbell root path".to_owned());
        }
        let tree = &self.island.tree_bridge;
        if tree.dynamic_foothold.id != 7
            || tree.dynamic_foothold.prev != 5
            || tree.dynamic_foothold.next != 6
            || tree.landing.foothold_id != 6
            || island.get(5).is_none()
            || island.get(6).is_none()
            || tree.falling_ticks == 0
            || !point_in_map(&tree.support, &island)
            || !foothold_endpoint_matches(island.get(5), &tree.dynamic_foothold, true)
            || !foothold_endpoint_matches(island.get(6), &tree.dynamic_foothold, false)
        {
            return Err("invalid Windbell tree bridge geometry".to_owned());
        }
        let heat = &self.island.heat;
        if heat.active_ticks == 0
            || heat.glide_ticks == 0
            || heat.fuel == 0
            || !heat.launch_vy.is_finite()
            || heat.launch_vy >= 0.0
            || !heat.glide_fall_speed.is_finite()
            || heat.glide_fall_speed <= 0.0
            || !zone_in_map(&heat.zone, &island)
            || !arrival_zone_valid(&heat.arrival, &island)
            || !point_in_map(&heat.branch, &island)
        {
            return Err("invalid Windbell heat route".to_owned());
        }
        validate_npcs(&self.island.npc_spawns, &island)?;

        if self.bridge.segment_ids.len() != 3
            || self.bridge.segments.len() != 3
            || self.bridge.segment_ids.as_slice() != [101, 102, 103]
            || self
                .bridge
                .segments
                .iter()
                .enumerate()
                .any(|(index, segment)| {
                    segment.id != self.bridge.segment_ids[index]
                        || bridge.get(segment.id).is_some()
                        || !foothold_in_bounds(segment, &bridge)
                })
            || self.bridge.material.source_planks != 6
            || self.bridge.material.source_ropes != 3
            || !point_in_map(
                &WindbellInteractionPoint {
                    x: self.bridge.cart.x,
                    y: self.bridge.cart.y,
                    range_x: self.bridge.cart.range_x,
                    range_y: self.bridge.cart.range_y,
                },
                &bridge,
            )
            || !point_in_map(
                &WindbellInteractionPoint {
                    x: self.bridge.material.x,
                    y: self.bridge.material.y,
                    range_x: self.bridge.material.handoff_range_x,
                    range_y: self.bridge.material.handoff_range_y,
                },
                &bridge,
            )
        {
            return Err("invalid Windbell public bridge geometry".to_owned());
        }
        validate_npcs(&self.bridge.npc_spawns, &bridge)?;
        Ok(())
    }
}

fn finite_range(min: f64, max: f64, bound_min: f64, bound_max: f64) -> bool {
    min.is_finite() && max.is_finite() && min <= max && min >= bound_min && max <= bound_max
}

fn point_in_map(point: &WindbellInteractionPoint, map: &Map) -> bool {
    point.x.is_finite()
        && point.y.is_finite()
        && point.range_x.is_finite()
        && point.range_y.is_finite()
        && point.range_x >= 0.0
        && point.range_y >= 0.0
        && (map.bounds.x_min..=map.bounds.x_max).contains(&point.x)
        && (map.bounds.y_min..=map.bounds.y_max).contains(&point.y)
}

fn zone_in_map(zone: &WindbellZone, map: &Map) -> bool {
    finite_range(zone.x_min, zone.x_max, map.bounds.x_min, map.bounds.x_max)
        && finite_range(zone.y_min, zone.y_max, map.bounds.y_min, map.bounds.y_max)
}

fn arrival_zone_valid(zone: &WindbellArrivalZone, map: &Map) -> bool {
    zone_in_map(
        &WindbellZone {
            x_min: zone.x_min,
            x_max: zone.x_max,
            y_min: zone.y_min,
            y_max: zone.y_max,
        },
        map,
    ) && map.get(zone.foothold_id).is_some()
}

fn foothold_in_bounds(foothold: &Foothold, map: &Map) -> bool {
    [foothold.x1, foothold.x2]
        .iter()
        .all(|x| (map.bounds.x_min..=map.bounds.x_max).contains(x))
        && [foothold.y1, foothold.y2]
            .iter()
            .all(|y| (map.bounds.y_min..=map.bounds.y_max).contains(y))
}

fn foothold_endpoint_matches(
    neighbour: Option<&Foothold>,
    bridge: &Foothold,
    bridge_start: bool,
) -> bool {
    let Some(neighbour) = neighbour else {
        return false;
    };
    let (nx, ny) = if bridge_start {
        (neighbour.x2, neighbour.y2)
    } else {
        (neighbour.x1, neighbour.y1)
    };
    let (bx, by) = if bridge_start {
        (bridge.x1, bridge.y1)
    } else {
        (bridge.x2, bridge.y2)
    };
    (nx - bx).abs() <= 0.001 && (ny - by).abs() <= 0.001
}

fn validate_npcs(spawns: &[WindbellNpcSpawn], map: &Map) -> Result<(), String> {
    let mut ids = std::collections::BTreeSet::new();
    for spawn in spawns {
        if spawn.id.is_empty()
            || spawn.template_id.is_empty()
            || !ids.insert(spawn.id.clone())
            || ![spawn.x, spawn.y].iter().all(|value| value.is_finite())
            || map.get(spawn.foothold_id).is_none()
            || !(map.bounds.x_min..=map.bounds.x_max).contains(&spawn.x)
            || !(map.bounds.y_min..=map.bounds.y_max).contains(&spawn.y)
        {
            return Err("invalid Windbell NPC spawn".to_owned());
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum WindbellTreeBridgeState {
    Held,
    Falling,
    Landed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum WindbellHeatState {
    Dry,
    Burning,
    Spent,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum WindbellArrivalPath {
    Root,
    Bridge,
    Fire,
}

impl WindbellArrivalPath {
    fn wire(self) -> &'static str {
        match self {
            Self::Root => "root",
            Self::Bridge => "bridge",
            Self::Fire => "fire",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum WindbellShipmentState {
    Stopped,
    InTransit,
    Arrived,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindbellPlayerProgress {
    #[serde(default)]
    pub(super) brace_cart: bool,
    #[serde(default)]
    pub(super) delivered_planks: u32,
    #[serde(default)]
    pub(super) delivered_ropes: u32,
    #[serde(default)]
    pub(super) arrived: bool,
    #[serde(default)]
    pub(super) arrival_path: Option<WindbellArrivalPath>,
    #[serde(default)]
    pub(super) last_attempt: Option<String>,
}

impl Default for WindbellPlayerProgress {
    fn default() -> Self {
        Self {
            brace_cart: false,
            delivered_planks: 0,
            delivered_ropes: 0,
            arrived: false,
            arrival_path: None,
            last_attempt: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindbellBridgeState {
    pub(super) source_planks: u32,
    pub(super) source_ropes: u32,
    pub(super) site_planks: u32,
    pub(super) site_ropes: u32,
    pub(super) segments: [bool; 3],
    pub(super) cart_upright: bool,
    /// Authoritative cart position while the finite shipment is in transit.
    /// It is persisted so a restart never snaps the cart back to the handoff.
    #[serde(default)]
    pub(super) cart_x: f64,
    pub(super) shipment: WindbellShipmentState,
    pub(super) revision: u64,
}

#[derive(Clone)]
struct WindbellReturn {
    map_id: String,
    x: f64,
    y: f64,
}

#[derive(Clone)]
pub(super) struct WindbellIslandInstance {
    map_id: String,
    #[allow(dead_code)]
    owner_id: String,
    return_position: WindbellReturn,
    tree_bridge: WindbellTreeBridgeState,
    bridge_lands_at: Option<u64>,
    heat: WindbellHeatState,
    heat_until: u64,
    leafwing: bool,
    arrival_path: Option<WindbellArrivalPath>,
    revision: u64,
}

#[derive(Clone)]
struct WindbellRequestRecord {
    action: WindbellAction,
    instance_id: Option<String>,
    sequence: u64,
}

#[derive(Clone)]
pub(super) struct WindbellRuntime {
    config: WindbellConfig,
    pub(super) bridge: WindbellBridgeState,
    /// Set on the first public-node visit.  The authored bridge facts may be
    /// loaded at server boot, but NPC autonomy must not consume the player's
    /// first-entry window while nobody has entered the activity.
    bridge_activity_started_tick: Option<u64>,
    bridge_next_npc_tick: u64,
    bridge_shipment_arrival_tick: Option<u64>,
    bridge_shipment_started_tick: Option<u64>,
    bridge_shipment_origin_x: f64,
    pub(super) islands: BTreeMap<String, WindbellIslandInstance>,
    bridge_returns: BTreeMap<String, WindbellReturn>,
    requests: BTreeMap<(String, String), WindbellRequestRecord>,
    request_sequence: u64,
}

impl WindbellRuntime {
    fn new(config: WindbellConfig, store: Option<&Store>) -> Result<Self, String> {
        let mut bridge = WindbellBridgeState {
            source_planks: config.bridge.material.source_planks,
            source_ropes: config.bridge.material.source_ropes,
            site_planks: 0,
            site_ropes: 0,
            segments: [false; 3],
            cart_upright: false,
            cart_x: config.bridge.cart.x,
            shipment: WindbellShipmentState::Stopped,
            revision: 0,
        };
        let mut shipment_arrival_tick = None;
        let mut shipment_started_tick = None;
        let mut shipment_origin_x = config.bridge.cart.x;
        let mut activity_started_tick = None;
        if let Some(store) = store {
            if let Some((state_json, revision)) =
                store.load_windbell_bridge_state(WIND_BELL_WORLD_ID)?
            {
                bridge = serde_json::from_str(&state_json)
                    .map_err(|_| "invalid persisted Windbell bridge state".to_owned())?;
                if !bridge.cart_x.is_finite() || bridge.cart_x == 0.0 {
                    bridge.cart_x = config.bridge.cart.x;
                }
                shipment_origin_x = bridge.cart_x;
                bridge.revision = bridge.revision.max(revision);
                validate_bridge_state(&bridge, &config.bridge)?;
                if bridge.shipment == WindbellShipmentState::InTransit {
                    // An in-flight shipment has no reason to block a restart;
                    // resume its finite schedule from the persisted position.
                    shipment_started_tick = Some(0);
                    shipment_arrival_tick = Some(WIND_BELL_SHIPMENT_TICKS);
                    activity_started_tick = Some(0);
                }
            }
        }
        Ok(Self {
            config,
            bridge,
            bridge_activity_started_tick: activity_started_tick,
            bridge_next_npc_tick: 0,
            bridge_shipment_arrival_tick: shipment_arrival_tick,
            bridge_shipment_started_tick: shipment_started_tick,
            bridge_shipment_origin_x: shipment_origin_x,
            islands: BTreeMap::new(),
            bridge_returns: BTreeMap::new(),
            requests: BTreeMap::new(),
            request_sequence: 0,
        })
    }
}

fn validate_bridge_state(
    state: &WindbellBridgeState,
    rules: &WindbellBridgeRules,
) -> Result<(), String> {
    let installed = state
        .segments
        .iter()
        .filter(|installed| **installed)
        .count() as u32;
    let planks_used = installed
        .saturating_mul(2)
        .saturating_add(state.site_planks);
    let ropes_used = installed.saturating_add(state.site_ropes);
    let all_segments = installed == 3;
    let destination_x = rules
        .segments
        .last()
        .map(|segment| segment.x2)
        .unwrap_or(rules.cart.x);
    if state.source_planks > rules.material.source_planks
        || state.source_ropes > rules.material.source_ropes
        || planks_used > rules.material.source_planks
        || ropes_used > rules.material.source_ropes
        || state.source_planks.saturating_add(planks_used) != rules.material.source_planks
        || state.source_ropes.saturating_add(ropes_used) != rules.material.source_ropes
        || !state.cart_x.is_finite()
        || state.cart_x < rules.cart.x.min(destination_x)
        || state.cart_x > rules.cart.x.max(destination_x)
        || (state.shipment != WindbellShipmentState::Stopped
            && (!all_segments || !state.cart_upright))
    {
        return Err("invalid persisted Windbell bridge counters".to_owned());
    }
    Ok(())
}

fn action_name(action: WindbellAction) -> &'static str {
    match action {
        WindbellAction::EnterIsland => "enterIsland",
        WindbellAction::EnterBridge => "enterBridge",
        WindbellAction::Leave => "leave",
        WindbellAction::CutSupport => "cutSupport",
        WindbellAction::Ignite => "ignite",
        WindbellAction::DeployLeafwing => "deployLeafwing",
        WindbellAction::Talk => "talk",
        WindbellAction::BraceCart => "braceCart",
        WindbellAction::DeliverPlank => "deliverPlank",
        WindbellAction::DeliverRope => "deliverRope",
    }
}

fn action_is_enter(action: WindbellAction) -> bool {
    matches!(
        action,
        WindbellAction::EnterIsland | WindbellAction::EnterBridge
    )
}

/// A durable request receipt is authoritative across reconnects.  Keep the
/// same instance-token check used by the in-memory cache when replaying a row
/// from SQLite; a reused request id with a forged/different instance must be a
/// conflict, never a snapshot replay.
fn persisted_windbell_instance_matches(result_json: &str, expected: Option<&str>) -> bool {
    let Ok(result) = serde_json::from_str::<serde_json::Value>(result_json) else {
        return false;
    };
    let Some(instance) = result.get("instanceId") else {
        return false;
    };
    match (instance, expected) {
        (serde_json::Value::Null, None) => true,
        (serde_json::Value::String(value), Some(expected)) => value == expected,
        _ => false,
    }
}

fn instance_map_id(id: &str) -> bool {
    id.starts_with(WIND_BELL_INSTANCE_PREFIX)
}

pub(super) fn is_runtime_instance_map(id: &str) -> bool {
    instance_map_id(id)
}

pub(super) fn canonical_map_id(map_id: &str) -> Option<&'static str> {
    instance_map_id(map_id).then_some(WIND_BELL_ISLAND_MAP_ID)
}

impl World {
    /// Attach the optional Windbell data after the normal catalog and
    /// gameplay have loaded.  The two authored maps remain in `self.maps`;
    /// only island instances are generated at runtime.
    pub fn with_windbell(mut self, config: WindbellConfig) -> Result<Self, String> {
        config.validate()?;
        let island = config.maps.island.to_map(WIND_BELL_ISLAND_MAP_ID)?;
        let bridge = config.maps.bridge.to_map(WIND_BELL_BRIDGE_MAP_ID)?;
        if self.maps.contains_key(&island.id) || self.maps.contains_key(&bridge.id) {
            return Err("Windbell map id collides with an existing map".to_owned());
        }
        let runtime = WindbellRuntime::new(config, self.store.as_ref())?;
        self.maps.insert(island.id.clone(), island);
        self.maps.insert(bridge.id.clone(), bridge);
        self.windbell = Some(runtime);
        self.sync_windbell_bridge_map()?;
        self.spawn_windbell_npcs(WIND_BELL_BRIDGE_MAP_ID, false)?;
        Ok(self)
    }

    /// Material installation changes the same foothold graph consumed by the
    /// normal movement step.  The authored bridge map contains the shore and
    /// the long route; installed segment footholds are added only when the
    /// durable public state says they exist.
    fn sync_windbell_bridge_map(&mut self) -> Result<(), String> {
        let Some(runtime) = self.windbell.as_ref() else {
            return Ok(());
        };
        let base = runtime.config.maps.bridge.to_map(WIND_BELL_BRIDGE_MAP_ID)?;
        let installed = runtime.bridge.segments;
        let segments = runtime.config.bridge.segments.clone();
        let mut map = base;
        let mut first_installed = None;
        let mut last_installed = None;
        for (index, segment) in segments.into_iter().enumerate() {
            if installed.get(index).copied().unwrap_or(false) {
                first_installed.get_or_insert(segment.id);
                last_installed = Some(segment.id);
                map.footholds.push(segment);
            }
        }
        if let Some(shore) = map.footholds.iter_mut().find(|foothold| foothold.id == 1) {
            shore.next = first_installed.unwrap_or(2);
        }
        if let Some(far_shore) = map.footholds.iter_mut().find(|foothold| foothold.id == 5) {
            far_shore.prev = last_installed.unwrap_or(4);
        }
        map.footholds.sort_by_key(|foothold| foothold.id);
        map.validate()?;
        self.maps.insert(WIND_BELL_BRIDGE_MAP_ID.to_owned(), map);
        Ok(())
    }

    pub(super) fn load_windbell_player_progress(
        &self,
        id: &str,
    ) -> Result<WindbellPlayerProgress, String> {
        let Some(store) = self.store.as_ref() else {
            return Ok(WindbellPlayerProgress::default());
        };
        let Some(json) = store.load_windbell_player_state(id)? else {
            return Ok(WindbellPlayerProgress::default());
        };
        serde_json::from_str(&json)
            .map_err(|_| "invalid persisted Windbell player state".to_owned())
    }

    fn save_windbell_player_progress(
        &self,
        id: &str,
        progress: &WindbellPlayerProgress,
    ) -> Result<(), String> {
        let Some(store) = self.store.as_ref() else {
            return Ok(());
        };
        let json =
            serde_json::to_string(progress).map_err(|_| "account persistence failed".to_owned())?;
        store.save_windbell_player_state(id, &json)
    }

    fn save_windbell_bridge_state(&self, bridge: &WindbellBridgeState) -> Result<(), String> {
        let Some(store) = self.store.as_ref() else {
            return Ok(());
        };
        let json =
            serde_json::to_string(bridge).map_err(|_| "account persistence failed".to_owned())?;
        store.save_windbell_bridge_state(WIND_BELL_WORLD_ID, &json, bridge.revision)
    }

    fn start_windbell_public_activity(&mut self) {
        let Some(runtime) = self.windbell.as_mut() else {
            return;
        };
        if runtime.bridge_activity_started_tick.is_none() {
            runtime.bridge_activity_started_tick = Some(self.tick);
            runtime.bridge_next_npc_tick =
                self.tick.saturating_add(WIND_BELL_CART_SELF_RESCUE_TICK);
        }
    }

    fn spawn_windbell_npcs(&mut self, map_id: &str, island: bool) -> Result<(), String> {
        let Some(runtime) = self.windbell.as_ref() else {
            return Ok(());
        };
        let spawns = if island {
            runtime.config.island.npc_spawns.clone()
        } else {
            runtime.config.bridge.npc_spawns.clone()
        };
        for spawn in spawns {
            let id = if island {
                format!("{map_id}:{}", spawn.id)
            } else {
                spawn.id.clone()
            };
            if self.npcs.contains_key(&id) {
                return Err(format!("duplicate Windbell NPC {id}"));
            }
            let (name, name_zh) = windbell_npc_name(&spawn.template_id);
            self.npcs.insert(
                id.clone(),
                NpcInstance {
                    state: NpcState {
                        id,
                        template_id: spawn.template_id.clone(),
                        name: name.to_owned(),
                        name_zh: Some(name_zh.to_owned()),
                        x: spawn.x,
                        y: spawn.y,
                        facing: spawn.facing,
                        shop_id: None,
                        job_advancement_available: None,
                        quest_available: None,
                    },
                    map_id: map_id.to_owned(),
                    template_id: spawn.template_id,
                    conversation: BTreeMap::new(),
                },
            );
        }
        Ok(())
    }

    pub(super) fn handle_windbell(
        &mut self,
        id: String,
        request_id: String,
        action: WindbellAction,
        instance_id: Option<String>,
    ) {
        let Some(_) = self.players.get(&id) else {
            return;
        };
        if action_is_enter(action) && instance_id.is_some() {
            self.send_reject(
                &id,
                "windbell_instance",
                "进入活动不能携带旧实例。",
                Some(&request_id),
            );
            return;
        }
        let key = (id.clone(), request_id.clone());
        if let Some(prior) = self
            .windbell
            .as_ref()
            .and_then(|runtime| runtime.requests.get(&key).cloned())
        {
            if prior.action == action && prior.instance_id == instance_id {
                self.send_snapshot(&id);
            } else {
                self.send_reject(
                    &id,
                    "request_conflict",
                    "风铃岛请求编号已用于另一操作。",
                    Some(&request_id),
                );
            }
            return;
        }
        if self.windbell.is_none() {
            self.send_reject(
                &id,
                "windbell_unavailable",
                "风铃活动尚未加载。",
                Some(&request_id),
            );
            return;
        }
        if let Some(store) = self.store.as_ref() {
            match store.load_windbell_action(&id, &request_id) {
                Ok(Some((prior_action, result_json)))
                    if prior_action == action_name(action)
                        && persisted_windbell_instance_matches(
                            &result_json,
                            instance_id.as_deref(),
                        ) =>
                {
                    self.send_snapshot(&id);
                    return;
                }
                Ok(Some(_)) => {
                    self.send_reject(
                        &id,
                        "request_conflict",
                        "风铃岛请求编号已用于另一操作。",
                        Some(&request_id),
                    );
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                    return;
                }
            }
        }
        if !action_is_enter(action) && instance_id.is_none() {
            self.send_reject(
                &id,
                "windbell_instance",
                "活动实例已变化，请刷新后重试。",
                Some(&request_id),
            );
            return;
        }
        self.execute_windbell_action(id, request_id, action, instance_id);
    }

    fn execute_windbell_action(
        &mut self,
        id: String,
        request_id: String,
        action: WindbellAction,
        instance_id: Option<String>,
    ) {
        let before_runtime = self.windbell.clone();
        let before_player = self.players.get(&id).cloned();
        let result = match action {
            WindbellAction::EnterIsland => self.enter_windbell_island(&id),
            WindbellAction::EnterBridge => self.enter_windbell_bridge(&id),
            WindbellAction::Leave => self.leave_windbell(&id, instance_id.as_deref()),
            WindbellAction::CutSupport => self.cut_windbell_support(&id, instance_id.as_deref()),
            WindbellAction::Ignite => self.ignite_windbell(&id, instance_id.as_deref()),
            WindbellAction::DeployLeafwing => {
                self.deploy_windbell_leafwing(&id, instance_id.as_deref())
            }
            WindbellAction::Talk => self.talk_windbell(&id, instance_id.as_deref()),
            WindbellAction::BraceCart => self.brace_windbell_cart(&id, instance_id.as_deref()),
            WindbellAction::DeliverPlank => {
                self.deliver_windbell_material(&id, instance_id.as_deref(), true)
            }
            WindbellAction::DeliverRope => {
                self.deliver_windbell_material(&id, instance_id.as_deref(), false)
            }
        };
        let Err((code, message)) = result else {
            let result_json = serde_json::json!({
                "instanceId": instance_id,
                "action": action_name(action),
            })
            .to_string();
            let mut bridge_json = None;
            let mut player_json = None;
            if matches!(
                action,
                WindbellAction::BraceCart
                    | WindbellAction::DeliverPlank
                    | WindbellAction::DeliverRope
            ) {
                let Some(runtime) = self.windbell.as_ref() else {
                    self.rollback_windbell_action(&id, before_runtime, before_player);
                    self.send_reject(
                        &id,
                        "windbell_unavailable",
                        "风铃活动尚未加载。",
                        Some(&request_id),
                    );
                    return;
                };
                bridge_json = match serde_json::to_string(&runtime.bridge) {
                    Ok(json) => Some(json),
                    Err(_) => {
                        self.rollback_windbell_action(&id, before_runtime, before_player);
                        self.send_reject(
                            &id,
                            "persistence",
                            "公共桥状态编码失败。",
                            Some(&request_id),
                        );
                        return;
                    }
                };
                player_json = self
                    .players
                    .get(&id)
                    .and_then(|player| serde_json::to_string(&player.windbell_progress).ok());
                if player_json.is_none() {
                    self.rollback_windbell_action(&id, before_runtime, before_player);
                    self.send_reject(
                        &id,
                        "persistence",
                        "个人贡献记忆编码失败。",
                        Some(&request_id),
                    );
                    return;
                }
            }
            let committed = match self.store.as_ref() {
                Some(store) => store.commit_windbell_action(
                    &id,
                    &request_id,
                    action_name(action),
                    &result_json,
                    bridge_json.as_deref().map(|json| {
                        (
                            json,
                            self.windbell
                                .as_ref()
                                .map_or(0, |runtime| runtime.bridge.revision),
                        )
                    }),
                    player_json.as_deref(),
                ),
                None => Ok(true),
            };
            match committed {
                Ok(true) => {
                    self.record_windbell_request(&id, &request_id, action, instance_id);
                    self.send_snapshot(&id);
                }
                Ok(false) => {
                    self.rollback_windbell_action(&id, before_runtime, before_player);
                    self.send_reject(
                        &id,
                        "request_replay",
                        "风铃岛请求已经提交，请使用最新状态。",
                        Some(&request_id),
                    );
                }
                Err(error) => {
                    eprintln!("windbell action transaction rolled back: {error}");
                    self.rollback_windbell_action(&id, before_runtime, before_player);
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                }
            }
            return;
        };
        self.send_reject(&id, code, message, Some(&request_id));
    }

    fn record_windbell_request(
        &mut self,
        id: &str,
        request_id: &str,
        action: WindbellAction,
        instance_id: Option<String>,
    ) {
        let Some(runtime) = self.windbell.as_mut() else {
            return;
        };
        runtime.request_sequence = runtime.request_sequence.saturating_add(1);
        let sequence = runtime.request_sequence;
        runtime.requests.insert(
            (id.to_owned(), request_id.to_owned()),
            WindbellRequestRecord {
                action,
                instance_id: instance_id.clone(),
                sequence,
            },
        );
        while runtime.requests.len() > 256 {
            let Some(oldest) = runtime
                .requests
                .iter()
                .min_by_key(|(_, record)| record.sequence)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            runtime.requests.remove(&oldest);
        }
    }

    fn rollback_windbell_action(
        &mut self,
        id: &str,
        before_runtime: Option<WindbellRuntime>,
        before_player: Option<Player>,
    ) {
        // Entering an activity calls the normal map move first, which saves
        // the new authored map before its request receipt is committed.  If
        // that receipt later fails, restore the prior canonical profile too.
        // A player that was already in a Windbell map deliberately keeps the
        // safe canonical profile written by the return path; persisting its
        // transient instance coordinates would reintroduce instance leakage.
        let profile_to_restore = before_player.as_ref().and_then(|player| {
            (!instance_map_id(&player.map_id)
                && player.map_id != WIND_BELL_ISLAND_MAP_ID
                && player.map_id != WIND_BELL_BRIDGE_MAP_ID)
                .then(|| {
                    profile_from_state(
                        &player.state,
                        &player.map_id,
                        &player.death_id,
                        player.base_max_mp,
                    )
                })
        });
        let before_islands: std::collections::BTreeSet<String> = before_runtime
            .as_ref()
            .map(|runtime| runtime.islands.keys().cloned().collect())
            .unwrap_or_default();
        let current_islands: Vec<String> = self
            .maps
            .keys()
            .filter(|map_id| instance_map_id(map_id))
            .cloned()
            .collect();
        self.windbell = before_runtime;
        for map_id in current_islands {
            if !before_islands.contains(&map_id) {
                self.maps.remove(&map_id);
                self.npcs.retain(|_, npc| npc.map_id != map_id);
            }
        }
        let missing_before: Vec<String> = before_islands
            .iter()
            .filter(|map_id| !self.maps.contains_key(*map_id))
            .cloned()
            .collect();
        for map_id in missing_before {
            let has_instance = self
                .windbell
                .as_ref()
                .is_some_and(|runtime| runtime.islands.contains_key(&map_id));
            if !has_instance {
                continue;
            }
            // `to_map` gives us the authored base geometry only.  A failed
            // leave can roll back an instance whose tree bridge had already
            // landed, so restore the dynamic foothold and the 5↔7↔6 links
            // before putting the player back.  Calling the normal landing
            // transition here would also advance the restored revision; this
            // path is geometry reconstruction and must be state preserving.
            let tree_landed = self
                .windbell
                .as_ref()
                .and_then(|runtime| runtime.islands.get(&map_id))
                .is_some_and(|instance| instance.tree_bridge == WindbellTreeBridgeState::Landed);
            let tree_rules = self
                .windbell
                .as_ref()
                .map(|runtime| runtime.config.island.tree_bridge.clone());
            let Some(mut map) = self.windbell.as_ref().and_then(|runtime| {
                runtime
                    .config
                    .maps
                    .island
                    .to_map(WIND_BELL_ISLAND_MAP_ID)
                    .ok()
            }) else {
                continue;
            };
            map.id = map_id.clone();
            if tree_landed {
                if let Some(rules) = tree_rules.as_ref() {
                    if !Self::restore_windbell_tree_bridge_geometry(&mut map, rules) {
                        eprintln!(
                            "windbell rollback could not restore landed tree bridge: {map_id}"
                        );
                        continue;
                    }
                }
            }
            self.maps.insert(map_id.clone(), map);
            if let Err(error) = self.spawn_windbell_npcs(&map_id, true) {
                eprintln!("windbell rollback could not restore island NPCs: {error}");
            }
        }
        if let Some(player) = before_player {
            self.players.insert(id.to_owned(), player);
        }
        if let (Some(store), Some(profile)) = (self.store.as_ref(), profile_to_restore) {
            if let Err(error) = store.save_profile(id, &profile) {
                eprintln!("windbell rollback could not restore canonical profile: {error}");
            }
        }
        if let Err(error) = self.sync_windbell_bridge_map() {
            eprintln!("windbell rollback could not restore public bridge map: {error}");
        }
    }

    fn enter_windbell_island(&mut self, id: &str) -> Result<(), (&'static str, &'static str)> {
        let player_snapshot = self
            .players
            .get(id)
            .map(|player| {
                (
                    player.map_id.clone(),
                    player.state.x,
                    player.state.y,
                    player.state.hp,
                    player.state.action,
                )
            })
            .ok_or(("player_unknown", "角色不存在。"))?;
        if player_snapshot.3 <= 0 || player_snapshot.4 == "dead" {
            return Err(("windbell_dead", "死亡角色不能进入风铃岛。"));
        }
        if instance_map_id(&player_snapshot.0) {
            return Err(("windbell_active", "风铃岛活动已经进行中。"));
        }
        let Some(base_map) = self.maps.get(WIND_BELL_ISLAND_MAP_ID).cloned() else {
            return Err(("windbell_unavailable", "风铃岛地图尚未加载。"));
        };
        if self.persist_player(id).is_err() {
            return Err(("persistence", "进入风铃岛前的位置保存失败。"));
        }
        let instance_id = format!("{WIND_BELL_INSTANCE_PREFIX}{}", auth::random_id());
        let mut instance_map = base_map.clone();
        instance_map.id = instance_id.clone();
        instance_map.portals.clear();
        let spawn = base_map.spawn.clone();
        let foothold_id = base_map
            .ground_near(spawn.x, spawn.y)
            .map(|(id, _)| id)
            .unwrap_or(0);
        self.maps.insert(instance_id.clone(), instance_map);
        let return_position = WindbellReturn {
            map_id: player_snapshot.0,
            x: player_snapshot.1,
            y: player_snapshot.2,
        };
        let instance = WindbellIslandInstance {
            map_id: instance_id.clone(),
            owner_id: id.to_owned(),
            return_position,
            tree_bridge: WindbellTreeBridgeState::Held,
            bridge_lands_at: None,
            heat: WindbellHeatState::Dry,
            heat_until: 0,
            leafwing: false,
            arrival_path: None,
            revision: 0,
        };
        self.windbell
            .as_mut()
            .expect("windbell runtime attached")
            .islands
            .insert(instance_id.clone(), instance);
        if let Err(_) = self.spawn_windbell_npcs(&instance_id, true) {
            self.remove_windbell_island(&instance_id);
            return Err(("windbell_unavailable", "风铃岛 NPC 无法生成。"));
        }
        if !self.move_player_to_map(id, &instance_id, spawn.x, spawn.y, foothold_id) {
            self.remove_windbell_island(&instance_id);
            return Err(("windbell_unavailable", "风铃岛出生点无效。"));
        }
        if let Some(player) = self.players.get_mut(id) {
            player.windbell_dialogue = vec!["风铃岛的根道一直开着。".to_owned()];
        }
        Ok(())
    }

    fn enter_windbell_bridge(&mut self, id: &str) -> Result<(), (&'static str, &'static str)> {
        let player_snapshot = self
            .players
            .get(id)
            .map(|player| (player.map_id.clone(), player.state.x, player.state.y))
            .ok_or(("player_unknown", "角色不存在。"))?;
        if instance_map_id(&player_snapshot.0) {
            return Err(("windbell_active", "请先退出当前风铃岛实例。"));
        }
        if player_snapshot.0 == WIND_BELL_BRIDGE_MAP_ID {
            self.start_windbell_public_activity();
            return Ok(());
        }
        let Some(map) = self.maps.get(WIND_BELL_BRIDGE_MAP_ID).cloned() else {
            return Err(("windbell_unavailable", "风铃桥地图尚未加载。"));
        };
        if self.persist_player(id).is_err() {
            return Err(("persistence", "进入风铃桥前的位置保存失败。"));
        }
        let spawn = map.spawn.clone();
        let foothold_id = map
            .ground_near(spawn.x, spawn.y)
            .map(|(id, _)| id)
            .unwrap_or(0);
        self.windbell
            .as_mut()
            .expect("windbell runtime attached")
            .bridge_returns
            .insert(
                id.to_owned(),
                WindbellReturn {
                    map_id: player_snapshot.0,
                    x: player_snapshot.1,
                    y: player_snapshot.2,
                },
            );
        if !self.move_player_to_map(id, WIND_BELL_BRIDGE_MAP_ID, spawn.x, spawn.y, foothold_id) {
            self.windbell
                .as_mut()
                .expect("windbell runtime attached")
                .bridge_returns
                .remove(id);
            return Err(("windbell_unavailable", "风铃桥出生点无效。"));
        }
        if let Some(player) = self.players.get_mut(id) {
            player.windbell_dialogue = vec!["渡口的木板和绳索都等着被送到工地。".to_owned()];
        }
        self.start_windbell_public_activity();
        Ok(())
    }

    fn leave_windbell(
        &mut self,
        id: &str,
        instance_id: Option<&str>,
    ) -> Result<(), (&'static str, &'static str)> {
        let map_id = self
            .players
            .get(id)
            .map(|player| player.map_id.clone())
            .ok_or(("player_unknown", "角色不存在。"))?;
        if instance_map_id(&map_id) {
            self.require_instance(id, instance_id)?;
            return self
                .finish_windbell_island(id, true)
                .then_some(())
                .ok_or(("persistence", "风铃岛返回位置保存失败。"));
        }
        if map_id == WIND_BELL_BRIDGE_MAP_ID {
            if instance_id != Some(WIND_BELL_SHARED_INSTANCE_ID) {
                return Err(("windbell_instance", "风铃桥实例标识已变化。"));
            }
            let return_position = self
                .windbell
                .as_ref()
                .and_then(|runtime| runtime.bridge_returns.get(id).cloned())
                .unwrap_or(WindbellReturn {
                    map_id: self.map.id.clone(),
                    x: self.map.spawn.x,
                    y: self.map.spawn.y,
                });
            if !self.return_player(id, &return_position) {
                eprintln!(
                    "windbell bridge return rejected for {id}: profile position was not saved"
                );
                return Err(("persistence", "返回原地图失败。"));
            }
            if let Some(runtime) = self.windbell.as_mut() {
                runtime.bridge_returns.remove(id);
            }
            Ok(())
        } else {
            Err(("windbell_unavailable", "角色当前不在风铃活动中。"))
        }
    }

    fn require_instance(
        &self,
        id: &str,
        instance_id: Option<&str>,
    ) -> Result<(), (&'static str, &'static str)> {
        let map_id = self.players.get(id).map(|player| player.map_id.as_str());
        if map_id.is_some_and(|map| instance_map_id(map)) && instance_id == map_id {
            Ok(())
        } else {
            Err(("windbell_instance", "活动实例已变化，请刷新后重试。"))
        }
    }

    fn move_player_to_map(
        &mut self,
        id: &str,
        map_id: &str,
        x: f64,
        y: f64,
        foothold_id: u64,
    ) -> bool {
        let Some(map) = self.maps.get(map_id).cloned() else {
            return false;
        };
        if !x.is_finite()
            || !y.is_finite()
            || !(map.bounds.x_min..=map.bounds.x_max).contains(&x)
            || !(map.bounds.y_min..=map.bounds.y_max).contains(&y)
        {
            return false;
        }
        let Some(mut candidate) = self.players.get(id).cloned() else {
            return false;
        };
        candidate.map_id = map_id.to_owned();
        candidate.state.x = x.clamp(map.bounds.x_min, map.bounds.x_max);
        candidate.state.y = y;
        candidate.state.vx = 0.0;
        candidate.state.vy = 0.0;
        candidate.state.grounded = foothold_id != 0;
        candidate.state.climbing = false;
        candidate.state.ladder_id = None;
        candidate.state.action = if candidate.state.grounded {
            "stand"
        } else {
            "jump"
        };
        candidate.state.action_started_tick = self.tick;
        candidate.direction = 0;
        candidate.vertical = 0;
        candidate.jump = false;
        candidate.swimming = false;
        candidate.foothold_id = foothold_id;
        candidate.last_foothold_id = foothold_id;
        candidate.drop_fh = 0;
        candidate.fall_boundary_hold = false;
        candidate.attack_until = 0;
        candidate.windbell_glide_until = 0;
        candidate.windbell_glide_fall_speed = 0.0;
        candidate.windbell_previous_foothold = foothold_id;
        candidate.windbell_arrival_origin_foothold = 0;
        candidate.windbell_dialogue.clear();
        clear_beginner_buffs(&mut candidate);
        refresh_player_derived(&self.gameplay, &self.mage_skills, &mut candidate);
        if let Some(store) = self.store.as_ref() {
            let profile = profile_from_state(
                &candidate.state,
                &candidate.map_id,
                &candidate.death_id,
                candidate.base_max_mp,
            );
            if store.save_profile(id, &profile).is_err() {
                return false;
            }
        }
        if let Some(player) = self.players.get_mut(id) {
            *player = candidate;
            true
        } else {
            false
        }
    }

    fn return_player(&mut self, id: &str, return_position: &WindbellReturn) -> bool {
        let map = self
            .maps
            .get(&return_position.map_id)
            .cloned()
            .unwrap_or_else(|| self.map.clone());
        let x = return_position.x.clamp(map.bounds.x_min, map.bounds.x_max);
        let (foothold_id, ground) = map
            .ground_near(x, return_position.y)
            .map_or((0, return_position.y), |(foothold_id, ground)| {
                (foothold_id, ground)
            });
        self.move_player_to_map(id, &map.id, x, ground, foothold_id)
    }

    fn remove_windbell_island(&mut self, map_id: &str) {
        self.maps.remove(map_id);
        self.npcs.retain(|_, npc| npc.map_id != map_id);
        if let Some(runtime) = self.windbell.as_mut() {
            runtime.islands.remove(map_id);
        }
    }

    fn finish_windbell_island(&mut self, id: &str, persist: bool) -> bool {
        let Some(map_id) = self.players.get(id).map(|player| player.map_id.clone()) else {
            return false;
        };
        let Some(instance) = self
            .windbell
            .as_ref()
            .and_then(|runtime| runtime.islands.get(&map_id))
            .cloned()
        else {
            return false;
        };
        let return_position = instance.return_position.clone();
        if persist {
            let progress = self
                .players
                .get(id)
                .map(|player| player.windbell_progress.clone())
                .unwrap_or_default();
            if let Err(error) = self.save_windbell_player_progress(id, &progress) {
                // Keep the private map and player in place so a disconnect or
                // explicit retry can attempt the same durable memory write.
                // Removing the instance here would lose the character's
                // contribution/arrival memory on a process failure.
                eprintln!("windbell island memory save rejected: {error}");
                return false;
            }
        }
        if !self.return_player(id, &return_position) {
            eprintln!("windbell island return rejected for {id}: profile position was not saved");
            return false;
        }
        if let Some(runtime) = self.windbell.as_mut() {
            runtime.islands.remove(&map_id);
        }
        self.maps.remove(&map_id);
        self.npcs.retain(|_, npc| npc.map_id != map_id);
        true
    }

    pub(super) fn disconnect_windbell_player(&mut self, id: &str) -> bool {
        if self
            .players
            .get(id)
            .is_some_and(|player| instance_map_id(&player.map_id))
        {
            self.finish_windbell_island(id, true)
        } else {
            true
        }
    }

    pub(super) fn prepare_windbell_replacement(&mut self, id: &str) -> bool {
        self.disconnect_windbell_player(id)
    }

    fn cut_windbell_support(
        &mut self,
        id: &str,
        instance_id: Option<&str>,
    ) -> Result<(), (&'static str, &'static str)> {
        self.require_instance(id, instance_id)?;
        let (map_id, x, y, alive) = self
            .players
            .get(id)
            .map(|player| {
                (
                    player.map_id.clone(),
                    player.state.x,
                    player.state.y,
                    player.state.hp > 0 && player.state.action != "dead",
                )
            })
            .ok_or(("player_unknown", "角色不存在。"))?;
        if !alive {
            return Err(("windbell_dead", "死亡角色不能切断支撑绳。"));
        }
        let Some(runtime) = self.windbell.as_ref() else {
            return Err(("windbell_unavailable", "风铃活动尚未加载。"));
        };
        let rules = runtime.config.island.tree_bridge.clone();
        if !near(x, y, &rules.support) {
            return Err(("windbell_out_of_range", "请靠近树桥支撑绳。"));
        }
        let Some(instance) = self
            .windbell
            .as_mut()
            .and_then(|runtime| runtime.islands.get_mut(&map_id))
        else {
            return Err(("windbell_instance", "活动实例已变化，请刷新后重试。"));
        };
        if instance.tree_bridge != WindbellTreeBridgeState::Held {
            return Err(("windbell_bridge_spent", "树桥支撑绳已经处理过了。"));
        }
        instance.tree_bridge = WindbellTreeBridgeState::Falling;
        instance.bridge_lands_at = Some(self.tick.saturating_add(rules.falling_ticks));
        instance.revision = instance.revision.saturating_add(1);
        Ok(())
    }

    fn ignite_windbell(
        &mut self,
        id: &str,
        instance_id: Option<&str>,
    ) -> Result<(), (&'static str, &'static str)> {
        self.require_instance(id, instance_id)?;
        let (map_id, x, y, alive) = self
            .players
            .get(id)
            .map(|player| {
                (
                    player.map_id.clone(),
                    player.state.x,
                    player.state.y,
                    player.state.hp > 0 && player.state.action != "dead",
                )
            })
            .ok_or(("player_unknown", "角色不存在。"))?;
        if !alive {
            return Err(("windbell_dead", "死亡角色不能点燃枯枝。"));
        }
        let Some(runtime) = self.windbell.as_ref() else {
            return Err(("windbell_unavailable", "风铃活动尚未加载。"));
        };
        let rules = runtime.config.island.heat.clone();
        if !near(x, y, &rules.branch) {
            return Err(("windbell_out_of_range", "请靠近石槽里的枯枝。"));
        }
        let Some(instance) = self
            .windbell
            .as_mut()
            .and_then(|runtime| runtime.islands.get_mut(&map_id))
        else {
            return Err(("windbell_instance", "活动实例已变化，请刷新后重试。"));
        };
        if instance.heat != WindbellHeatState::Dry {
            return Err(("windbell_fire_spent", "这次热流已经结束。"));
        }
        instance.heat = WindbellHeatState::Burning;
        instance.heat_until = self.tick.saturating_add(rules.active_ticks);
        instance.revision = instance.revision.saturating_add(1);
        Ok(())
    }

    fn deploy_windbell_leafwing(
        &mut self,
        id: &str,
        instance_id: Option<&str>,
    ) -> Result<(), (&'static str, &'static str)> {
        self.require_instance(id, instance_id)?;
        let (map_id, x, y, alive) = self
            .players
            .get(id)
            .map(|player| {
                (
                    player.map_id.clone(),
                    player.state.x,
                    player.state.y,
                    player.state.hp > 0 && player.state.action != "dead",
                )
            })
            .ok_or(("player_unknown", "角色不存在。"))?;
        if !alive {
            return Err(("windbell_dead", "死亡角色不能展开叶翼。"));
        }
        let Some(runtime) = self.windbell.as_ref() else {
            return Err(("windbell_unavailable", "风铃活动尚未加载。"));
        };
        let rules = runtime.config.island.heat.clone();
        let Some(instance) = self
            .windbell
            .as_ref()
            .and_then(|runtime| runtime.islands.get(&map_id))
        else {
            return Err(("windbell_instance", "活动实例已变化，请刷新后重试。"));
        };
        if instance.heat != WindbellHeatState::Burning || self.tick >= instance.heat_until {
            return Err(("windbell_heat_inactive", "热流尚未点燃或已经结束。"));
        }
        if instance.leafwing {
            return Err(("windbell_leafwing_active", "叶翼已经展开。"));
        }
        if !zone_contains(&rules.zone, x, y) {
            return Err(("windbell_out_of_range", "请站在有效热流中再展开叶翼。"));
        }
        let Some(instance) = self
            .windbell
            .as_mut()
            .and_then(|runtime| runtime.islands.get_mut(&map_id))
        else {
            return Err(("windbell_instance", "活动实例已变化，请刷新后重试。"));
        };
        instance.leafwing = true;
        instance.revision = instance.revision.saturating_add(1);
        if let Some(player) = self.players.get_mut(id) {
            player.state.vy = rules.launch_vy;
            player.state.vx = 0.0;
            player.state.grounded = false;
            player.state.climbing = false;
            player.state.ladder_id = None;
            player.foothold_id = 0;
            player.last_foothold_id = 0;
            player.drop_fh = 0;
            player.windbell_glide_until = self.tick.saturating_add(rules.glide_ticks);
            player.windbell_glide_fall_speed = rules.glide_fall_speed;
            player.state.action = "jump";
            player.state.action_started_tick = self.tick;
            player.direction = 0;
            player.vertical = 0;
            player.jump = false;
        }
        Ok(())
    }

    fn bridge_player(
        &self,
        id: &str,
        instance_id: Option<&str>,
    ) -> Result<(f64, f64), (&'static str, &'static str)> {
        let Some(player) = self.players.get(id) else {
            return Err(("player_unknown", "角色不存在。"));
        };
        if player.map_id != WIND_BELL_BRIDGE_MAP_ID
            || instance_id != Some(WIND_BELL_SHARED_INSTANCE_ID)
        {
            return Err(("windbell_instance", "风铃桥实例标识已变化。"));
        }
        Ok((player.state.x, player.state.y))
    }

    fn brace_windbell_cart(
        &mut self,
        id: &str,
        instance_id: Option<&str>,
    ) -> Result<(), (&'static str, &'static str)> {
        let (x, y) = self.bridge_player(id, instance_id)?;
        let rules = self
            .windbell
            .as_ref()
            .ok_or(("windbell_unavailable", "风铃活动尚未加载。"))?
            .config
            .bridge
            .cart
            .clone();
        if !near(x, y, &rules) {
            return Err(("windbell_out_of_range", "请靠近阿苇的货车。"));
        }
        let before = self
            .windbell
            .as_ref()
            .map(|runtime| runtime.bridge.clone())
            .ok_or(("windbell_unavailable", "风铃活动尚未加载。"))?;
        if before.cart_upright {
            return Err(("windbell_cart_done", "货车已经扶正了。"));
        }
        let mut next = before.clone();
        next.cart_upright = true;
        next.revision = next.revision.saturating_add(1);
        let Some(old_progress) = self
            .players
            .get(id)
            .map(|player| player.windbell_progress.clone())
        else {
            return Err(("player_unknown", "角色不存在。"));
        };
        let mut progress = old_progress.clone();
        progress.brace_cart = true;
        // The caller commits this public state, the character contribution,
        // and the request receipt in one SQLite transaction.  Keep the
        // in-memory mutation provisional until that transaction succeeds.
        self.windbell
            .as_mut()
            .expect("windbell runtime attached")
            .bridge = next;
        if let Some(player) = self.players.get_mut(id) {
            player.windbell_progress = progress;
        }
        Ok(())
    }

    fn deliver_windbell_material(
        &mut self,
        id: &str,
        instance_id: Option<&str>,
        planks: bool,
    ) -> Result<(), (&'static str, &'static str)> {
        let (x, y) = self.bridge_player(id, instance_id)?;
        let material = self
            .windbell
            .as_ref()
            .ok_or(("windbell_unavailable", "风铃活动尚未加载。"))?
            .config
            .bridge
            .material
            .clone();
        let in_range = (x - material.x).abs() <= material.handoff_range_x
            && (y - material.y).abs() <= material.handoff_range_y;
        if !in_range {
            return Err(("windbell_out_of_range", "请靠近工地材料堆。"));
        }
        let before = self
            .windbell
            .as_ref()
            .map(|runtime| runtime.bridge.clone())
            .ok_or(("windbell_unavailable", "风铃活动尚未加载。"))?;
        let mut next = before.clone();
        if planks {
            if next.source_planks == 0 {
                return Err(("windbell_material_empty", "木板已经交接完了。"));
            }
            next.source_planks -= 1;
            next.site_planks = next.site_planks.saturating_add(1);
        } else {
            if next.source_ropes == 0 {
                return Err(("windbell_material_empty", "绳索已经交接完了。"));
            }
            next.source_ropes -= 1;
            next.site_ropes = next.site_ropes.saturating_add(1);
        }
        next.revision = next.revision.saturating_add(1);
        let Some(old_progress) = self
            .players
            .get(id)
            .map(|player| player.windbell_progress.clone())
        else {
            return Err(("player_unknown", "角色不存在。"));
        };
        let mut progress = old_progress.clone();
        if planks {
            progress.delivered_planks = progress.delivered_planks.saturating_add(1);
        } else {
            progress.delivered_ropes = progress.delivered_ropes.saturating_add(1);
        }
        // The caller commits this public state, the character contribution,
        // and the request receipt in one SQLite transaction.  Keep the
        // in-memory mutation provisional until that transaction succeeds.
        self.windbell
            .as_mut()
            .expect("windbell runtime attached")
            .bridge = next;
        if let Some(player) = self.players.get_mut(id) {
            player.windbell_progress = progress;
        }
        Ok(())
    }

    fn talk_windbell(
        &mut self,
        id: &str,
        instance_id: Option<&str>,
    ) -> Result<(), (&'static str, &'static str)> {
        let (map_id, x, y) = self
            .players
            .get(id)
            .map(|player| (player.map_id.clone(), player.state.x, player.state.y))
            .ok_or(("player_unknown", "角色不存在。"))?;
        if instance_map_id(&map_id) {
            self.require_instance(id, instance_id)?;
            let spawn = self
                .windbell
                .as_ref()
                .ok_or(("windbell_unavailable", "风铃活动尚未加载。"))?
                .config
                .island
                .npc_spawns
                .first()
                .cloned()
                .ok_or(("windbell_unavailable", "岚织尚未出现。"))?;
            if (x - spawn.x).abs() > WIND_BELL_TALK_RANGE_X
                || (y - spawn.y).abs() > WIND_BELL_TALK_RANGE_Y
            {
                return Err(("windbell_out_of_range", "请靠近岚织再交谈。"));
            }
            let line = self
                .windbell
                .as_ref()
                .and_then(|runtime| runtime.islands.get(&map_id))
                .and_then(|instance| instance.arrival_path)
                .map(|path| match path {
                    WindbellArrivalPath::Root => "你从根道上来了。石脊没有替你走路。",
                    WindbellArrivalPath::Bridge => "你踩着刚落稳的树桥过来了。",
                    WindbellArrivalPath::Fire => "你从热流里落下，叶翼还留着一点温度。",
                })
                .unwrap_or("风铃岛的根道一直开着，想走哪条路都可以慢慢来。");
            if let Some(player) = self.players.get_mut(id) {
                player.windbell_dialogue = vec![line.to_owned()];
            }
            return Ok(());
        }
        let (x, y) = self.bridge_player(id, instance_id)?;
        // Resolve identity and coordinates from the live NPC instances.  A
        // future finite transport step may move a worker with the cart; talk
        // range must follow that authoritative map state rather than the
        // authored spawn point.
        let bridge_npc = self
            .npcs
            .values()
            .filter(|npc| npc.map_id == WIND_BELL_BRIDGE_MAP_ID)
            .filter(|npc| {
                (x - npc.state.x).abs() <= WIND_BELL_TALK_RANGE_X
                    && (y - npc.state.y).abs() <= WIND_BELL_TALK_RANGE_Y
            })
            .min_by(|a, b| {
                let da = (x - a.state.x).mul_add(x - a.state.x, (y - a.state.y) * (y - a.state.y));
                let db = (x - b.state.x).mul_add(x - b.state.x, (y - b.state.y) * (y - b.state.y));
                da.total_cmp(&db)
            })
            .map(|npc| npc.template_id.clone())
            .ok_or(("windbell_out_of_range", "请靠近桥边的 NPC 再交谈。"))?;
        let progress = self
            .players
            .get(id)
            .map(|player| player.windbell_progress.clone())
            .unwrap_or_default();
        let runtime = self
            .windbell
            .as_ref()
            .ok_or(("windbell_unavailable", "风铃活动尚未加载。"))?;
        let bridge = &runtime.bridge;
        let line = if bridge_npc == "windbell-awei" {
            if bridge.shipment == WindbellShipmentState::Arrived {
                if progress.brace_cart {
                    "货已运过桥了。我还记得你扶住车辕的那一下，进棚歇歇吧。".to_owned()
                } else {
                    "货已运过桥了，桥边又能落脚歇息了。".to_owned()
                }
            } else if bridge.shipment == WindbellShipmentState::InTransit {
                "车轮正沿着修好的桥面前进，这批货就快到对岸了。".to_owned()
            } else if progress.brace_cart {
                "我记得你扶住车辕的那一下。车轮已经扶正了，等桥通了我们带着同一批货上路。"
                    .to_owned()
            } else if bridge.cart_upright {
                "车轮已经扶正了。等桥通了，我们就带着同一批货上路。".to_owned()
            } else {
                "车轮卡在沟沿了……如果你愿意，搭把手扶住车辕吧。".to_owned()
            }
        } else if progress.delivered_planks > 0 || progress.delivered_ropes > 0 {
            format!(
                "你交来的{}块木板、{}捆绳，我都按工单记下了；每一件都有去处。",
                progress.delivered_planks, progress.delivered_ropes
            )
        } else if bridge.segments.iter().all(|installed| *installed) {
            "桥段都装好了。材料的来处和每一段去处，我都记在工单上。".to_owned()
        } else {
            "木板和绳索一件件交到工地，桥会按顺序恢复。".to_owned()
        };
        if let Some(player) = self.players.get_mut(id) {
            player.windbell_dialogue = vec![line];
        }
        Ok(())
    }

    pub(super) fn step_windbell_before_players(&mut self) {
        let before_runtime = self.windbell.clone();
        let mut changed = false;
        let mut bridge_to_save = None;
        let mut geometry_changed = false;
        {
            let Some(runtime) = self.windbell.as_mut() else {
                return;
            };
            if runtime.bridge_activity_started_tick.is_some()
                && self.tick >= runtime.bridge_next_npc_tick
            {
                runtime.bridge_next_npc_tick = self.tick.saturating_add(WIND_BELL_NPC_STEP_TICKS);
                let mut self_rescued = false;
                if !runtime.bridge.cart_upright
                    && runtime.bridge_activity_started_tick.is_some_and(|started| {
                        self.tick >= started.saturating_add(WIND_BELL_CART_SELF_RESCUE_TICK)
                    })
                {
                    runtime.bridge.cart_upright = true;
                    runtime.bridge.revision = runtime.bridge.revision.saturating_add(1);
                    changed = true;
                    self_rescued = true;
                }
                // One NPC wake-up performs at most one supply/install action.
                // It is enough to let the bridge make finite progress without
                // a general background simulation or a player standing nearby.
                let installed_count = runtime
                    .bridge
                    .segments
                    .iter()
                    .filter(|installed| **installed)
                    .count();
                let remaining = u32::try_from(3usize.saturating_sub(installed_count)).unwrap_or(0);
                let next_segment = runtime
                    .bridge
                    .segments
                    .iter()
                    .position(|installed| !*installed);
                if !self_rescued
                    && runtime.bridge.site_planks < 2 * remaining
                    && runtime.bridge.source_planks > 0
                {
                    runtime.bridge.source_planks -= 1;
                    runtime.bridge.site_planks = runtime.bridge.site_planks.saturating_add(1);
                    runtime.bridge.revision = runtime.bridge.revision.saturating_add(1);
                    changed = true;
                } else if !self_rescued
                    && runtime.bridge.site_ropes < remaining
                    && runtime.bridge.source_ropes > 0
                {
                    runtime.bridge.source_ropes -= 1;
                    runtime.bridge.site_ropes = runtime.bridge.site_ropes.saturating_add(1);
                    runtime.bridge.revision = runtime.bridge.revision.saturating_add(1);
                    changed = true;
                } else if !self_rescued {
                    if let Some(index) = next_segment {
                        if runtime.bridge.site_planks >= 2 && runtime.bridge.site_ropes >= 1 {
                            runtime.bridge.site_planks -= 2;
                            runtime.bridge.site_ropes -= 1;
                            runtime.bridge.segments[index] = true;
                            runtime.bridge.revision = runtime.bridge.revision.saturating_add(1);
                            changed = true;
                            geometry_changed = true;
                        }
                    }
                }
                if runtime.bridge.segments.iter().all(|installed| *installed)
                    && runtime.bridge.cart_upright
                    && runtime.bridge.shipment == WindbellShipmentState::Stopped
                {
                    runtime.bridge.shipment = WindbellShipmentState::InTransit;
                    runtime.bridge.revision = runtime.bridge.revision.saturating_add(1);
                    runtime.bridge_shipment_started_tick = Some(self.tick);
                    runtime.bridge_shipment_origin_x = runtime.bridge.cart_x;
                    runtime.bridge_shipment_arrival_tick =
                        Some(self.tick.saturating_add(WIND_BELL_SHIPMENT_TICKS));
                    changed = true;
                }
            }
            if runtime.bridge.shipment == WindbellShipmentState::InTransit {
                let arrival_tick = runtime
                    .bridge_shipment_arrival_tick
                    .unwrap_or_else(|| self.tick.saturating_add(WIND_BELL_SHIPMENT_TICKS));
                let started_tick = runtime.bridge_shipment_started_tick.unwrap_or(0);
                let span = arrival_tick.saturating_sub(started_tick).max(1) as f64;
                let progress =
                    (self.tick.saturating_sub(started_tick) as f64 / span).clamp(0.0, 1.0);
                let destination_x = runtime
                    .config
                    .bridge
                    .segments
                    .last()
                    .map(|segment| segment.x2)
                    .unwrap_or(runtime.config.bridge.cart.x);
                let cart_x = runtime.bridge_shipment_origin_x
                    + (destination_x - runtime.bridge_shipment_origin_x) * progress;
                if (runtime.bridge.cart_x - cart_x).abs() > 0.001 {
                    runtime.bridge.cart_x = cart_x;
                    runtime.bridge.revision = runtime.bridge.revision.saturating_add(1);
                    changed = true;
                }
            }
            if runtime
                .bridge_shipment_arrival_tick
                .is_some_and(|arrival_tick| arrival_tick <= self.tick)
                && runtime.bridge.shipment == WindbellShipmentState::InTransit
            {
                runtime.bridge.shipment = WindbellShipmentState::Arrived;
                runtime.bridge_shipment_arrival_tick = None;
                runtime.bridge_shipment_started_tick = None;
                runtime.bridge.cart_x = runtime
                    .config
                    .bridge
                    .segments
                    .last()
                    .map(|segment| segment.x2)
                    .unwrap_or(runtime.config.bridge.cart.x);
                runtime.bridge.revision = runtime.bridge.revision.saturating_add(1);
                changed = true;
            }
            if changed {
                bridge_to_save = Some(runtime.bridge.clone());
            }
        }
        if geometry_changed {
            if let Err(error) = self.sync_windbell_bridge_map() {
                eprintln!("windbell bridge geometry update rolled back: {error}");
                self.windbell = before_runtime.clone();
                if let Err(sync_error) = self.sync_windbell_bridge_map() {
                    eprintln!("windbell bridge rollback map sync failed: {sync_error}");
                }
                self.step_windbell_island_schedules();
                return;
            }
        }
        if let Some(bridge) = bridge_to_save {
            if let Err(error) = self.save_windbell_bridge_state(&bridge) {
                // The bridge state is a durable public fact.  Keep the old
                // in-memory state when SQLite rejects the write; the next
                // scheduled NPC wake retries the same finite action instead
                // of silently consuming materials or moving the cart.
                eprintln!("windbell bridge persistence rolled back: {error}");
                self.windbell = before_runtime;
                if geometry_changed {
                    if let Err(sync_error) = self.sync_windbell_bridge_map() {
                        eprintln!(
                            "windbell bridge persistence rollback map sync failed: {sync_error}"
                        );
                    }
                }
            }
        }
        if let Some(runtime) = self.windbell.as_ref() {
            if let Some(spawn) = runtime
                .config
                .bridge
                .npc_spawns
                .iter()
                .find(|npc| npc.template_id == "windbell-awei")
            {
                if let Some(npc) = self.npcs.get_mut(&spawn.id) {
                    npc.state.x = runtime.bridge.cart_x + spawn.x - runtime.config.bridge.cart.x;
                    npc.state.y = spawn.y;
                }
            }
        }
        self.step_windbell_island_schedules();
    }

    fn step_windbell_island_schedules(&mut self) {
        let due: Vec<String> = self
            .windbell
            .as_ref()
            .map(|runtime| {
                runtime
                    .islands
                    .values()
                    .filter(|instance| {
                        instance
                            .bridge_lands_at
                            .is_some_and(|tick| tick <= self.tick)
                    })
                    .map(|instance| instance.map_id.clone())
                    .collect()
            })
            .unwrap_or_default();
        for map_id in due {
            if !self.land_windbell_tree_bridge(&map_id) {
                eprintln!("windbell island bridge landing retry deferred: {map_id}");
            }
        }
        let expired: Vec<String> = self
            .windbell
            .as_ref()
            .map(|runtime| {
                runtime
                    .islands
                    .values()
                    .filter(|instance| {
                        instance.heat == WindbellHeatState::Burning
                            && instance.heat_until > 0
                            && instance.heat_until <= self.tick
                    })
                    .map(|instance| instance.map_id.clone())
                    .collect()
            })
            .unwrap_or_default();
        for map_id in expired {
            if let Some(instance) = self
                .windbell
                .as_mut()
                .and_then(|runtime| runtime.islands.get_mut(&map_id))
            {
                instance.heat = WindbellHeatState::Spent;
                instance.leafwing = false;
                instance.heat_until = 0;
                instance.revision = instance.revision.saturating_add(1);
            }
        }
    }

    /// Add the authored falling-tree foothold to an island map and reconnect
    /// both neighbouring footholds.  The caller decides whether this is a
    /// state transition or a rollback reconstruction; this helper only
    /// changes map geometry and validates the resulting graph.
    fn restore_windbell_tree_bridge_geometry(
        map: &mut Map,
        rules: &WindbellTreeBridgeRules,
    ) -> bool {
        if map.get(rules.dynamic_foothold.id).is_some() {
            return true;
        }
        if let Some(foothold) = map.footholds.iter_mut().find(|foothold| foothold.id == 5) {
            foothold.next = rules.dynamic_foothold.id;
        }
        if let Some(foothold) = map.footholds.iter_mut().find(|foothold| foothold.id == 6) {
            foothold.prev = rules.dynamic_foothold.id;
        }
        map.footholds.push(rules.dynamic_foothold.clone());
        map.footholds.sort_by_key(|foothold| foothold.id);
        map.validate().is_ok()
    }

    fn land_windbell_tree_bridge(&mut self, map_id: &str) -> bool {
        let Some(runtime) = self.windbell.as_ref() else {
            return false;
        };
        let rules = runtime.config.island.tree_bridge.clone();
        let Some(current) = self.maps.get(map_id).cloned() else {
            return false;
        };
        if current.get(rules.dynamic_foothold.id).is_some() {
            if let Some(instance) = self
                .windbell
                .as_mut()
                .and_then(|runtime| runtime.islands.get_mut(map_id))
            {
                instance.tree_bridge = WindbellTreeBridgeState::Landed;
                instance.bridge_lands_at = None;
            }
            return true;
        }
        let mut next = current;
        if !Self::restore_windbell_tree_bridge_geometry(&mut next, &rules) {
            return false;
        }
        self.maps.insert(map_id.to_owned(), next);
        if let Some(instance) = self
            .windbell
            .as_mut()
            .and_then(|runtime| runtime.islands.get_mut(map_id))
        {
            instance.tree_bridge = WindbellTreeBridgeState::Landed;
            instance.bridge_lands_at = None;
            instance.revision = instance.revision.saturating_add(1);
        }
        true
    }

    /// Called immediately before the normal movement step.  Heat only lifts
    /// an already-deployed leafwing while the player is inside the authored
    /// heat zone; after leaving it the movement loop's bounded glide speed is
    /// the only remaining modifier.
    pub(super) fn prepare_windbell_player(&mut self, id: &str) {
        let Some((map_id, x, y)) = self
            .players
            .get(id)
            .map(|player| (player.map_id.clone(), player.state.x, player.state.y))
        else {
            return;
        };
        let Some(instance) = self
            .windbell
            .as_ref()
            .and_then(|runtime| runtime.islands.get(&map_id))
        else {
            return;
        };
        let Some(runtime) = self.windbell.as_ref() else {
            return;
        };
        let heat = &runtime.config.island.heat;
        if let Some(player) = self.players.get_mut(id) {
            player.windbell_previous_foothold = player.foothold_id;
            if instance.leafwing
                && instance.heat == WindbellHeatState::Burning
                && self.tick < instance.heat_until
                && zone_contains(&heat.zone, x, y)
            {
                let dt = TICK_MS as f64 / 1000.0;
                player.state.vy =
                    (player.state.vy - WIND_BELL_HEAT_LIFT_ACCEL * dt).max(heat.launch_vy);
            }
        }
    }

    pub(super) fn windbell_leafwing_speed_factor(&self, id: &str) -> f64 {
        let Some(player) = self.players.get(id) else {
            return 1.0;
        };
        if player.windbell_glide_until <= self.tick {
            return 1.0;
        }
        let Some(instance) = self
            .windbell
            .as_ref()
            .and_then(|runtime| runtime.islands.get(&player.map_id))
        else {
            return 1.0;
        };
        let Some(runtime) = self.windbell.as_ref() else {
            return 1.0;
        };
        let heat = &runtime.config.island.heat;
        if instance.leafwing
            && instance.heat == WindbellHeatState::Burning
            && self.tick < instance.heat_until
            && !zone_contains(&heat.zone, player.state.x, player.state.y)
        {
            WIND_BELL_LEAFWING_SPEED_FACTOR
        } else {
            1.0
        }
    }

    /// Called immediately after `step_player`, where a stable foothold is
    /// authoritative.  Arrival is inferred from the foothold path, never from
    /// a client-submitted target or a fixed timer.
    pub(super) fn step_windbell_player(&mut self, id: &str) {
        let Some((
            map_id,
            grounded,
            foothold_id,
            x,
            y,
            previous_foothold,
            arrival_origin,
            glide_deadline,
        )) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.grounded,
                player.foothold_id,
                player.state.x,
                player.state.y,
                player.windbell_previous_foothold,
                player.windbell_arrival_origin_foothold,
                player.windbell_glide_until,
            )
        })
        else {
            return;
        };
        if !instance_map_id(&map_id) || !grounded {
            return;
        }
        let Some(runtime) = self.windbell.as_ref() else {
            return;
        };
        let arrival = runtime.config.island.root_path.clone();
        let heat_arrival = runtime.config.island.heat.arrival.clone();
        let Some(instance_snapshot) = runtime.islands.get(&map_id).cloned() else {
            return;
        };
        // The instance flag covers the launch itself; the player deadline
        // preserves the attempt when the finite heat window expires in flight.
        let was_leafwing = instance_snapshot.leafwing || glide_deadline > self.tick;

        if let Some(player) = self.players.get_mut(id) {
            player.windbell_glide_until = 0;
            player.windbell_glide_fall_speed = 0.0;
        }

        let in_arrival_zone = foothold_id == heat_arrival.foothold_id
            && foothold_id == arrival.arrival_foothold_id
            && x >= heat_arrival.x_min
            && x <= heat_arrival.x_max
            && y >= heat_arrival.y_min
            && y <= heat_arrival.y_max;
        let mut route_origin = arrival_origin;
        if foothold_id == arrival.arrival_foothold_id
            && previous_foothold != foothold_id
            && previous_foothold != 0
        {
            route_origin = previous_foothold;
        }
        if route_origin != arrival_origin {
            if let Some(player) = self.players.get_mut(id) {
                player.windbell_arrival_origin_foothold = route_origin;
            }
        }
        let path = if in_arrival_zone && instance_snapshot.arrival_path.is_none() {
            if was_leafwing {
                Some(WindbellArrivalPath::Fire)
            } else if instance_snapshot.tree_bridge == WindbellTreeBridgeState::Landed
                && (route_origin == 6 || route_origin == 7)
            {
                // Reaching foothold 4 from the landed tree bridge is the
                // bridge route.  Landing on the bridge itself never counts.
                Some(WindbellArrivalPath::Bridge)
            } else {
                Some(WindbellArrivalPath::Root)
            }
        } else {
            None
        };

        if let Some(path) = path {
            if let Some(instance) = self
                .windbell
                .as_mut()
                .and_then(|runtime| runtime.islands.get_mut(&map_id))
            {
                if instance.arrival_path.is_none() {
                    instance.arrival_path = Some(path);
                    instance.revision = instance.revision.saturating_add(1);
                    if path == WindbellArrivalPath::Fire {
                        instance.heat = WindbellHeatState::Spent;
                        instance.heat_until = 0;
                        instance.leafwing = false;
                    }
                }
            }
            let progress = if let Some(player) = self.players.get_mut(id) {
                player.windbell_progress.arrived = true;
                player.windbell_progress.arrival_path = Some(path);
                player.windbell_progress.last_attempt = Some("success".to_owned());
                Some(player.windbell_progress.clone())
            } else {
                None
            };
            if let Some(progress) = progress {
                if let Err(error) = self.save_windbell_player_progress(id, &progress) {
                    // Keep the in-memory arrival fact authoritative for the
                    // current session.  Leave/disconnect retries the same
                    // character-memory write before tearing the instance down.
                    eprintln!("windbell arrival memory retained in session: {error}");
                }
            }
            if let Some(player) = self.players.get_mut(id) {
                player.windbell_arrival_origin_foothold = 0;
            }
        } else if was_leafwing && instance_snapshot.arrival_path.is_none() {
            // A leafwing run that landed away from the destination consumed
            // its one finite fuel source and records a failed attempt only.
            let progress = if let Some(player) = self.players.get_mut(id) {
                player.windbell_progress.last_attempt = Some("failed".to_owned());
                Some(player.windbell_progress.clone())
            } else {
                None
            };
            if let Some(instance) = self
                .windbell
                .as_mut()
                .and_then(|runtime| runtime.islands.get_mut(&map_id))
            {
                instance.leafwing = false;
                instance.heat = WindbellHeatState::Spent;
                instance.heat_until = 0;
                instance.revision = instance.revision.saturating_add(1);
            }
            if let Some(progress) = progress {
                if let Err(error) = self.save_windbell_player_progress(id, &progress) {
                    eprintln!("windbell failed-attempt memory retained in session: {error}");
                }
            }
        }
    }

    pub(super) fn windbell_snapshot_fields(
        &self,
        id: &str,
        map_id: &str,
    ) -> Option<(String, serde_json::Value)> {
        let runtime = self.windbell.as_ref()?;
        let player = self.players.get(id)?;
        if map_id == WIND_BELL_BRIDGE_MAP_ID {
            let bridge = &runtime.bridge;
            return Some((
                WIND_BELL_BRIDGE_MAP_ID.to_owned(),
                windbell_state_json(
                    "bridge",
                    WIND_BELL_SHARED_INSTANCE_ID,
                    WindbellTreeBridgeState::Held,
                    WindbellHeatState::Dry,
                    false,
                    player.windbell_progress.arrival_path,
                    bridge_stage(bridge),
                    bridge.cart_upright,
                    bridge
                        .segments
                        .iter()
                        .filter(|installed| **installed)
                        .count() as u32,
                    bridge.cart_x,
                    bridge.source_planks,
                    bridge.source_ropes,
                    player.windbell_dialogue.clone(),
                    bridge.revision,
                ),
            ));
        }
        let instance = runtime.islands.get(map_id)?;
        Some((
            WIND_BELL_ISLAND_MAP_ID.to_owned(),
            windbell_state_json(
                "island",
                &instance.map_id,
                instance.tree_bridge,
                instance.heat,
                instance.leafwing,
                instance.arrival_path,
                bridge_stage(&runtime.bridge),
                runtime.bridge.cart_upright,
                runtime
                    .bridge
                    .segments
                    .iter()
                    .filter(|installed| **installed)
                    .count() as u32,
                runtime.bridge.cart_x,
                runtime.bridge.source_planks,
                runtime.bridge.source_ropes,
                player.windbell_dialogue.clone(),
                instance.revision,
            ),
        ))
    }
}

fn near(x: f64, y: f64, point: &WindbellInteractionPoint) -> bool {
    (x - point.x).abs() <= point.range_x && (y - point.y).abs() <= point.range_y
}

fn zone_contains(zone: &WindbellZone, x: f64, y: f64) -> bool {
    x >= zone.x_min && x <= zone.x_max && y >= zone.y_min && y <= zone.y_max
}

fn bridge_stage(state: &WindbellBridgeState) -> &'static str {
    if state.shipment == WindbellShipmentState::Arrived {
        "inhabited"
    } else if state.segments.iter().all(|installed| *installed) {
        "connected"
    } else if state.cart_upright || state.site_planks > 0 || state.site_ropes > 0 {
        "working"
    } else {
        "broken"
    }
}

fn windbell_state_json(
    scene: &'static str,
    instance_id: &str,
    tree_bridge: WindbellTreeBridgeState,
    heat: WindbellHeatState,
    leafwing: bool,
    arrival_path: Option<WindbellArrivalPath>,
    bridge_stage: &'static str,
    cart_upright: bool,
    bridge_segments: u32,
    cart_x: f64,
    planks: u32,
    ropes: u32,
    dialogue: Vec<String>,
    revision: u64,
) -> serde_json::Value {
    serde_json::json!({
        "scene": scene,
        "instanceId": instance_id,
        "treeBridge": match tree_bridge {
            WindbellTreeBridgeState::Held => "held",
            WindbellTreeBridgeState::Falling => "falling",
            WindbellTreeBridgeState::Landed => "landed",
        },
        "heat": match heat {
            WindbellHeatState::Dry => "dry",
            WindbellHeatState::Burning => "burning",
            WindbellHeatState::Spent => "spent",
        },
        "leafwing": leafwing,
        "arrivalPath": arrival_path.map(WindbellArrivalPath::wire),
        "bridgeStage": bridge_stage,
        "cartUpright": cart_upright,
        "bridgeSegments": bridge_segments,
        "cartX": cart_x,
        "planks": planks,
        "ropes": ropes,
        "dialogue": dialogue,
        "revision": revision,
    })
}

fn windbell_npc_name(template_id: &str) -> (&'static str, &'static str) {
    match template_id {
        "windbell-awei" => ("Awei", "阿苇"),
        "windbell-mucen" => ("Mucen", "木岑"),
        "windbell-lanzhi" => ("Lanzhi", "岚织"),
        _ => ("Windbell NPC", "风铃岛居民"),
    }
}
