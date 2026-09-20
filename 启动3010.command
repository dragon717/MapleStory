#!/bin/zsh
# One-click launcher for the gameplay server only. It never manages port 3000.
set -u

ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
cd -- "$ROOT" || exit 1

# 双击打开时把窗口放大到约 120 列（默认 80x24 太挤，字符画与启动状态都放不下）。
# 仅 Terminal.app 且有终端时执行；被其他环境调用或系统拒绝时静默跳过。
if [[ "${TERM_PROGRAM:-}" == "Apple_Terminal" && -t 1 ]] && (( $+commands[osascript] )); then
  osascript >/dev/null 2>&1 <<'OSA' || true
tell application "Terminal"
  if (count of windows) > 0 then
    set bounds of front window to {80, 60, 1220, 800}
  end if
end tell
OSA
fi

CONTROL_DIR="$ROOT/runtime/3010-control"
SERVER_PID_FILE="$CONTROL_DIR/server.pid"
BOT_PID_FILE="$CONTROL_DIR/bot.pid"
SERVER_LOG="$CONTROL_DIR/server.log"
BOT_LOG="$CONTROL_DIR/bot.log"
BOT_CREDENTIALS="$CONTROL_DIR/bot-credentials.json"
START_LOCK_DIR="$CONTROL_DIR/start.lock"
SERVER_BIN="$ROOT/build/current/server/maplestory-server"
LEGACY_SERVER_BIN="$ROOT/server/target/debug/maplestory-server"
RELEASE_TOOL="$ROOT/scripts/build-release.cjs"
DB="$ROOT/server/data/tms273.sqlite3"
DIST="$ROOT/build/current/client"
ASSETS="$ROOT/client/public-tms273/assets"
GAMEPLAY="$ROOT/shared/gameplay.json"
MAP="$ROOT/shared/map.json"
MAP_CATALOG="$ROOT/shared/maps.json"
HEALTH_URL="http://127.0.0.1:3010/api/health"
ART_ZSH="$ROOT/scripts/launcher-art.zsh"
ART_GENERATOR="$ROOT/scripts/gen_launcher_ascii_art.py"

