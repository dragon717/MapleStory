//! 客户端交付边界（v3 §4 版本契约 / §5 HTTP 缓存）。
//!
//! 本模块只回答三件与「页面和资源怎么交付」有关的事，不参与世界业务：
//!
//! 1. **发布描述**：`/api/client-release` 返回小型、无隐私的当前发布组合
//!    （releaseId / protocolVersion / contentVersion / assetRevision / 已发布
//!    桌面包）。它不是巨大的游戏 manifest，响应 `no-store`。
//! 2. **缓存分类**：按请求路径给静态响应分类，只有**真正不可变**的地址才
//!    允许长期 immutable；过渡期的固定名内容资源一律 `no-cache`（可存储、
//!    使用前必须验证），绝不因为「还没迁移完」就把它锁一年。
//! 3. **资源修订标识**：`assetRevision` 只在服务端确实建立了不可变资源索引
//!    时才有值；没有索引就是 `null`，不拿构建时间或 contentVersion 冒充。
//!
//! 不负责：登录/会话、业务协议、权威世界状态、玩家数据。缓存只是「少下载」
//! 的手段，缓存缺失必须仍然能正常联网获取资源（v3 §5.3）。

use axum::{
    extract::Request,
    http::{header::CACHE_CONTROL, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::path::Path;

/// 长期不可变资源：`max-age=31536000, immutable`。
///
/// 只允许给**地址不变则字节不变**的对象：带内容指纹的构建产物，以及未来
/// 内容寻址对象库里的 `/assets/objects/<算法>/<摘要>.<ext>`。
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// 使用前必须重新验证：页面与过渡期固定名资源。
const REVALIDATE: &str = "no-cache";
/// 不得存储：发布描述与私人 API。
const NO_STORE: &str = "no-store";

/// 缓存分类。分类是纯函数，便于定向断言，不依赖运行时环境。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheClass {
    /// 内容寻址 / 带指纹：地址不变则字节不变。
    Immutable,
    /// 可存储但使用前必须验证：HTML 入口与尚未不可变的固定名资源。
    Revalidate,
    /// 不存储：发布描述、登录等私人 API。
    NoStore,
    /// 不纳入资源缓存分类：WebSocket 升级等实时通道。
    Unmanaged,
}

impl CacheClass {
    pub fn header_value(self) -> Option<HeaderValue> {
        let value = match self {
            CacheClass::Immutable => IMMUTABLE,
            CacheClass::Revalidate => REVALIDATE,
            CacheClass::NoStore => NO_STORE,
            CacheClass::Unmanaged => return None,
        };
        // 三个常量都是 ASCII，构造不可能失败。
        HeaderValue::from_static(value).into()
    }
}

/// Vite 构建产物的指纹形如 `index-DkG2abcd.js`：点号前一段以 `-` 结尾的
/// 8 位以上 base64url 串。`assets/objects/<algo>/<hex>` 是内容寻址对象。
fn has_content_fingerprint(path: &str) -> bool {
    if let Some(rest) = path.strip_prefix("/assets/objects/") {
        // /assets/objects/<算法>/<摘要>.<扩展名>
        let mut parts = rest.split('/');
        let algorithm = parts.next().unwrap_or("");
        let file = parts.next().unwrap_or("");
        let digest = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
        return !algorithm.is_empty()
            && parts.next().is_none()
            && digest.len() >= 16
            && digest.chars().all(|c| c.is_ascii_hexdigit());
    }
    let file = path.rsplit('/').next().unwrap_or("");
    let Some((stem, extension)) = file.rsplit_once('.') else {
        return false;
    };
    if !matches!(extension, "js" | "css" | "mjs" | "woff" | "woff2" | "ttf" | "png" | "jpg" | "jpeg" | "svg" | "webp" | "ogg" | "mp3") {
        return false;
    }
    let Some((_, tail)) = stem.rsplit_once('-') else {
        return false;
    };
    tail.len() >= 8 && tail.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 按请求路径判定静态交付的缓存分类。
///
/// 判定只看路径，不看响应内容：同一路径在过渡期可能既由 dist 提供也由
/// `ASSETS_DIR` 兜底，分类必须对两种来源都成立。
pub fn classify(path: &str) -> CacheClass {
    // 去掉查询串（`?ce=<修复代数>` 等），查询参数不改变资源本身的可变性。
    let path = path.split('?').next().unwrap_or(path);
    if path == "/ws" {
        return CacheClass::Unmanaged;
    }
    if path.starts_with("/api/") {
        return CacheClass::NoStore;
    }
    if path == "/" || path.ends_with(".html") || path == "/index.html" {
        // 入口页要能及时发现新代码：可存储，但每次使用前必须验证。
        return CacheClass::Revalidate;
    }
    if path.starts_with("/assets/") && has_content_fingerprint(path) {
        return CacheClass::Immutable;
    }
    if path.starts_with("/assets/") {
        // 过渡期的固定名内容资源：源目录可被装配管线原地改写，
        // 不能在这里声称一年不变（v3 §5.1 最后两行）。
        return CacheClass::Revalidate;
    }
    // 其余静态文件（favicon 等）保持可验证，不加长期缓存。
    CacheClass::Revalidate
}

/// 缓存头中间件：按路径给响应补 `Cache-Control`，不改动状态码与正文。
///
/// 只在响应**没有**自带该头时写入，避免覆盖业务路由显式设置的策略。
pub async fn apply_cache_headers(request: Request, next: Next) -> Response {
    let class = classify(request.uri().path());
    let mut response = next.run(request).await;
    if let Some(value) = class.header_value() {
        if !response.headers().contains_key(CACHE_CONTROL) {
            response.headers_mut().insert(CACHE_CONTROL, value);
        }
    }
    response
}

/// 当前发布描述。字段与 `client/src/platform/runtime-config.ts` 的
/// `ClientRelease` 逐字对应；缺字段一律由客户端判为检查失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseDescriptor {
    pub release_id: String,
    pub protocol_version: u32,
    pub content_version: String,
    /// 资源索引已建立时的不可变资源修订标识；未建立＝ `None`（如实为空）。
    pub asset_revision: Option<String>,
    /// 已发布的桌面包列表；没有真实安装包＝ `None`（不伪造下载地址）。
    pub desktop: Option<serde_json::Value>,
    pub created_at: Option<String>,
}

impl ReleaseDescriptor {
    /// 只有候选发布清单可解析时才用它；读不到就退回「未版本化」，
    /// 不猜、不用构建时间冒充发布身份。
    ///
    /// `assets` 是内容资源根（`ASSETS_DIR`）：资源修订只能来自该目录里已发布的
    /// 内容寻址对象库指针，不从别处推断。
    pub fn load(dist: &Path, assets: &Path) -> Self {
        let metadata = dist.parent().map(|parent| parent.join("metadata.json"));
        let release_id = metadata
            .as_ref()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
            .and_then(|value| value.get("releaseId")?.as_str().map(str::to_string))
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| "unversioned".to_string());
        let created_at = metadata
            .as_ref()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
            .and_then(|value| value.get("createdAt")?.as_str().map(str::to_string));
        Self {
            release_id,
            protocol_version: crate::protocol::PROTOCOL_VERSION,
            content_version: crate::protocol::CONTENT_VERSION.to_string(),
            asset_revision: asset_revision(assets),
            desktop: desktop_releases(),
            created_at,
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        json!({
            "releaseId": self.release_id,
            "protocolVersion": self.protocol_version,
            "contentVersion": self.content_version,
            "assetRevision": self.asset_revision,
            "desktop": self.desktop,
            "createdAt": self.created_at,
        })
    }
}

/// 资源修订：优先显式配置（`ASSET_REVISION`），否则读内容寻址对象库的发布指针。
///
/// 指针由 `scripts/index_client_assets.cjs` 在**对象与不可变索引都写完之后**最后
/// 写入，所以「指针存在」就等于「对象库已完整发布」。指针缺失＝尚未建立索引＝
/// 如实为空，不拿构建时间或 contentVersion 冒充（v3 §4 表格）。
fn asset_revision(assets: &Path) -> Option<String> {
    if let Ok(value) = std::env::var("ASSET_REVISION") {
        let value = value.trim().to_string();
        if !value.is_empty() && is_valid_revision(&value) {
            return Some(value);
        }
    }
    AssetIndex::load(assets).map(|index| index.revision)
}

/// 修订标识只允许十六进制摘要（长度 ≥ 16）；这是**双向**约束：写方（索引脚本）
/// 与读方（本模块）必须对同一个形状达成一致，否则客户端会拿到一个它无法
/// 拼出索引地址的修订号。
fn is_valid_revision(value: &str) -> bool {
    value.len() >= 16 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// 内容寻址对象库的发布指针 `<ASSETS_DIR>/objects/current.json`。
///
/// 字段与 `scripts/index_client_assets.cjs` 写出的形状逐字对应；形状对不上
/// 一律视为「未建立」，宁可退回复验式缓存，也不给客户端一个拼不出索引的修订号。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetIndex {
    pub revision: String,
    pub index: String,
    pub count: u64,
    pub bytes: u64,
}

impl AssetIndex {
    pub fn load(assets: &Path) -> Option<Self> {
        let body = std::fs::read_to_string(assets.join("objects/current.json")).ok()?;
        let value: serde_json::Value = serde_json::from_str(&body).ok()?;
        let revision = value.get("revision")?.as_str()?.to_string();
        let index = value.get("index")?.as_str()?.to_string();
        if !is_valid_revision(&revision) {
            return None;
        }
        // 索引地址必须自洽：固定前缀 + 以自身 revision 命名的文件。这条同时挡住
        // 「索引被换过但指针没换」和「revision 被改写」两种不一致。
        if index != format!("/assets/objects/index/{revision}.json") {
            return None;
        }
        Some(Self {
            revision,
            index,
            count: value.get("count").and_then(serde_json::Value::as_u64).unwrap_or(0),
            bytes: value.get("bytes").and_then(serde_json::Value::as_u64).unwrap_or(0),
        })
    }
}

/// 已发布桌面包。只有配置了 `DESKTOP_RELEASE_FILE` 且文件是数组时才上报；
/// 数组为空或文件不存在都如实报 `None`（v3 §10.1：未发布不假链接）。
fn desktop_releases() -> Option<serde_json::Value> {
    let file = std::env::var("DESKTOP_RELEASE_FILE").ok()?;
    let body = std::fs::read_to_string(&file).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&body).ok()?;
    let list = value.as_array()?;
    if list.is_empty() {
        return None;
    }
    Some(serde_json::Value::Array(list.clone()))
}

