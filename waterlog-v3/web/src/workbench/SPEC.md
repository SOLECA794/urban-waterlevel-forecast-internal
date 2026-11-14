# 工作台（`/w`）实现契约

**给协作者的唯一必读文件。** 读完直接动手，不要重新设计骨架。

## 这件事在做什么

用户的原话（本次任务的定义）：

> 你要把这些业务能力融合到一整张屏幕里面的，不通过标签来区分页面内容，而是直接通过
> 页面交互逻辑的点击和层次关系，从一个固定的页面中把所有的业务能力融合展示出来

> 我们不是要做新的标签按钮，而是通过创新交互形式，同时设计页面交互内容，总体来说
> 就是尽量把所有功能固定到同一页里面就都可以操作，不换页

所以：**没有导航、没有标签栏、没有换页**。整屏固定成四个区，所有业务能力体现为
「在这几个区里随点选逐层展开」。

## 四个区（整屏固定，永不改变位置）

```
┌────────────────────────────────────────────────────────────────────┐
│ FactBar 顶栏 54px：全域结论 · 待办数 · 激活数 · 模型 · 链路灯 · 时钟   │  ← 这些数字本身就是入口
├──────────┬───────────────────────────────────┬─────────────────────┤
│ Rail 236 │ Stage 中舞台（占满剩余）            │ Drill 452 钻取栈     │
│ 站点/预警 │ 九个舞台之一                       │ 一层压一层，可收起    │
│ 列表     │                                    │                     │
│ 不随舞台  │                                    │ 中舞台与右栏**同时**  │
│ 重挂     │                                    │ 显示不同内容         │
└──────────┴───────────────────────────────────┴─────────────────────┘
```

**中舞台与右栏能同时装两件不同的事** —— 这是「一屏放下全部业务能力」的关键。
中舞台是「我正在处理的对象」，右栏是「我是怎么走到这里的、路上看过什么」。

## 状态契约

`web/src/workbench/model.ts`（**已写好，不要改语义**）：

- `Stage`：九种，`situation | site | event | handoff | trust | rules | plumbing | governance | wall`
- `Crumb`：五种，`site | event | metric | layer | api`，右栏栈的一层
- `reduce()`：换舞台**清空栈**（栈记录的是「在某个舞台上怎么钻下去的」）；
  压栈时同一对象不重复入栈、已在栈里则截断到它
- `encodeUrl` / `decodeUrl`：`?on=site&site=S08&trail=s:S08,e:12`，用 `replaceState`

`web/src/workbench/ctx.ts`（**已写好**）：舞台拿到的唯一上下文

```ts
interface StageCtx {
  state: { stage: Stage; trail: readonly Crumb[] }
  goStage(s: Stage): void          // 换舞台
  push(c: Crumb): void             // 往下钻一层
  popTo(index: number): void
  pop(): void
  home(): void
  openSite(siteId: string, name?: string): void
  openEvent(eventId: number, name?: string, level?: Level): void
  openMetric(key: string, name: string): void
  openLayer(key: string, name: string): void
  openApi(key: string, name: string): void
  setSort(s: RailSort): void
  toast(k: 'ok' | 'err' | 'info', msg: string): void
}
```

## 视觉契约

- `web/src/workbench/visual.ts` → `W`（颜色）、`RAIL_W=236`、`DRILL_W=452`、`BAR_H=54`、`ease`
- `web/src/workbench/kit.tsx` → `Block` `Row` `Figure` `Pill` `Ruler` `Nothing` `Shimmer`

**必须用 `W`，不要用 `utils/tokens.ts` 的 `T`。** 两套色混用会得到「一半玻璃一半硬边」。
`T` 是「十张卡片平铺」那套排版的假设，`W` 是这一屏三层纵向分区那套。

## 硬约束（评审会逐条查）

