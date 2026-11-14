# 07 · ICM 复用单元落地说明（第一批代码 + 第二批：网关接入）

> **版本** v2.0 · 2026-11-10（§1–§6 为第一批 v1.0；§7 为第二批新增）
> **关联** `docs/06-接口设计说明-对接黄岩区城市内涝基础平台.md`（接口契约与字段核对的唯一权威）
> **对应需求** 「重合的部分按对方接口复用」「先按对方给出来的接口把已有的代码调一下，剩下的等后面再改」
> **本文性质**：代码落地说明，不是联调报告、不是验收报告。未与对方平台做任何真实联调。

---

## 1. 先说清一件事：为什么是「新增一层」而不是「改几行」

【事实】动工前逐字检索过 `waterlog-v3` 全库：`indexCode` / `deviceType` / `eventDest` / `artemis` / `monitorItemCodes` 等对方字段**只出现在这份设计文档里**，代码里零命中；`EXT-POINT` 也只写在文档里，没有任何 `.go` 落点。也就是说，**v3 里原本没有任何 ICM 对接层可以"调"**。

【推断】因此「按对方接口把已有的代码调一下」的实际形态是：按 ICM 原件的真实路径与字段，**新增一层出站复用客户端**，再把取到的数据**接进 v3 已有的 ingest 入口**。这与设计文档 §2.2 已定的路线一致——**v3 主干零改动**（改 `respond.go` / `router.go` 会破坏已上线验收的 9 个页面、SSE 与审计中间件）。

**本批未修改任何现有文件**，全部是新增：

| 文件 | 职责 |
|---|---|
| `api/internal/icm/config.go` | 独立配置（全部环境变量，缺省=不启用）、Token 插件位 |
| `api/internal/icm/client.go` | 出站客户端：code 归一化、分页壳、时间格式、重试、链路头 |
| `api/internal/icm/endpoints.go` | 表一 12 条接口的真实路径 + 真实字段 + 强类型方法 |
| `api/internal/icm/endpoints_extra.go` | §3.4 补充复用接口 R13–R26 的路径登记表 + 通用调用入口 |
| `api/internal/icm/map.go` | 编码映射 + 时间基准（双时钟）+ 转成 `domain.TelemetryBatch` |
| `api/internal/icm/source.go` | `DataSource` / `Sink` 抽象、ICM 数据源、接入已有 ingest 端点 |
| `api/internal/icm/icm_test.go` | 14 个本地单测（httptest 模拟对方响应） |
| `api/cmd/icm-pull/main.go` | 独立手动/调度入口，**不属于 v3 主进程** |

---

## 2. 本批做了什么（范围）

### 2.1 表一 12 条：路径与字段全部按对方原件

【事实】12 条路径逐条在 ICM 文档中核对存在（设计文档 §3.1）。字段名**不用**基础文档表一的简化命名，一律用 §3.2 核对后的真实字段，例如：

| 接口 | 代码里的真实字段 | 基础文档简写（未采用） |
|---|---|---|
| R1/R2 | `deviceType`(必填) / `indexCodes[]` / `beginTime` / `endTime` / `isDesc` | `deviceIds` / `monitorItemCodes` |
| R1/R2 出参 | `id` / `indexCode` / `monitorTime` / `createTime` + **监测项编码作为动态字段名**（`ValueOf("wl")`） | `deviceId` / `monitorValue` / `collectTime` |
| R3 | `menuCode` / `deviceTypes[]` / `deviceIds[]` / `regionCode` / `onlineStatus` | `deviceName` 单独入参 |
| R4 | `runningStatus[]{code,name}`（**无独立电量/电压字段**） | `battery` / `voltage` / `signalStrength` |
| R5/R7 | `pageNo` / `pageSize` / `treeCode`（默认 `"0"` 国标树） | `parentIndexCode` / `regionType` |
| R6 | `parentIndexCode` / `treeCode`，**无分页参数** | `indexCode` + 分页 |
| R7 出参 | `cameraIndexCode` / `name` / WGS84 经纬度 | `cameraName` |
| R8 | `geometryType` / `longitude` / `latitude` / `distance` / `wkt` | `spatialIndex` |
| R9 | `cameraIndexCode` / `streamType` / `protocol` / `transmode`，出 `url`，**无 expireTime** | 出参含 `expireTime` |
| R10 | `beginTime` / `endTime` / `recordLocation` / `uuid`，出 `url`+`uuid`+`list[]` | 含 `streamType` / `expireTime` |
| R11 | `pageNo` / `pageSize` / `indexCodes[]`，**无时间范围入参**，出 `inspectDate` / `inspectResult` | `diagnoseTime` / `diagnoseResult` |
| R12 | `eventTypes[]` / `subWay` / `eventDest` / `subType`，**无 subscribeId** | `callbackUrl` / `subscribeId` |

