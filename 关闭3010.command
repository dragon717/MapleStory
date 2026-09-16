#!/bin/zsh
# One-click stopper for the gameplay server only. It never manages port 3000.
set -u

ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
CONTROL_DIR="$ROOT/runtime/3010-control"
SERVER_PID_FILE="$CONTROL_DIR/server.pid"
BOT_PID_FILE="$CONTROL_DIR/bot.pid"

# ---- 分步耗时：先停陪测 bot 再停游戏服务，最后给出两段与总计 ----
zmodload zsh/datetime 2>/dev/null || true
now_seconds() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then print -r -- "$EPOCHREALTIME"
  else print -r -- "$(date +%s.%N 2>/dev/null || date +%s)"; fi
}
secs_between() { LC_NUMERIC=C printf '%.1f' $(( $2 - $1 )) }
STOP_ALL="$(now_seconds)"

print_pid() { [[ -r "$1" ]] || return 0; sed -n '1{s/[[:space:]]//g;p;}' "$1"; }
process_command() { ps -p "$1" -o command= 2>/dev/null | sed 's/^[[:space:]]*//'; }
process_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | tail -n 1; }
is_server_process() {
  local pid="$1" cmd cwd
  [[ "$pid" =~ '^[0-9]+$' ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(process_command "$pid")"
  cwd="$(process_cwd "$pid")"
  [[ "$cmd" == *maplestory-server* ]] || return 1
  [[ "$cwd" == "$ROOT" || "$cmd" == *"$ROOT/build/current/server/maplestory-server"* || "$cmd" == *"$ROOT/server/target/debug/maplestory-server"* ]] || return 1
}
is_server_pid() {
  local pid="$1"
  is_server_process "$pid" || return 1
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
STOP_BOT_DONE="$(now_seconds)"

SERVER_PID="$(print_pid "$SERVER_PID_FILE")"
if ! is_server_process "$SERVER_PID"; then
  [[ -n "$SERVER_PID" ]] && rm -f "$SERVER_PID_FILE"
  SERVER_PID="$(listen_pid)"
fi
if [[ -n "$SERVER_PID" ]] && is_server_process "$SERVER_PID"; then
  if stop_pid "$SERVER_PID" "3010 游戏服务"; then
    rm -f "$SERVER_PID_FILE"
  else
    result=1
  fi
else
  if [[ -n "$SERVER_PID" ]]; then
    print -u2 -- "3010 端口上的进程不是本项目实例，未停止。"
    result=1
  fi
fi
[[ -z "$SERVER_PID" ]] && rm -f "$SERVER_PID_FILE"
(( result == 0 )) || exit "$result"
STOP_SERVER_DONE="$(now_seconds)"
STOP_BOT_SECONDS="$(secs_between "$STOP_ALL" "$STOP_BOT_DONE")"
STOP_SERVER_SECONDS="$(secs_between "$STOP_BOT_DONE" "$STOP_SERVER_DONE")"
STOP_TOTAL_SECONDS="$(secs_between "$STOP_ALL" "$STOP_SERVER_DONE")"
print -- "3010 游戏服务与陪测 bot 已停止（耗时：陪测 bot ${STOP_BOT_SECONDS}s ｜ 游戏服务 ${STOP_SERVER_SECONDS}s ｜ 总计 ${STOP_TOTAL_SECONDS}s）；数据库、账号和日志保留。"
# 机器可读行：启动脚本剥掉 `[stop] ` 前缀后贴在「停旧服务」那一行上。
# **前缀必须保持 ASCII**（启动脚本按它取行），后面的中文只给人看，不参与匹配。
print -- "[stop] 陪测 bot ${STOP_BOT_SECONDS}s · 游戏服务 ${STOP_SERVER_SECONDS}s · 总计 ${STOP_TOTAL_SECONDS}s"
