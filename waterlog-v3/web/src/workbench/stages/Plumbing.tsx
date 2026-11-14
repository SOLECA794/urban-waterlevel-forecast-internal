import { useMemo, useState } from 'react'
import { useHealth, useRetrainStatus } from '../../data/queries'
import { useLive } from '../../data/live'
import {
  ROLE_LABEL,
  allLinksUp,
  fmtDuration,
  fmtMinutes,
  fmtTime,
  linkStatus,
  uptimeText,
} from '../../domain'
import { Block, Figure, Pill, Row, Shimmer } from '../kit'
import { W, ease } from '../visual'
import type { StageCtx } from '../ctx'

/**
 * 舞台：链路与接口。
 *
 * 这一块要回答的问题是**「页面现在是坏的，还是只是慢」**——
 * 其余八个舞台都假设数据是真的，只有这里负责「如果不真，坏在哪一层」。
 *
 * 为什么必须写「用户会看到什么现象」：值班员不会来看这个舞台。
 * 他是在发现「曲线不太对」之后才来这里找依据的。所以每一层都必须能从
 * 「屏幕上看到的那件事」倒推回来——只写「服务不可用」，等于让人自己
 * 把症状翻译成组件名，这一步没人做得到。
 *
 * 四层的排序不是随意的，是按**误判代价**排的：数据源断掉看起来最像「雨停了」，
 * 它排第一；Go API 的「半死状态」看起来最像「一切正常」，它排第三。
 */