### 2.2 五处协议差异在客户端层一次性消化（§3.3）

| # | 差异 | 代码落点 |
|---|---|---|
| 1 | `code` 是字符串 `"0"`，个别接口是数字 `0` | `normalizeCode()` 统一按 `"0"` 比较，兼容 `0` / `0.0`；**不凭 HTTP 200 判成功** |
| 2 | `total` / `pageNo` / `pageSize` 出参可能是 String | `flexInt` / `flexFloat` 兼容 number 与 string number |
| 3 | 时间 `yyyy-MM-dd'T'HH:mm:ss.SSSXXX`（含毫秒含时区） | `ParseICMTime` 兼容带/不带毫秒/无时区三种；`FormatICMTime` 出站按原件格式 |
| 4 | `pageSize ≤ 1000`，禁止无条件全量拉取 | `fetchAll` 分页循环，终止条件「已取 ≥ total / list 空 / `MaxPages` 上限」 |
| 5 | 文档未提供应用认证接口 | `TokenProvider` 插件位，**不写死任何凭据** |

补充落实：链路头 `X-Request-Id` / `X-Trace-Id` 透传；幂等读 2 次退避重试、`code != "0"` 业务错误不重试（§3.5）；R19/R20 按原件走 `GET + Query`（§3.4 注）；忽略未知字段（`json.Unmarshal` 默认行为）。

### 2.3 数据接进 v3 已有的 ingest 入口（零路由改动）

```
ICM R1/R2 → DataSource.Fetch → MapRealtime（编码/时间/字段映射）
          → Sink.Push → POST /api/ingest/telemetry（已有端点，带 X-Ingest-Token）
          → v3 落库 + 预警四态 + SSE 广播（全部复用既有链路）
```

- **默认 dry-run**：`DryRunSink` 只报告行数，绝不写库。要写入必须显式 `--push`。
- **不注册路由、不启 goroutine、不改任何 handler**；入口是独立命令 `cmd/icm-pull`。
  （第一批口径。第二批起，网关**额外**挂在 v3 主进程里，见 §7；第一批的独立命令仍是
  手动/外部调度入口，两条路径共用同一份 `SyncOnce` 代码。）
- **缺省不启用**：未配置 `WL_ICM_BASE_URL` 时任何出站调用都直接返回错误（有单测覆盖）。

### 2.4 双时钟按 §6.3 落实到代码，没有装作没问题

【事实】v3 是 60 倍速仿真时钟（`NowTS() = MAX(telemetry.ts)`），对方 `monitorTime` 是真实 ISO 时间，两者不在同一时间轴上。

代码里的处理：
- `MapConfig.Basis` 显式二选一：`real`（真实 Unix 秒，仅适用于 v3 已切 1 倍速真实时钟）/ `simulated`（整批对齐 `SimNow`，联调与验收用）。
- `MapReport` 始终带 `timeBasis` 与告警文案，**禁止静默混用**。
- `SyncReport` 在写入后追加告警，提示核对时间基准。
- 【未做】真实时钟 ↔ 仿真时钟的长期对齐策略、生产 1 倍速切换 —— 属后面批次。

### 2.5 补充复用接口 R13–R26

【纪律】对方文档只给了这些接口的**关键字段**，没给完整请求/响应结构。因此**不编造 struct**：只登记真实路径（`SupplementalPaths`，逐条与 ICM 文档核对通过）+ 提供 `CallJSON` / `CallQuery` 通用入口，请求体由调用方按对方原件填。R13 字典、R19 阈值给了带字段的便捷方法。