/// `/api/client-release` 处理器：`no-store`，不含任何玩家数据。
pub async fn client_release(descriptor: std::sync::Arc<ReleaseDescriptor>) -> Response {
    (
        StatusCode::OK,
        [(CACHE_CONTROL, HeaderValue::from_static(NO_STORE))],
        axum::Json(descriptor.to_json()),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_entry_pages_as_revalidate() {
        assert_eq!(classify("/"), CacheClass::Revalidate);
        assert_eq!(classify("/index.html"), CacheClass::Revalidate);
    }

    #[test]
    fn classifies_fingerprinted_build_assets_as_immutable() {
        assert_eq!(classify("/assets/index-DkG2abcd.js"), CacheClass::Immutable);
        assert_eq!(classify("/assets/index-DkG2abcd.css"), CacheClass::Immutable);
        // 查询串（修复代数）不改变分类。
        assert_eq!(classify("/assets/index-DkG2abcd.js?ce=3"), CacheClass::Immutable);
    }

    #[test]
    fn classifies_content_addressed_objects_as_immutable() {
        let hex = "a".repeat(64);
        assert_eq!(classify(&format!("/assets/objects/sha256/{hex}.png")), CacheClass::Immutable);
    }

    #[test]
    fn never_locks_mutable_fixed_name_content() {
        // 固定名内容资源会被装配管线原地改写，不能给一年 immutable
        // （v3 §15-5：不在资源未不可变时设置 immutable）。
        assert_eq!(classify("/assets/manifest.json"), CacheClass::Revalidate);
        assert_eq!(classify("/assets/entry/appearance.json"), CacheClass::Revalidate);
        assert_eq!(classify("/assets/tms273/actor/00002000.img/stand1.0.png"), CacheClass::Revalidate);
    }

    #[test]
    fn classifies_private_api_and_realtime_channels() {
        assert_eq!(classify("/api/health"), CacheClass::NoStore);
        assert_eq!(classify("/api/login"), CacheClass::NoStore);
        assert_eq!(classify("/api/client-release"), CacheClass::NoStore);
        // WebSocket 不纳入静态资源缓存分类。
        assert_eq!(classify("/ws"), CacheClass::Unmanaged);
    }

    #[test]
    fn header_values_are_well_formed() {
        assert_eq!(
            CacheClass::Immutable.header_value().unwrap(),
            HeaderValue::from_static("public, max-age=31536000, immutable")
        );
        assert_eq!(
            CacheClass::Revalidate.header_value().unwrap(),
            HeaderValue::from_static("no-cache")
        );
        assert_eq!(
            CacheClass::NoStore.header_value().unwrap(),
            HeaderValue::from_static("no-store")
        );
        assert!(CacheClass::Unmanaged.header_value().is_none());
    }

    #[test]
    fn release_descriptor_reports_expected_contract() {
        let descriptor = ReleaseDescriptor {
            release_id: "20260917065719-aa0b37cc".to_string(),
            protocol_version: 24,
            content_version: "tms273-31".to_string(),
            asset_revision: None,
            desktop: None,
            created_at: Some("2026-09-17T06:57:19.620Z".to_string()),
        };
        let body = descriptor.to_json();
        assert_eq!(body["releaseId"], "20260917065719-aa0b37cc");
        assert_eq!(body["protocolVersion"], 24);
        assert_eq!(body["contentVersion"], "tms273-31");
        // 未建立索引就如实为空，不用构建时间或 contentVersion 冒充。
        assert!(body["assetRevision"].is_null());
        assert!(body["desktop"].is_null());
    }

    #[test]
    fn release_descriptor_falls_back_without_metadata() {
        // 发布清单读不到时不能假造身份；`unversioned` 是明确可识别的兜底。
        let descriptor = ReleaseDescriptor::load(Path::new("/nonexistent/client"), Path::new("/nonexistent/assets"));
        assert_eq!(descriptor.release_id, "unversioned");
        assert_eq!(descriptor.protocol_version, crate::protocol::PROTOCOL_VERSION);
        assert_eq!(descriptor.content_version, crate::protocol::CONTENT_VERSION);
        // 资源根不存在＝对象库未建立＝如实为空，不用 contentVersion 冒充资源修订。
        assert!(descriptor.asset_revision.is_none());
    }

    #[test]
    fn asset_index_requires_self_consistent_pointer() {
        let root = std::env::temp_dir().join(format!("maple-asset-index-{}", std::process::id()));
        let objects = root.join("objects");
        std::fs::create_dir_all(&objects).unwrap();
        let revision = "a".repeat(64);
        // 索引地址必须由 revision 自身命名，否则读方无法从修订号拼出索引。
        let pointer = |index: &str| {
            serde_json::json!({
                "revision": revision,
                "index": index,
                "count": 3,
                "bytes": 42,
            })
        };

        std::fs::write(objects.join("current.json"), pointer("/assets/objects/index/other.json").to_string()).unwrap();
        assert!(AssetIndex::load(&root).is_none(), "索引地址与 revision 不一致时必须判为未建立");

        std::fs::write(
            objects.join("current.json"),
            pointer(&format!("/assets/objects/index/{revision}.json")).to_string(),
        )
        .unwrap();
        let index = AssetIndex::load(&root).expect("自洽的指针必须可读");
        assert_eq!(index.revision, revision);
        assert_eq!(index.index, format!("/assets/objects/index/{revision}.json"));
        assert_eq!(index.count, 3);
        assert_eq!(index.bytes, 42);

        // 修订号不是十六进制摘要 → 判为未建立，而不是把脏值透给客户端。
        std::fs::write(
            objects.join("current.json"),
            serde_json::json!({"revision": "not-a-digest", "index": "/assets/objects/index/not-a-digest.json"}).to_string(),
        )
        .unwrap();
        assert!(AssetIndex::load(&root).is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn classifies_published_pointer_and_index_separately() {
        let revision = "b".repeat(64);
        // 发布指针是固定名、会被后续发布改写 ⇒ 只能重新验证。
        assert_eq!(classify("/assets/objects/current.json"), CacheClass::Revalidate);
        // 不可变索引与内容对象由自身摘要命名 ⇒ 才是强缓存。
        assert_eq!(classify(&format!("/assets/objects/index/{revision}.json")), CacheClass::Immutable);
        assert_eq!(classify(&format!("/assets/objects/sha256/{revision}.png")), CacheClass::Immutable);
    }
}
