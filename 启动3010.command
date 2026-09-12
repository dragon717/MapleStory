#!/bin/zsh
# One-click launcher for the gameplay server only. It never manages port 3000.
set -u

ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
cd -- "$ROOT" || exit 1
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

release_start_lock() {
  [[ "${START_LOCK_OWNED:-0}" == 1 ]] || return 0
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

die() { print -u2 -- "启动失败：$*"; exit 1; }
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
    health="$(curl -fsS --max-time 1 "$HEALTH_URL" 2>/dev/null || true)"
    if "$NODE_BIN" -e 'const h=JSON.parse(process.argv[1]); process.exit(h.ok === true && h.protocolVersion === Number(process.argv[2]) && h.contentVersion === process.argv[3] ? 0 : 1)' "$health" "$PROTOCOL_VERSION" "$CONTENT_VERSION" 2>/dev/null; then return 0; fi
    sleep 0.25
  done
  return 1
}

release_failure() {
  print -u2 -- "启动失败：$1"
  zsh "$ROOT/关闭3010.command" >/dev/null 2>&1 || true
  "$NODE_BIN" "$RELEASE_TOOL" rollback --release-id "$RELEASE_ID" >/dev/null 2>&1 || print -u2 -- "旧成功版本恢复失败；请检查 build/.activation.json 后手动 rollback"
  exit 1
}

mkdir -p "$CONTROL_DIR" || die "无法创建运行目录：$CONTROL_DIR"
chmod 700 "$CONTROL_DIR"
acquire_start_lock
mkdir -p "${DB:h}" || die "无法创建数据库目录"
[[ -d "$ASSETS" && -f "$GAMEPLAY" && -f "$MAP" && -f "$MAP_CATALOG" ]] || die "3010 固定配置或资源不完整"
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "找不到 Node 22；请先加载 Node 22 环境"
NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[[ "$NODE_MAJOR" =~ '^[0-9]+$' ]] && (( NODE_MAJOR >= 22 )) || die "需要 Node 22 或更高版本"

PROTOCOL_VERSION="$($NODE_BIN --disable-warning=ExperimentalWarning --experimental-strip-types --input-type=module -e 'import { PROTOCOL_VERSION } from "./shared/protocol.ts"; console.log(PROTOCOL_VERSION)')" || die "无法读取协议版本"
CONTENT_VERSION="$($NODE_BIN --disable-warning=ExperimentalWarning --experimental-strip-types --input-type=module -e 'import { CONTENT_VERSION } from "./shared/protocol.ts"; console.log(CONTENT_VERSION)')" || die "无法读取资源版本"
CARGO_BIN="$(command -v cargo || true)"
[[ -n "$CARGO_BIN" ]] || CARGO_BIN="$HOME/.cargo/bin/cargo"
[[ -x "$CARGO_BIN" ]] || die "找不到 Cargo，无法构建新版服务"
export CARGO_BIN
"$NODE_BIN" "$RELEASE_TOOL" recover >/dev/null || die "上次发布恢复失败，未启动新实例"
"$NODE_BIN" "$ROOT/scripts/check_tms273_runtime.cjs" "$CONTENT_VERSION" || die "运行资源未装配或不兼容，未停止正在运行的服务"
print -- "正在生成客户端与服务器候选；成功后重启 3010…"
"$NODE_BIN" "$RELEASE_TOOL" prepare || die "候选构建失败，未停止正在运行的服务"
RELEASE_ID="$($NODE_BIN -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(m.releaseId)' "$ROOT/build/tmp/metadata.json")" || die "无法读取候选 releaseId，未停止正在运行的服务"
[[ -n "$RELEASE_ID" ]] || die "候选 releaseId 为空，未停止正在运行的服务"
zsh "$ROOT/关闭3010.command" || die "旧服务未能停止，未启动新实例"
OCCUPANT="$(listen_pid)"
[[ -z "$OCCUPANT" ]] || die "127.0.0.1:3010 仍被其他进程占用（PID $OCCUPANT），未切换版本"
"$NODE_BIN" "$RELEASE_TOOL" activate --release-id "$RELEASE_ID" || die "候选切换失败，旧版本仍保留"

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
"$NODE_BIN" "$RELEASE_TOOL" commit --release-id "$RELEASE_ID" || die "health 已通过但旧版本清理未完成；服务保持当前版本，请稍后执行 commit"

if [[ ! -f "$BOT_CREDENTIALS" ]]; then
  print -- "3010 游戏服务已运行（PID $SERVER_PID）"
  print -- "原陪测 bot 凭据缺失；未创建新账号。恢复 $BOT_CREDENTIALS 后再次启动即可连接。"
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
print -- "3010 游戏服务已运行（PID $SERVER_PID）"
print -- "陪测 bot 已运行（PID $BOT_PID）；日志：$BOT_LOG"
print -- "数据库与账号未重置；控制文件：$CONTROL_DIR"