`EXT-POINT(INTEGRATION)`: R24 告警上报 / R26 工单联动是**写接口**，需先申请事件类型号段与写权限（§8 Q3/Q5），本包不主动发起任何写操作，由上层 feature flag 决定。

---

## 3. 配置（全部环境变量，缺省值不影响 v3）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WL_ICM_BASE_URL` | 空 | **空 = 整个单元不启用**；填对方平台地址才开始生效 |
| `WL_ICM_TIMEOUT_MS` | 5000 | 单次请求超时 |
| `WL_ICM_PAGE_SIZE` | 500 | 分页大小，钳制 1–1000 |
| `WL_ICM_MAX_PAGES` | 200 | 分页循环硬上限 |
| `WL_ICM_RETRY` / `WL_ICM_RETRY_BASE_MS` | 2 / 1000 | 可重试错误的次数与退避基数 |
| `WL_ICM_TREE_CODE` | `0` | 国标树（§8 Q2 待对方确认） |
| `WL_ICM_DEVICE_TYPE` | `waterLevelGauge` | 示例值，真实枚举待 R17 / §8 Q4 |
| `WL_ICM_MONITOR_ITEM` | `wl` | 水位监测项编码（动态字段名） |
| `WL_ICM_MONITOR_ITEM_RAIN` | 空 | 雨量监测项编码 |
| `WL_ICM_POINT_MAP` | 空（恒等映射） | `indexCode=siteId,...` |
| `WL_ICM_TOKEN` | 空 | 现成 token；**不冒充认证接口** |
| `WL_ICM_INGEST_URL` | `http://127.0.0.1:8200/api/ingest/telemetry` | v3 已有写入端 |
| `WL_INGEST_TOKEN` | 复用 v3 已有 | 不另造一套密钥 |

运行（默认 dry-run，不写库）：

```bash
WL_ICM_BASE_URL=https://<icm-host> \
WL_ICM_POINT_MAP='<indexCode>=S01,<indexCode2>=S02' \
go run ./cmd/icm-pull

# 显式写入（需先确认时间基准与编码映射）
go run ./cmd/icm-pull --push --basis=simulated --sim-now=<v3当前仿真时刻>
```

---

## 4. 验证结果（如实记录）

**已执行**（本机，Go 1.25.5）：

- `gofmt -l` 无残留
- `go vet ./...` 通过
- `go build ./...` 全模块编译通过（含原有 `cmd/waterlog-api`，未受影响）
- `go test ./...`：新建 `internal/icm` 包 **14 个测试全通过**；其余包无测试文件
- 测试覆盖：code 字符串/数字归一化、业务错误不重试、5xx 重试、链路头与 Token 插件位、分页循环终止、String 型分页出参、R1 String / R2 Number 动态监测项、R6 无分页参数、R12 回调无返回值、R19 GET+Query、时间格式三种兼容、真实/仿真双时钟映射、编码映射与跳过统计、ingest 不凭 HTTP 200 判成功、dry-run 不写库、未启用拒绝调用

**未执行 / 未声称**：

- 未与黄岩区基础平台做任何真实联调（无测试地址与凭据，§8 Q1）
- 未验证跨网域（政务外网/视频专网）、单向光闸、视频专网可达性
- 未做压测（约定要求峰值 1.5 倍、成功率 ≥99.9%、P95 达标）
- 未部署到线上 8200，未重启任何在跑的服务
- 未验证 `deviceType` / `treeCode` / 监测项编码 / 事件类型号段的真实取值
- 未验证 R24/R26 写接口的报文与权限（默认关闭）
- 大屏（`/board`、`/screen`）本批**完全未改动**

---

## 5. `EXT-POINT` 留白清单（`grep EXT-POINT` 可列全）