export function PlumbingStage({ ctx }: { ctx: StageCtx }) {
  const health = useHealth()
  const live = useLive()
  const retrain = useRetrainStatus()

  const h = health.data
  const links = linkStatus(h, live.connected)
  const engine = h?.engine
  const healthy = allLinksUp(links)

  /** 「多久没更新了」用墙钟差。这里不能用仿真时钟：仿真时钟本身就可能停。 */
  const silentFor = useMemo(() => {
    if (!live.lastEventAt) return null
    return Math.max(0, Math.round(Date.now() / 1000 - live.lastEventAt))
  }, [live.lastEventAt, live.events])

  if (health.isLoading && !h) {
    return (
      <div style={{ flex: '1 1 0', minHeight: 0, padding: 12 }}>
        <Block title="链路与接口" grow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Shimmer h={54} />
            <Shimmer h={150} />
            <Shimmer h={150} />
          </div>
        </Block>
      </div>
    )
  }

  return (
    <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <ChainStrip
        links={links}
        healthy={healthy}
        clients={h?.clients ?? 0}
        silentFor={silentFor}
        enginePending={engine?.pending ?? null}
        service={h?.service ?? '—'}
        now={h?.now ?? 0}
        onOpenMetric={() => ctx.openMetric('仿真时钟', '仿真时钟')}
      />

      <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: 12 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(400px, 1.05fr) minmax(420px, 1.2fr)',
            gap: 12,
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            <Block
              title="四层链路，逐层倒推"
              sub="点任一层，右栏记下这一层，方便边看边退"
              aside={
                <Pill tone={healthy ? W.ok : W.warn}>
                  {healthy ? '四段都通' : `${[links.api, links.engine, links.stream].filter((s) => s === 'down').length} 段不通`}
                </Pill>
              }
              pad={10}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {LAYERS.map((l, i) => (
                  <LayerCard
                    key={l.key}
                    layer={l}
                    index={i}
                    status={layerStatus(l.key, links, h?.engineOk ?? false, live.connected, engine?.pending ?? null)}
                    onOpen={() => ctx.openLayer(l.key, l.name)}
                  />
                ))}
              </div>
            </Block>

            <EngineBlock
              health={h}
              live={live.connected}
              retrain={retrain.data ?? null}
              onOpenMetric={(k, n) => ctx.openMetric(k, n)}
            />
          </div>

          <Block
            title="接口清单"
            sub={`${APIS.length} 条 · 点任一行把它的身份记到右栏`}
            aside={<Pill tone={W.ink4}>端口 8200</Pill>}
            pad={0}
          >
            <div style={{ flex: '1 1 0', minHeight: 0, padding: '4px 10px 10px' }}>
              <div style={{ fontSize: 10.5, color: W.ink4, lineHeight: 1.7, padding: '6px 0 8px' }}>
                表格里的「权限」是后端路由上真实挂的中间件，不是前端按钮的显隐逻辑：
                operator 即「{ROLE_LABEL.operator}」，admin 即「{ROLE_LABEL.admin}」。
                两者对不上的时候（按钮能点、接口却 403），以后端为准——那说明前端这里少了
                <code style={{ fontFamily: W.mono }}> can() </code>判断。
              </div>
              {APIS.map((a) => (
                <ApiRow key={`${a.m} ${a.path}`} api={a} onOpen={() => ctx.openApi(`${a.m} ${a.path}`, a.path)} />
              ))}
            </div>
          </Block>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 顶部链路条

/**
 * 四段链路的横向指示灯。
 *
 * 为什么把「SSE」单独列出来而不是并进 API：这是这套系统里最容易出事的一段——
 * 反向代理默认 60s 读超时会安静地把长连接切掉，而 HTTP 请求全都 200。
 * 结果就是「页面看着完全正常，但什么都不刷新」。
 */
function ChainStrip({
  links,
  healthy,
  clients,
  silentFor,
  enginePending,
  service,
  now,
  onOpenMetric,
}: {
  links: { api: 'up' | 'down'; engine: 'up' | 'down'; stream: 'up' | 'down' }
  healthy: boolean
  clients: number
  silentFor: number | null
  enginePending: number | null
  service: string
  now: number
  onOpenMetric: () => void
}) {
  return (
    <div
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
        padding: '9px 12px',
        borderBottom: `1px solid ${W.line}`,
        background: W.stage,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            background: healthy ? W.ok : W.warn,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, color: W.ink2 }}>
          {healthy ? '链路正常' : '有一段不通'}
        </span>
      </span>

      {[
        { k: 'Go API', s: links.api },
        { k: 'Python 引擎', s: links.engine },
        { k: 'SSE 推送', s: links.stream },
      ].map((x) => (
        <span key={x.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: x.s === 'up' ? W.ok : W.bad,
            }}
          />
          <span style={{ color: W.ink3 }}>{x.k}</span>
          <span style={{ color: x.s === 'up' ? W.ok : W.bad, fontWeight: 600 }}>
            {x.s === 'up' ? '通' : '断'}
          </span>
        </span>
      ))}

      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        <Mini label="SSE 连接数" value={String(clients)} bad={clients === 0} />
        <Mini
          label="距上个事件"
          value={silentFor === null ? '—' : fmtDuration(silentFor)}
          bad={silentFor !== null && silentFor > 120}
        />
        <Mini
          label="待结算预测"
          value={enginePending === null ? '—' : String(enginePending)}
          bad={enginePending === 0}
        />
        <button
          type="button"
          onClick={onOpenMetric}
          style={{
            border: 0,
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            font: 'inherit',
            textAlign: 'left',
          }}
          title="什么是仿真时钟"
        >
          <Mini label={`${service} 时钟`} value={now ? fmtTime(now, 'HH:mm:ss') : '—'} bad={false} dashed />
        </button>
      </span>
    </div>
  )
}

function Mini({ label, value, bad, dashed }: { label: string; value: string; bad: boolean; dashed?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 1, alignItems: 'flex-end' }}>
      <span
        style={{
          fontSize: 9.5,
          color: W.ink4,
          borderBottom: dashed ? `1px dashed ${W.ink4}88` : undefined,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          fontFamily: W.mono,
          fontVariantNumeric: 'tabular-nums',
          color: bad ? W.bad : W.ink2,
        }}
      >
        {value}
      </span>
    </span>
  )
}

