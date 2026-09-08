mod auth;
mod combat;
mod inventory;
pub(crate) mod lobby;
mod mage;
#[cfg(test)]
mod inventory_acceptance;
mod network;
mod npc;
mod protocol;
mod quest_text;
mod world;
use axum::{
    extract::DefaultBodyLimit,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use network::{error, lobby as lobby_route, login, register, upgrade, App};
use protocol::CONTENT_VERSION;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{mpsc, Semaphore};
use tower_http::services::{ServeDir, ServeFile};
fn setting(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let map_path = PathBuf::from(setting(
        "MAP_FILE",
        root.join("shared/map.json").to_str().unwrap(),
    ));
    let map = world::Map::load(&map_path)
        .map_err(|error| format!("Cannot load map {}: {error}", map_path.display()))?;
    let gameplay_path = PathBuf::from(setting(
        "GAMEPLAY_FILE",
        root.join("shared/gameplay.json").to_str().unwrap(),
    ));
    let gameplay = world::Gameplay::load(&gameplay_path)
        .map_err(|error| format!("Cannot load gameplay {}: {error}", gameplay_path.display()))?;
    let mage_skills_path = PathBuf::from(setting(
        "MAGE_SKILLS_FILE",
        root.join("shared/mage-skills.json").to_str().unwrap(),
    ));
    let mage_skills = mage::MageSkills::load(&mage_skills_path).map_err(|error| {
        format!(
            "Cannot load mage skills {}: {error}",
            mage_skills_path.display()
        )
    })?;
    let catalog_path = PathBuf::from(setting(
        "MAP_CATALOG",
        root.join("shared/maps.json").to_str().unwrap(),
    ));
    let quest_text_path = PathBuf::from(setting(
        "QUEST_TEXT_FILE",
        root.join("shared/quest-text.json").to_str().unwrap(),
    ));
    let quest_text = quest_text::QuestTextCorpus::load(&quest_text_path).map_err(|error| {
        format!(
            "Cannot load quest text corpus {}: {error}",
            quest_text_path.display()
        )
    })?;
    #[derive(Deserialize)]
    struct NpcNamesFile {
        npcs: BTreeMap<String, String>,
    }
    let npc_names_zh_path = PathBuf::from(setting(
        "NPC_NAMES_ZH_FILE",
        root.join("shared/npc-names.json").to_str().unwrap(),
    ));
    let npc_names_zh: BTreeMap<String, String> =
        serde_json::from_str::<NpcNamesFile>(&std::fs::read_to_string(&npc_names_zh_path).map_err(
            |error| {
                format!(
                    "Cannot read npc names zh {}: {error}",
                    npc_names_zh_path.display()
                )
            },
        )?)
        .map_err(|error| {
            format!(
                "Cannot parse npc names zh {}: {error}",
                npc_names_zh_path.display()
            )
        })?
        .npcs;
    let duration_ms: u64 = setting("ATTACK_DURATION_MS", "800").parse()?;
    if !(50..=5000).contains(&duration_ms) {
        return Err("ATTACK_DURATION_MS must be 50..5000".into());
    }
    let auth_service = auth::start(&PathBuf::from(setting(
        "ACCOUNT_DB",
        root.join("server/data/tms273.sqlite3").to_str().unwrap(),
    )))?;
    let world_store = auth_service.store.clone();
    let (world_tx, rx) = mpsc::channel(1024);
    let world = if catalog_path.is_file() {
        let catalog = world::MapCatalog::load(&catalog_path).map_err(|error| {
            format!(
                "Cannot load map catalog {}: {error}",
                catalog_path.display()
            )
        })?;
        world::World::new_with_store_and_catalog(map, duration_ms, gameplay, world_store, catalog)?
    } else {
        world::World::new_with_store(map, duration_ms, gameplay, world_store)?
    }
    .with_quest_text(quest_text)
    .with_npc_names_zh(npc_names_zh)
    .with_mage_skills(mage_skills);
    tokio::spawn(world::run(world, rx));
    let state = App {
        auth: auth_service.sender,
        world: world_tx,
        auth_slots: Arc::new(Semaphore::new(4)),
        connections: Arc::new(Semaphore::new(256)),
    };
    let dist = PathBuf::from(setting(
        "CLIENT_DIST",
        root.join("client/dist-tms273").to_str().unwrap(),
    ));
    let assets = PathBuf::from(setting(
        "ASSETS_DIR",
        root.join("client/public-tms273/assets").to_str().unwrap(),
    ));
    let app=Router::new().route("/api/register",post(register)).route("/api/login",post(login)).route("/api/lobby",post(lobby_route)).route("/api/health",get(||async{Json(serde_json::json!({"ok":true,"protocolVersion":protocol::PROTOCOL_VERSION,"contentVersion":CONTENT_VERSION}))}))
        .route("/api/{*path}",get(||async{error(StatusCode::NOT_FOUND,"Unknown API route")}))
        .route("/ws",get(upgrade)).nest_service("/assets",ServeDir::new(dist.join("assets")).fallback(ServeDir::new(assets)))
        .fallback_service(ServeDir::new(&dist).not_found_service(ServeFile::new(dist.join("index.html"))))
        .layer(DefaultBodyLimit::max(2048)).with_state(state);
    let address = setting("BIND_ADDR", "127.0.0.1:3010");
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("MapleStory server listening on {address}; content={CONTENT_VERSION}, tick={}ms, attack={}ms",world::TICK_MS,duration_ms);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
