import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createDemoSnapshot } from './data'
import type { Snapshot, Station, Level } from './types'
import { LEVEL_COLORS, LEVEL_NAMES } from './types'
import { StationMap } from './StationMap'
import { TrendChart, FleetChart, RainChart, AccuracyChart, Sparkline } from './Charts'
import { pageFromSearch, nextPage, rotationDelay } from './presentation'
import { HOUR, LEVELS, dayText, timeText, levelOf, horizon, peak, statusCounts, fmtDepth, fmtRain } from './view'

type Page = 0 | 1

function useDisplayClock() {
  const [step, setStep] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setStep(s => s + 1), 2200)
    return () => window.clearInterval(timer)
  }, [])
  return step
}

function Flash({ children, token }: { children: ReactNode; token: string | number }) {
  return <span key={token} className="flash">{children}</span>
}

function Panel({ title, subtitle, extra, children, className = '', accent = 'blue' }: {
  title: string; subtitle?: string; extra?: ReactNode; children: ReactNode; className?: string; accent?: string
}) {
  return <section className={`panel ${className}`}>
    <header className="panel-head">
      <span className={`panel-bar bar-${accent}`} />
      <div className="panel-titles"><h3>{title}</h3>{subtitle && <small>{subtitle}</small>}</div>
      {extra && <div className="panel-extra">{extra}</div>}
    </header>
    <div className="panel-body">{children}</div>
  </section>
}

function LevelChip({ level }: { level: Level }) {
  return <span className="level-chip" style={{ borderColor: LEVEL_COLORS[level], color: LEVEL_COLORS[level] }}>{LEVEL_NAMES[level]}</span>
}

function Donut({ counts, total }: { counts: Record<Level, number>; total: number }) {
  let acc = 0
  const stops = LEVELS.map(level => {
    const value = counts[level]
    const from = acc / Math.max(1, total) * 100
    acc += value
    const to = acc / Math.max(1, total) * 100
    return `${LEVEL_COLORS[level]} ${from}% ${to}%`
  })
  return <div className="donut-wrap">
    <div className="donut" style={{ background: `conic-gradient(${stops.join(',')})` }}>
      <div className="donut-hole"><b>{counts.red}</b><small>红色预警</small></div>
    </div>
    <ul className="donut-legend">
      {LEVELS.map(level => <li key={level}><i style={{ background: LEVEL_COLORS[level] }} />{LEVEL_NAMES[level]}<b>{counts[level]}</b></li>)}
    </ul>
  </div>
}

function CalendarCard({ now }: { now: number }) {
  const base = new Date(now)
  const year = base.getFullYear(), month = base.getMonth()
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const today = base.getUTCDate()
  const cells: (number | null)[] = [...Array.from({ length: (first + 6) % 7 }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)]
  while (cells.length % 7) cells.push(null)
  const hasAlert = (d: number) => ((d * 7 + month * 3) % 11) < 3
  return <Panel title="预警日历" subtitle={`${year}年${month + 1}月 · 按模拟时钟`} accent="teal">
    <div className="calendar">
      {['一', '二', '三', '四', '五', '六', '日'].map(d => <span key={d} className="cal-head">{d}</span>)}
      {cells.map((d, i) => d === null ? <span key={`e${i}`} className="cal-cell empty" /> :
        <span key={d} className={`cal-cell ${d === today ? 'today' : ''} ${hasAlert(d) ? 'alert' : ''}`}>{d}{hasAlert(d) && <i />}</span>)}
    </div>
    <p className="cal-note">本月预警 <b>{cells.filter(d => d !== null && hasAlert(d)).length}</b> 天 · 今日为模拟时间</p>
  </Panel>
}

