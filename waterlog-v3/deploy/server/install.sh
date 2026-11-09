#!/bin/bash
# install.sh — 在服务器上执行：安装依赖、编译、装 systemd 单元、启动
#
# 前置：部署包已解到 /opt/waterlog-v3（本脚本就在 /opt/waterlog-v3/deploy/install.sh）
# 用法：bash /opt/waterlog-v3/deploy/install.sh
set -euo pipefail

APP=/opt/waterlog-v3
PY=/usr/bin/python3.11
GO=/usr/local/go/bin/go
cd "$APP"

echo "== 1/6 目录与日志"
mkdir -p logs api/data engine/data/models

echo "== 2/6 Python 虚拟环境"
if [ ! -x engine/.venv/bin/python ]; then
  "$PY" -m venv engine/.venv
fi
engine/.venv/bin/pip install -q --upgrade pip
# 走阿里云内网源（/etc/pip.conf 已配）
engine/.venv/bin/pip install -q -r engine/requirements.txt
engine/.venv/bin/python -c "import numpy,sklearn,fastapi,uvicorn,joblib;print('   依赖 OK', numpy.__version__, sklearn.__version__)"

echo "== 3/6 编译 Go API"
export GOPROXY=https://goproxy.cn,direct
export GOFLAGS=-mod=mod
export GOCACHE=/root/.cache/go-build
cd "$APP/api"
# vendor 目录不存在时用模块代理拉依赖；服务器内存小，限制并行编译数
GOMAXPROCS=2 "$GO" build -trimpath -ldflags "-s -w" -o waterlog-api ./cmd/waterlog-api
ls -la waterlog-api
cd "$APP"

echo "== 4/6 安装 systemd 单元"
cp deploy/wl-v3-engine.service /etc/systemd/system/
cp deploy/wl-v3-api.service    /etc/systemd/system/
systemctl daemon-reload

echo "== 5/6 启动顺序：先引擎，后 API"
systemctl enable --now wl-v3-engine.service
for i in $(seq 1 40); do
  if curl -sf -o /dev/null http://127.0.0.1:8201/health; then echo "   引擎就绪（${i}次探测）"; break; fi
  sleep 3
done
curl -sf -o /dev/null http://127.0.0.1:8201/health || { echo "!! 引擎未就绪，看 logs/engine.log"; tail -30 logs/engine.log; exit 1; }

systemctl enable --now wl-v3-api.service
for i in $(seq 1 20); do
  if curl -sf -o /dev/null http://127.0.0.1:8200/api/health; then echo "   API 就绪（${i}次探测）"; break; fi
  sleep 2
done

echo "== 6/6 健康检查"
printf '   引擎 : '; curl -s http://127.0.0.1:8201/health | head -c 120; echo
printf '   API  : '; curl -s http://127.0.0.1:8200/api/health | head -c 200; echo
printf '   首页 : '; curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:8200/
echo "== 完成。对外地址 http://114.55.31.135:8200"