| 类型 | 位置 | 说明 | 契约状态 |
|---|---|---|---|
| `INTEGRATION` | `config.go` / `client.go` | 应用认证 / Token 获取方式（§8 Q1） | 接口 `TokenProvider.AccessToken(ctx) (string,error)` 已定义 + `StaticToken` 可运行实现 |
| `INTEGRATION` | `endpoints_extra.go` | R24 告警上报 / R26 工单联动（写接口） | `CallJSON(ctx, path, body) (json.RawMessage, error)` 已定义，默认不调用 |
| `DATASOURCE` | `map.go` | `pointCode ↔ indexCode` 正式对照表 | `PointMap` 接口 + `IdentityPointMap` / `StaticPointMap` 真实现 |
| `DATASOURCE` | `map.go` | 真实气象/降水预报源、数据质量标记 | 字段留 0/1，`MapReport.Warnings` 显式标注 |
| `DATASOURCE` | `source.go` | 真实气象/视频图像样本源 | `DataSource` 接口已定义，可插拔 |
| `INTEGRATION` | 设计文档 §2.2 | 协议适配网关（`{code,msg,data}` 包装、Token→Cookie 桥接） | 契约固定，实现留后续批次 |

---

## 6. 「剩下的等后面再改」清单（本批明确未做）

| # | 事项 | 依据 |
|---|---|---|
| 1 | 自研接口 A-1–A-21 落地为代码 | 设计文档 §4 |
| 2 | 协议适配网关（`/api/aiwater/v1/*`、响应包包装、鉴权桥接、分页壳） | §2.2 / §8 Q7 |
| 3 | A-9 事件接收端（验签 + 幂等 + 返回 HTTP 200）、A-20 告警回传启用 | §4.2 / §8 Q5 |
| 4 | `docs/api/openapi.yaml` 补网关契约 | §8 Q8 |

> 第二批已补：`/api/icm/health` 已进 `docs/api/openapi.yaml`（含 `ICMHealth` schema），
> 见 §7.3。本行剩余的是 A-1–A-21 自研接口网关的契约，仍待 Q7 决定后统一出。
| 5 | 23 条功能条款中「◐ 部分 / ⬚ 留白」的补全（雨情场景、动态阈值、多模态、训练样本等） | §5 |
| 6 | 双时钟长期对齐策略、生产 1 倍速切换 | §6.3 |
| 7 | 真实联调、压测、跨网域验证 | §7.3 / §8 |
| 8 | **大屏展示效果改版** | 用户明确「一会还要改」，本批不动 |

> 与本批同仓并存、互不干扰：另一会话正在改 `web/src/board/*`（大屏页面），本批未触碰 `web/` 下任何文件；主工作区已有的 `??` / `M` 产物（`merged-*`、`server-pull/`、`waterlog-v2/`、`docs/README.md`、`_tools/DELIVERY.md`、`engine/data/`）也一律未动。

---

## 7. 第二批：网关接入 v3 主进程 + 健康端点

> **版本** v2.0 · 2026-11-10
> **性质** 同样是代码落地说明，不是联调报告。第一批的「独立单元」形态没有被推翻，
> 只是**多了一条**常驻路径：网关现在能在 v3 进程里自己跑起来。

### 7.1 为什么第一批没接、这一批才接

第一批刻意做成独立命令，是为了不惊动已上线的 v3 主干（改 `router.go` / `respond.go`
会破坏 9 个页面、SSE 与审计中间件）。但独立命令有个现实问题：**它只能靠外部调度器
拉起**，"能不能拿到数据"这件事在 v3 自己的视图里是看不见的 —— 出站链路挂了，
v3 照样一切正常，只是数据悄悄不更新了。

所以这一批做的是**旁路接入**，而不是改主干：网关挂在 v3 的后台 goroutine 上，
健康度从**已登录只读段**暴露出来。v3 主干仍然一行没改协议。

### 7.2 装配链路

```
cmd/waterlog-api/main.go
  └─ icm.GatewayConfigFromEnv(svc.NowTS)   ← 读环境变量，缺省即「不启用」
       ├─ Config      = icm.Load()
       ├─ Client      = icm.NewClient(cfg)
       ├─ Src         = icm.NewRealtimeSource(client, cfg.DeviceType, indexCodes)
       ├─ Sink        = icm.NewIngestSink(cfg)  当 WL_ICM_PUSH=1
       │                icm.DryRunSink{}       否则（默认，绝不写库）
       ├─ Points      = icm.ParsePointMap(WL_ICM_POINT_MAP)
       ├─ Map         = icm.MapConfig{LevelItem, RainItem, Basis, SimNow}
       └─ Interval    = WL_ICM_INTERVAL_SEC（默认 5 分钟）
  └─ icm.NewGateway(...)  →  go gateway.Run(bgCtx)
```

