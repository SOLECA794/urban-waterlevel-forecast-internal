import { useMemo, useRef, useState } from 'react'
import { useAlertTotal, useAlerts } from '../data/queries'
import { useWatchlist, type SiteGlance } from '../view/useWatchlist'
import { useSituation, type SituationSummary } from '../view/useSituation'
import { isActive, LEVEL_LABEL, LEVEL_RANK, type Level } from '../domain'
import { Nothing, Shimmer } from './kit'
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
 *
 * 这一版按从上到下的顺序新增了四件事：
 *   1. 顶部态势摘要——「红色几个、橙色几个、最深在哪」是值班员扫这一列之前
 *      就已经成立的结论，把它压在页签之下就等于让人先读完十行才敢下判断。
 *   2. 街道分组——十个站平铺时，「哪些站在同一片汇水区」只能靠读街道名猜；
 *      分组之后，一条街的站点涨了会一起涨，组头就是那条街的结论。
 *   3. 行内 20 点走势——只给一个当下的水深，看不出「在涨还是在退」；
 *      第三行那条 52×14 的折线回答的正是这个，右侧顺手给出离红阈还有多远。
 *   4. 预警页签的等级芯片——原来只能「全部 / 只看激活」，60 条事件里想先看红色
 *      只能一条条扫。芯片把这件事变成一次点击，且**只在本地过滤**，
 *      不改接口、不改 URL（左栏的筛选不该产生一条可分享的地址）。
 */

