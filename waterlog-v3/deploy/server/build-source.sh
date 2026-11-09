#!/bin/bash
# build-source.sh — 打包「可交接的完整源码」（给接手的人用，不是部署包）
#
# 与 build-payload.sh 的区别：
#   payload  只含运行所需（web/dist、模型、数据集）+ api/engine 源码 → 用来跑
#   本脚本   含 web/src、scripts、docs、README、.env.example 等 → 用来继续开发
#
# 不打：node_modules / .venv / __pycache__ / shots / 大二进制
#   （模型 .joblib、dataset.npz、eval.sqlite 加起来近百 MB，服务器上已有运行版，源码包里不需要）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$ROOT/dist-deploy/waterlog-v3-source.tar.gz}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

APP="$STAGE/waterlog-v3"
mkdir -p "$APP"

cd "$ROOT"
tar -cf - \
  --exclude='./web/node_modules' \
  --exclude='./web/dist' \
  --exclude='./engine/.venv' \
  --exclude='./engine/data/eval.sqlite' \
  --exclude='./engine/data/dataset.npz' \
  --exclude='./engine/data/sim_state.npz' \
  --exclude='./engine/data/models' \
  --exclude='./api/waterlog-api.exe' \
  --exclude='./api/data' \
  --exclude='./logs' \
  --exclude='./shots' \
  --exclude='./dist-deploy' \
  --exclude='./_tools' \
  --exclude='./_tmp' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  . | tar -xf - -C "$APP"

mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$STAGE" waterlog-v3
printf '>> 源码包 %s (%s)\n' "$OUT" "$(du -h "$OUT" | cut -f1)"
printf '>> 顶层内容\n'
tar -tzf "$OUT" | sed 's|waterlog-v3/||' | awk -F/ 'NF<=2 {print}' | sort -u | head -30
