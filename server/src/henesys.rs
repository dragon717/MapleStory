//! Authored solid ledges on the curved rail. x remains arc distance, y height.
//! The same source footholds and thickness are used by the Blender exporter.
use super::*;
use std::sync::OnceLock;

fn thickness(map: &Map, id: u64) -> Option<f64> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Deck { id: u64 }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Rail { map_id: String, platform_thickness: f64, deck_thickness: f64, decks: Vec<Deck> }
    static RAIL: OnceLock<Rail> = OnceLock::new();
    let rail = RAIL.get_or_init(|| {
        let rail: Rail = serde_json::from_str(include_str!("../../shared/henesys-rail.json")).expect("rail config");
        assert!(rail.platform_thickness.is_finite() && rail.platform_thickness > 0.0);
        assert!(rail.deck_thickness.is_finite() && rail.deck_thickness > 0.0);
        rail
    });
    (map.id == rail.map_id).then_some(if rail.decks.iter().any(|d| d.id == id) { rail.deck_thickness } else { rail.platform_thickness })
}

pub(super) fn solid(map: &Map) -> bool { thickness(map, 0).is_some() }

/// Sweep side faces at the actual crossing height; no tick-end tunnelling.
pub(super) fn side(map: &Map, x: f64, y: f64, next_x: f64, next_y: f64) -> f64 {
    if !solid(map) { return next_x; }
    if x == next_x { return next_x; }
    let mut result = next_x;
    for f in map.footholds.iter().filter(|f| f.x2 > f.x1) {
        let depth = thickness(map, f.id).unwrap();
        let wall = if next_x > x { f.x1 } else { f.x2 };
        let t = (wall - x) / (next_x - x);
        if !(0.0..=1.0).contains(&t) { continue; }
        let top = if next_x > x { f.y1 } else { f.y2 };
        let foot = y + (next_y - y) * t;
        if foot > top + 0.001 && foot - BODY_HEIGHT_PX < top + depth - 0.001 {
            result = if next_x > x { result.min(wall) } else { result.max(wall) };
        }
    }
    result
}

/// Rising head versus sloped underside. Returns contact foot height.
pub(super) fn ceiling(map: &Map, x: f64, y: f64, next_x: f64, next_y: f64) -> Option<f64> {
    thickness(map, 0)?;
    let mut hit: Option<(f64, f64)> = None;
    for f in map.footholds.iter().filter(|f| f.x2 > f.x1) {
        let depth = thickness(map, f.id).unwrap();
        let slope = (f.y2 - f.y1) / (f.x2 - f.x1);
        let bottom = |px: f64| f.y1 + (px - f.x1) * slope + depth + BODY_HEIGHT_PX;
        let before = y - bottom(x);
        let after = next_y - bottom(next_x);
        if before < -0.001 || after >= 0.0 || before <= after { continue; }
        let t = before / (before - after);
        let px = x + (next_x - x) * t;
        if px >= f.x1 && px <= f.x2 && hit.is_none_or(|(old, _)| t < old) {
            // Stay below the underside at the final horizontal position too.
            hit = Some((t, bottom(px).max(bottom(next_x))));
        }
    }
    hit.map(|(_, y)| y)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn solid_ledge_blocks_sides_and_head_but_allows_jump_over_top() {
        let map: Map = serde_json::from_value(serde_json::json!({
            "id":"100000000", "bounds":{"xMin":-200,"xMax":300,"yMin":-200,"yMax":500},
            "spawn":{"x":0,"y":100},
            "footholds":[{"id":1,"x1":40,"x2":100,"y1":0,"y2":0}]
        })).unwrap();
        assert_eq!(side(&map, 0.0, 40.0, 160.0, 40.0), 40.0);
        assert_eq!(side(&map, 160.0, 40.0, 0.0, 40.0), 100.0);
        assert_eq!(side(&map, 0.0, -10.0, 80.0, -10.0), 80.0);
        assert_eq!(side(&map, 0.0, 830.0, 80.0, 830.0), 80.0);
        assert_eq!(ceiling(&map, 60.0, 800.0, 60.0, 730.0), Some(770.0));
        assert_eq!(ceiling(&map, 0.0, 100.0, 0.0, -30.0), None);
        assert!(map.landing_on_sweep(60.0, 60.0, -40.0, 20.0, 0).is_some());
        let mut other = map.clone(); other.id = "other".into();
        assert_eq!(side(&other, 0.0, 40.0, 160.0, 40.0), 160.0);
        assert_eq!(ceiling(&other, 60.0, 100.0, 60.0, -30.0), None);
    }
}
