//! Tauri 构建脚本：校验 `tauri.conf.json`、生成 capabilities 的 schema 与
//! 权限清单。内容保持默认，不在这里塞业务逻辑。
fn main() {
    tauri_build::build()
}
