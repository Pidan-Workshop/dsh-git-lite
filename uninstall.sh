#!/usr/bin/env bash
# dsh-git-lite 卸载脚本：移除包本体与 profile 里的加载器条目。
set -euo pipefail

PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PKG_NAME="dsh-git-lite"
PATCH_FILE="cordis.patch.yml"

DEST="${PROFILE}/node_modules/${PKG_NAME}"
if [ -d "$DEST" ]; then
  rm -rf "$DEST"
  echo "✅ 已移除包：$DEST"
else
  echo "⏭️  包不在 profile 中：$DEST"
fi

TARGET="${PROFILE}/${PATCH_FILE}"
if [ -f "$TARGET" ] && grep -q "id: git-lite" "$TARGET"; then
  cp "$TARGET" "${TARGET}.bak-git-lite"
  # 删掉注释行 + insert 块的四行（id/name/inject/config）
  python3 - "$TARGET" <<'PY'
import re, sys
p = sys.argv[1]
src = open(p, encoding='utf-8').read()
block = re.compile(
    r"\n?# dsh-git-lite 加载器条目[^\n]*\n- insert:\n(?:    .*\n)+"
)
out, n = block.subn("\n", src)
open(p, 'w', encoding='utf-8').write(out)
print(f"✅ 已从 {p} 移除加载器条目（命中 {n} 处）")
PY
  echo "   备份留在 ${TARGET}.bak-git-lite"
else
  echo "⏭️  ${PATCH_FILE} 中没有 git-lite 条目"
fi

echo
echo "完成。重启 dsh web 后生效。"
