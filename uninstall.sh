#!/usr/bin/env bash
# dsh-git-lite 卸载脚本（Web 版 / 桌面版通用）。
#
# Windows 上的桌面版请改用 uninstall.ps1。用法与本脚本同构：
#   bash uninstall.sh                   # 默认从 desktop profile 卸载
#   bash uninstall.sh web
#   DSH_CLI=~/bin/dsh bash uninstall.sh
#
# 同样转交官方 CLI，由它撤掉 profile 的 dependencies、dsh.profile.bundles
# 与 cordis.patch.yml 三处登记。装/卸之前请完全退出 DeepSeek Harness。
set -euo pipefail

PROFILE="${1:-desktop}"
PKG_NAME="dsh-git-lite"

CLI="${DSH_CLI:-}"
if [ -z "$CLI" ] && command -v dsh >/dev/null 2>&1; then
  CLI="$(command -v dsh)"
fi
if [ -z "$CLI" ] && [ -n "${DSH_DESKTOP_DIR:-}" ] &&
   [ -x "${DSH_DESKTOP_DIR}/resources/runtime/cli/bin/dsh.cmd" ]; then
  CLI="${DSH_DESKTOP_DIR}/resources/runtime/cli/bin/dsh.cmd"
fi

if [ -z "$CLI" ]; then
  echo "❌ 找不到 dsh CLI。桌面版请用 uninstall.ps1，或设 DSH_CLI=<dsh 路径>。" >&2
  exit 1
fi

echo "CLI    ：$CLI"
echo "profile：$PROFILE"
echo

"$CLI" plugin --profile "$PROFILE" remove "$PKG_NAME"

echo
echo "✅ 已卸载。重启 DeepSeek Harness 后生效。"