1. **不得新增路由、不得新增标签栏、不得新增整页导航。**
2. **不得用 `<Link>` / `nav()` 跳页。** 要看别的东西一律 `ctx.goStage()` / `ctx.push()`。
3. **不得 import `components/interactive/Drawer` 或 `SiteDrawer`。** 右栏（Drill）就是抽屉
   的替代品；再用抽屉会出现两层浮层。
4. **不得设置 `background` / `color` 以外的装饰性 CSS**（渐变、阴影、玻璃）。
   唯一允许的阴影是「浮在地图上的结论卡」那一处（已写）。
5. **`children` 不能用 `JSExpression`**（这条是生成器约束，写 TSX 时无关，但别把
   旧 schema 的写法抄进来）。
6. **一屏里要同时看得见四件事**：对象的事实 / 它的走向 / 它凭什么这样判 / 谁在管。
   只显示一件的舞台是不合格的。
7. 每个舞台根节点必须是 `<div style={{ flex:'1 1 0', minHeight:0, ... }}>`，
   因为父容器是 flex 列，`minHeight:0` 少了列表就撑破视口。

## 数据

`web/src/data/queries.ts`（React Query hooks，直接用，别包一层）：

| hook | 返回 |
|---|---|
| `useOverview()` | `{issuedAt, rows: {site, reading, assessment}[]}` |
| `useSiteDetail(id)` | `{site, series, forecast, issuedAt, modelVersion}` |
| `useHistory(id, hours)` | `SiteSeries {siteId, hours, points:{at,level,rain}[]}` |
| `useAllHistory(hours)` | `Record<siteId, SiteSeries>` |
| `useForecast()` | `{issuedAt, modelVersion, stepMin, sites:{[id]:SiteForecast}}` |
| `useAlerts(activeOnly)` | `AlertEvent[]` |
| `useAlertDetail(id)` | `AlertDetail`（含 `notes` 备注） |
| `useMetrics(windowH)` | `{latest: MetricsBundle, history, rolling}` |
| `useDecisions(limit)` | `DecisionRow[]` |
| `useEvalPairs(hours)` | `EvalPair[]` |
| `useModelVersions()` | 版本列表 |
| `useRules()` / `useSaveRules()` / `usePreviewRules()` | 规则读写 + **预演** |
| `useHealth()` | `{apiOk, engineOk, engine:{modelVersion,cycles,pending,...}, clients, now}` |
| `useRetrainStatus()` / `useRetrain()` | 重训 |
| `useUsers()` `useAudit(hours,user)` `useChannels()` `useDeliveries()` | 治理面 |
| `useAckAlert()` `useAssignAlert()` `useSetDisposition()` `useAddNote()` | 预警写操作 |
| `useSimStorm()` `useResetWater()` | 注入降雨 / 排空 |

视图层 `web/src/view/`（**优先用这些，它们已经把口径统一了**）：

- `useSituation()` → `{hasData, topLevel, counts[{level,count}], alarmCount, deepest{value,siteName}, rainingSites, topSites, issuedAt, total}`
- `useWatchlist(sort)` → `SiteGlance[]`：`{site, reading, assessment, redThreshold, depthRatio, isAlarm, raining}`
- `useTopWatch(n)`
- `useSiteEvidence(id)` → `{site, series, forecast, assessment, nowLevel, nowDepth, observedPeak, forecastPeak, red, issuedAt, modelVersion, quality}`
- `useShiftReport(hours=12)` → `{from,to,hours,raised,cleared,active,worst,avgAckMin,todos[],backlog,timeline[]}`；
  `todos[]` 里每项 `{event, ageMin, ackMin, action, tone}` —— **`action` 是「该谁做、做什么」，这是值班台上唯一真正有用的那一行**
- `useTrust()` → `{reading, forecast, streamOk, worst, readingAge, forecastAge, label, hint}`
- `useSession()` → 当前用户与角色（决定按钮亮不亮）

领域层 `web/src/domain/`：纯类型与纯函数，**必须用**（不要在组件里重算量纲）：

