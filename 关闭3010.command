#!/bin/zsh
# One-click stopper for the gameplay server only. It never manages port 3000.
set -u

ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
CONTROL_DIR="$ROOT/evidence/runtime/3010-control"
SERVER_PID_FILE="$CONTROL_DIR/server.pid"
BOT_PID_FILE="$CONTROL_DIR/bot.pid"

print_pid() { [[ -r "$1" ]] || return 0; sed -n '1{s/[[:space:]]//g;p;}' "$1"; }
process_command() { ps -p "$1" -o command= 2>/dev/null | sed 's/^[[:space:]]*//'; }
process_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | tail -n 1; }
is_server_pid() {
  local pid="$1" cmd cwd
  [[ "$pid" =~ '^[0-9]+$' ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(process_command "$pid")"
  cwd="$(process_cwd "$pid")"
  [[ "$cmd" == *maplestory-server* ]] || return 1
  [[ "$cwd" == "$ROOT" || "$cmd" == *"$ROOT/server/target/debug/maplestory-server"* ]] || return 1
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
bot_candidates() {
  local candidates candidate
  candidates="$(pgrep -f 'bots/run.mjs demo' 2>/dev/null || true)"
  for candidate in ${(f)candidates}; do
    is_bot_pid "$candidate" && print -r -- "$candidate"
  done
}
stop_pid() {
  local pid="$1" label
  label="$2"
  kill -TERM "$pid" 2>/dev/null || return 0
  for _ in {1..40}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    print -u2 -- "$label（PID $pid）未在 4 秒内退出，未强杀；请查看进程后重试。"
    return 1
  fi
}

result=0
BOT_PID="$(print_pid "$BOT_PID_FILE")"
if is_bot_pid "$BOT_PID"; then
  stop_pid "$BOT_PID" "3010 陪测 bot" || result=1
else
  [[ -n "$BOT_PID" ]] && rm -f "$BOT_PID_FILE"
  for BOT_PID in ${(f)"$(bot_candidates)"}; do
    stop_pid "$BOT_PID" "3010 陪测 bot" || result=1
  done
fi
rm -f "$BOT_PID_FILE"

SERVER_PID="$(print_pid "$SERVER_PID_FILE")"
if ! is_server_pid "$SERVER_PID"; then
  [[ -n "$SERVER_PID" ]] && rm -f "$SERVER_PID_FILE"
  SERVER_PID="$(listen_pid)"
fi
if [[ -n "$SERVER_PID" ]] && is_server_pid "$SERVER_PID"; then
  stop_pid "$SERVER_PID" "3010 游戏服务" || result=1
else
  if [[ -n "$SERVER_PID" ]]; then
    print -u2 -- "3010 端口上的进程不是本项目实例，未停止。"
    result=1
  fi
fi
rm -f "$SERVER_PID_FILE"
(( result == 0 )) || exit "$result"
print -- "3010 游戏服务与陪测 bot 已停止；数据库、账号和日志保留。"