# ---- 模式分派（v2 §4 / v3 §8）：无参数＝既有发布式启动，逐字不变；----
# dev/status/stop dev 是显式子命令。未知参数一律用法说明 + 非零退出，
# 绝不落入旧的构建重启分支（防止 `./启动3010.command status` 意外重build）。
# dev 只附着已运行的 3010（不构建、不重启、不碰 bot），并管理本入口的 Vite。
VITE_PID_FILE="$CONTROL_DIR/vite.pid"
VITE_LOG="$CONTROL_DIR/vite.log"
DEV_URL="http://127.0.0.1:5173"
launcher_usage() {
  print -r -- "用法：启动3010.command [模式]"
  print -r -- "  （无参数）  构建候选并启动正式 3010（原发布流程，数据库与 bot 保留）"
  print -r -- "  preview 端口  前台运行候选，独立数据库；不切换正式版本或启动 bot"
  print -r -- "  dev         源码开发：附着已运行的 3010，启动/复用 Vite 5173 开发页"
  print -r -- "  status      只读查看 3010 与开发页状态（不构建、不启停）"
  print -r -- "  stop dev    仅停止本入口管理的 Vite 开发页；3010 与 bot 不动"
}
mode_die() { print -u2 -- "$*"; exit 1; }
mode_process_command() { ps -p "$1" -o command= 2>/dev/null | sed 's/^[[:space:]]*//'; }
mode_process_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | tail -n 1; }
mode_is_vite_pid() {
  local pid="$1" cmd cwd
  [[ "$pid" =~ '^[0-9]+$' ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(mode_process_command "$pid")"
  cwd="$(mode_process_cwd "$pid")"
  [[ "$cmd" == *vite* ]] || return 1
  [[ "$cwd" == "$ROOT/client" || "$cwd" == "$ROOT" ]] || return 1
  lsof -nP -a -p "$pid" -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1
}
mode_vite_occupant() { lsof -nP -tiTCP:5173 -sTCP:LISTEN 2>/dev/null | head -n 1 | tr -d '[:space:]'; }
mode_read_pid() { [[ -r "$1" ]] || return 0; sed -n '1{s/[[:space:]]//g;p;}' "$1"; }
mode_health() { curl -fsS --noproxy "*" --max-time 2 "$HEALTH_URL" 2>/dev/null || true; }
mode_backend_summary() {
  local health
  health="$(mode_health)"
  if [[ -z "$health" ]]; then print -r -- "未运行（$HEALTH_URL 不可达；先运行 启动3010.command 启动后端）"; return 1; fi
  print -r -- "运行中 · $health"
}
mode_ensure_backend() {
  mode_health >/dev/null || mode_die "dev 模式需要已运行的 3010 后端（本模式不构建、不重启服务）。请先运行：./启动3010.command"
}
mode_start_vite() {
  local pid occupant
  pid="$(mode_read_pid "$VITE_PID_FILE")"
  if mode_is_vite_pid "$pid"; then
    print -r -- "Vite 开发页已在运行（PID $pid，复用，不重复启动）：$DEV_URL"
    return 0
  fi
  [[ -n "$pid" ]] && rm -f "$VITE_PID_FILE"
  occupant="$(mode_vite_occupant)"
  if [[ -n "$occupant" ]]; then
    mode_die "127.0.0.1:5173 已被其他进程占用（PID $occupant）。不换端口、不停止占用者；如属本项目残留 Vite，请用 stop dev 或手动确认后处理。"
  fi
  [[ -f "$ROOT/client/node_modules/vite/bin/vite.js" ]] || mode_die "缺少前端依赖：client/node_modules/vite 不存在，请先在 client 目录 npm install"
  nohup "$NODE_BIN" "$ROOT/client/node_modules/vite/bin/vite.js" >>"$VITE_LOG" 2>&1 </dev/null &
  pid=$!
  print -r -- "$pid" >| "$VITE_PID_FILE"
  local ok=0
  for _ in {1..60}; do
    if curl -fsS --noproxy "*" --max-time 1 "$DEV_URL/" 2>/dev/null | grep -q '/src/app/main.ts'; then ok=1; break; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  (( ok )) || mode_die "Vite 开发页未就绪（源码入口不可达）；日志：$VITE_LOG"
  print -r -- "Vite 开发页已启动（PID $pid）：$DEV_URL"
}
mode_dev() {
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] || mode_die "找不到 Node"
  mkdir -p "$CONTROL_DIR"
  print -r -- "━━━━━━━━ 3010 源码开发模式 ━━━━━━━━"
  mode_ensure_backend
  print -r -- "① 后端 3010：$(mode_backend_summary)"
  mode_start_vite
  print -r -- "② 开发页：$DEV_URL（DEV_SOURCE，保存源码自动生效；构建页 3010 不受影响）"
  print -r -- "③ 说明：5173 与 3010 是不同 origin，localStorage 不共用，首次进入可能需要重新登录；"
  print -r -- "   同一角色不要同时在两页登录。停止开发页用：./启动3010.command stop dev"
}
mode_status() {
  print -r -- "━━━━━━━━ 3010 状态（只读）━━━━━━━━"
  local backend vite_pid
  backend="$(mode_backend_summary)" && print -r -- "① 后端 3010：$backend" || print -r -- "① 后端 3010：$backend"
  vite_pid="$(mode_read_pid "$VITE_PID_FILE")"
  if mode_is_vite_pid "$vite_pid"; then
    print -r -- "② 开发页：运行中（PID $vite_pid）$DEV_URL"
  else
    local occupant
    occupant="$(mode_vite_occupant)"
    if [[ -n "$occupant" ]]; then
      print -r -- "② 开发页：5173 被其他进程占用（PID $occupant），本入口未管理"
    else
      print -r -- "② 开发页：未运行"
    fi
  fi
  print -r -- "③ 控制文件：$CONTROL_DIR"
}
mode_stop_dev() {
  local pid
  pid="$(mode_read_pid "$VITE_PID_FILE")"
  if mode_is_vite_pid "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..40}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    rm -f "$VITE_PID_FILE"
    print -r -- "Vite 开发页已停止；3010 后端与陪测 bot 未受影响。"
  else
    rm -f "$VITE_PID_FILE"
    print -r -- "本入口未在管理 Vite 开发页（无停止对象）；3010 后端与陪测 bot 未受影响。"
  fi
}
MODE_DISPATCH=0
case "${1:-}" in
  "") ;;
  preview)
    # Foreground candidate preview: its own database, no release activation or bots.
    [[ $# -eq 2 && "$2" == <1024-65535> && "$2" != 3010 ]] || mode_die "用法：启动3010.command preview <隔离端口，非3010>"
    preview_port="$2"
    preview_candidate="$ROOT/build/tmp"
    [[ -x "$preview_candidate/server/maplestory-server" && -f "$preview_candidate/client/index.html" ]] || mode_die "请先运行 node scripts/build-release.cjs prepare 生成候选"
    [[ -z "$(lsof -nP -tiTCP:$preview_port -sTCP:LISTEN 2>/dev/null)" ]] || mode_die "隔离端口已占用；未停止任何进程"
    preview_data="$ROOT/runtime/preview-$preview_port"
    mkdir -p "$preview_data"
    print -r -- "隔离候选：http://127.0.0.1:$preview_port；Ctrl-C 停止。数据：$preview_data"
    exec env BIND_ADDR="127.0.0.1:$preview_port" ACCOUNT_DB="$preview_data/accounts.sqlite3" CLIENT_DIST="$preview_candidate/client" ASSETS_DIR="$ASSETS" GAMEPLAY_FILE="$GAMEPLAY" MAP_FILE="$MAP" MAP_CATALOG="$MAP_CATALOG" "$preview_candidate/server/maplestory-server"
    ;;
  dev) mode_dev "$@"; exit 0 ;;
  status) mode_status; exit 0 ;;
  stop)
    if [[ "${2:-}" == "dev" && $# -eq 2 ]]; then mode_stop_dev; exit 0; fi
    launcher_usage; exit 2 ;;
  *) launcher_usage; exit 2 ;;
esac
unset MODE_DISPATCH

# ---- 分步耗时：每个阶段一行「耗时 X.Xs」，末尾汇总并追加一条记录到 startup-timings.log ----
# 用 zsh/datetime 的 EPOCHREALTIME（无子进程开销）；模块不可用时回退到 date。
# 未走过的阶段显示「跳过」而不是 0，避免把「没执行」误读成「很快」。
zmodload zsh/datetime 2>/dev/null || true
now_seconds() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then print -r -- "$EPOCHREALTIME"
  else print -r -- "$(date +%s.%N 2>/dev/null || date +%s)"; fi
}
START_ALL="$(now_seconds)"
typeset -A TIMER_START TIMER_SECONDS
timer_start() { TIMER_START[$1]="$(now_seconds)" }
timer_stop() {
  local started="${TIMER_START[$1]:-}"
  [[ -n "$started" ]] || return 0
  TIMER_SECONDS[$1]="$(LC_NUMERIC=C printf '%.1f' $(( $(now_seconds) - started )))"
}
timer_seconds() { print -r -- "${TIMER_SECONDS[$1]:-跳过}" }
# 展示用：跳过时不要留「跳过s」这种尾巴。
timer_label() {
  local value
  value="$(timer_seconds "$1")"
  [[ "$value" == "跳过" ]] && print -r -- "跳过" || print -r -- "${value}s"
}
elapsed_total() { LC_NUMERIC=C printf '%.1f' $(( $(now_seconds) - ${START_ALL:-0} )) }
# 每条进度行都印「累计」，因为只印「本步耗时」时，黑箱里的几分钟会显得毫无归属：
# 2026-09-16 那次 325s 就发生在 [2/4] 与 [3/4] 之间——[3/4] 自称 10.7s，用户只能看到
# 「这一步不止 10 秒」。有了累计，相邻两行的差值立刻指出是哪一段吃掉了时间。
elapsed_label() { print -r -- "，累计 $(elapsed_total)s" }
TIMINGS_FILE="$CONTROL_DIR/startup-timings.log"
timing_summary() {
  print -r -- "总计 $(elapsed_total)s ｜ 资源校验 $(timer_label check) ｜ 构建打包 $(timer_label build) ｜ 停旧与切换 $(timer_label rotate)（停旧服务 $(timer_label stop) + 端口确认 $(timer_label port) + 版本轮替 $(timer_label switch)）｜ 起服务与健康 $(timer_label serve) ｜ 陪测 bot $(timer_label bot)"
}
# 每次启动追加一行，便于跨次比较（失败也记，否则「变慢」只发生在成功路径上）。
timings_append() {
  local result="$1"
  print -r -- "$(date '+%Y-%m-%d %H:%M:%S') | result=$result total=$(elapsed_total)s check=$(timer_label check) build=$(timer_label build) rotate=$(timer_label rotate) stop=$(timer_label stop) port=$(timer_label port) switch=$(timer_label switch) serve=$(timer_label serve) bot=$(timer_label bot) | fresh=${CURRENT_FRESH:-?} modules=${CLIENT_MODULES:-?} | releaseId=${RELEASE_ID:-none}" >>| "$TIMINGS_FILE" 2>/dev/null || true
}

