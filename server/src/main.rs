mod auth;
// 客户端交付边界（v3 §4/§5）：发布描述端点、静态缓存分类、资源修订标识。
mod client_delivery;
mod combat;
mod inventory;
#[cfg(test)]
mod inventory_acceptance;
pub(crate) mod lobby;
mod mage;
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
    let npc_names_zh: BTreeMap<String, String> = serde_json::from_str::<NpcNamesFile>(
        &std::fs::read_to_string(&npc_names_zh_path).map_err(|error| {
            format!(
                "Cannot read npc names zh {}: {error}",
                npc_names_zh_path.display()
            )
        })?,
    )
    .map_err(|error| {
        format!(
            "Cannot parse npc names zh {}: {error}",
            npc_names_zh_path.display()
        )
    })?
    .npcs;
    // 阶段二（2026-09-17）：NPC 台词表。与 npc-names.json 同一条装配链产出
    // （scripts/export_tms273_npc_dialogue.cjs），因此同样按硬失败处理：表在=内容
    // 完整，表缺=装配没跑完；静默降级会让整张地图的 NPC 集体回到占位提示而不报警。
    #[derive(Deserialize)]
    struct NpcDialogueFile {
        npcs: BTreeMap<String, npc::NpcDialogue>,
    }
    let npc_dialogue_path = PathBuf::from(setting(
        "NPC_DIALOGUE_FILE",
        root.join("shared/npc-dialogue.json").to_str().unwrap(),
    ));
    let npc_dialogue: BTreeMap<String, npc::NpcDialogue> = serde_json::from_str::<NpcDialogueFile>(
        &std::fs::read_to_string(&npc_dialogue_path).map_err(|error| {
            format!(
                "Cannot read npc dialogue {}: {error}",
                npc_dialogue_path.display()
            )
        })?,
    )
    .map_err(|error| {
        format!(
            "Cannot parse npc dialogue {}: {error}",
            npc_dialogue_path.display()
        )
    })?
    .npcs;
    // 根因修复（2026-09-17）：源 NPC 脚本表。与台词表同一条装配链产出
    // （scripts/export_tms273_npc_scripts.cjs），因此同样按硬失败处理：表在=源里有
    // 实体且可转换的脚本都接上了；表缺=装配没跑完，而静默降级的表现**恰好**是
    // 「計程車这类 NPC 说一句话然后什么都不发生」——那正是要修的病症本身，所以
    // 不能让它悄悄回退。
    #[derive(Deserialize)]
    struct NpcScriptsFile {
        npcs: BTreeMap<String, npc::DialogueScript>,
    }
    let npc_scripts_path = PathBuf::from(setting(
        "NPC_SCRIPTS_FILE",
        root.join("shared/npc-scripts.json").to_str().unwrap(),
    ));
    let npc_scripts: BTreeMap<String, npc::DialogueScript> = serde_json::from_str::<NpcScriptsFile>(
        &std::fs::read_to_string(&npc_scripts_path).map_err(|error| {
            format!(
                "Cannot read npc scripts {}: {error}",
                npc_scripts_path.display()
            )
        })?,
    )
    .map_err(|error| {
        format!(
            "Cannot parse npc scripts {}: {error}",
            npc_scripts_path.display()
        )
    })?
    .npcs;
    // 与 `gameplay.rs` 对 `template.script` 的校验同一口径：悬空的跳转节点在运行时会
    // 变成「对话卡住」，必须在启动时挡下。
    for (template_id, script) in &npc_scripts {
        script
            .validate(template_id)
            .map_err(|error| format!("invalid source npc script: {error}"))?;
    }
    let windbell_path = PathBuf::from(setting(
        "WINDBELL_FILE",
        root.join("shared/windbell.json").to_str().unwrap(),
    ));
    let windbell = world::windbell::WindbellConfig::load(&windbell_path).map_err(|error| {
        format!(
            "Cannot load Windbell activity {}: {error}",
            windbell_path.display()
        )
    })?;
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
    .with_npc_dialogue(npc_dialogue)
    .with_npc_scripts(npc_scripts)
    .with_mage_skills(mage_skills)
    .with_windbell(windbell)?;
    tokio::spawn(world::run(world, rx));
    let state = App {
        auth: auth_service.sender,
        world: world_tx,
        auth_slots: Arc::new(Semaphore::new(4)),
        connections: Arc::new(Semaphore::new(256)),
    };
    let dist = PathBuf::from(setting(
        "CLIENT_DIST",
        root.join("build/current/client").to_str().unwrap(),
    ));
    let assets = PathBuf::from(setting(
        "ASSETS_DIR",
        root.join("client/public-tms273/assets").to_str().unwrap(),
    ));
    // /assets 命名空间被两类东西共用，顺序不能反：
    //   ① dist/assets —— vite 的构建产物（index-<hash>.js/css），必须先命中；
    //   ② ASSETS_DIR —— 内容数据（tms273/windbell/entry 等美术音频），由两个启停入口
    //      指向 client/public-tms273/assets，作为兜底。
    // 内容数据不再复制进候选版本：那份副本既让每次启动多花 25~50s 全量拷贝 843MB，
    // 又会在变旧时遮蔽源目录里的新内容（见 client/vite.config.ts）。
    //
    // ASSETS_DIR 下的 `objects/` 是内容寻址对象库（scripts/index_client_assets.cjs）：
    // 同一份字节被复制成 `objects/sha256/<摘要><扩展名>`，地址由字节决定，因此
    // 服务端可以给它 immutable 强缓存（见 client_delivery::classify）。它落在资源根
    // 内部，正好由这里已经挂好的 ServeDir 兜底提供，不需要额外路由。
    // /api/client-release（v3 §4）：小型发布描述（releaseId / 协议 / 内容 /
    // 资源修订 / 已发布桌面包），no-store，不含任何玩家数据。首页强制更新
    // 按钮靠它判断兼容性，它不依赖地图资源加载成功。
    let release = std::sync::Arc::new(client_delivery::ReleaseDescriptor::load(&dist, &assets));
    let app=Router::new().route("/api/register",post(register)).route("/api/login",post(login)).route("/api/lobby",post(lobby_route)).route("/api/health",get(||async{Json(serde_json::json!({"ok":true,"protocolVersion":protocol::PROTOCOL_VERSION,"contentVersion":CONTENT_VERSION}))}))
        .route("/api/client-release",get({
            let release = std::sync::Arc::clone(&release);
            move || client_delivery::client_release(std::sync::Arc::clone(&release))
        }))
        .route("/api/{*path}",get(||async{error(StatusCode::NOT_FOUND,"Unknown API route")}))
        .route("/ws",get(upgrade)).nest_service("/assets",ServeDir::new(dist.join("assets")).fallback(ServeDir::new(&assets)))
        .fallback_service(ServeDir::new(&dist).not_found_service(ServeFile::new(dist.join("index.html"))))
        // 静态缓存分类（v3 §5.1）：指纹产物长期 immutable，入口页与过渡期
        // 固定名内容资源 no-cache，API 一律 no-store。
        .layer(axum::middleware::from_fn(client_delivery::apply_cache_headers))
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