/** 数字一律等宽 + tabular-nums：水位、雨量、计数每 5 秒变一次，字宽一跳行就抖。 */
const NUM = {
  fontFamily: W.mono,
  fontVariantNumeric: 'tabular-nums',
} as const

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
  /** 街道折叠状态。默认全展开——一进来就看不见的站点等于没列出来。 */
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  /** 预警页签的等级过滤。null = 不过滤；只在组件内生效，不进 URL、不进 query key。 */
  const [levelFilter, setLevelFilter] = useState<Level | null>(null)

  const sit = useSituation()
  const sites = useWatchlist(sort)
  const alerts = useAlerts(alarmsOnly)
  const alertTotal = useAlertTotal(alarmsOnly)

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

  const groups = useMemo(() => groupByDistrict(rows), [rows])

  const events = useMemo(() => (alerts.data ?? []).slice(0, 60), [alerts.data])

  /**
   * 四个等级芯片的计数。
   *
   * 统计范围和列表用的是**同一批** 60 条：芯片写 12、点开却只有 8 行，
   * 比不给数字更糟——用户会开始怀疑整块面板的口径。
   */
  const levelCount = useMemo(() => {
    const tally: Record<string, number> = { red: 0, orange: 0, yellow: 0, blue: 0 }
    for (const e of events) if (e.level !== 'none') tally[e.level] = (tally[e.level] ?? 0) + 1
    return tally
  }, [events])

  const shownEvents = useMemo(
    () => (levelFilter ? events.filter((e) => e.level === levelFilter) : events),
    [events, levelFilter],
  )

  const activeCount = useMemo(
    () => (alerts.data ?? []).filter((a) => isActive(a.state)).length,
    [alerts.data],
  )

  /** 最后一条预警时间：语义保留在事件页签的页脚，站点页签不再重复写一遍。 */
  const lastTime = events[0]
    ? new Date(events[0].raisedAt * 1000).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'

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
      {/* 顶部态势摘要：两行 46px。
          排在页签**之上**，因为它不属于任何一个页签——红色几个、橙色几个、
          最深在哪，是「这一列十个站里现在最该看谁」的结论，不是站点页签的附属信息。
          原来这行字趴在列表最底下，只有滚到底才看得见，等于把结论藏起来。 */}
      <SituationStrip sit={sit} />

      {/* 两个页面级对象：站点 / 事件。这是「按内容组织」而不是「按功能页面组织」——
          预警不是另一张页面，它是同一批站点上的另一类对象。 */}
      <div style={{ display: 'flex', padding: '8px 8px 0', gap: 4, flex: '0 0 auto' }}>
        <Switch on={tab === 'sites'} onClick={() => setTab('sites')} dataKey="sites">
          站点 {sit.total > 0 && <Num>{sit.total}</Num>}
        </Switch>
        <Switch on={tab === 'events'} onClick={() => setTab('events')} dataKey="events">
          {/* 用数据库给的总数，不用取回来的条数：列表有 limit，超过就永远显示 100。 */}
          预警 {alertTotal !== null ? <Num>{alertTotal}</Num> : alerts.data && <Num>{alerts.data.length}</Num>}
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

      {/* 预警页签的四个等级芯片。
          放在事件列表**正上方**：用户点进「预警」这一页，第一个问题几乎总是
          「有没有红色的」，而不是「最早那条是什么时候」。四个数字就是这一页的目录。
          再点一次同一个芯片取消过滤——单选芯片做成可回退的开关，
          否则用户得靠「再点别处」退出，那是猜谜。 */}
      {tab === 'events' && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: '0 8px 6px',
            flex: '0 0 auto',
          }}
        >
          {(['red', 'orange', 'yellow', 'blue'] as Level[]).map((lv) => (
            <LevelChip
              key={lv}
              level={lv}
              count={levelCount[lv] ?? 0}
              on={levelFilter === lv}
              onClick={() => setLevelFilter((cur) => (cur === lv ? null : lv))}
            />
          ))}
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
            // 分组渲染。**组序就是「哪条街最该管」**：先比组内最高等级，再比组内最深水位，
            // 最后按名字稳定排序——同等级同深度的两条街不该每次刷新都换位置。
            // 组内顺序沿用用户选的排序（等级/水深/涨速/雨强），分组不夺走排序的控制权。
            groups.map((g) => {
              const open = !folded[g.district]
              return (
                <div key={g.district}>
                  <GroupHeader
                    g={g}
                    open={open}
                    onToggle={() =>
                      setFolded((cur) => ({ ...cur, [g.district]: !cur[g.district] }))
                    }
                  />
                  {open &&
                    g.rows.map((row) => (
                      <SiteRow
                        key={row.site.id}
                        g={row}
                        on={stage.kind === 'site' && stage.siteId === row.site.id}
                        onClick={() => onPickSite(row.site.id)}
                      />
                    ))}
                </div>
              )
            })
          ))}

        {tab === 'events' &&
          (alerts.isLoading ? (
            <div style={{ padding: 10 }}>
              <Shimmer h={48} />
            </div>
          ) : shownEvents.length === 0 ? (
            // 空态必须区分「本来就没有」和「被我自己筛空了」：
            // 两种情况该做的事完全相反（一个等下一次研判，一个取消过滤）。
            levelFilter ? (
              <Nothing
                why={`「${LEVEL_LABEL[levelFilter]}」这一档现在没有记录`}
                hint={`列表是被上面的等级芯片筛空的。再点一次同一个芯片取消过滤，可以看到全部 ${events.length} 条。`}
              />
            ) : (
              <Nothing
                why={alarmsOnly ? '现在没有激活中的预警' : '最近没有预警记录'}
                hint={
                  alarmsOnly
                    ? '只看预警已打开。关掉它可以看到已解除的历史记录——解除不等于归档，仍要有人确认。'
                    : '预警由模型研判产生；没有记录说明近期没有站点触及阈值。'
                }
              />
            )
          ) : (
            shownEvents.map((e) => (
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

      {/* 事件页签的页脚：保留「最后一条预警时间」这条语义。
          站点页签不再有页脚——它的结论已经升到顶部摘要条，底下再写一遍是重复。
          这里的「最后一条」始终取未过滤的列表，因为它是这一页的时间基准，
          不该随用户点哪个芯片而变。 */}
      {tab === 'events' && (
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'baseline',
            gap: 4,
            padding: '6px 10px',
            borderTop: `1px solid ${W.line}`,
            fontSize: 10.5,
            color: W.ink4,
            lineHeight: '14px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <span>激活</span>
          <b style={{ ...NUM, color: activeCount > 0 ? W.ink2 : W.ink4, fontWeight: 600 }}>
            {activeCount}
          </b>
          <span>条</span>
          <span style={{ color: W.lineStrong }}>·</span>
          <span>最后一条</span>
          <b style={{ ...NUM, color: W.ink2, fontWeight: 600 }}>{lastTime}</b>
          {levelFilter && (
            <button
              type="button"
              onClick={() => setLevelFilter(null)}
              style={{
                marginLeft: 'auto',
                padding: 0,
                border: 0,
                background: 'none',
                color: W.accent,
                fontSize: 10.5,
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              取消过滤
            </button>
          )}
        </div>
      )}
    </aside>
  )
}

/**
 * 顶部态势摘要：两行 46px。
 *
 * 第一行是**等级分布**（红、橙各几个），右侧是雨情——「几个站在下雨」解释了
 * 为什么等级可能在往上走。第二行是**最深的那一个**：一个城十条街，
 * 全城最深的那个站决定了接下来先打给谁。
 *
 * 三个数都从 `useSituation` 来（`counts` / `deepest` / `rainingSites`），
 * 不在这一层重新统计——L1 结论只该算一次，否则顶栏和左栏迟早会说出两个数字。
 */
function SituationStrip({ sit }: { sit: SituationSummary }) {
  const count = (lv: Level) => sit.counts.find((c) => c.level === lv)?.count ?? 0
  return (
    <div
      data-rail-summary=""
      style={{
        flex: '0 0 auto',
        height: 46,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 3,
        padding: '0 10px',
        background: W.stage,
        borderBottom: `1px solid ${W.line}`,
      }}
    >
      {sit.hasData ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 4,
              fontSize: 11,
              lineHeight: '15px',
            }}
          >
            <Tally label="红色" v={count('red')} tone={W.levelInk.red} />
            <span style={{ color: W.lineStrong }}>·</span>
            <Tally label="橙色" v={count('orange')} tone={W.levelInk.orange} />
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10.5,
                color: sit.rainingSites > 0 ? W.levelInk.blue : W.ink4,
                whiteSpace: 'nowrap',
              }}
            >
              正在下雨 <b style={{ ...NUM, fontWeight: 600 }}>{sit.rainingSites}</b> 站
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 4,
              fontSize: 11,
              lineHeight: '14px',
              color: W.ink3,
              minWidth: 0,
            }}
          >
            <span style={{ flex: '0 0 auto' }}>最深</span>
            <b
              style={{
                ...NUM,
                fontSize: 12,
                fontWeight: 600,
                color: sit.deepest.value > 0 ? W.ink : W.ink4,
              }}
            >
              {sit.deepest.value.toFixed(2)}
            </b>
            <span style={{ flex: '0 0 auto' }}>m</span>
            <span style={{ color: W.lineStrong, flex: '0 0 auto' }}>·</span>
            <span
              title={sit.deepest.siteName}
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                color: W.ink2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {sit.deepest.siteName}
            </span>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: W.ink4, lineHeight: '15px' }}>等待首帧数据</div>
      )}
    </div>
  )
}