// ---------------------------------------------------------------- 四层

interface LayerDef {
  readonly key: string
  readonly name: string
  /** 用户屏幕上看到的**现象**。这一栏必须能从「我看到的事」倒推回来。 */
  readonly symptom: string
  /** 一个可执行的判据。不是「可能」「也许」，是「照这个看就能分出是不是它」。 */
  readonly judge: string
  readonly fix: string
  /** 这一层最常见的误判。写成一句话，让人记得住。 */
  readonly trap: string
}

const LAYERS: readonly LayerDef[] = [
  {
    key: 'source',
    name: '数据源',
    symptom:
      '曲线变成一条水平直线；「近 1h 变化」慢慢收敛到 0；雨量也不再变化。最容易被误判成「雨停了、水退了」——而这恰恰是漏报最危险的时刻。',
    judge:
      '看「待结算预测」这个数（engine.pending）：数据源断了但引擎还活着时，它会只增不减，因为发出去的预测永远等不到实测来结算。配合看 engine.last_ts 与仿真时钟的差，差在持续拉大就是它。',
    fix:
      '重启模拟器，让它从 sim_clock.json 里的时钟续跑，不要清库——清库会在历史序列里留一段真的断层，之后任何「近 N 小时」的对比都失真。',
    trap: '最像「雨停了」。',
  },
  {
    key: 'engine',
    name: 'Python 引擎',
    symptom:
      '实测还在照常更新（水位数字在跳），但四个预见期全部变成「—」；地图气泡不再显示峰值；已有的预警只挂着不解除——因为没人再判它是该解除还是该升级。',
    judge:
      'engine_ok = false，而 /api/overview 仍有新数据。这两个同时成立就锁定在引擎：Go 侧没坏（数据还在进），坏的是「把数据变成预测与等级」的那一段。',
    fix:
      '先看 47 维特征是不是齐的（少一列时整批预测会静默失败，日志里不一定有 ERROR），补齐再重启引擎。特征不齐时重启只会让它再挂一次。',
    trap: '实测在跳，最容易被当成「一切正常」。',
  },
  {
    key: 'api',
    name: 'Go API',
    symptom:
      '半死状态：API 活着、每个 /api/* 都还是 200，页面看着完全正常，但它不会自己刷新了——数字停在某一刻，预警不再冒出来。这不是「崩了」，是「不推了」。',
    judge:
      '看顶栏的「SSE 通/断」，再对一下 /api/health 里的 clients 是不是 0。clients = 0 表示一个浏览器连接都没挂在这条 SSE 上，那么页面上的数字无论多正常都只是上一次拉取的快照。',
    fix:
      '查反向代理的读超时：本项目有意不设 WriteTimeout（长连接本来就不该有写超时），但 Nginx 默认 60s 的 proxy_read_timeout 会安静地把 SSE 切掉，而且切的时候不发任何错误。把那一层调大或改成流式透传。',
    trap: '所有接口都 200，最难自查。',
  },
  {
    key: 'browser',
    name: '浏览器连接',
    symptom:
      '只有当前这个标签页是坏的：别人那台机器正常、同一台机器的无痕窗口也正常。刷新一下有时好有时不好。',
    judge:
      '开一个无痕窗口登录同一账号看同一个页面。无痕里正常 = 问题在本地的缓存或登录态，不在服务端；无痕里也坏，那还是上面三层，回到线下继续查。',
    fix:
      '退出重登（401 之后前端会把会话置空，界面上表现为整屏回到登录页）；瓦片地图在内网时确认代理可达；最后再硬刷新清掉旧的前端资源缓存。',
    trap: '看起来像「整个系统坏了」，其实只有这一个标签页。',
  },
]

