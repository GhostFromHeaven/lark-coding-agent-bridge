#!/usr/bin/env bash
# 构建 lark-coding-agent-bridge 并安装到系统（已安装则覆盖更新），随后重启 daemon。
#
# 做三件事：
#   1. pnpm build               —— 构建 dist/
#   2. 重建两级全局 symlink       —— ~/.local/lib/node_modules/lark-channel-bridge
#                                    → 本仓库；~/.local/bin/lark-channel-bridge
#                                    → bin/lark-channel-bridge.mjs（存在则覆盖）
#   3. lark-channel-bridge restart —— 重启 launchd daemon 加载新构建
#
# 用法：tools/install.sh [--no-restart]
#   --no-restart  只构建+安装，不重启 daemon
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_NAME="lark-channel-bridge"
BIN_DIR="${HOME}/.local/bin"
MODULES_DIR="${HOME}/.local/lib/node_modules"
RESTART=1

for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    *) echo "未知参数: $arg（支持 --no-restart）" >&2; exit 1 ;;
  esac
done

echo "==> 构建（pnpm build）"
cd "$REPO_ROOT"
pnpm build

echo "==> 安装全局命令"
mkdir -p "$BIN_DIR" "$MODULES_DIR"
# 两级 symlink 与 npm link 产物同构；ln -sfn 覆盖已有链接（含 npm link 留下的）
ln -sfn "$REPO_ROOT" "$MODULES_DIR/$BIN_NAME"
ln -sfn "$MODULES_DIR/$BIN_NAME/bin/$BIN_NAME.mjs" "$BIN_DIR/$BIN_NAME"
echo "    $BIN_DIR/$BIN_NAME -> $MODULES_DIR/$BIN_NAME/bin/$BIN_NAME.mjs -> $REPO_ROOT"

if [ "$RESTART" -eq 0 ]; then
  echo "==> 跳过 daemon 重启（--no-restart）"
  exit 0
fi

echo "==> 重启 daemon"
if ! command -v "$BIN_NAME" >/dev/null 2>&1; then
  echo "    $BIN_NAME 不在 PATH（$BIN_DIR 未加入 PATH？），请手动重启" >&2
  exit 1
fi
"$BIN_NAME" restart
