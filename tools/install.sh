#!/usr/bin/env bash
# 构建 lark-coding-agent-bridge 并安装到系统（已安装则覆盖更新），随后重启所有在运行的 daemon。
#
# 做三件事：
#   1. pnpm build               —— 构建 dist/
#   2. 重建两级全局 symlink       —— ~/.local/lib/node_modules/lark-channel-bridge
#                                    → 本仓库；~/.local/bin/lark-channel-bridge
#                                    → bin/lark-channel-bridge.mjs（存在则覆盖）
#   3. 遍历所有 profile，逐个重启在运行的 daemon（未运行的 profile 不拉起）
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

echo "==> 重启所有在运行的 daemon"
if ! command -v "$BIN_NAME" >/dev/null 2>&1; then
  echo "    $BIN_NAME 不在 PATH（$BIN_DIR 未加入 PATH？），请手动重启" >&2
  exit 1
fi
# profile list 的 STATUS 列带 pid= 即该 profile 的 daemon 在运行；只重启这些，
# 不把已停用的 profile 意外拉起。
# 首列 ACTIVE 为 `*`（激活）或空；空时 awk 按空白切分会左移一列，需按首列判断。
RUNNING_PROFILES="$("$BIN_NAME" profile list | awk 'NR>1 && /pid=/ {print ($1=="*") ? $2 : $1}')"
if [ -z "$RUNNING_PROFILES" ]; then
  echo "    没有在运行的 daemon，跳过"
  exit 0
fi
FAILED=0
while IFS= read -r profile; do
  [ -z "$profile" ] && continue
  echo "    restart --profile $profile"
  if ! "$BIN_NAME" restart --profile "$profile" 2>&1 | tail -1; then
    echo "    profile $profile 重启失败" >&2
    FAILED=1
  fi
done <<< "$RUNNING_PROFILES"
exit "$FAILED"