release_start_lock() {
  [[ "${START_LOCK_OWNED:-0}" == 1 ]] || return 0
  # 退出时收掉后台任务：字符画播放 / 并发资源校验
  [[ -n "${ART_PID:-}" ]] && kill "$ART_PID" 2>/dev/null
  [[ -n "${CHECK_PID:-}" ]] && kill "$CHECK_PID" 2>/dev/null
  rm -f "$START_LOCK_DIR/pid"
  rmdir "$START_LOCK_DIR" 2>/dev/null || true
}
acquire_start_lock() {
  if mkdir "$START_LOCK_DIR" 2>/dev/null; then
    START_LOCK_OWNED=1
    print -r -- "$$" >| "$START_LOCK_DIR/pid"
    trap 'release_start_lock' EXIT
    trap 'release_start_lock; exit 130' INT
    trap 'release_start_lock; exit 143' TERM
    trap 'release_start_lock; exit 129' HUP
    return 0
  fi
  local owner
  owner="$(read_pid_file "$START_LOCK_DIR/pid")"
  if [[ "$owner" =~ '^[0-9]+$' ]] && kill -0 "$owner" 2>/dev/null; then
    die "已有启动流程正在进行（PID $owner），未重复构建"
  fi
  if [[ "$owner" =~ '^[0-9]+$' ]]; then
    rm -f "$START_LOCK_DIR/pid"
    rmdir "$START_LOCK_DIR" 2>/dev/null || die "无法清理上次启动锁：$START_LOCK_DIR"
    acquire_start_lock
    return $?
  fi
  die "启动锁缺少有效 PID，无法确认所属进程：$START_LOCK_DIR"
}

