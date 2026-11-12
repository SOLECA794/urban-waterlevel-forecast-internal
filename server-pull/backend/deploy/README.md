# 城市内涝水位预测系统 · 后端部署指南

## 快速开始

本后端为单个静态二进制，零依赖、零容器亦可运行。

### 方案 B：systemd 裸机部署（推荐）

```bash
# 1. 交叉编译（本地或 CI）
cd backend
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags='-s -w' -o waterlog-server ./cmd/server

# 2. 上传到服务器
scp waterlog-server deploy/waterlog.service user@server:/tmp/
ssh user@server <<'REMOTE'
  sudo mkdir -p /opt/waterlog/data
  sudo mv /tmp/waterlog-server /opt/waterlog/
  sudo chmod +x /opt/waterlog/waterlog-server
  sudo useradd -r -s /bin/false waterlog || true
  sudo chown -R waterlog:waterlog /opt/waterlog
  sudo mv /tmp/waterlog.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now waterlog
REMOTE
```

### 方案 A：Docker Compose

```bash
cd backend/deploy
# 前置：构建前端 dist 并放到 ./frontend-dist
docker compose up -d
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADDR` | `:8080` | 监听地址（容器内建议 `:8080`） |
| `DB_PATH` | `./app.db` | SQLite 路径（需持久化卷） |
| `DEMO_MODE` | `true` | 是否启用模拟数据源（生产必设 `false`） |
| `OPENMETEO_ENABLED` | `true` | 真实降雨预报接入 |
| `FORECAST_SCHEDULE_MIN` | `15` | 滚动预测间隔（分钟） |
| `CORS_ORIGINS` | `http://localhost,http://localhost:5173,http://127.0.0.1` | 跨域白名单，逗号分隔；nginx 反代场景可留空 |

## 初始化与升级

- **首次启动**：自动执行 migration + 种子数据，零手工初始化。
- **升级**：备份 DB → 替换二进制 → `systemctl restart waterlog`。
- **回滚**：换回旧二进制 + 恢复 DB 备份。
- **数据备份**：`sqlite3 /opt/waterlog/data/app.db ".backup /opt/waterlog/data/app.db.bak"`

## 历史乱码记录清洗

若从旧版本升级且 publish_record 表存在中文乱码记录，启动时服务端会自动检测并修复（日志输出 "已清洗 N 条乱码发布记录"）。也可手动清空：`sqlite3 app.db "DELETE FROM publish_record;"`。

## 健康检查

- 存活：`curl http://localhost:8080/health`
- 详情：`curl http://localhost:8080/health/detail`