/** 「红色 3」这种计数对。数字为 0 时压成灰色：0 红色不该和 3 红色一样抢眼。 */
function Tally({ label, v, tone }: { label: string; v: number; tone: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3, flex: '0 0 auto' }}>
      <span style={{ color: W.ink3, fontSize: 10.5 }}>{label}</span>
      <b style={{ ...NUM, fontSize: 12, fontWeight: 600, color: v > 0 ? tone : W.ink4 }}>{v}</b>
    </span>
  )
}

/** 一组同街道的站点。三个结论先算好放进组头，折叠之后它们仍然成立。 */
interface SiteGroup {
  readonly district: string
  readonly level: Level
  readonly deepest: number
  readonly rows: readonly SiteGlance[]
}

/**
 * 按街道分组。
 *
 * 为什么是街道而不是「片区」「站点类型」：街道是值班员真正会打电话过去的单位，
 * 也是降雨会同时落下来的单位——一条街的几个站往往一起涨，分组之后
 * 「这条街是不是整体在恶化」一眼就看得出，而不是靠在十条平铺的行里比对街道名。
 */
function groupByDistrict(rows: readonly SiteGlance[]): SiteGroup[] {
  const buckets = new Map<string, SiteGlance[]>()
  for (const g of rows) {
    const key = g.site.district || '未标注街道'
    const bucket = buckets.get(key)
    if (bucket) bucket.push(g)
    else buckets.set(key, [g])
  }

  const out: SiteGroup[] = []
  for (const [district, list] of buckets) {
    let level: Level = 'none'
    let deepest = 0
    for (const g of list) {
      if (LEVEL_RANK[g.assessment.level] > LEVEL_RANK[level]) level = g.assessment.level
      if (g.reading.depth > deepest) deepest = g.reading.depth
    }
    out.push({ district, level, deepest, rows: list })
  }

  // 组序：等级高的街道先出现（那里最可能要处置）→ 同级比组内最深水位 →
  // 再按名字稳定排序。稳定这一条不是洁癖：每 5 秒刷一次，组头如果来回换位，
  // 用户刚锁定的那一组会在他眼前跑掉。
  out.sort(
    (a, b) =>
      LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
      b.deepest - a.deepest ||
      a.district.localeCompare(b.district, 'zh-Hans-CN'),
  )
  return out
}

