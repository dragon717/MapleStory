//! 冒险岛 TMS273 桌面外壳（v3 §9）。
//!
//! 职责边界（越一条就破坏了本方案的架构）：
//!   - 只把**本地打包**的前端装进系统 WebView（Windows: WebView2 / macOS: WKWebView /
//!     Linux: WebKitGTK）。Tauri 不是「给所有平台打包同一个 Chromium」。
//!   - 不启动第二份权威世界：不连数据库、不跑 tick、不做业务校验（v3 §9.1 / §15-7）。
//!   - 把服务器来源注入页面 `window.__MAPLE_DESKTOP__`（v3 §9.2）：游戏静态内容走
//!     `assetBase`，`/api` 与 `/ws` 走 `apiBase`。业务代码不分叉成两套。
//!   - 除窗口本身外不给页面任何原生能力。
//!
//! 来源是**编译期**常量而不是运行时文件：这样 CSP（由 `scripts/build-desktop.cjs`
//! 生成的 config overlay 写入）与注入值必然一致，也不存在「远端页面诱使外壳连到
//! 任意主机」的路径（v3 §D05）。非法 scheme 一律当作未配置，退回同源。

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// 权威世界（Rust 3010）来源，例如 `https://world.example.com`。
fn api_base() -> &'static str {
    sanitize(option_env!("MAPLE_API_BASE").unwrap_or(""))
}

/// 游戏静态内容来源，例如 `https://content.example.com`。
fn asset_base() -> &'static str {
    sanitize(option_env!("MAPLE_ASSET_BASE").unwrap_or(""))
}

/// 只接受 `http(s)://host` 形状的绝对来源；其它一律视为未配置。
///
/// 与客户端 `platform/desktop-config.ts` 的 `normalizeBase` 同一口径：两侧都收窄，
/// 才能保证「外壳注入什么、页面就只认什么」，不会出现一侧宽松一侧严格的错配。
fn sanitize(value: &str) -> &str {
    let trimmed = value.trim().trim_end_matches('/');
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return "";
    }
    // 拒绝路径/查询/空白进入来源位：来源只应是 scheme + authority。
    let rest = &trimmed[trimmed.find("://").map_or(0, |index| index + 3)..];
    if rest.is_empty() || rest.contains(['/', '?', '#']) || rest.contains(char::is_whitespace) {
        return "";
    }
    trimmed
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 注入早于任何页面脚本执行，`platform/desktop-config.ts` 在模块求值时读取。
            // 用 serde_json 序列化而不是手工拼字符串：来源里出现引号也不会变成代码。
            let injected = serde_json::json!({
                "apiBase": api_base(),
                "assetBase": asset_base(),
            });
            let script = format!("window.__MAPLE_DESKTOP__ = Object.freeze({injected});");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("冒险岛 TMS273")
                .inner_size(1280.0, 720.0)
                .min_inner_size(960.0, 540.0)
                // 地图是横向卷轴，允许自由缩放但保留可拖动窗口，不做无边框。
                .resizable(true)
                .initialization_script(&script)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动桌面外壳失败");
}
