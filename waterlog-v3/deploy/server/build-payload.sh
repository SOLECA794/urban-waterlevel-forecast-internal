#!/bin/bash
# build-payload.sh — 打包 waterlog-v3 的服务器部署包
#
# 用法：bash deploy/server/build-payload.sh [输出路径]
# 产物：一个 tar.gz，里面是服务器上 /opt/waterlog-v3 的完整内容
#
# 打什么、不打什么：
#   打    engine 源码 + 模型 + 数据集 + sim 状态；web/dist；api 源码（服务器上 go build）
#   不打  api/waterlog-api.exe（Windows 产物，服务器要重新编译）
#         api/data/waterlog.db（本地库，服务器自己建）
#         engine/data/eval.sqlite（本地 50MB 评估库，服务器重建）
#         web/node_modules、engine/__pycache__、logs、shots、_stage
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$ROOT/dist-deploy/waterlog-v3-payload.tar.gz}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

APP="$STAGE/waterlog-v3"
mkdir -p "$APP"/{engine,web,api,logs}

echo ">> 收集文件"

# 本机 Git Bash 没有 rsync，用 tar 管道复制（排除规则写在 tar 的 --exclude 里）
copy_tree() {  # copy_tree <源目录> <目标父目录> [排除模式...]
  local src="$1" dst="$2"; shift 2
  mkdir -p "$dst"
  local ex=() a
  for a in "$@"; do ex+=(--exclude="$a"); done
  tar -cf - -C "$(dirname "$src")" "${ex[@]}" "$(basename "$src")" | tar -xf - -C "$dst"
}

# --- 引擎：源码 + 运行时数据 ---
copy_tree "$ROOT/engine/waterlog" "$APP/engine/" '__pycache__' '*.pyc'
mkdir -p "$APP/engine/data/models"
cp "$ROOT/engine/data/dataset.npz"    "$APP/engine/data/"
cp "$ROOT/engine/data/sim_state.npz"  "$APP/engine/data/"
cp "$ROOT/engine/data/sim_clock.json" "$APP/engine/data/"
cp "$ROOT/engine/data/metrics.json"   "$APP/engine/data/"
cp "$ROOT/engine/data/rules.json"     "$APP/engine/data/"
cp "$ROOT/engine/requirements.txt"    "$APP/engine/"
# 只带当前在用的模型 + latest.txt 指针
LATEST="$(cat "$ROOT/engine/data/models/latest.txt").joblib"
cp "$ROOT/engine/data/models/$LATEST" "$APP/engine/data/models/"
cp "$ROOT/engine/data/models/latest.txt" "$APP/engine/data/models/"
echo "   引擎模型版本：$LATEST"

# --- 前端：构建产物 ---
copy_tree "$ROOT/web/dist" "$APP/web/"

# --- API：Go 源码（服务器上编译，架构才匹配） ---
copy_tree "$ROOT/api" "$APP/" '*.exe' '*.exe~' 'data'
mkdir -p "$APP/api/data"

# --- 部署脚本与单元文件 ---
mkdir -p "$APP/deploy"
cp "$ROOT/deploy/server/"*.sh        "$APP/deploy/" 2>/dev/null || true
cp "$ROOT/deploy/server/"*.service   "$APP/deploy/"

mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$STAGE" waterlog-v3
printf '>> 打包完成 %s (%s)\n' "$OUT" "$(du -h "$OUT" | cut -f1)"
printf '>> 内容概览\n'
tar -tzf "$OUT" | sed 's|waterlog-v3/||' | awk -F/ '{print $1"/"$2}' | sort -u | head -20