function layerStatus(
  key: string,
  links: { api: 'up' | 'down'; engine: 'up' | 'down'; stream: 'up' | 'down' },
  engineOk: boolean,
  streamLive: boolean,
  pending: number | null,
): 'up' | 'down' | 'suspect' {
  switch (key) {
    case 'api':
      return links.api
    case 'engine':
      return links.engine
    case 'browser':
      return streamLive ? 'up' : 'down'
    case 'source':
      // 数据源没有独立的健康位——它只能从引擎的两个行为量间接推断：
      // 引擎不健康时无法判断，pending 归零且引擎在跑则高度可疑。
      if (!engineOk) return 'suspect'
      return pending === 0 ? 'suspect' : 'up'
    default:
      return 'suspect'
  }
}

function LayerCard({
  layer,
  index,
  status,
  onOpen,
}: {
  layer: LayerDef
  index: number
  status: 'up' | 'down' | 'suspect'
  onOpen: () => void
}) {
  const [open, setOpen] = useState(index === 0)
  const tone = status === 'up' ? W.ok : status === 'down' ? W.bad : W.warn
  const word = status === 'up' ? '正常' : status === 'down' ? '断' : '待判'

  return (
    <div
      data-layer={layer.key}
      style={{
        border: `1px solid ${status === 'up' ? W.line : tone + '66'}`,
        borderRadius: 7,
        overflow: 'hidden',
        transition: `border-color 160ms ${ease}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: '1 1 0',
            minWidth: 0,
            border: 0,
            background: open ? W.lineSoft : 'transparent',
            padding: '7px 9px',
            cursor: 'pointer',
            font: 'inherit',
            textAlign: 'left',
          }}
          title="展开/收起这一层的现象、判据、恢复动作"
        >
          <span
            style={{
              fontSize: 10,
              color: W.ink4,
              fontFamily: W.mono,
              width: 12,
              flex: '0 0 auto',
            }}
          >
            {index + 1}
          </span>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: tone,
              flex: '0 0 auto',
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 600, color: W.ink }}>{layer.name}</span>
          <span style={{ fontSize: 10.5, color: tone, fontWeight: 600 }}>{word}</span>
          {open && (
            <span style={{ fontSize: 10.5, color: W.ink4, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
              {layer.trap}
            </span>
          )}
        </button>
        {/* 「记到右栏」和「展开看」是两件事，所以是两个按钮：
            前者是路径（我查过这一层），后者是阅读。合成一个按钮会让
            每次想看内容都往右栏压一层，一路退不回来。 */}
        <button
          type="button"
          onClick={onOpen}
          style={{
            border: 0,
            borderLeft: `1px solid ${W.line}`,
            background: 'transparent',
            padding: '0 9px',
            cursor: 'pointer',
            fontSize: 10.5,
            color: W.accent,
            fontFamily: W.sans,
            whiteSpace: 'nowrap',
          }}
          title="把这一层记到右栏的钻取路径上"
        >
          记下
        </button>
      </div>

      {open && (
        <div style={{ padding: '8px 9px 10px', borderTop: `1px solid ${W.lineSoft}`, background: W.stage }}>
          <Field label="现象" text={layer.symptom} tone={W.ink2} />
          <Field label="怎么确认是它" text={layer.judge} tone={W.ink2} />
          <Field label="恢复动作" text={layer.fix} tone={W.ink2} />
        </div>
      )}
    </div>
  )
}

function Field({ label, text, tone }: { label: string; text: string; tone: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
      <span
        style={{
          fontSize: 10,
          color: W.ink4,
          width: 66,
          flex: '0 0 auto',
          paddingTop: 2,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 11, color: tone, lineHeight: 1.75 }}>{text}</span>
    </div>
  )
}

// ---------------------------------------------------------------- 引擎健康

/**
 * 引擎的六个量。为什么值得单独一块：
 * 它们合起来才能回答「引擎是在干活，还是只是还活着」。
 * - `cycles` 只涨不停 = 真的在轮转；
 * - `pending` 是**已发出但还没到结算时刻**的预测条数，健康时应该是一个稳定的小正数；
 *   为 0 且 cycles 不涨 = 卡住了（没有新预测发出）；
 * - `clients` = 0 说明这条浏览器链路没在推，与引擎健康无关——两件事不能混。
 */
function EngineBlock({
  health,
  live,
  retrain,
  onOpenMetric,
}: {
  health:
    | {
        engineOk: boolean
        engine: { modelVersion: string; cycles: number; pending: number; uptimeS: number; lastTs: number }
        clients: number
      }
    | undefined
  live: boolean
  retrain:
    | { status: string; startedAt: number | null; version: string | null; seconds: number | null; error: string | null }
    | null
  onOpenMetric: (key: string, name: string) => void
}) {
  const e = health?.engine
  const pending = e?.pending ?? 0
  const stalled = health ? pending === 0 : false

  return (
    <Block
      title="引擎健康"
      sub="六个量合起来才能区分「在干活」和「还活着」"
      aside={
        <Pill tone={health?.engineOk ? W.ok : health ? W.bad : W.ink4}>
          {health ? (health.engineOk ? 'engine_ok' : 'engine_ok=false') : '未取到'}
        </Pill>
      }
    >
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 8 }}>
        <Figure
          value={e ? String(e.cycles) : '—'}
          label="轮次 cycles"
          size={22}
          hint="只涨不停才算在轮转"
        />
        <Figure
          value={e ? String(pending) : '—'}
          label="待结算 pending"
          size={22}
          tone={stalled ? W.bad : W.ink}
          hint="为 0 且 cycles 不涨 = 卡住"
        />
        <button
          type="button"
          onClick={() => onOpenMetric('仿真时钟', '仿真时钟')}
          style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', font: 'inherit' }}
          title="仿真时钟以 60 倍速推进，所有「近 N 小时」都按它算"
        >
          <Figure
            value={e ? uptimeText(e.uptimeS) : '—'}
            label="已运行"
            size={22}
            hint="后台进程的墙钟时长"
          />
        </button>
        <Figure
          value={health ? String(health.clients) : '—'}
          label="SSE 连接数"
          size={22}
          tone={health && health.clients === 0 ? W.bad : W.ink}
          hint="0 = 这条浏览器链路没在推"
        />
        <Figure
          value={live ? '已连接' : '断开'}
          label="本条浏览器 SSE"
          size={22}
          tone={live ? W.ok : W.bad}
          hint="EventSource 的 onopen/onerror"
        />
      </div>

      <Row k="模型版本" v={e?.modelVersion ?? '—'} hint="引擎自报，不是前端写死的" />
      <Row
        k="最近一轮时间"
        v={e?.lastTs ? fmtTime(e.lastTs, 'MM-DD HH:mm:ss') : '—'}
        hint="仿真时钟"
        tone={e && e.lastTs === 0 ? W.bad : undefined}
      />
      <Row
        k="研判窗口"
        v="按仿真时钟"
        hint="60× 加速，别用墙钟差去解释它"
        onClick={() => onOpenMetric('仿真时钟', '仿真时钟')}
      />

      <div style={{ marginTop: 9, paddingTop: 8, borderTop: `1px solid ${W.lineSoft}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11.5, color: W.ink2 }}>重训状态</span>
          <Pill tone={retrainTone(retrain?.status)}>
            {retrain?.status ?? '—'}
            {retrain?.status === 'running' && retrain.seconds != null
              ? ` · ${fmtMinutes(retrain.seconds / 60)}`
              : ''}
          </Pill>
          {retrain?.version && (
            <span style={{ fontSize: 10.5, color: W.ink4, fontFamily: W.mono }}>{retrain.version}</span>
          )}
          {retrain?.status === 'running' && (
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: W.ink4 }}>
              每 3s 刷新一次
            </span>
          )}
        </div>
        {retrain?.status === 'failed' && retrain.error && (
          <div style={{ fontSize: 10.5, color: W.bad, marginTop: 5, lineHeight: 1.7 }}>
            后端原话：{retrain.error}
          </div>
        )}
        {retrain?.status === 'done' && (
          <div style={{ fontSize: 10.5, color: W.ink4, marginTop: 5, lineHeight: 1.7 }}>
            重训完成不等于已生效：新版本要经过「模型可信度」那一块的准入判断才会被切换，
            期间线上用的还是旧版本。
          </div>
        )}
      </div>
    </Block>
  )
}

