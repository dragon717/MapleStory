#!/bin/zsh
# 一键打出 Windows 端资源包（双击运行）
# 产物：artifacts/win-bundle/MapleStory-win-<版本>.zip

set -e
# 以本文件所在目录为仓库根，双击/终端都能定位
ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="$HOME/.workbuddy/binaries/node/versions/22.22.2-3/bin/node"

echo "=============================================="
echo " MapleStory → Windows 资源包打包"
echo " 仓库根：$ROOT"
echo "=============================================="

if [ ! -x "$NODE" ]; then
  echo "[提示] 找不到 WorkBuddy 管理的 node，回退系统 node…"
  NODE="$(command -v node || true)"
fi
if [ -z "$NODE" ]; then
  echo "[错误] 未找到 node，请先安装 Node.js"
  exit 1
fi

cd "$ROOT"
"$NODE" scripts/package_win_bundle.cjs

ZIP="$ROOT/artifacts/win-bundle/$(ls -t "$ROOT/artifacts/win-bundle" | grep '^MapleStory-win-.*\.zip$' | head -1)"
echo ""
echo "✅ 打包完成：$ZIP"
open -R "$ZIP"
