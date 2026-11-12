#!/usr/bin/env bash
# v2 一体化构建：前端 build → 产物嵌入 backend/webembed/web → Go 单二进制
# 用法：bash build.sh [输出路径]        （默认 backend/server，Linux amd64）
#       GOOS=windows bash build.sh backend/server.exe
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/${1:-backend/server}"

echo "==> 1/3 前端构建"
(cd "$ROOT/frontend" && npm run build)

echo "==> 2/3 嵌入静态资源"
rm -rf "$ROOT/backend/webembed/web"
mkdir -p "$ROOT/backend/webembed/web"
cp -r "$ROOT/frontend/dist/." "$ROOT/backend/webembed/web/"

echo "==> 3/3 Go 交叉编译（GOOS=${GOOS:-linux}）"
(cd "$ROOT/backend" && CGO_ENABLED=0 GOOS="${GOOS:-linux}" GOARCH=amd64 go build \
  -mod=vendor -trimpath -ldflags="-s -w" -o "$OUT" ./cmd/server)
ls -lh "$OUT"
echo "构建完成：$OUT"
