import type { Palette } from './theme'
import type { Level } from '../domain'

/**
 * 「地图分区」屏的**辖区看板**。
 *
 * 取代原来的 `DistrictStats` 明细表。原来的问题不是数据不对，是形状不对：
 * 一列一列的数字表在 1920 大屏上要「读」，而值班场景要的是「扫」——
 * 哪个区最紧张、紧张在哪个站、三小时后还是不是紧张，这三件事应该各占一块
 * 大小一致、位置固定的区域，眼睛不用在一行里横着找。
 *
 * 布局按「五街道 × 四列」定：列宽用 fr 均分而不是固定 px，所以街道数是 4 个
 * 还是 6 个都能对齐；行高用 `1fr` 均分，多一个街道就矮一点，不会撑破卡片。
 */

const RANK: Record<string, number> = { none: 0, blue: 1, yellow: 2, orange: 3, red: 4 }
const LEVEL_NAME: Record<string, string> = { none: '正常', blue: '蓝色', yellow: '黄色', orange: '橙色', red: '红色' }

/** 一个站点的最小信息：辖区看板不关心它来自哪个接口。 */
export interface DistrictSiteRow {
  readonly siteId: string
  readonly name: string
  readonly district: string
  readonly level: Level
  readonly depth: number
  /** 1 小时水位变化量（m，正涨负退），不是速度 */
  readonly slope: number
  readonly rain: number
  /** 12h 内预测峰值水位（m，绝对值）；没有预测时为 null */
  readonly peakLevel: number | null
  /** 峰值出现在多少分钟后；没有预测时为 null */
  readonly peakAtMin: number | null
}

interface DistrictAgg {
  district: string
  n: number
  /** 最深积水 */
  maxDepth: number
  /** 平均 1h 变幅 */
  avgSlope: number
  /** 最紧张的那个站 */
  worst: DistrictSiteRow
  /** 超阈（蓝及以上）站数 */
  over: number
  /** 辖区内的最高等级 */
  topLevel: Level
  /** 辖区内最近的一场雨 */
  maxRain: number
  /** 辖区内最高的 12h 预测峰值，含站点名 */
  peak: { level: number; atMin: number; name: string } | null
}

function aggregate(rows: readonly DistrictSiteRow[]): DistrictAgg[] {
  const byDistrict = new Map<string, DistrictSiteRow[]>()
  for (const r of rows) {
    const list = byDistrict.get(r.district) ?? []
    list.push(r)
    byDistrict.set(r.district, list)
  }

  return Array.from(byDistrict.entries())
    .map(([district, list]) => {
      const worst = [...list].sort((a, b) => RANK[b.level] - RANK[a.level] || b.depth - a.depth)[0]
      // 积水深按最深取、变幅按均值 —— 一个涵洞淹了就是淹了，
      // 平均会被旁边没淹的站摊平，读起来像没事（这个口径写在领域注释里，别改）。
      const maxDepth = Math.max(...list.map((x) => x.depth))
      const avgSlope = list.reduce((a, b) => a + b.slope, 0) / list.length
      const over = list.filter((x) => RANK[x.level] > 0).length
      const maxRain = Math.max(...list.map((x) => x.rain))

      let peak: DistrictAgg['peak'] = null
      for (const x of list) {
        if (x.peakLevel == null) continue
        if (!peak || x.peakLevel > peak.level) {
          peak = { level: x.peakLevel, atMin: x.peakAtMin ?? 0, name: x.name }
        }
      }

      return { district, n: list.length, maxDepth, avgSlope, worst, over, topLevel: worst.level, maxRain, peak }
    })
    .sort((a, b) => RANK[b.topLevel] - RANK[a.topLevel] || b.maxDepth - a.maxDepth)
}

