import { useMemo, useRef, useState } from 'react'
import { useAlerts } from '../data/queries'
import { useWatchlist, type SiteGlance } from '../view/useWatchlist'
import { useSituation } from '../view/useSituation'
import { isActive, LEVEL_LABEL } from '../domain'
import { Nothing, Ruler, Shimmer } from './kit'
import { W, RAIL_W, ease } from './visual'
import type { Crumb, RailSort, Stage } from './model'

/**
 * 左侧对象栏：**整屏唯一一份「有哪些站点」的列表**。
 *
 * 它是这一屏能成立的前提。此前的做法是每个页面各带一个列表（站点表、一张图的清单、
 * 预警页的表格），用户在页面之间跳时列表就换了一次位置、一次排序、一次筛选，
 * 于是「我刚才在看哪个站」这件小事每次都要重新找。
 *
 * 所以这里刻意**不跟随舞台变化**：不管你正在看某个站的详情、某条预警的卷宗，
 * 还是模型可信度，左边永远是同一份列表、同一个排序、同一个筛选、同一个滚动位置。
 * 用户因此永远知道「我在哪、旁边的站是什么、换一个要往哪点」。
 */
export function Rail({
  stage,
  sort,
  query,
  alarmsOnly,
  onSort,
  onQuery,
  onAlarmsOnly,
  onPickSite,
  onPickEvent,
}: {
  stage: Stage
  sort: RailSort
  query: string
  alarmsOnly: boolean
  onSort: (s: RailSort) => void
  onQuery: (q: string) => void
  onAlarmsOnly: (on: boolean) => void
  onPickSite: (siteId: string) => void
  onPickEvent: (eventId: number, siteId: string, level: string) => void
}) {
  const [tab, setTab] = useState<'sites' | 'events'>('sites')
  const sit = useSituation()
  const sites = useWatchlist(sort)
  const alerts = useAlerts(alarmsOnly)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = alarmsOnly ? sites.filter((g) => g.isAlarm) : sites
    if (!q) return base
    return base.filter(
      (g) =>
        g.site.name.toLowerCase().includes(q) ||
        g.site.id.toLowerCase().includes(q) ||
        g.site.district.toLowerCase().includes(q),
    )
  }, [sites, query, alarmsOnly])

  const events = useMemo(
    () => (alerts.data ?? []).slice(0, 60),
    [alerts.data],
  )

  const searchRef = useRef<HTMLInputElement>(null)

  return (
    <aside
      data-tour="wb-rail"
      data-rail="objects"
      aria-label="站点与预警列表"
      style={{
        width: RAIL_W,
        flex: '0 0 auto',
        background: W.rail,
        borderRight: `1px solid ${W.line}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* 两个页面级对象：站点 / 事件。这是「按内容组织」而不是「按功能页面组织」——
          预警不是另一张页面，它是同一批站点上的另一类对象。 */}
      <div style={{ display: 'flex', padding: '8px 8px 0', gap: 4, flex: '0 0 auto' }}>
        <Switch on={tab === 'sites'} onClick={() => setTab('sites')} dataKey="sites">
          站点 {sit.total > 0 && <Num>{sit.total}</Num>}
        </Switch>
        <Switch on={tab === 'events'} onClick={() => setTab('events')} dataKey="events">
          预警 {alerts.data && <Num>{alerts.data.length}</Num>}
        </Switch>
      </div>

      {/* 搜索。`/` 聚焦——键盘用户不该为了搜一个站去够鼠标。 */}
      <div style={{ padding: '8px 8px 6px', flex: '0 0 auto' }}>
        <div style={{ position: 'relative' }}>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onQuery('')
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            placeholder="搜站名 / 街道 / 编号"
            aria-label="搜索站点或事件"
            style={{
              width: '100%',
              height: 28,
              padding: '0 8px 0 26px',
              fontSize: 12,
              color: W.ink,
              background: W.stage,
              border: `1px solid ${W.line}`,
              borderRadius: 6,
              outline: 'none',
              fontFamily: W.sans,
            }}
          />
          <span
            style={{
              position: 'absolute',
              left: 8,
              top: 6,
              fontSize: 12,
              color: W.ink4,
              pointerEvents: 'none',
            }}
          >
            ⌕
          </span>
          {query && (
            <button
              type="button"
              onClick={() => onQuery('')}
              aria-label="清空搜索"
              style={{
                position: 'absolute',
                right: 6,
                top: 5,
                width: 18,
                height: 18,
                borderRadius: 9,
                border: 0,
                background: W.line,
                color: W.ink2,
                cursor: 'pointer',
                fontSize: 11,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {tab === 'sites' && (
        <div
          style={{
            display: 'flex',
            gap: 2,
            padding: '0 8px 6px',
            flex: '0 0 auto',
            flexWrap: 'wrap',
          }}
        >
          {(
            [
              ['level', '等级'],
              ['depth', '水深'],
              ['trend', '涨速'],
              ['rain', '雨强'],
            ] as [RailSort, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => onSort(k)}
              data-sort={k}
              // 排序是一组互斥开关，用 aria-pressed 表达「现在是它」。
              // 顺带让测试脚本能断言「点了站之后排序没被重置」——
              // 只看样式变化是断不出来的（颜色对不上人眼也看不出）。
              aria-pressed={sort === k}
              style={{
                padding: '2px 7px',
                fontSize: 10.5,
                borderRadius: 4,
                border: `1px solid ${sort === k ? W.accent + '77' : 'transparent'}`,
                background: sort === k ? W.accentSoft : 'transparent',
                color: sort === k ? W.accent : W.ink3,
                cursor: 'pointer',
                font: 'inherit',
              }}
              title={`按${label}排序`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onAlarmsOnly(!alarmsOnly)}
            data-rail-alarm-only=""
            aria-pressed={alarmsOnly}
            style={{
              marginLeft: 'auto',
              padding: '2px 7px',
              fontSize: 10.5,
              borderRadius: 4,
              border: `1px solid ${alarmsOnly ? W.level.orange + '77' : 'transparent'}`,
              background: alarmsOnly ? W.levelWash.orange : 'transparent',
              color: alarmsOnly ? W.levelInk.orange : W.ink3,
              cursor: 'pointer',
              font: 'inherit',
            }}
            title="只列出现在有预警的站点"
          >
            只看预警
          </button>
        </div>
      )}

      {/* 列表本身：撑满剩余高度、独立滚动。**它不随舞台重挂**，
          所以滚动位置在「看站点详情 → 看预警卷宗 → 去模型可信度」之间全程保留。 */}
      <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '0 6px 8px' }}>
        {tab === 'sites' &&
          (sites.length === 0 ? (
            <div style={{ padding: 10 }}>
              <Shimmer h={54} />
              <div style={{ height: 6 }} />
              <Shimmer h={54} />
              <div style={{ height: 6 }} />
              <Shimmer h={54} />
            </div>
          ) : rows.length === 0 ? (
            <Nothing
              why="没有符合条件的站点"
              hint={query ? `「${query}」没有匹配到站名、街道或编号。` : '当前筛选条件下没有站点，试试关掉「只看预警」。'}
            />
          ) : (
            rows.map((g) => (
              <SiteRow
                key={g.site.id}
                g={g}
                on={stage.kind === 'site' && stage.siteId === g.site.id}
                onClick={() => onPickSite(g.site.id)}
              />
            ))
          ))}

        {tab === 'events' &&
          (alerts.isLoading ? (
            <div style={{ padding: 10 }}>
              <Shimmer h={48} />
            </div>
          ) : events.length === 0 ? (
            <Nothing
              why={alarmsOnly ? '现在没有激活中的预警' : '最近没有预警记录'}
              hint={
                alarmsOnly
                  ? '只看预警已打开。关掉它可以看到已解除的历史记录——解除不等于归档，仍要有人确认。'
                  : '预警由模型研判产生；没有记录说明近期没有站点触及阈值。'
              }
            />
          ) : (
            events.map((e) => (
              <EventRow
                key={e.id}
                id={e.id}
                siteId={e.siteId}
                siteName={e.siteName}
                level={e.level}
                state={e.state}
                disposition={e.disposition}
                on={stage.kind === 'event' && stage.eventId === e.id}
                onClick={() => onPickEvent(e.id, e.siteId, e.level)}
              />
            ))
          ))}
      </div>

      {/* 底部一句话：把列表本身也变成一个「结论」，而不只是名称的罗列。 */}
      <div
        style={{
          flex: '0 0 auto',
          padding: '7px 10px',
          borderTop: `1px solid ${W.line}`,
          fontSize: 10.5,
          color: W.ink4,
          lineHeight: 1.55,
        }}
      >
        {tab === 'sites'
          ? sit.hasData
            ? `最深 ${sit.deepest.value.toFixed(2)} m 在 ${sit.deepest.siteName} · ${sit.rainingSites} 站在下雨`
            : '等待首帧数据'
          : `${(alerts.data ?? []).filter((a) => isActive(a.state)).length} 条激活中 · 最后一条 ${
              events[0] ? new Date(events[0].raisedAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—'
            }`}
      </div>
    </aside>
  )
}

function Switch({
  on,
  onClick,
  children,
  dataKey,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
  dataKey?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-rail-tab={dataKey}
      aria-pressed={on}
      style={{
        flex: '1 1 0',
        height: 26,
        borderRadius: 6,
        border: `1px solid ${on ? W.lineStrong : 'transparent'}`,
        background: on ? W.stage : 'transparent',
        color: on ? W.ink : W.ink3,
        fontSize: 12,
        fontWeight: on ? 600 : 400,
        cursor: 'pointer',
        fontFamily: W.sans,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        transition: `background 140ms ${ease}, color 140ms ${ease}`,
      }}
    >
      {children}
    </button>
  )
}

function Num({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, color: W.ink4, fontFamily: W.mono, fontVariantNumeric: 'tabular-nums' }}>
      {children}
    </span>
  )
}

/**
 * 一条站点。
 *
 * 一行里放六件事：等级色条、站名、街道、水深、离红阈的比例、1h 变化。
 * 之所以塞这么密：**值班员是靠扫这一列来找「哪个不对劲」的**，
 * 如果把水深藏在点开之后，他就必须逐个点开十个站才能比较——那不叫对比。
 */
export function SiteRow({
  g,
  on,
  onClick,
}: {
  g: SiteGlance
  on: boolean
  onClick: () => void
}) {
  const lv = g.assessment.level
  return (
    <button
      type="button"
      onClick={onClick}
      data-site-row={g.site.id}
      data-rail-row={g.site.id}
      aria-pressed={on}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '7px 8px 8px 9px',
        marginBottom: 3,
        borderRadius: 6,
        border: `1px solid ${on ? W.accent + '66' : 'transparent'}`,
        background: on ? W.accentSoft : W.stage,
        cursor: 'pointer',
        font: 'inherit',
        position: 'relative',
        transition: `background 140ms ${ease}, border-color 140ms ${ease}`,
      }}
      title={`${g.site.name} · ${g.site.district}`}
    >
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: 7,
          bottom: 7,
          width: 3,
          borderRadius: 2,
          background: W.level[lv],
        }}
      />
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, paddingLeft: 4 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: on ? 600 : 500,
            color: W.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: '1 1 auto',
          }}
        >
          {g.site.name}
        </span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            fontFamily: W.mono,
            fontVariantNumeric: 'tabular-nums',
            color: g.reading.depth > 0 ? W.ink : W.ink4,
          }}
        >
          {g.reading.depth > 0 ? g.reading.depth.toFixed(2) : '0.00'}
        </span>
        <span style={{ fontSize: 9.5, color: W.ink4 }}>m</span>
      </span>

      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          paddingLeft: 4,
          marginTop: 4,
          fontSize: 10,
          color: W.ink4,
        }}
      >
        <span style={{ color: W.levelInk[lv] }}>{g.isAlarm ? LEVEL_LABEL[lv] : '正常'}</span>
        <span style={{ color: W.lineStrong }}>·</span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 62,
          }}
        >
          {g.site.district}
        </span>
        {Math.abs(g.reading.trend1h) > 0.005 && (
          <>
            <span style={{ color: W.lineStrong }}>·</span>
            <span
              style={{
                color: g.reading.trend1h > 0 ? W.levelInk.orange : W.ok,
                fontFamily: W.mono,
              }}
            >
              {g.reading.trend1h > 0 ? '+' : '−'}
              {Math.abs(g.reading.trend1h).toFixed(2)}
            </span>
          </>
        )}
        {g.raining && <span style={{ color: W.levelInk.blue }}>雨</span>}
      </span>

      <span style={{ display: 'block', paddingLeft: 4, marginTop: 5 }}>
        <Ruler
          ratio={g.depthRatio}
          color={W.level[lv]}
          height={3}
          marks={[{ at: 1, color: W.lineStrong }]}
        />
      </span>
    </button>
  )
}

function EventRow({
  id,
  siteName,
  level,
  state,
  disposition,
  on,
  onClick,
}: {
  id: number
  siteId: string
  siteName: string
  level: string
  state: string
  disposition: string
  on: boolean
  onClick: () => void
}) {
  const closed = disposition === 'resolved' || disposition === 'false_alarm'
  return (
    <button
      type="button"
      onClick={onClick}
      data-event-row={id}
      aria-pressed={on}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 8px 7px 9px',
        marginBottom: 3,
        borderRadius: 6,
        border: `1px solid ${on ? W.accent + '66' : 'transparent'}`,
        background: on ? W.accentSoft : W.stage,
        cursor: 'pointer',
        font: 'inherit',
        position: 'relative',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: 6,
          bottom: 6,
          width: 3,
          borderRadius: 2,
          background: W.level[level] ?? W.level.none,
        }}
      />
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 5, paddingLeft: 4 }}>
        <span
          style={{
            fontSize: 11.5,
            color: W.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: '1 1 auto',
            fontWeight: on ? 600 : 500,
          }}
        >
          {siteName}
        </span>
      </span>
      <span
        style={{
          display: 'flex',
          gap: 5,
          paddingLeft: 4,
          marginTop: 3,
          fontSize: 10,
          color: W.ink4,
        }}
      >
        <span style={{ color: W.levelInk[level] ?? W.ink4 }}>
          {LEVEL_LABEL[level as 'none'] ?? level}
        </span>
        <span style={{ color: W.lineStrong }}>·</span>
        <span>{state.startsWith('ACTIVE') ? '激活中' : '已解除'}</span>
        <span style={{ color: W.lineStrong }}>·</span>
        <span style={{ color: closed ? W.ok : W.ink3 }}>
          {state.endsWith('UNACK') ? '未确认' : '已确认'}
        </span>
      </span>
    </button>
  )
}

export type { Crumb }
