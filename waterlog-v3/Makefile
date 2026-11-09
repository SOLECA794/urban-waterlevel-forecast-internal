# ============================================================================
# waterlog-v3 常用操作
#
# Windows 本机开发用 start.ps1（它负责起服务、管端口、写日志）。
# 这个 Makefile 面向 CI 与 Linux/容器环境，以及那些「一次性」的维护动作。
#
#   make help          看全部目标
#   make check         跑一遍全部静态检查（CI 用这个）
#   make up            容器起全套
# ============================================================================

SHELL := /bin/bash
.DEFAULT_GOAL := help

API_DIR    := api
ENGINE_DIR := engine
WEB_DIR    := web

# 容器编排：默认读 .env，没有就用 .env.example 的默认值
COMPOSE := docker compose

.PHONY: help
help: ## 显示所有目标
	@echo "waterlog-v3 — 城市内涝预警与水位预测"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- 依赖

.PHONY: deps
deps: ## 安装三层依赖（go mod / pip / npm）
	cd $(API_DIR) && go mod download
	cd $(ENGINE_DIR) && pip install -r requirements.txt
	cd $(WEB_DIR) && npm ci --no-audit --no-fund

# ---------------------------------------------------------------- 构建

.PHONY: build
build: build-web build-api ## 构建全部产物

.PHONY: build-web
build-web: ## 构建前端到 web/dist
	cd $(WEB_DIR) && npm run build

.PHONY: build-api
build-api: ## 编译 Go 二进制到 api/waterlog-api.exe
	cd $(API_DIR) && go build -trimpath -o waterlog-api.exe ./cmd/waterlog-api

.PHONY: build-linux
build-linux: ## 交叉编译 Linux 静态二进制（部署用）
	cd $(API_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
		go build -trimpath -ldflags "-s -w" -o waterlog-api ./cmd/waterlog-api

# ---------------------------------------------------------------- 检查（CI）

.PHONY: check
check: check-go check-web check-py ## 全部静态检查

.PHONY: check-go
check-go: ## go vet + gofmt 检查
	cd $(API_DIR) && go vet ./...
	@cd $(API_DIR) && out=$$(gofmt -l .); \
		if [ -n "$$out" ]; then echo "gofmt 需要格式化："; echo "$$out"; exit 1; fi

.PHONY: check-web
check-web: ## tsc 类型检查（不产出）
	cd $(WEB_DIR) && npx tsc --noEmit

.PHONY: check-py
check-py: ## python 语法与 import 检查
	cd $(ENGINE_DIR) && python -m compileall -q waterlog
	cd $(ENGINE_DIR) && python -c "import waterlog.api.app; print('engine import ok')"

# ---------------------------------------------------------------- 数据与模型

.PHONY: bootstrap
bootstrap: ## 重建 60 天数据集并训练全部模型（约 2 分钟）
	cd $(ENGINE_DIR) && python -m waterlog.cli.bootstrap --days 60

.PHONY: retrain
retrain: ## 复用现有数据集只重训（约 90 秒）
	cd $(ENGINE_DIR) && python -m waterlog.cli.bootstrap --keep

.PHONY: reset-data
reset-data: ## 删掉数据集、模型、评估库、仿真时钟，回到出厂状态
	rm -f $(ENGINE_DIR)/data/*.npz $(ENGINE_DIR)/data/*.sqlite* \
	      $(ENGINE_DIR)/data/models/*.joblib $(ENGINE_DIR)/data/models/latest.txt \
	      $(ENGINE_DIR)/data/corrector.json $(ENGINE_DIR)/data/sim_clock.json
	rm -rf $(API_DIR)/data
	@echo "已清空。下次启动会重新 bootstrap。"

# ---------------------------------------------------------------- 容器

.PHONY: up
up: ## 容器起全套（后台）
	$(COMPOSE) up -d --build

.PHONY: down
down: ## 停容器（保留数据卷）
	$(COMPOSE) down

.PHONY: nuke
nuke: ## 停容器并删数据卷（等于 reset-data）
	$(COMPOSE) down -v

.PHONY: logs
logs: ## 跟随两个服务的日志
	$(COMPOSE) logs -f api engine

# ---------------------------------------------------------------- 验收

.PHONY: acceptance
acceptance: ## 跑端到端验收（含暴雨演练与四态闭环）
	pwsh -NoProfile -File scripts/acceptance.ps1

.PHONY: acceptance-fast
acceptance-fast: ## 跑验收但跳过暴雨演练（快，约 20 秒）
	pwsh -NoProfile -File scripts/acceptance.ps1 -SkipStorm

.PHONY: shots
shots: ## 重新截 7 张页面截图到 shots/
	node scripts/shoot.mjs --base http://127.0.0.1:8200 --wait 3500
