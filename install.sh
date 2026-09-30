#!/usr/bin/env bash
# dsh-git-lite 安装脚本（Web 版 / 桌面版通用）。
#
# Windows 上的桌面版请改用 install.ps1 —— 它会自动发现桌面自带的 dsh.cmd：
#   pwsh -File install.ps1                 # 装进 desktop profile
#   pwsh -File install.ps1 -Profile web    # 装进 web profile
#
# 本脚本刻意**不自己拼 profile 的加载器条目**，而是转交官方 CLI。原因：一个
# 组合包（bundle）要同时登记 profile 的 dependencies、dsh.profile.bundles 与
# cordis.patch.yml 三处，官方实现才是权威；手搓容易半对半错，而半错的症状
# （标签页不出现、或出现两次）很难查。
#
# 用法：
#   bash install.sh                     # 默认装进 desktop profile
#   bash install.sh web                 # 装进 web profile
#   bash install.sh desktop /path/to/dsh-git-lite-0.2.0.tgz
#   DSH_CLI=~/bin/dsh bash install.sh   # 指定 dsh CLI
#
# 关于 desktop profile：它由桌面应用独占管理，普通 dsh 会被拒绝
#   error: profile "desktop" is managed exclusively by the Electron application
# 必须用桌面安装目录里的 CLI（<安装目录>/resources/runtime/cli/bin/dsh.cmd）。
# 装之前请完全退出 DeepSeek Harness。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${1:-desktop}"
SPEC="${2:-link:$HERE}"
PKG_NAME="dsh-git-lite"

# CLI 发现顺序：显式 DSH_CLI → PATH 上的 dsh → 桌面安装目录（仅 Windows/Git Bash）
CLI="${DSH_CLI:-}"
if [ -z "$CLI" ] && command -v dsh >/dev/null 2>&1; then
  CLI="$(command -v dsh)"
fi
if [ -z "$CLI" ] && [ -n "${DSH_DESKTOP_DIR:-}" ] &&
   [ -x "${DSH_DESKTOP_DIR}/resources/runtime/cli/bin/dsh.cmd" ]; then
  CLI="${DSH_DESKTOP_DIR}/resources/runtime/cli/bin/dsh.cmd"
fi

if [ -z "$CLI" ]; then
  cat >&2 <<'EOF'
❌ 找不到 dsh CLI。
   · 桌面版：用 install.ps1（会自动发现桌面自带的 dsh.cmd），
     或先设 DSH_DESKTOP_DIR=<桌面安装目录>。
   · Web 版：需要 PATH 上有 dsh（npm i -g @deepseek-ai/dsh@0.2.0-rc.2）。
   · 也可以直接给 DSH_CLI=<dsh 可执行文件路径>。
EOF
  exit 1
fi

if [ "$PROFILE" = "desktop" ]; then
  PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
  if [ ! -f "${PROFILE_DIR}/package.json" ]; then
    echo "❌ desktop profile 尚未初始化（${PROFILE_DIR}/package.json 不存在）。" >&2
    echo "   请先启动一次 DeepSeek Harness，再完全退出，然后重跑本脚本。" >&2
    exit 1
  fi
fi

echo "CLI    ：$CLI"
echo "profile：$PROFILE"
echo "安装源 ：$SPEC"
echo

"$CLI" plugin --profile "$PROFILE" add "$SPEC"

echo
echo "✅ 已装入。重启 DeepSeek Harness 后，在右侧栏切到「Git」标签页"
echo "   （或点会话头部右侧带分支名的胶囊）。"