/**
 * 街道组头。
 *
 * 折叠后**仍然保留三个数字**（几站、最高等级色点、最深水深）——
 * 折起来是为了腾地方看别的街道，不是为了把这个街道变成盲区。
 * 这也是它为什么不用「折叠后只剩一个街道名」的常见做法。
 *
 * 右侧那个「最深 2.83 m」必须带「最深」两个字：单独一个数字会被读成
 * 「这条街的水位是 2.83」，而街道没有水位——它只有组内最深的那个站。
 */
function GroupHeader({
  g,
  open,
  onToggle,
}: {
  g: SiteGroup
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-rail-group={g.district}
      title={`${g.district}：${g.rows.length} 站，组内最深 ${g.deepest.toFixed(2)} m。点一下${open ? '收起' : '展开'}`}
      style={{
        // sticky：一屏十行带三四个组头，滚到第四行时组头还在，才知道这一行属于哪条街。
        position: 'sticky',
        top: 0,
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        width: '100%',
        height: 24,
        padding: '0 6px 0 2px',
        border: 0,
        borderBottom: `1px solid ${W.lineSoft}`,
        background: W.rail,
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: '0 0 10px',
          fontSize: 9,
          lineHeight: 1,
          color: W.ink4,
          textAlign: 'center',
        }}
      >
        {open ? '▾' : '▸'}
      </span>
      <span
        style={{
          flex: '0 1 auto',
          minWidth: 0,
          fontSize: 11,
          fontWeight: 600,
          color: W.ink2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {g.district}
      </span>
      <span style={{ flex: '0 0 auto', fontSize: 10, color: W.ink4 }}>{g.rows.length} 站</span>
      <span
        style={{
          marginLeft: 'auto',
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 3,
          flex: '0 0 auto',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: W.level[g.level],
            flex: '0 0 6px',
            transform: 'translateY(-1px)',
          }}
        />
        <span style={{ fontSize: 9.5, color: W.ink4, flex: '0 0 auto' }}>最深</span>
        <span
          style={{
            ...NUM,
            fontSize: 10.5,
            color: g.deepest > 0 ? W.ink : W.ink4,
          }}
        >
          {g.deepest.toFixed(2)}
        </span>
        <span style={{ fontSize: 9, color: W.ink4 }}>m</span>
      </span>
    </button>
  )
}

/**
 * 一条站点。
 *
 * 三行：站名 + 水深 / 等级 + 街道 + 涨速 + 雨 / 20 点走势 + 离红阈多远。
 * 之所以塞这么密：**值班员是靠扫这一列来找「哪个不对劲」的**，
 * 如果把水深藏在点开之后，他就必须逐个点开十个站才能比较——那不叫对比。
 *
 * **三行高度全部写死**（20 / 18 / 14 + 2px 进度条）。这不是为了整齐好看：
 * 水深那一行原来会随下面两行内容变化被挤动（同一组里「南城永丰河排水渠 0.25」
 * 就比邻居低一截，因为它右边写的是「距红 0.33」而不是「超红」）。
 * 数字列一旦不齐，整列数字就没法竖着比，而竖着比正是这个列表唯一的用法。
 * 所以标题行固定 20px、明细行固定 18px（没内容也占位，不塌缩）、
 * 走势行固定 14px，数字列 `alignSelf:'flex-start'` 钉在顶部。
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
  // 离红阈还有多远。负数即已超阈——这时写「超红」而不是「距红 -0.03」，
  // 因为值班员读的是一个判断，不是一个减法。
  const gap = g.redThreshold - g.reading.depth
  const over = gap < 0
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
        // 内边距收到 3/2：给「标题 20 + 明细 18」腾出高度，整行仍压在 65px 以内。
        padding: '3px 8px 2px 9px',
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
          top: 5,
          bottom: 5,
          width: 3,
          borderRadius: 2,
          background: W.level[lv],
        }}
      />

      {/* 第一行（20px，定高）：站名 + 水深 + 单位。
          三个子项都是 20px 行高、数字列 flex-start 顶对齐——下面两行写什么、
          写几行，都不会再把这一行推上去或压下来。 */}
      <span
        style={{
          display: 'flex',
          alignItems: 'baseline',
          height: 20,
          gap: 6,
          paddingLeft: 4,
        }}
      >
        <span
          style={{
            fontSize: 12,
            lineHeight: '20px',
            fontWeight: on ? 600 : 500,
            color: W.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: '1 1 auto',
            minWidth: 0,
          }}
        >
          {g.site.name}
        </span>
        <span
          style={{
            ...NUM,
            fontSize: 13,
            lineHeight: '20px',
            fontWeight: 600,
            alignSelf: 'flex-start',
            flex: '0 0 auto',
            color: g.reading.depth > 0 ? W.ink : W.ink4,
          }}
        >
          {g.reading.depth > 0 ? g.reading.depth.toFixed(2) : '0.00'}
        </span>
        <span
          style={{
            fontSize: 9.5,
            lineHeight: '20px',
            alignSelf: 'flex-start',
            flex: '0 0 auto',
            color: W.ink4,
          }}
        >
          m
        </span>
      </span>

      {/* 第二行（18px，定高）：等级 + 街道 + 1h 变化 + 当前雨强。
          街道放在这里而不是第一行，是因为它是「归属」不是「结论」；
          过长时由它自己先省略（flex 0 1 auto），保证涨速和雨量不被挤掉。 */}
      <span
        style={{
          display: 'flex',
          alignItems: 'baseline',
          height: 18,
          gap: 4,
          paddingLeft: 4,
          fontSize: 10,
          lineHeight: '18px',
          color: W.ink4,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ flex: '0 0 auto', color: g.isAlarm ? W.levelInk[lv] : W.ink3 }}>
          {g.isAlarm ? LEVEL_LABEL[lv] : '正常'}
        </span>
        <span style={{ color: W.lineStrong, flex: '0 0 auto' }}>·</span>
        <span
          style={{
            flex: '0 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {g.site.district || '未标注街道'}
        </span>
        {Math.abs(g.reading.trend1h) > 0.005 && (
          <>
            <span style={{ color: W.lineStrong, flex: '0 0 auto' }}>·</span>
            <span
              style={{
                ...NUM,
                flex: '0 0 auto',
                color: g.reading.trend1h > 0 ? W.levelInk.orange : W.ok,
              }}
            >
              {g.reading.trend1h > 0 ? '+' : '−'}
              {Math.abs(g.reading.trend1h).toFixed(2)}
            </span>
          </>
        )}
        {/* 雨强必须带数值。原来这里只有一个「雨」字：十站全在下雨时它就是常量，
            占着位置却不解释任何事。写成「雨 8.2」之后，它回答的是
            「这条为什么值得看」——雨大的站水位还在往上走。
            0.05 以下等于没在下，整段不渲染，省下的宽度留给街道名。 */}
        {g.reading.rain >= 1 && (
          <>
            <span style={{ color: W.lineStrong, flex: '0 0 auto' }}>·</span>
            <span
              title={`当前雨强 ${g.reading.rain.toFixed(1)} mm/h`}
              style={{
                ...NUM,
                flex: '0 0 auto',
                color: W.levelInk.blue,
                fontSize: 9.5,
              }}
            >
              雨 {g.reading.rain.toFixed(1)}
            </span>
          </>
        )}
      </span>

      {/* 第三行（14px，定高）：走势 + 离红阈。走势在左、距离在右——
          左边回答「在往哪走」，右边回答「还有多远」，两个问题必须能同一次扫读拿到。 */}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 4,
          height: 14,
        }}
      >
        <MiniTrend g={g} />
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            lineHeight: '14px',
            whiteSpace: 'nowrap',
            color: W.ink4,
          }}
        >
          {over && <span style={{ color: W.levelInk.red }}>▸ </span>}
          <span style={{ color: over ? W.levelInk.red : W.ink3 }}>{over ? '超红 ' : '距红 '}</span>
          <b
            style={{
              ...NUM,
              fontWeight: 600,
              color: over ? W.levelInk.red : W.ink2,
            }}
          >
            {(over ? Math.abs(gap) : gap).toFixed(2)}
          </b>
        </span>
      </span>

      {/* 第四行（2px）：水深 / 红阈进度条。和走势分工：
          走势说「在动」，这条说「动到红阈的几成、还差多少」。 */}
      <span style={{ display: 'block', paddingLeft: 4, marginTop: 1 }}>
        <DepthBar depth={g.reading.depth} redThreshold={g.redThreshold} level={lv} />
      </span>
    </button>
  )
}