三条边界，都是有意为之：

| 边界 | 做法 | 原因 |
|---|---|---|
| 仿真时钟 | `internal/icm` **不 import** `internal/store` / `internal/service`；由 cmd 层注入 `simNow func() int64`（取 `svc.NowTS()`） | 反向依赖会把包依赖搞成环，也违背「不改 v3 主干」的边界 |
| 装配失败 | 未配置 → 不启用；配错（如 `timeBasis` 非法、simulated 却拿不到仿真时钟）→ 记错误日志并跳过 | 网关是**可选能力**，不该让一个可选能力把整个服务拖垮 |
| 写入 | 默认 dry-run，要写必须显式 `WL_ICM_PUSH=1` | 沿用第一批的安全口径，不因为"接进主进程"就放松 |

网关挂在**已有的** `bgCtx/bgCancel` 上：进程优雅退出时它跟着停，不会留下还在拉数的 goroutine。

### 7.3 健康端点

`GET /api/icm/health` —— 挂在 `router.go` 的「已登录即可：读端」段。

| 项 | 值 |
|---|---|
| 路径 | `/api/icm/health` |
| 权限 | **需登录**（任何已登录角色）。不放公开段：快照里带对方地址、接入点、映射告警等内部集成状态 |
| 未启用时 | 仍返回 **200**，`status=not_enabled`。不是 404 —— 端点一直在，只是能力没开；404 会让前端误判成「接口不存在」 |
| 契约 | `docs/api/openapi.yaml`（`tags: [icm]`，新增 `ICMHealth` schema） |

响应示例（网关启用且正常）：

```json
{
  "enabled": true,
  "intervalSec": 300,
  "totalRuns": 12,
  "totalFailures": 0,
  "consecutiveFails": 0,
  "degraded": false,
  "lastRunAt": 1792537745,
  "lastSuccessAt": 1792537745,
  "lastError": "",
  "lastRows": 10,
  "lastReport": { "...": "见 openapi ICMHealth" },
  "status": "ok",
  "message": "ICM 集成网关正常"
}
```

未启用时：

```json
{
  "enabled": false,
  "intervalSec": 0,
  "totalRuns": 0,
  "totalFailures": 0,
  "consecutiveFails": 0,
  "degraded": false,
  "lastRunAt": 0,
  "lastSuccessAt": 0,
  "lastError": "",
  "lastRows": 0,
  "status": "not_enabled",
  "message": "ICM 集成网关未启用（未配置 WL_ICM_BASE_URL）"
}
```

### 7.4 退避与健康语义

- 退避：失败越多等得越久（30s → 60s → 120s…），**总间隔封顶 `backoffMax`（10 分钟）**。
  封顶作用在总间隔而不是退避增量上，否则基准 5 分钟 + 退避 10 分钟会让人等 15 分钟。
  成功一次立即归零回到基准间隔。
- `degraded` = 连续失败 ≥ 1；`consecutiveFails` 成功一次即归零；`totalFailures` 只增不减。
- `lastError` **成功之后也不清空**：它回答「上一次为什么失败」，而「现在有没有错」
  由 `degraded` / `consecutiveFails` 回答。运维排障时最需要的恰恰是「刚才失败过，原因是 X」。
- `Health()` 返回**深拷贝**（含 `lastReport` 的两个告警切片）：调用方拿到快照后
  随便改都不会污染网关内部留存的历史报告。

### 7.5 新增环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WL_ICM_INDEX_CODES` | 空（全部设备） | 逗号分隔的设备编码 |
| `WL_ICM_POINT_MAP` | 空（恒等映射） | `indexCode=siteId,...` |
| `WL_ICM_TIME_BASIS` | `real` | `real` / `simulated`；`simulated` 必须能拿到 v3 仿真时钟 |
| `WL_ICM_PUSH` | 空（dry-run） | `1` / `true` / `yes` 才写入 v3 |
| `WL_ICM_INTERVAL_SEC` | 300 | 同步周期（秒）；非正数回落默认 |

### 7.6 本批改动的文件

