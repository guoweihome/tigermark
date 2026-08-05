#!/usr/bin/env bash
# Upload local release artifacts to Gitee Release v1.0.0
# Usage:
#   export GITEE_TOKEN=你的私人令牌
#   ./scripts/upload-gitee-release.sh
set -euo pipefail

OWNER="${GITEE_OWNER:-pytiger}"
REPO="${GITEE_REPO:-tigermark}"
RELEASE_ID="${GITEE_RELEASE_ID:-775503}"
TOKEN="${GITEE_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "请先设置 GITEE_TOKEN（Gitee 私人令牌，需有仓库权限）"
  exit 1
fi

API="https://gitee.com/api/v5/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/attach_files"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/release"

FILES=(
  "TigerMark-1.0.0-win-portable.exe"
  "TigerMark-1.0.0-mac.zip"
  "TigerMark-1.0.0.dmg"
)

for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "跳过（不存在）: $f"
    continue
  fi
  size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  if (( size > 104857600 )); then
    echo "跳过（超过 100MB）: $f ($size bytes)"
    continue
  fi
  echo "上传 $f ..."
  code=$(curl -sS -o /tmp/gitee-upload.json -w "%{http_code}" -X POST "$API" \
    -H "Authorization: Bearer ${TOKEN}" \
    -F "file=@${f}")
  echo "HTTP $code"
  python3 - <<'PY'
import json
print(json.load(open("/tmp/gitee-upload.json")))
PY
done

echo "完成。查看: https://gitee.com/${OWNER}/${REPO}/releases/tag/v1.0.0"