function retrainTone(s: string | undefined): string {
  if (s === 'running') return W.accent
  if (s === 'done') return W.ok
  if (s === 'failed') return W.bad
  return W.ink4
}

// ---------------------------------------------------------------- 接口

interface ApiDef {
  readonly m: 'GET' | 'POST' | 'PUT' | 'PATCH'
  readonly path: string
  /** 路由上真实挂的中间件：匿名 / 登录 / operator / admin / 引擎令牌 */
  readonly auth: string
  readonly perm: string
  readonly ret: string
  readonly curl: string
}

/**
 * 接口清单。**路径逐条对过 `api/internal/httpapi/router.go` 与 `data/client.ts`**，
 * 不是凭记忆写的：旧页面里就有 `POST /api/rules` 这种看起来合理、
 * 实际路由是 `PUT /api/rules` 的条目——照着自己写的文档去调，只会拿到 405。
 */
const APIS: readonly ApiDef[] = [
  {
    m: 'GET',
    path: '/api/health',
    auth: '匿名',
    perm: '—',
    ret: '{ ok, service, engine_ok, engine:{ cycles, pending, uptime_s, model_version, last_ts }, clients, ts }',
    curl: 'curl -s http://127.0.0.1:8200/api/health',
  },
  {
    m: 'GET',
    path: '/api/overview',
    auth: '登录',
    perm: 'viewer',
    ret: '{ issued_at, sites:[{ site_id, name, lon, lat, base_level, thresholds, level, depth, rain, warn_level, warn_score, peak_value, duration_min, spark }] }',
    curl: 'curl -s -b wl_session=$WL http://127.0.0.1:8200/api/overview',
  },
  {
    m: 'GET',
    path: '/api/forecast',
    auth: '登录',
    perm: 'viewer',
    ret: '{ issued_at, model_version, step_min, sites:{ S07:{ now_level, horizons[4], curve[145] } } }　curve 元素是 [offsetMin, level, lower, upper]',
    curl: 'curl -s -b wl_session=$WL http://127.0.0.1:8200/api/forecast',
  },
  {
    m: 'GET',
    path: '/api/history?site=S08&hours=12',
    auth: '登录',
    perm: 'viewer',
    ret: '{ site_id, hours, points:[{ ts, level, rain }] }　键是 points，不是 sites',
    curl: 'curl -s -b wl_session=$WL "http://127.0.0.1:8200/api/history?site=S08&hours=12"',
  },
  {
    m: 'GET',
    path: '/api/alerts?active=1',
    auth: '登录',
    perm: 'viewer',
    ret: '{ alerts:[{ id, site_id, state, disposition, level, raised_at, note_count }] }　active=0 才含已解除',
    curl: 'curl -s -b wl_session=$WL "http://127.0.0.1:8200/api/alerts?active=1&limit=100"',
  },
  {
    m: 'POST',
    path: '/api/alerts/{id}/ack',
    auth: '登录',
    perm: 'operator',
    ret: '{ ok, state }　非法迁移返回 409 + 中文原因（比如「已确认，无需重复确认」）',
    curl: 'curl -s -X POST -b wl_session=$WL http://127.0.0.1:8200/api/alerts/152/ack',
  },
  {
    m: 'POST',
    path: '/api/alerts/{id}/disposition',
    auth: '登录',
    perm: 'operator',
    ret: '{ ok, event }　五态推进；dispatched → open 后端故意不允许（409）',
    curl: 'curl -s -X POST -b wl_session=$WL -H "Content-Type: application/json" -d "{\\"disposition\\":\\"dispatched\\",\\"note\\":\\"已派单\\"}" http://127.0.0.1:8200/api/alerts/152/disposition',
  },
  {
    m: 'GET',
    path: '/api/metrics?window_h=6',
    auth: '登录',
    perm: 'viewer',
    ret: '{ models, importance, rolling:{ "60":{ n, rmse, baseline_rmse, skill } } }　参数名是 window_h，不是 window',
    curl: 'curl -s -b wl_session=$WL "http://127.0.0.1:8200/api/metrics?window_h=6"',
  },
  {
    m: 'GET',
    path: '/api/models/versions',
    auth: '登录',
    perm: 'viewer',
    ret: '{ active, versions:[{ version, trained_at, n_train, metrics }] }',
    curl: 'curl -s -b wl_session=$WL http://127.0.0.1:8200/api/models/versions',
  },
  {
    m: 'POST',
    path: '/api/models/adopt?version=',
    auth: '登录',
    perm: 'admin',
    ret: '{ ok, active, reloaded }　先验证 pickle 能否加载，加载失败不改当前版本',
    curl: 'curl -s -X POST -b wl_session=$WL "http://127.0.0.1:8200/api/models/adopt?version=v20261115_0310"',
  },
  {
    m: 'GET',
    path: '/api/rules',
    auth: '登录',
    perm: 'viewer',
    ret: '{ weights, min_duration_min, score_cutoffs, duration_saturation_min, trend_upgrade_slope, trend_downgrade_slope, trend_score_span, horizon_min, min_level_for_alarm }',
    curl: 'curl -s -b wl_session=$WL http://127.0.0.1:8200/api/rules',
  },
  {
    m: 'POST',
    path: '/api/rules/preview',
    auth: '登录',
    perm: 'operator',
    ret: '{ before, after, up, down, changes }　用同一条已发布曲线重判，不重新预测',
    curl: 'curl -s -X POST -b wl_session=$WL -H "Content-Type: application/json" -d @rules.json http://127.0.0.1:8200/api/rules/preview',
  },
  {
    m: 'PUT',
    path: '/api/rules',
    auth: '登录',
    perm: 'admin',
    ret: '{ ok, rules }　是 PUT 不是 POST（写成 POST 会被 chi 判 405）；错误的 method 会被 chi 直接判 405',
    curl: 'curl -s -X PUT -b wl_session=$WL -H "Content-Type: application/json" -d @rules.json http://127.0.0.1:8200/api/rules',
  },
  {
    m: 'POST',
    path: '/api/sim/storm?peak=&dur=',
    auth: '登录',
    perm: 'operator',
    ret: '{ ok, storm:{ start_step, dur_steps, peak_mm_h, sim_minutes } }　dur 是步数不是分钟',
    curl: 'curl -s -X POST -b wl_session=$WL "http://127.0.0.1:8200/api/sim/storm?peak=170&dur=30"',
  },
  {
    m: 'POST',
    path: '/api/sim/reset-water',
    auth: '登录',
    perm: 'operator',
    ret: '{ ok, sites, clear_sky, dropped_pending }　dropped_pending 是被作废的未结算预测条数',
    curl: 'curl -s -X POST -b wl_session=$WL "http://127.0.0.1:8200/api/sim/reset-water?clear_sky=true"',
  },
  {
    m: 'POST',
    path: '/api/ingest/telemetry',
    auth: '引擎令牌',
    perm: 'X-Ingest-Token',
    ret: '{ ok, accepted }　浏览器没有这个头，所以这条接口在页面上永远调不通——这是设计，不是 bug',
    curl: 'curl -s -X POST -H "X-Ingest-Token: $WL_INGEST_TOKEN" -H "Content-Type: application/json" -d @batch.json http://127.0.0.1:8200/api/ingest/telemetry',
  },
  {
    m: 'GET',
    path: '/api/audit?hours=24',
    auth: '登录',
    perm: 'admin',
    ret: '{ entries:[{ at, username, role, method, path, status, duration_ms, summary, request_id }] }',
    curl: 'curl -s -b wl_session=$WL "http://127.0.0.1:8200/api/audit?hours=24&limit=100"',
  },
  {
    m: 'GET',
    path: '/api/icm/health',
    auth: '登录',
    perm: 'viewer',
    ret: '{ ok, ... }　ICM 侧的探活，用来区分「我方 API 好」与「对接方好」',
    curl: 'curl -s -b wl_session=$WL http://127.0.0.1:8200/api/icm/health',
  },
  {
    m: 'GET',
    path: '/api/events',
    auth: '登录',
    perm: 'viewer',
    ret: 'text/event-stream，事件 type 有 hello / telemetry / forecast / warning / rules',
    curl: 'curl -N -b wl_session=$WL http://127.0.0.1:8200/api/events',
  },
]