- 单位是品牌类型：`Meters` `Depth` `Delta` `Rate` `RainRate` `RainSum`；`depthOf(level, base)` / `levelOf(base, depth)`
- `fmtMeters` `fmtDepth` `fmtDelta` `fmtRate` `fmtRain` `fmtPct` `fmtMinutes` `fmtTime` `fmtClock`
- `LEVEL_LABEL`（无预警/蓝色/黄色/橙色/红色）、`LEVEL_FULL`、`LEVEL_MEANING`（各档是什么意思）
- `thresholdOf(t, level)`、`redThreshold(t)`、`thresholdRows(t)`、`levelForDepth(d, t)`
- `isActive(state)` / `isUnack(state)` / `canAck(state)`（四态轴）
- `DISPOSITION_LABEL` / `DISPOSITION_HINT` / `DISPOSITION_ORDER`（五态轴）
- `validateRules(doc)` → `RuleIssue[]`、`hasError()`、`weightShares(w)`、`FACTOR_LABEL`
- `MODEL_FAMILIES` / `MODEL_LABEL` / `MODEL_HINT`

**两个轴不要混**：预警的四态（ACTIVE/CLEARED × ACK/UNACK）由**模型**决定；
处置五态（open/dispatched/onsite/resolved/false_alarm）由**人**决定。
`dispatched → open` 后端故意不允许（409）。界面不该给出会被拒绝的按钮。

## 已有可复用件

- `components/domain/Value.tsx`：`DepthValue` `LevelValue` `RateValue` `RainValue` `ThresholdRuler` `DeltaValue` `topLevelOf`
- `components/domain/Assessment.tsx`：`FactorBars` `AssessmentReason` `FactorSummary` `AssessmentHeadline` `BlockedNote`
- `components/domain/LevelChip.tsx`：`LevelChip` `LevelBadge` `StatusDot` `Tag`
- `components/charts/TrendChart.tsx`：`TrendChart({series, forecast, baseLevel, thresholds, issuedAt, height})`
  —— **三条约束不能破**：x 轴锚 `issuedAt`（不是 `Date.now()`，仿真时钟 60x 会把预测移出画布）、
  阈值线画**绝对水位**、置信带上界传 `upper-lower`
- `components/interactive/StationTrend.tsx`：紧凑版（214px），同一个契约
- `components/interactive/Tooltip.tsx`：`Glossary term="skill"`、`Tooltip`
- `map/RealMap.tsx`：`RealMap({stations, focusId, onPick, height, interactive, fitKey})`
- `components/primitives/Shapes.tsx` 等：`Meter` `Sparkline` `Gauge` `StatCard`

## 验证

```bash
cd waterlog-v3/web && npx tsc --noEmit          # 必须干净
cd waterlog-v3/web && npm run build             # 必须通过
```

服务：`127.0.0.1:8200`（`admin/admin123`）。构建产物由 Go 直接托管，
`npm run build` 后刷新即生效，**不用重启服务**。

注雨（截图前必做，否则十站退水、画面全空）：

```bash
cd waterlog-v3
printf '{"username":"admin","password":"admin123"}' > /tmp/b.json
curl.exe --noproxy '*' -s -c /tmp/j.txt -H "Content-Type: application/json" \
  --data-binary @/tmp/b.json http://127.0.0.1:8200/api/auth/login
curl.exe --noproxy '*' -s -b /tmp/j.txt -X POST "http://127.0.0.1:8200/api/sim/storm?peak=228&dur=48"
# 然后轮询 /api/overview 直到十站最大 depth >= 0.5m（实测约 70s）
```

## 写文件的坑（这个仓库特有的）

`write` / `edit` 覆盖**已存在**的文件会报 `SetFileSecurityW EACCES (Win32 5)`。
可靠办法：先 `OpsWrite` 到新文件名再 `bash cp` 覆盖，或用 python 读写。
`rm -rf <dir>/.<name>.*` 有时能清掉残留再写成功。
