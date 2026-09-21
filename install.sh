#!/usr/bin/env bash
# dsh-git-lite 安装脚本（手动路径；推荐优先用官方 CLI：
#   dsh plugin --profile web add dsh-git-lite               # npm 发布后
#   dsh plugin --profile web add /path/to/dsh-git-lite      # 本地目录
#   dsh plugin --profile web add link:/path/to/dsh-git-lite # 链接方式，改完刷新页面即生效
# ）
#
# 用法：
#   bash install.sh                                        # 默认 profile：~/.dsh/profiles/web
#   DSH_PROFILE_DIR=~/.dsh/profiles/dev bash install.sh    # 指定其它 profile
#
# 装完需重启 dsh web 生效（会话有持久化，可恢复）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PKG_NAME="dsh-git-lite"
PATCH_FILE="cordis.patch.yml"
MARKER="id: git-lite"

if [ ! -d "$PROFILE" ]; then
  echo "❌ 找不到 DSH profile：${PROFILE}（可用 DSH_PROFILE_DIR 指定）"
  exit 1
fi

# 1) 包本体 → profile 的 node_modules（hoisted 布局：目录即包，放入即可被解析）
DEST="${PROFILE}/node_modules/${PKG_NAME}"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "${HERE}/package.json" "${HERE}/lib" "${HERE}/${PATCH_FILE}" "$DEST/"
echo "✅ 已装入包：$DEST"

# 2) 加载器条目 → profile 的 cordis.patch.yml（幂等）
TARGET="${PROFILE}/${PATCH_FILE}"
if [ -f "$TARGET" ] && grep -q "$MARKER" "$TARGET"; then
  echo "⏭️  ${PATCH_FILE} 已包含 ${MARKER}，跳过打补丁"
elif [ -s "$TARGET" ]; then
  {
    echo
    echo "# dsh-git-lite 加载器条目（install.sh 追加，可手动删除）"
    echo "- insert:"
    echo "    - id: git-lite"
    echo "      name: dsh-git-lite"
    echo "      inject: [webServer, sessions, workspaceRegistry]"
    echo "      config: {}"
  } >> "$TARGET"
  echo "✅ 已在 ${PATCH_FILE} 追加加载器条目"
else
  cat "${HERE}/${PATCH_FILE}" > "$TARGET"
  echo "✅ 已写入 ${PATCH_FILE}（样例内容）"
fi

echo
echo "完成。重启 dsh web 后生效。"
echo "打开方式：右侧栏切换到「Git」标签页，或点会话头部右侧带分支名的胶囊。"
echo "提示：pnpm install 会清理手工放置的包，重装依赖后请重跑本脚本。"