function OperationCard({ snap, counts }: { snap: Snapshot; counts: Record<Level, number> }) {
  const maxDepth = Math.max(...snap.stations.map(s => s.actual))
  const maxRain = Math.max(...snap.stations.map(s => s.rain))
  const deepest = snap.stations.find(s => s.actual === maxDepth)!
  return <Panel title="运行概况" subtitle="10 个监测点 · 实时汇聚" accent="blue">
    <div className="op-grid">
      <div><small>监测点位</small><b><Flash token={snap.stations.length}>{snap.stations.length}</Flash></b><em>处</em></div>
      <div><small>预警点位</small><b className="danger"><Flash token={counts.red}>{counts.red}</Flash></b><em>处</em></div>
      <div><small>最大水深</small><b><Flash token={maxDepth.toFixed(2)}>{maxDepth.toFixed(2)}</Flash></b><em>m</em></div>
      <div><small>最大雨强</small><b><Flash token={maxRain.toFixed(0)}>{maxRain.toFixed(0)}</Flash></b><em>mm/h</em></div>
    </div>
    <div className="deepest">最深点位 <b>{deepest.name}</b> <span>{fmtDepth(deepest.actual)} m</span></div>
    <Donut counts={counts} total={snap.stations.length} />
  </Panel>
}

function StationList({ stations, selectedId, onSelect }: { stations: Station[]; selectedId: string; onSelect: (id: string) => void }) {
  return <Panel title="监测点列表" subtitle="点击查看该点全部统计" accent="teal" className="panel-grow">
    <ul className="station-list">
      {stations.map(s => {
        const lv = levelOf(s.actual, s.thresholds)
        return <li key={s.id} className={s.id === selectedId ? 'active' : ''} onClick={() => onSelect(s.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && onSelect(s.id)}>
          <i className="dot" style={{ background: LEVEL_COLORS[lv] }} />
          <div className="station-name"><b>{s.name}</b><small>{fmtDepth(s.actual)} m · {fmtRain(s.rain)} mm/h</small></div>
          <div className="station-spark"><Sparkline values={s.history.slice(-24).map(p => p.depth)} color={LEVEL_COLORS[lv]} /></div>
          <LevelChip level={lv} />
        </li>
      })}
    </ul>
  </Panel>
}

function AlertsCard({ snap, onSelect }: { snap: Snapshot; onSelect: (id: string) => void }) {
  const alerts = [...snap.stations].filter(s => levelOf(s.actual, s.thresholds) !== 'none').sort((a, b) => b.actual - a.actual).slice(0, 6)
  return <Panel title="预警列表" subtitle={`当前 ${alerts.length} 条 · 点击定位`} extra={<span className="linkish">全部 →</span>} accent="orange">
    {alerts.length === 0 && <p className="empty-hint">当前无预警，全部监测点水位正常。</p>}
    <ul className="alert-list">
      {alerts.map(s => {
        const lv = levelOf(s.actual, s.thresholds)
        const p = peak(s)
        return <li key={s.id} onClick={() => onSelect(s.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && onSelect(s.id)}>
          <span className="alert-badge" style={{ background: LEVEL_COLORS[lv] }}>{LEVEL_NAMES[lv]}</span>
          <div className="alert-main"><b>{s.name}</b><small>水深 <b>{fmtDepth(s.actual)}</b> m · 雨强 {fmtRain(s.rain)} mm/h · 预计峰值 {fmtDepth(p.depth)} m</small></div>
        </li>
      })}
    </ul>
  </Panel>
}

function RankingCard({ stations, selectedId, onSelect }: { stations: Station[]; selectedId: string; onSelect: (id: string) => void }) {
  const ranked = [...stations].sort((a, b) => peak(b).depth - peak(a).depth).slice(0, 6)
  const max = Math.max(...ranked.map(s => peak(s).depth), 0.01)
  return <Panel title="未来峰值排行" subtitle="12 小时预报峰值 · 点击联动" accent="blue">
    <ul className="rank-list">
      {ranked.map((s, i) => {
        const p = peak(s)
        return <li key={s.id} className={s.id === selectedId ? 'active' : ''} onClick={() => onSelect(s.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && onSelect(s.id)}>
          <span className="rank-no">{String(i + 1).padStart(2, '0')}</span>
          <span className="rank-name">{s.name}</span>
          <span className="rank-bar"><i style={{ width: `${p.depth / max * 100}%` }} /></span>
          <b>{fmtDepth(p.depth)}</b>
        </li>
      })}
    </ul>
  </Panel>
}

function SiteDetail({ station, now, onClose }: { station: Station; now: number; onClose: () => void }) {
  const lv = levelOf(station.actual, station.thresholds)
  const p = peak(station)
  const h1 = horizon(station, 1)
  return <div className="site-detail">
    <div className="site-detail-head">
      <div><small>当前选中监测点</small><h4>{station.name}</h4></div>
      <button className="icon-btn" onClick={onClose} aria-label="关闭详情">×</button>
    </div>
    <div className="site-metrics">
      <div><small>当前水深</small><b style={{ color: LEVEL_COLORS[lv] }}><Flash token={station.actual.toFixed(2)}>{fmtDepth(station.actual)}</Flash></b><em>m</em></div>
      <div><small>1 小时后</small><b>{h1 ? fmtDepth(h1.depth) : '—'}</b><em>m</em></div>
      <div><small>12h 峰值</small><b>{fmtDepth(p.depth)}</b><em>m</em></div>
      <div><small>雨强</small><b>{fmtRain(station.rain)}</b><em>mm/h</em></div>
    </div>
    <div className="site-chart"><TrendChart station={station} now={now} compact /></div>
    <div className="site-foot"><LevelChip level={lv} /><span>红阈 {station.thresholds.red.toFixed(2)} m · 峰值 {timeText(p.at)}</span></div>
  </div>
}

function OverviewPage({ snap, selected, onSelect, showDetail, setShowDetail }: {
  snap: Snapshot; selected: Station; onSelect: (id: string) => void; showDetail: boolean; setShowDetail: (v: boolean) => void
}) {
  const counts = statusCounts(snap.stations)
  return <div className="page overview-page">
    <aside className="side left-side">
      <CalendarCard now={snap.now} />
      <OperationCard snap={snap} counts={counts} />
      <StationList stations={snap.stations} selectedId={selected.id} onSelect={id => { onSelect(id); setShowDetail(true) }} />
    </aside>
    <main className="map-stage">
      <StationMap stations={snap.stations} selectedId={selected.id} onSelect={id => { onSelect(id); setShowDetail(true) }} />
      <div className="map-legend">
        {LEVELS.map(level => <span key={level}><i style={{ background: LEVEL_COLORS[level] }} />{LEVEL_NAMES[level]}</span>)}
      </div>
      <div className="map-caption">台州市黄岩区 · 监测点分布（点击圆点查看统计）</div>
      {showDetail && <SiteDetail station={selected} now={snap.now} onClose={() => setShowDetail(false)} />}
    </main>
    <aside className="side right-side">
      <AlertsCard snap={snap} onSelect={id => { onSelect(id); setShowDetail(true) }} />
      <RankingCard stations={snap.stations} selectedId={selected.id} onSelect={id => { onSelect(id); setShowDetail(true) }} />
      <Panel title="站点轮换" subtitle="自动轮播监测点数据" accent="teal" className="rotate-card">
        <p className="rotate-note">选中项将同步到地图、统计图表与预测专屏</p>
      </Panel>
    </aside>
  </div>
}

function HorizonCard({ station, hours, label }: { station: Station; hours: number; label: string }) {
  const h = horizon(station, hours)
  const lv = h ? levelOf(h.depth, station.thresholds) : 'none'
  return <div className="horizon-card">
    <small>{label}</small>
    <b style={{ color: LEVEL_COLORS[lv] }}>{h ? fmtDepth(h.depth) : '—'}<em>m</em></b>
    <div className="horizon-band"><i style={{ left: `${Math.max(0, Math.min(100, (h ? h.lower : 0) / 1.2 * 100))}%`, width: `${h ? (h.upper - h.lower) / 1.2 * 100 : 0}%` }} /></div>
    <span>置信 {h ? `${fmtDepth(h.lower)}~${fmtDepth(h.upper)}` : '—'}</span>
  </div>
}

function PredictionPage({ snap, selected, onSelect }: { snap: Snapshot; selected: Station; onSelect: (id: string) => void }) {
  const ranked = [...snap.stations].sort((a, b) => peak(b).depth - peak(a).depth)
  const lv = levelOf(selected.actual, selected.thresholds)
  return <div className="page prediction-page">
    <div className="station-strip">
      <span className="strip-label">监测点</span>
      <div className="strip-items">
        {snap.stations.map(s => {
          const sl = levelOf(s.actual, s.thresholds)
          return <button key={s.id} className={s.id === selected.id ? 'active' : ''} onClick={() => onSelect(s.id)}>
            <i style={{ background: LEVEL_COLORS[sl] }} />{s.name.replace(/·.*/, '')}<small>{fmtDepth(s.actual)}</small>
          </button>
        })}
      </div>
    </div>
    <div className="pred-grid">
      <Panel title={`${selected.name} · 观测与 12 小时预测`} subtitle={`红阈 ${selected.thresholds.red.toFixed(2)} m · 当前 ${LEVEL_NAMES[lv]}`} accent="blue" className="pred-main">
        <div className="trend-big"><TrendChart station={selected} now={snap.now} /></div>
        <div className="horizon-row">
          <HorizonCard station={selected} hours={1} label="+1 小时" />
          <HorizonCard station={selected} hours={3} label="+3 小时" />
          <HorizonCard station={selected} hours={6} label="+6 小时" />
          <HorizonCard station={selected} hours={12} label="+12 小时" />
        </div>
      </Panel>
      <div className="pred-side">
        <Panel title="全网站点 12 小时预测" subtitle="同尺度对比 · 线色=预警等级" accent="teal" className="pred-fleet">
          <div className="chart-box"><FleetChart stations={snap.stations} now={snap.now} /></div>
        </Panel>
        <Panel title="预测与实测对照" subtitle="提前 1 小时 · 误差可查" accent="orange" className="pred-acc">
          <div className="chart-box"><AccuracyChart points={snap.evaluation} /></div>
        </Panel>
        <Panel title="近 6 小时降雨" subtitle="站点平均雨强" accent="blue" className="pred-rain">
          <div className="chart-box"><RainChart stations={snap.stations} now={snap.now} /></div>
        </Panel>
      </div>
    </div>
    <Panel title="12 小时峰值预测表" subtitle="全站点排序 · 点击切换主图" accent="teal" className="pred-table">
      <div className="pred-table-scroll"><table>
        <thead><tr><th>序号</th><th>监测点</th><th>当前水深</th><th>+1h</th><th>+3h</th><th>+6h</th><th>+12h</th><th>预测峰值</th><th>状态</th></tr></thead>
        <tbody>
          {ranked.map((s, i) => {
            const sl = levelOf(s.actual, s.thresholds)
            const h1 = horizon(s, 1), h3 = horizon(s, 3), h6 = horizon(s, 6), h12 = horizon(s, 12)
            return <tr key={s.id} className={s.id === selected.id ? 'active' : ''} onClick={() => onSelect(s.id)}>
              <td>{String(i + 1).padStart(2, '0')}</td>
              <td className="name">{s.name}</td>
              <td>{fmtDepth(s.actual)}</td>
              <td>{h1 ? fmtDepth(h1.depth) : '—'}</td>
              <td>{h3 ? fmtDepth(h3.depth) : '—'}</td>
              <td>{h6 ? fmtDepth(h6.depth) : '—'}</td>
              <td>{h12 ? fmtDepth(h12.depth) : '—'}</td>
              <td><b>{fmtDepth(peak(s).depth)}</b></td>
              <td><LevelChip level={sl} /></td>
            </tr>
          })}
        </tbody>
      </table></div>
    </Panel>
  </div>
}

export default function App() {
  const step = useDisplayClock()
  const snap = useMemo(() => createDemoSnapshot(step), [step])
  const [page, setPage] = useState<Page>(() => pageFromSearch(window.location.search))
  const [selectedId, setSelectedId] = useState(snap.stations[0].id)
  const [showDetail, setShowDetail] = useState(false)
  const [paused, setPaused] = useState(() => new URLSearchParams(window.location.search).get('paused') === '1')
  const lastAuto = useRef(0)

  useEffect(() => {
    const onPop = () => setPage(pageFromSearch(window.location.search))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (paused) return
    lastAuto.current = Date.now()   // 进入每页时重置计时，避免首帧立即切页
    const timer = window.setInterval(() => {
      const now = Date.now()
      if (now - lastAuto.current < rotationDelay(window.location.search)) return
      lastAuto.current = now
      setPage(p => {
        const next = nextPage(p)
        window.history.replaceState(null, '', `?page=${next === 0 ? 1 : 2}`)
        return next
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [paused])

  useEffect(() => {
    if (paused) return
    const timer = window.setInterval(() => {
      setSelectedId(id => {
        const i = snap.stations.findIndex(s => s.id === id)
        return snap.stations[(i + 1) % snap.stations.length].id
      })
    }, 11000)
    return () => window.clearInterval(timer)
  }, [paused, snap.stations])

  const selected = snap.stations.find(s => s.id === selectedId) ?? snap.stations[0]
  const counts = statusCounts(snap.stations)
  const go = (p: Page) => {
    setPage(p)
    window.history.replaceState(null, '', `?page=${p === 0 ? 1 : 2}`)
  }

  return <div className={`app page-${page}`}>
    <div className="bg-sky"><div className="globe"><div className="globe-grid" /></div><div className="horizon-line" /></div>
    <header className="topbar">
      <div className="brand"><div className="brand-mark">水</div><div><h1>台州市黄岩区 · 城市内涝监测中心</h1><p>水位监测与预测 · 全域态势超集屏</p></div></div>
      <div className="top-status">
        <span className="status-pill"><i /> 数据更新中</span>
        <span className="status-pill warn">红色预警 <b>{counts.red}</b></span>
        <span className="status-pill">最深 <b>{fmtDepth(Math.max(...snap.stations.map(s => s.actual)))}</b> m</span>
      </div>
      <div className="top-right">
        <div className="clock"><b>{timeText(snap.now)}</b><small>{dayText(snap.now)} · 模拟时钟</small></div>
        <div className="tabs">
          <button className={page === 0 ? 'active' : ''} onClick={() => go(0)}>全域态势</button>
          <button className={page === 1 ? 'active' : ''} onClick={() => go(1)}>预测专屏</button>
        </div>
        <button className={`pause-btn ${paused ? 'on' : ''}`} onClick={() => setPaused(v => !v)}>{paused ? '▶ 继续' : '❚❚ 暂停'}</button>
      </div>
      <div className="rotation-progress"><i key={`${page}-${step}`} /></div>
    </header>
    <div className="content">
      {page === 0 ? <OverviewPage snap={snap} selected={selected} onSelect={setSelectedId} showDetail={showDetail} setShowDetail={setShowDetail} />
        : <PredictionPage snap={snap} selected={selected} onSelect={setSelectedId} />}
    </div>
    <footer className="ticker">
      <span className="ticker-label">实时播报</span>
      <div className="ticker-body">
        <span>模拟时刻 {dayText(snap.now)} {timeText(snap.now)}</span>
        <span>红色预警 {counts.red} 处 · 橙色 {counts.orange} 处</span>
        <span>当前关注 {selected.name} · 水深 {fmtDepth(selected.actual)} m</span>
        <span>12h 预测峰值 {fmtDepth(peak(selected).depth)} m（{timeText(peak(selected).at)}）</span>
        <span>数据来源：本地模拟演示 · 非真实观测</span>
      </div>
      <span className="ticker-page">{page === 0 ? '1 / 2' : '2 / 2'}</span>
    </footer>
  </div>
}