/** 把分钟翻成值班能用的说法：90 → 「1.5h 后」。 */
function whenLabel(atMin: number): string {
  if (atMin <= 0) return '此刻'
  if (atMin < 60) return `${atMin}min 后`
  const h = atMin / 60
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h 后`
}

/**
 * 辖区看板：一张「五街道 × 四列」的矩阵。
 *
 * 四列是四个不同的问题，不是四个字段：
 *   现状   —— 现在淹多深、什么等级
 *   预测   —— 12 小时内会不会更高、什么时候最高
 *   雨情   —— 还在不在下（不下的水会退，下的水还会涨）
 *   最紧张 —— 这个区该先看哪个站
 *
 * 等级色只用在「现状」列的左侧竖条上，其余数字用中性色。
 * 一屏里彩色太多等于没有颜色可用（这是大屏设计里最容易犯的错）。
 */
export function DistrictBoard({ rows, p }: { rows: readonly DistrictSiteRow[]; p: Palette }) {
  if (!rows.length) return <div style={{ fontSize: 11, color: p.textFaint }}>等待监测数据</div>

  const groups = aggregate(rows)
  const maxD = Math.max(...groups.map((g) => g.maxDepth), 0.1)

  const head: React.CSSProperties = {
    fontSize: 9,
    color: p.textFaint,
    letterSpacing: 0.5,
    paddingBottom: 4,
    borderBottom: `1px solid ${p.panelLine}`,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: '0 0 auto', display: 'grid', gridTemplateColumns: '1.05fr 1.15fr 1.25fr 0.85fr 1.3fr', gap: 10 }}>
        <span style={head}>辖区</span>
        <span style={head}>此刻积水</span>
        <span style={head}>12h 预测峰值</span>
        <span style={{ ...head, textAlign: 'right' }}>雨情</span>
        <span style={head}>最紧张</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {groups.map((g, i) => {
          const rising = g.avgSlope > 0.02
          const falling = g.avgSlope < -0.02
          return (
            <div
              key={g.district}
              style={{
                flex: '1 1 0',
                minHeight: 0,
                display: 'grid',
                gridTemplateColumns: '1.05fr 1.15fr 1.25fr 0.85fr 1.3fr',
                gap: 10,
                alignItems: 'center',
                borderTop: i === 0 ? 'none' : `1px solid ${p.panelLine}`,
              }}
            >
              {/* 辖区名 + 站数 + 等级色竖条：竖条是这一行唯一的彩色信息来源 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{ flex: '0 0 3px', alignSelf: 'stretch', margin: '3px 0', background: p.level[g.topLevel], borderRadius: 2, opacity: 0.9 }} />
                <span style={{ minWidth: 0 }}>
                  <b style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{g.district}</b>
                  <span style={{ fontSize: 9, color: p.textFaint }}>
                    {g.n} 站 · {LEVEL_NAME[g.topLevel]}预警
                  </span>
                </span>
              </div>

              {/* 此刻积水：数字 + 占比条，条长按全城最深的辖区归一 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                  <b style={{ fontSize: 15, color: p.levelInk[g.topLevel], fontVariantNumeric: 'tabular-nums' }}>{g.maxDepth.toFixed(2)}</b>
                  <span style={{ fontSize: 9, color: p.textFaint }}>m 最深</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9.5, color: g.over ? p.levelInk.red : p.textFaint, fontVariantNumeric: 'tabular-nums' }}>
                    {g.over}/{g.n} 超阈
                  </span>
                </div>
                <span style={{ height: 6, background: p.panelLine, borderRadius: 3, overflow: 'hidden', display: 'block' }}>
                  <span style={{ display: 'block', height: '100%', width: `${(g.maxDepth / maxD) * 100}%`, background: p.level[g.topLevel], opacity: 0.85, borderRadius: 3 }} />
                </span>
              </div>

              {/* 12h 预测峰值：这块是「往后看」的唯一入口，回答「还会不会更糟」 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                {g.peak ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                      <b style={{ fontSize: 12.5, color: p.forecast, fontVariantNumeric: 'tabular-nums' }}>{g.peak.level.toFixed(2)}</b>
                      <span style={{ fontSize: 9, color: p.textFaint }}>m · {whenLabel(g.peak.atMin)}</span>
                    </div>
                    <span style={{ fontSize: 9, color: p.textFaint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      峰值在 <b style={{ color: p.textDim }}>{g.peak.name}</b>
                      {g.peak.level > g.maxDepth + 0.03 ? <span style={{ color: p.levelInk.orange }}> · 还会涨</span> : <span> · 已过峰</span>}
                    </span>
                  </>
                ) : (
                  <span style={{ fontSize: 10, color: p.textFaint }}>无预测</span>
                )}
              </div>

              {/* 雨情：还在下就会继续涨，这个是判断「要不要现在派人」的前置 */}
              <div style={{ textAlign: 'right', minWidth: 0 }}>
                <b style={{ fontSize: 12.5, color: g.maxRain >= 1 ? p.rain : p.textFaint, fontVariantNumeric: 'tabular-nums' }}>{g.maxRain.toFixed(1)}</b>
                <span style={{ fontSize: 9, color: p.textFaint }}> mm/h</span>
                <span style={{ display: 'block', fontSize: 9, color: rising ? p.levelInk.orange : falling ? p.levelInk.blue : p.textFaint }}>
                  {rising ? '↑ 仍在涨' : falling ? '↓ 正在退' : '→ 平稳'} {g.avgSlope >= 0 ? '+' : ''}{g.avgSlope.toFixed(2)}m
                </span>
              </div>

              {/* 最紧张：一眼给人名与状态，不用回头去表里找 */}
              <div style={{ minWidth: 0 }}>
                <b style={{ fontSize: 11, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.worst.name}</b>
                <span style={{ fontSize: 9, color: p.textFaint }}>
                  积水 {g.worst.depth.toFixed(2)}m
                  {g.worst.peakAtMin != null && g.worst.peakLevel != null && g.worst.peakLevel > g.worst.depth + 0.03 ? ` · ${whenLabel(g.worst.peakAtMin)}达峰` : ' · 已过峰'}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ flex: '0 0 auto', display: 'flex', gap: 12, fontSize: 9, color: p.textFaint, paddingTop: 5, borderTop: `1px solid ${p.panelLine}` }}>
        <span>
          全城最紧张：<b style={{ color: p.levelInk[groups[0].topLevel] }}>{groups[0].district} · {groups[0].worst.name}</b>
        </span>
        <span style={{ marginLeft: 'auto' }}>{groups.length} 个辖区 · {rows.length} 个监测点 · 深取最深、变幅取均值</span>
      </div>
    </div>
  )
}
