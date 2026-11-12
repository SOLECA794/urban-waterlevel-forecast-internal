# 城市内涝水位预测系统 · 前端（真实化版本）

基于第二版原型改造的完整前端：6 页结构、深色大屏、MapLibre 地图（三级降级）、Agent 结构化卡片、
预警等级 3-5 级联动、预测版本对比等已认可能力全部保留；**全部 mock 数据已替换为真实后端接口**
（React Query 封装，按接口契约 v1）。

## 技术栈

React 18 + TypeScript + Vite 6 + Ant Design 5 + @tanstack/react-query 5 + zustand（仅 UI 态）
+ ECharts + MapLibre GL 4（天地图 → OSM → SVG 三级降级） + Tailwind CSS 3 + react-router-dom 6

## 目录结构

```
frontend/
├── nginx.conf              # 生产部署示例（dist 托管 + /api 反代 + SSE 透传）
├── .env.example            # 环境变量模板
└── src/
    ├── api/
    │   ├── client.ts       # 统一请求层：{code,message,data} 解包 / ApiError / API_BASE
    │   ├── types.ts        # 后端 DTO 的 TS 镜像（契约 v1 逐字段对齐）
    │   ├── endpoints.ts    # 31 个接口函数
    │   └── queries.ts      # React Query hooks（查询/变更/SSE 实时流/派生数据）
    ├── components/
    │   ├── common/         # Layout / Sidebar / GlobalStatusBar / ErrorBoundary
    │   ├── gis/GisMap.tsx  # MapLibre 三级降级地图（动态视口、瓦片错误计数）
    │   ├── charts/         # ECharts 趋势图 / 预测对比图
    │   └── agent/          # Agent 结构化卡片组件
    ├── pages/              # 6 页：Overview / Trend / AlertCenter / DataSource / Calibration / Settings
    ├── hooks/              # useAlertLevels（等级派生）
    ├── stores/             # zustand（仅 UI 状态：选中站点/时间片）
    ├── utils/agentCards.ts # Agent 卡片生成器（真实数据派生）
    └── types/
```

## 环境变量

复制 `.env.example` 为 `.env`：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | 后端 API 基础地址 | `/api/v1`（dev 走 vite 代理，prod 走 nginx 反代） |
| `VITE_PROXY_TARGET` | 仅开发模式生效：vite 代理目标 | `http://localhost:8080` |
| `VITE_TIANDITU_TOKEN` | 天地图 token；**留空时地图自动降级 OSM，不报错** | 空 |

## 启动方式（命令级）

前置：Node.js ≥ 20，后端服务监听 `:8080`（见后端任务交付说明：
`cd backend && go run ./cmd/server`，默认 `ADDR=:8080`、`OPENMETEO_ENABLED=false`）。

```bash
# 1. 安装依赖
npm install

# 2. 开发模式（vite dev server，/api 自动代理到 8080）
npm run dev            # http://localhost:5173

# 3. 生产构建（产物在 dist/，可被 nginx 托管）
npm run build

# 4. 本地预览构建产物（需后端在 8080 运行）
npm run preview
```

## 生产部署（nginx）

```bash
npm run build
sudo cp -r dist /opt/waterlog/frontend/dist
# 使用仓库内 nginx.conf（已含 /api 反代与 SSE 透传），root 指向 dist
sudo nginx -t && sudo systemctl reload nginx
```

## 6 页与核心接口

| 页面 | 路由 | 核心接口 |
| --- | --- | --- |
| 综合态势总览 | `/` | GET /stations、/alerts/stats、/alerts、POST /stations/{id}/predict |
| 趋势分析 | `/trend` | GET /stations/{id}/series、/stations/{id}/forecasts、/forecasts/{id}/comparison |
| 预警处置中心 | `/alerts` | GET /alerts、/alerts/stats、POST /alerts/{id}/confirm\|resolve\|false-report\|publish |
| 数据源接入 | `/datasources` | GET /datasources、PUT /datasources/{id} |
| 模型校准中心 | `/calibration` | GET /models、/calibrations、POST /calibrate-params、POST /models/{id}/activate |
| 系统配置中心 | `/settings` | GET/PUT /alert-levels、/forecast/leads、/publish-channels |

实时链路：SSE `GET /api/v1/stream/alerts`（EventSource，事件名 `alert`）→ 自动刷新预警/站点/统计。

## 容错设计

- 每页均含加载态（Spin）与错误态（Alert + 重试按钮），接口异常不白屏
- App 级 + 页面级 ErrorBoundary，路由懒加载带独立 Suspense 占位
- 地图三级降级：天地图 → OSM → SVG 静态示意（瓦片连续错误自动切换、计数跨降级重置）
- React Query 全局 retry 1 次 + 60s 轮询关键数据，SSE 断线由 EventSource 自动重连