die() { timings_append fail; print -u2 -- "启动失败（已耗时 $(elapsed_total)s）：$*"; exit 1; }
read_pid_file() { [[ -r "$1" ]] || return 0; sed -n '1{s/[[:space:]]//g;p;}' "$1"; }
process_command() { ps -p "$1" -o command= 2>/dev/null | sed 's/^[[:space:]]*//'; }
process_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | tail -n 1; }
is_server_pid() {
  local pid="$1" cmd cwd
  [[ "$pid" =~ '^[0-9]+$' ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(process_command "$pid")"
  cwd="$(process_cwd "$pid")"
  [[ "$cmd" == *maplestory-server* ]] || return 1
  [[ "$cwd" == "$ROOT" || "$cmd" == *"$SERVER_BIN"* || "$cmd" == *"$LEGACY_SERVER_BIN"* ]] || return 1
  lsof -nP -a -p "$pid" -iTCP:3010 -sTCP:LISTEN >/dev/null 2>&1
}
is_bot_pid() {
  local pid="$1" cmd cwd
  [[ "$pid" =~ '^[0-9]+$' ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps eww -p "$pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//')"
  cwd="$(process_cwd "$pid")"
  [[ "$cmd" == *"bots/run.mjs demo"* ]] || return 1
  [[ "$cmd" == *"SERVER_URL=http://127.0.0.1:3010"* ]] || return 1
  [[ "$cwd" == "$ROOT" ]]
}
listen_pid() { lsof -nP -tiTCP:3010 -sTCP:LISTEN 2>/dev/null | head -n 1 | tr -d '[:space:]'; }
find_bot_pid() {
  local candidates candidate
  candidates="$(pgrep -f 'bots/run.mjs demo' 2>/dev/null || true)"
  for candidate in ${(f)candidates}; do
    is_bot_pid "$candidate" && { print -r -- "$candidate"; return 0; }
  done
  return 1
}
wait_health() {
  local health
  for _ in {1..40}; do
    health="$(curl -fsS --noproxy "*" --max-time 1 "$HEALTH_URL" 2>/dev/null || true)"
    if "$NODE_BIN" -e 'const h=JSON.parse(process.argv[1]); process.exit(h.ok === true && h.protocolVersion === Number(process.argv[2]) && h.contentVersion === process.argv[3] ? 0 : 1)' "$health" "$PROTOCOL_VERSION" "$CONTENT_VERSION" 2>/dev/null; then return 0; fi
    sleep 0.25
  done
  return 1
}

release_failure() {
  timings_append fail
  print -u2 -- "启动失败（已耗时 $(elapsed_total)s）：$1"
  zsh "$ROOT/关闭3010.command" >/dev/null 2>&1 || true
  if (( CURRENT_FRESH )); then
    print -u2 -- "现行版本未被本次启动改动，无需回滚；请检查 $SERVER_LOG"
  else
    "$NODE_BIN" "$RELEASE_TOOL" rollback --release-id "$RELEASE_ID" >/dev/null 2>&1 || print -u2 -- "旧成功版本恢复失败；请检查 build/.activation.json 后手动 rollback"
  fi
  exit 1
}

mkdir -p "$CONTROL_DIR" || die "无法创建运行目录：$CONTROL_DIR"
chmod 700 "$CONTROL_DIR"
timer_start lock
acquire_start_lock
timer_stop lock
mkdir -p "${DB:h}" || die "无法创建数据库目录"
[[ -d "$ASSETS" && -f "$GAMEPLAY" && -f "$MAP" && -f "$MAP_CATALOG" ]] || die "3010 固定配置或资源不完整"
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "找不到 Node 22；请先加载 Node 22 环境"
NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[[ "$NODE_MAJOR" =~ '^[0-9]+$' ]] && (( NODE_MAJOR >= 22 )) || die "需要 Node 22 或更高版本"

# ---- 启动进度字符画：后台逐行播放（约 0.15s/行），与主流程并发；状态行先等播放完成，绝不插进画中间 ----
ART_PID="" CHECK_PID=""
NO_ART=0
MAP_COUNT="?" SOURCE_REFS="?" CLIENT_MODULES="?" PREPARE_TIMING="" PREPARE_LINE="" PREPARE_MODE="" STOP_TIMING="" ROTATE_TIMING=""
ART_PY="$HOME/.workbuddy/binaries/python/envs/default/bin/python"
[[ -x "$ART_PY" ]] || ART_PY="$(command -v python3 2>/dev/null || true)"
ART_SRC_NEWEST="$(ls -t "$ROOT/scripts/launcher-art/"*.png 2>/dev/null | head -n 1 || true)"
if [[ -n "$ART_PY" && -n "$ART_SRC_NEWEST" ]] && { [[ ! -f "$ART_ZSH" ]] || [[ "$ART_ZSH" -ot "$ART_SRC_NEWEST" ]] || [[ "$ART_ZSH" -ot "$ART_GENERATOR" ]]; }; then
  "$ART_PY" "$ART_GENERATOR" "$ART_SRC_NEWEST" "$ART_ZSH" >/dev/null 2>&1 || NO_ART=1
fi
if (( ! NO_ART )) && [[ -f "$ART_ZSH" ]] && source "$ART_ZSH" 2>/dev/null && typeset -f launcher_art_play >/dev/null 2>&1; then
  launcher_art_play
  ART_PID="$LAUNCHER_ART_PID"
else
  NO_ART=1
fi
art_wait() { (( NO_ART )) || launcher_art_wait; }
print_summary() {
  timings_append ok
  print ""
  print -- "━━━━━━━━ 3010 启动结果 ━━━━━━━━"
  print -- "① 模块加载：运行时 $MAP_COUNT 图 / $SOURCE_REFS 源引用 · 客户端 $CLIENT_MODULES 模块"
  print -- "② 服务状态：正式服务器 ✓（PID ${SERVER_PID}） · 陪测 bot ${BOT_SUMMARY:-未启动}"
  print -- "③ 同步打包：$BUILD_SUMMARY（协议 $PROTOCOL_VERSION / $CONTENT_VERSION，releaseId $RELEASE_ID）"
  print -- "④ 分步耗时：$(timing_summary)"
  print -- "数据库与账号未重置；控制文件：$CONTROL_DIR"
}

# 根因修复：zsh `read -r A B` 只消费一行输入，node 必须把两个版本号打印在
# 同一行（此前分两行输出，第二行被丢弃，CONTENT_VERSION 恒为空）。
VERSIONS="$($NODE_BIN --disable-warning=ExperimentalWarning --experimental-strip-types --input-type=module -e 'import { PROTOCOL_VERSION, CONTENT_VERSION } from "./shared/protocol.ts"; console.log(`${PROTOCOL_VERSION} ${CONTENT_VERSION}`)')" || die "无法读取协议版本"
read -r PROTOCOL_VERSION CONTENT_VERSION <<< "$VERSIONS"
[[ -n "$PROTOCOL_VERSION" && -n "$CONTENT_VERSION" ]] || die "无法读取协议/资源版本"
CARGO_BIN="$(command -v cargo || true)"
[[ -n "$CARGO_BIN" ]] || CARGO_BIN="$HOME/.cargo/bin/cargo"
[[ -x "$CARGO_BIN" ]] || die "找不到 Cargo，无法构建新版服务"
export CARGO_BIN
"$NODE_BIN" "$RELEASE_TOOL" recover >/dev/null || die "上次发布恢复失败，未启动新实例"
# 输入指纹未变化且现行版本即该指纹产物 → 跳过 Cargo/Vite 构建与版本轮替。
# 此前每次启动都全量重编译服务器并重跑 vite（约 50s+），是启动变慢的根因。
CURRENT_FRESH=0
if "$NODE_BIN" "$RELEASE_TOOL" current-fresh >/dev/null 2>&1; then CURRENT_FRESH=1; fi
# 资源校验与构建并发：校验后台跑、构建前台跑，两者都完成后再报状态
CHECK_OUT="$CONTROL_DIR/check.out"
rm -f "$CHECK_OUT" "$CHECK_OUT.rc"
timer_start check
( "$NODE_BIN" "$ROOT/scripts/check_tms273_runtime.cjs" "$CONTENT_VERSION" >"$CHECK_OUT" 2>&1; echo $? >| "$CHECK_OUT.rc" ) &
CHECK_PID=$!
timer_start build
if (( CURRENT_FRESH )); then
  CLIENT_MODULES="$("$NODE_BIN" -e 'try{const s=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(s.clientModules??""))}catch{}' "$ROOT/build/.prepare-stamp.json" 2>/dev/null || true)"
  RELEASE_ID="$("$NODE_BIN" -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(m.releaseId)' "$ROOT/build/current/metadata.json")" || die "无法读取现行 releaseId，请删除 build/.prepare-stamp.json 后重试"
  [[ -n "$RELEASE_ID" ]] || die "现行 releaseId 为空，请删除 build/.prepare-stamp.json 后重试"
  BUILD_SUMMARY="✓ 输入未变化，复用现行版本（跳过 Cargo/Vite 构建）"
else
  if ! "$NODE_BIN" "$RELEASE_TOOL" prepare >|"$CONTROL_DIR/prepare.log" 2>&1; then
    kill "$CHECK_PID" 2>/dev/null
    tail -n 30 "$CONTROL_DIR/prepare.log" >&2
    die "候选构建失败，未停止正在运行的服务"
  fi
  CLIENT_MODULES="$(grep -oE '[0-9]+ modules transformed' "$CONTROL_DIR/prepare.log" 2>/dev/null | head -n 1 | grep -oE '[0-9]+' || true)"
  RELEASE_ID="$($NODE_BIN -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(m.releaseId)' "$ROOT/build/tmp/metadata.json")" || die "无法读取候选 releaseId，未停止正在运行的服务"
  [[ -n "$RELEASE_ID" ]] || die "候选 releaseId 为空，未停止正在运行的服务"
  BUILD_SUMMARY="✓ 客户端+服务器同批构建"
  # 构建内部的分项由 build-release.cjs 打在 prepare.log 的 [prepare] 行上，格式 `mode | 明细`。
  # mode 是 ASCII（build/reuse），用它判断走的哪条路径：复用候选时若仍报「同批构建」会自相矛盾。
  PREPARE_LINE="$(sed -n 's/^\[prepare\][[:space:]]*//p' "$CONTROL_DIR/prepare.log" 2>/dev/null | tail -n 1)"
  # `${X%%|*}` 会把分隔符前面的空格一起带出来（"reuse | …" → "reuse "），
  # 所以 mode 一律去掉空格再比较；mode 自身按约定不含空格。
  PREPARE_MODE="${PREPARE_LINE%%|*}"
  PREPARE_MODE="${PREPARE_MODE// /}"
  PREPARE_TIMING="${PREPARE_LINE#*|}"
  PREPARE_TIMING="${PREPARE_TIMING# }"
  # 去掉 prepare 自报的「合计」：本行已经有单独的阶段计时，两个总量并排只会让人怀疑哪个不准。
  PREPARE_TIMING="${PREPARE_TIMING% · 合计*}"
  if [[ "$PREPARE_MODE" == reuse ]]; then
    BUILD_SUMMARY="✓ 输入未变化，复用候选构建（跳过 Cargo 与 tsc/vite）"
    # 复用行的明细只有「复用候选构建」这一句同义话，再贴一次纯属重复。
    PREPARE_TIMING=""
  fi
fi
timer_stop build
wait "$CHECK_PID" 2>/dev/null || true
timer_stop check
CHECK_PID=""
CHECK_RC="$(cat "$CHECK_OUT.rc" 2>/dev/null || print 1)"
RUNTIME_CHECK="$(cat "$CHECK_OUT" 2>/dev/null || true)"
if [[ "$CHECK_RC" != "0" ]]; then
  print -r -- "$RUNTIME_CHECK" >&2
  die "运行资源未装配或不兼容，未停止正在运行的服务"
fi
[[ "$RUNTIME_CHECK" =~ '([0-9]+) maps; ([0-9]+) source references' ]] && MAP_COUNT="$match[1]" && SOURCE_REFS="$match[2]"
art_wait
print -- "✔ [1/4] 资源校验：$MAP_COUNT 图 / $SOURCE_REFS 源引用（耗时 $(timer_label check)，与构建并发$(elapsed_label)）"
if (( CURRENT_FRESH )); then
  print -- "✔ [2/4] 构建打包：$BUILD_SUMMARY（耗时 $(timer_label build)$(elapsed_label)）"
else
  print -- "✔ [2/4] 构建打包：$BUILD_SUMMARY（客户端 ${CLIENT_MODULES:-?} 模块，耗时 $(timer_label build)${PREPARE_TIMING:+：$PREPARE_TIMING}$(elapsed_label)，日志：$CONTROL_DIR/prepare.log）"
  timer_start rotate
  # 停旧与切换以前是一整段「黑盒」：2026-09-16 实测它吃过 325s，界面上却只表现为
  # 「[2/4] 之后几分钟没有输出」。现在拆成 停旧服务 / 端口确认 / 版本轮替 三段，
  # 每段结束立刻报耗时，两个子命令的输出也留档（stop.log / activate.log）供回看。
  timer_start stop
  if ! zsh "$ROOT/关闭3010.command" >|"$CONTROL_DIR/stop.log" 2>&1; then
    timer_stop stop
    tail -n 20 "$CONTROL_DIR/stop.log" >&2
    die "旧服务未能停止，未启动新实例"
  fi
  timer_stop stop
  STOP_TIMING="$(sed -n 's/^\[stop\][[:space:]]*//p' "$CONTROL_DIR/stop.log" 2>/dev/null | tail -n 1)"
  print -- "  · 停旧服务（含陪测 bot）：$(timer_label stop)${STOP_TIMING:+（$STOP_TIMING）}$(elapsed_label)"
  # 端口确认单独计时：它夹在停旧与轮替之间，以前是唯一没有归属的一段。若它变大，
  # 要么是别的进程抢了 3010，要么是 lsof/内核在等旧连接释放。
  timer_start port
  OCCUPANT="$(listen_pid)"
  [[ -z "$OCCUPANT" ]] || die "127.0.0.1:3010 仍被其他进程占用（PID $OCCUPANT），未切换版本"
  timer_stop port
  print -- "  · 端口确认（3010 已释放）：$(timer_label port)$(elapsed_label)"
  timer_start switch
  if ! "$NODE_BIN" "$RELEASE_TOOL" activate --release-id "$RELEASE_ID" >|"$CONTROL_DIR/activate.log" 2>&1; then
    timer_stop switch
    tail -n 20 "$CONTROL_DIR/activate.log" >&2
    die "候选切换失败，旧版本仍保留"
  fi
  timer_stop switch
  # activate 自报的 `[rotate]` 行里就是轮替内部的分项（事务检查/进程扫描/候选校验/四次搬移/落事务
  # + 每次搬移的秒数与文件数）。搬移大目录时这一行会很长——那正是要找的东西。
  ROTATE_TIMING="$(sed -n 's/^\[rotate\][[:space:]]*//p' "$CONTROL_DIR/activate.log" 2>/dev/null | tail -n 1)"
  print -- "  · 版本轮替（activate）：$(timer_label switch)${ROTATE_TIMING:+（$ROTATE_TIMING）}$(elapsed_label)"
  timer_stop rotate
  print -- "  · 停旧与切换合计：$(timer_label rotate)$(elapsed_label)"
fi

timer_start serve
SERVER_PID="$(read_pid_file "$SERVER_PID_FILE")"
if ! is_server_pid "$SERVER_PID"; then
  [[ -n "$SERVER_PID" ]] && rm -f "$SERVER_PID_FILE"
  OCCUPANT="$(listen_pid)"
  if [[ -n "$OCCUPANT" ]]; then
    is_server_pid "$OCCUPANT" || release_failure "127.0.0.1:3010 已被其他进程占用（PID $OCCUPANT），未停止它"
    SERVER_PID="$OCCUPANT"
  else
    nohup env \
      BIND_ADDR=0.0.0.0:3010 \
      ACCOUNT_DB="$DB" \
      CLIENT_DIST="$DIST" \
      ASSETS_DIR="$ASSETS" \
      GAMEPLAY_FILE="$GAMEPLAY" \
      MAP_FILE="$MAP" \
      MAP_CATALOG="$MAP_CATALOG" \
      "$SERVER_BIN" >>"$SERVER_LOG" 2>&1 </dev/null &
    SERVER_PID=$!
    sleep 0.2
  fi
  print -r -- "$SERVER_PID" >| "$SERVER_PID_FILE"
fi
wait_health || release_failure "3010 health 未就绪；日志：$SERVER_LOG"
if (( ! CURRENT_FRESH )); then
  "$NODE_BIN" "$RELEASE_TOOL" commit --release-id "$RELEASE_ID" >/dev/null || die "health 已通过但旧版本清理未完成；服务保持当前版本，请稍后执行 commit"
fi
timer_stop serve
print -- "✔ [3/4] 正式服务器：已运行（PID $SERVER_PID，端口 3010，耗时 $(timer_label serve)$(elapsed_label)）"
timer_start bot

if [[ ! -f "$BOT_CREDENTIALS" ]]; then
  BOT_SUMMARY="✗ 未启动（凭据缺失）"
  print -- "✘ [4/4] 陪测 bot：未启动——恢复 $BOT_CREDENTIALS 后再次启动即可连接$(elapsed_label)"
  print_summary
  exit 0
fi

BOT_PID="$(read_pid_file "$BOT_PID_FILE")"
if ! is_bot_pid "$BOT_PID"; then
  [[ -n "$BOT_PID" ]] && rm -f "$BOT_PID_FILE"
  BOT_PID="$(find_bot_pid || true)"
  if [[ -z "$BOT_PID" ]]; then
    nohup env \
      SERVER_URL=http://127.0.0.1:3010 \
      BOT_CREDENTIALS_FILE="$BOT_CREDENTIALS" \
      "$NODE_BIN" "$ROOT/bots/run.mjs" demo >>"$BOT_LOG" 2>&1 </dev/null &
    BOT_PID=$!
  fi
  print -r -- "$BOT_PID" >| "$BOT_PID_FILE"
fi
for _ in {1..40}; do
  if lsof -nP -a -p "$BOT_PID" -iTCP:3010 -sTCP:ESTABLISHED >/dev/null 2>&1; then break; fi
  sleep 0.25
done
is_bot_pid "$BOT_PID" || die "3010 陪测 bot 未保持运行；日志：$BOT_LOG"
lsof -nP -a -p "$BOT_PID" -iTCP:3010 -sTCP:ESTABLISHED >/dev/null 2>&1 || die "3010 陪测 bot 未连接；日志：$BOT_LOG"
timer_stop bot
print -- "✔ [4/4] 陪测 bot：已连接（PID $BOT_PID，耗时 $(timer_label bot)$(elapsed_label)）"
BOT_SUMMARY="✓ 已连接（PID $BOT_PID）"
print_summary