/**
 * 水深 / 红阈进度条（2px）。
 *
 * 语义是**进度**，不是装饰下划线：填充长度 = `min(1, depth / redThreshold)`，
 * 也就是「离红阈还差多少」被画成了长度；右端那道 1.5px 竖刻度就是红阈线本身。
 * 原来的做法是整条铺满等级色、刻度恒在右端——那样不管差 3cm 还是差 3m，
 * 画出来都一模一样，等于没画。
 *
 * 超红时填充恒满、整条转红，刻度退到 `redThreshold / depth` 的位置（在填充内部，
 * 表示「红阈线已经被甩在后面多远」），右边再补一个 ▸：条子已经到顶，
 * 继续按比例拉长只会冲出容器，而像素溢出不是信息。
 */
function DepthBar({
  depth,
  redThreshold,
  level,
}: {
  depth: number
  redThreshold: number
  level: Level
}) {
  const scale = redThreshold > 0 ? redThreshold : 0
  const ratio = scale > 0 ? Math.max(0, depth) / scale : 0
  const over = ratio > 1
  const fill = Math.min(1, ratio)
  const color = over ? W.level.red : W.level[level]
  // 红阈刻度：没超时钉在 100%，超了以后往回退到红阈真正的位置。
  const tickLeft = over ? `${(1 / ratio) * 100}%` : undefined

  return (
    <span
      style={{
        position: 'relative',
        display: 'block',
        height: 2,
        borderRadius: 1,
        background: W.lineSoft,
      }}
      title={
        scale > 0
          ? `水深 ${depth.toFixed(2)} m，红阈 ${scale.toFixed(2)} m（${Math.round(ratio * 100)}%）`
          : `水深 ${depth.toFixed(2)} m，该站未设红阈`
      }
    >
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${fill * 100}%`,
          borderRadius: 1,
          background: color,
        }}
      />
      {scale > 0 && (
        <span
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            // 竖刻度本身也要看得见：超红时红刻度落在红填充上，只能反白。
            left: tickLeft,
            right: tickLeft ? undefined : 0,
            width: 1.5,
            background: over ? W.stage : W.level.red,
          }}
        />
      )}
      {over && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: -3,
            top: -1,
            width: 0,
            height: 0,
            borderTop: '2px solid transparent',
            borderBottom: '2px solid transparent',
            borderLeft: `3px solid ${W.level.red}`,
          }}
        />
      )}
    </span>
  )
}

/**
 * 行内 20 点迷你走势，52×14。
 *
 * 数据是 `reading.spark` 的绝对水位，减掉 `site.baseLevel` 换成水深、负值夹 0
 * （基准高程以下的读数不是积水，画进去会凭空多出一次「退水」）。
 *
 * 纵轴刻意用**本段采样**的 min/max，而不是 0~红阈：52×14 里如果按红阈铺满，
 * 一个只在 3cm 内波动的站会被压成一条直线，「看得出在动」这件事就没了。
 * 为了不让毫米级噪声被画成剧烈波动，量程下限设成 2cm。
 *
 * 颜色只表方向（涨/退/平），等级已经由左边色条和文字表达，同一个信息不重复染色。
 */
function MiniTrend({ g }: { g: SiteGlance }) {
  const base = g.site.baseLevel
  const pts = useMemo(
    () => g.reading.spark.map((v) => Math.max(0, v - base)),
    [g.reading.spark, base],
  )

  const W0 = 52
  const H0 = 14

  const usable = pts.length >= 2 && pts.every((v) => Number.isFinite(v))
  if (!usable) {
    // 没有足够采样时不画线：画一条凭空的横线比空着更糟，用户会以为「水位很稳」。
    return (
      <span
        title="这一站还没有足够的连续采样，暂时画不出走势"
        style={{
          display: 'block',
          flex: '0 0 52px',
          width: W0,
          height: H0,
          borderBottom: `1px solid ${W.lineSoft}`,
        }}
      />
    )
  }

  const lo = Math.min(...pts)
  const hi = Math.max(...pts)
  const span = Math.max(hi - lo, 0.02)
  const y = (v: number) => H0 - 1.5 - ((v - lo) / span) * (H0 - 3)
  const line = pts
    .map((v, i) => `${((i / (pts.length - 1)) * (W0 - 2) + 1).toFixed(2)},${y(v).toFixed(2)}`)
    .join(' ')
  const head = pts[pts.length - 1]
  const dir = head - pts[0]
  const stroke = dir > 0.005 ? W.warn : dir < -0.005 ? W.ok : W.ink3

  return (
    <svg
      width={W0}
      height={H0}
      viewBox={`0 0 ${W0} ${H0}`}
      role="img"
      aria-label="近 20 次采样的水深走势"
      style={{ display: 'block', flex: '0 0 52px' }}
    >
      <title>{`近 ${pts.length} 次采样水深 ${pts[0].toFixed(2)} → ${head.toFixed(2)} m`}</title>
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* 末端点 = 此刻。折线只有一条时读不出「现在在哪一头」。 */}
      <circle cx={W0 - 1} cy={y(head)} r={1.4} fill={stroke} />
    </svg>
  )
}

/** 预警等级芯片：色点 + 单字 + 计数，四个等宽铺满一行。 */
function LevelChip({
  level,
  count,
  on,
  onClick,
}: {
  level: Level
  count: number
  on: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-rail-level={level}
      aria-pressed={on}
      title={on ? `再点一次取消「${LEVEL_LABEL[level]}」过滤` : `只看${LEVEL_LABEL[level]}预警`}
      style={{
        flex: '1 1 0',
        minWidth: 0,
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        padding: '0 2px',
        borderRadius: 4,
        border: `1px solid ${on ? W.level[level] : W.line}`,
        background: on ? W.levelWash[level] : 'transparent',
        color: count > 0 ? W.levelInk[level] : W.ink4,
        opacity: count === 0 && !on ? 0.7 : 1,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 10.5,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: 3,
          flex: '0 0 5px',
          background: count > 0 ? W.level[level] : W.ink4,
        }}
      />
      <span style={{ flex: '0 0 auto' }}>{LEVEL_LABEL[level].charAt(0)}</span>
      <b style={{ ...NUM, fontWeight: 600 }}>{count}</b>
    </button>
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
  return <span style={{ ...NUM, fontSize: 10, color: W.ink4 }}>{children}</span>
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
  level: Level
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
        <span style={{ color: W.levelInk[level] ?? W.ink4 }}>{LEVEL_LABEL[level] ?? level}</span>
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