function ApiRow({ api, onOpen }: { api: ApiDef; onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const copy = () => {
    // 剪贴板可能不可用（非安全上下文）。失败就只展开显示，不弹窗、不报错。
    void navigator.clipboard?.writeText(api.curl).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      },
      () => setOpen(true),
    )
  }

  return (
    <div
      data-api={`${api.m} ${api.path}`}
      style={{ borderBottom: `1px solid ${W.lineSoft}`, padding: '5px 0' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            fontFamily: W.mono,
            color: api.m === 'GET' ? W.ink3 : api.m === 'PUT' ? W.warn : W.accent,
            width: 34,
            flex: '0 0 auto',
          }}
        >
          {api.m}
        </span>
        <button
          type="button"
          onClick={onOpen}
          title="把这条接口记到右栏的钻取路径上"
          style={{
            border: 0,
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 11.5,
            fontFamily: W.mono,
            color: W.ink,
            textAlign: 'left',
            borderBottom: `1px dashed ${W.lineStrong}`,
            flex: '1 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {api.path}
        </button>
        <Pill tone={authTone(api.perm)} title={`${api.auth} · ${api.perm}`}>
          {api.perm}
        </Pill>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            border: 0,
            background: 'transparent',
            padding: '0 2px',
            cursor: 'pointer',
            fontSize: 10,
            color: W.ink4,
            fontFamily: W.sans,
          }}
          title="展开这一条的返回与 curl"
        >
          {open ? '收起' : 'curl'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 5, paddingLeft: 40 }}>
          <div style={{ fontSize: 10.5, color: W.ink3, lineHeight: 1.7 }}>{api.ret}</div>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
              marginTop: 5,
              padding: '5px 7px',
              borderRadius: 5,
              background: W.rail,
              border: `1px solid ${W.lineSoft}`,
            }}
          >
            <code
              style={{
                fontSize: 10,
                fontFamily: W.mono,
                color: W.ink2,
                lineHeight: 1.6,
                wordBreak: 'break-all',
                flex: '1 1 0',
              }}
            >
              {api.curl}
            </code>
            <button
              type="button"
              onClick={copy}
              style={{
                border: 0,
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
                fontSize: 10,
                color: copied ? W.ok : W.accent,
                fontFamily: W.sans,
                flex: '0 0 auto',
              }}
              title="复制这条 curl"
            >
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <div style={{ fontSize: 10, color: W.ink4, marginTop: 4, lineHeight: 1.6 }}>
            鉴权：{api.auth}　·　权限：{api.perm}　·
            <code style={{ fontFamily: W.mono }}>wl_session</code> 是会话 cookie，
            浏览器里由登录写入，命令行里要自己带上。
          </div>
        </div>
      )}
    </div>
  )
}

function authTone(perm: string): string {
  if (perm === 'admin') return W.level.orange
  if (perm === 'operator') return W.accent
  if (perm === 'viewer') return W.ink3
  if (perm === '—') return W.ink4
  return W.ink4
}
