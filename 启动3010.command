#!/bin/zsh
# One-click launcher for the gameplay server only. It never manages port 3000.
set -u

ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
CONTROL_DIR="$ROOT/evidence/runtime/3010-control"
SERVER_PID_FILE="$CONTROL_DIR/server.pid"
BOT_PID_FILE="$CONTROL_DIR/bot.pid"
SERVER_LOG="$CONTROL_DIR/server.log"
BOT_LOG="$CONTROL_DIR/bot.log"
BOT_CREDENTIALS="$CONTROL_DIR/bot-credentials.json"
SERVER_BIN="$ROOT/server/target/debug/maplestory-server"
DB="$ROOT/server/data/qa-gameplay-round2.sqlite3"
DIST="$ROOT/client/dist-next"
ASSETS="$ROOT/client/public-gameplay/assets"
GAMEPLAY="$ROOT/evidence/runtime/gameplay-round2.json"
MAP="$ROOT/evidence/runtime/map-round2.json"
HEALTH_URL="http://127.0.0.1:3010/api/health"

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
  [[ "$cwd" == "$ROOT" || "$cmd" == *"$SERVER_BIN"* ]]
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
    if [[ "$health" == *'"protocolVersion":2'* && "$health" == *'"contentVersion":"gms83-gameplay-2"'* ]]; then return 0; fi
    sleep 0.25
  done
  return 1
}

mkdir -p "$CONTROL_DIR" || die "无法创建运行目录：$CONTROL_DIR"
chmod 700 "$CONTROL_DIR"
[[ -x "$SERVER_BIN" ]] || die "缺少已构建服务：$SERVER_BIN；需要时运行 ~/.cargo/bin/cargo build --manifest-path server/Cargo.toml"
[[ -f "$DB" ]] || die "数据库不存在，为避免误建新库已停止：$DB"
[[ -f "$DIST/index.html" && -d "$ASSETS" && -f "$GAMEPLAY" && -f "$MAP" ]] || die "3010 固定配置或 dist-next 资源不完整"
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "找不到 Node 22；请先加载 Node 22 环境"
NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[[ "$NODE_MAJOR" =~ '^[0-9]+$' ]] && (( NODE_MAJOR >= 22 )) || die "需要 Node 22 或更高版本"

SERVER_PID="$(read_pid_file "$SERVER_PID_FILE")"
if ! is_server_pid "$SERVER_PID"; then
  [[ -n "$SERVER_PID" ]] && rm -f "$SERVER_PID_FILE"
  OCCUPANT="$(listen_pid)"
  if [[ -n "$OCCUPANT" ]]; then
    is_server_pid "$OCCUPANT" || die "127.0.0.1:3010 已被其他进程占用（PID $OCCUPANT），未停止它"
    SERVER_PID="$OCCUPANT"
  else
    nohup env \
      BIND_ADDR=127.0.0.1:3010 \
      ACCOUNT_DB="$DB" \
      CLIENT_DIST="$DIST" \
      ASSETS_DIR="$ASSETS" \
      GAMEPLAY_FILE="$GAMEPLAY" \
      MAP_FILE="$MAP" \
      "$SERVER_BIN" >>"$SERVER_LOG" 2>&1 </dev/null &
    SERVER_PID=$!
    sleep 0.2
  fi
  print -r -- "$SERVER_PID" >| "$SERVER_PID_FILE"
fi
wait_health || die "3010 health 未就绪；日志：$SERVER_LOG"

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
print -- "3010 游戏服务已运行（PID $SERVER_PID）"
print -- "陪测 bot 已运行（PID $BOT_PID）；日志：$BOT_LOG"
print -- "数据库与账号未重置；控制文件：$CONTROL_DIR"