| 文件 | 改动 |
|---|---|
| `api/internal/icm/gateway.go` | `GatewayConfigFromEnv` 从「返回硬编码 nil」改成真正能装配部件；`Health()` 改深拷贝；`lastError` 语义与文档对齐；退避封顶改到总间隔 |
| `api/internal/icm/gateway_test.go` | 新增：退避、健康状态机、dry-run 全链路、快照隔离、并发读、装配函数各态、ctx 取消 |
| `api/internal/httpapi/icm.go` | 新增：`GatewayHealth` 接口 + `/api/icm/health` handler |
| `api/internal/httpapi/icm_test.go` | 新增：未启用 200 + `not_enabled`、启用后字段透出、降级态三例 |
| `api/cmd/waterlog-api/main.go` | 装配网关 → `go gateway.Run(bgCtx)`；启动日志增一行网关启用状态 |
| `api/internal/httpapi/server.go` | `Server` 增 `gw` 字段，`New(...)` 增一个参数 |
| `api/internal/httpapi/router.go` | 只读段挂 `/api/icm/health` |
| `docs/api/openapi.yaml` | 新增 `icm` tag、`/api/icm/health` 路径、`ICMHealth` schema；顺带修一处既有 YAML 语法错误（见下） |

### 7.7 本批验证结果（如实记录）

**已执行**（本机，Go 1.25）：

```
go build ./...                        （无输出 = 通过）
go vet ./...                          （无输出 = 通过）
go test ./internal/icm/...            ok  waterlog-v3/api/internal/icm
go test ./internal/httpapi/...        ok  waterlog-v3/api/internal/httpapi
go test ./...                         全部 ok / no test files
```

`internal/icm` 新增 15 个用例（退避 2 + 健康状态机 1 + dry-run 全链路 1 + 失败态 1 +
快照隔离 1 + 并发读 1 + 装配函数 5 + 索引码解析 1 + ctx 取消 1 + 既有 14 个），
`internal/httpapi` 新增 3 个用例。

**端到端实跑**（本机起进程 + 起一个假 ICM 平台，非真实联调）：

| 场景 | 结果 |
|---|---|
| 未配置 `WL_ICM_BASE_URL` 启动 | 日志 `ICM 网关 enabled=false`，进程正常启动，既有行为不变 |
| 未登录访问 `/api/icm/health` | `401 {"error":"未登录或会话已过期"}` |
| 登录后、网关未启用 | `200`，`status=not_enabled` |
| 配置 `WL_ICM_BASE_URL` 启动 | 日志 `ICM 网关 enabled=true` + `[icm] 网关启动：间隔 1m0s`；启动即跑一轮 |
| 登录后、网关已启用 | `200`，`status=ok`，`totalRuns=1`、`wouldPush=2`、`pushedRows=0`（dry-run 未写库） |

**顺手修掉的一个既有缺陷**：`docs/api/openapi.yaml` 第 1531 行
`description: 人读的一句话，如「确认预警 #202」` —— flow mapping 里未加引号的 `#`
被 YAML 当成注释起始符，**整个文件无法被任何 YAML 解析器读入**（`yaml.safe_load` 直接抛
ParserError）。已加引号修好。这不是本批引入的，是改这份文件时才发现的既有 bug。

**未执行 / 未声称**：

- 未与黄岩区基础平台做任何真实联调（无地址与凭据，§8 Q1）；上表的"端到端实跑"用的是本机假平台
- 未改动 `web/` 下任何文件 —— 前端 `data/client.ts` 尚未加 `/api/icm/health` 的调用封装
  （本批只交付后端契约；前端接入不在本批范围）
- 未做熔断器、限流、失败告警上报（`EXT-POINT(INTEGRATION)` 仍留白，原因见 `gateway.go` 顶部）
- 未做 A-1–A-21 自研接口网关（§6 表第 2 行）
- 未做双时钟长期对齐策略、生产 1 倍速切换
- 未部署到线上 8200，未重启任何在跑的服务
- `gofmt -l` 在本仓会标记 10 个**改动前就已存在**的 CRLF 文件（`internal/config/config.go` 等），
  本批新增/修改的文件全部 `gofmt` 干净；未顺手统一行尾，避免把无关文件卷进 diff

