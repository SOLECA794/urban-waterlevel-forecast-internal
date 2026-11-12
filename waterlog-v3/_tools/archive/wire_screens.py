# -*- coding: utf-8 -*-
"""把「辖区预测」与「全域研判」两屏的数据派生逻辑插进 BoardPage.tsx。

为什么用脚本而不是 edit：这一段有 150 多行、含大量反引号与 ${}，
经过 bash heredoc 会被 shell 抢先解释（上一次就栽在这里）。
写成独立文件再跑，python 只负责读改写。
"""
import io

P = 'web/src/board/BoardPage.tsx'
s = io.open(P, encoding='utf-8').read()

anchor = "  const series = detail.data?.series ?? null\n"
assert s.count(anchor) == 1, s.count(anchor)

BLOCK = r'''  // ---------------------------------------------------------------- 辖区预测格
  /**
   * 「辖区预测」屏的六格：五个街道各一格 + 一格「全域合计」。
   *
   * 六格共用一条纵轴（由 sharedDomain 负责），否则「东城看着比西城高」
   * 可能只是两格的刻度不同——那是彻底的误读。
   *
   * 曲线点取自 `forecast.sites[id].curve`，是引擎发布的完整 5 分钟粒度曲线，
   * 不是四个预见期插值出来的：插值会抹平拐点，而「最先穿红」恰好发生在拐点上。
   */
  const zoneCells = useMemo<ZoneCell[]>(() => {
    const fc = forecast.data
    if (!fc) return []

    const byDistrict = new Map<string, OverviewRow[]>()
    for (const r of list) {
      const key = r.site.district || '未分区'
      const arr = byDistrict.get(key) ?? []
      arr.push(r)
      byDistrict.set(key, arr)
    }

    const build = (district: string, members: readonly OverviewRow[]): ZoneCell => {
      const zseries: ZoneSeries[] = []
      let peak: ZoneCell['peak'] = null
      let crossRed: number | null = null
      let topLevel: Level = 'none'
      let maxDepth = 0
      const thr0 = members[0]?.site.thresholds
      const thr = {
        blue: Number(thr0?.blue ?? 0.15),
        yellow: Number(thr0?.yellow ?? 0.25),
        orange: Number(thr0?.orange ?? 0.35),
        red: Number(thr0?.red ?? 0.45),
      }

      for (const m of members) {
        const sf = fc.sites[m.site.id]
        const base = Number(m.site.baseLevel)
        const pts = sf ? sf.curve.map((c) => ({ offsetMin: c.offsetMin, level: Number(c.level) - base })) : []
        if (pts.length >= 2) {
          zseries.push({
            siteId: m.site.id,
            name: m.site.name,
            district,
            level: m.assessment.level,
            now: Number(m.reading.depth),
            points: pts,
          })
          for (const pt of pts) {
            if (!peak || pt.level > peak.level) peak = { level: pt.level, atMin: pt.offsetMin, name: m.site.name }
          }
          // 「穿红」用该站自己的红阈：拿辖区最紧张那个站的红阈去衡量别的站是错的，
          // 各站基准高程不同，阈值的绝对水位也不同。
          const red = Number(m.site.thresholds.red) - base
          const hit = pts.find((pt) => pt.level >= red)
          if (hit && (crossRed == null || hit.offsetMin < crossRed)) crossRed = hit.offsetMin
        }
        if (LEVEL_RANK[m.assessment.level] > LEVEL_RANK[topLevel]) topLevel = m.assessment.level
        maxDepth = Math.max(maxDepth, Number(m.reading.depth))
      }

      return { district, series: zseries, topLevel, maxDepth, peak, crossRedAtMin: crossRed, thresholds: thr }
    }

    const cells = Array.from(byDistrict.entries())
      .map(([d, ms]) => build(d, ms))
      .filter((c) => c.series.length > 0)
      .sort((a, b) => LEVEL_RANK[b.topLevel] - LEVEL_RANK[a.topLevel] || b.maxDepth - a.maxDepth)

    // 最后一格：全域合计。把十站的「水位减基准」加起来，得到全城累计积水深。
    // 它回答的是「这波是面上的雨还是点上的雨」——十站各自一格时看不出来。
    if (cells.length > 0 && cells.length < 6) {
      const sumPts = new Map<number, number>()
      for (const r of list) {
        const sf = fc.sites[r.site.id]
        if (!sf) continue
        const base = Number(r.site.baseLevel)
        for (const c of sf.curve) sumPts.set(c.offsetMin, (sumPts.get(c.offsetMin) ?? 0) + (Number(c.level) - base))
      }
      const pts = Array.from(sumPts.entries()).sort((a, b) => a[0] - b[0]).map(([offsetMin, level]) => ({ offsetMin, level }))
      if (pts.length >= 2) {
        let pk: ZoneCell['peak'] = null
        for (const pt of pts) if (!pk || pt.level > pk.level) pk = { level: pt.level, atMin: pt.offsetMin, name: '全域合计' }
        const sumNow = list.reduce((a, r) => a + Number(r.reading.depth), 0)
        cells.push({
          district: '全域合计',
          series: [{ siteId: '_all', name: '全域合计', district: '全域合计', level: worst, now: sumNow, points: pts }],
          topLevel: worst,
          maxDepth: sumNow,
          peak: pk,
          crossRedAtMin: null,
          // 合计值没有单一阈值：把它当成「十站阈值之和」没有业务含义，
          // 所以这里给一组不可能被触发的值，图上的阈值带自然消失。
          thresholds: { blue: 99, yellow: 99, orange: 99, red: 99 },
        })
      }
    }
    return cells.slice(0, 6)
  }, [forecast.data, list, worst])

  const zoneDomain = useMemo(() => sharedDomain(zoneCells), [zoneCells])

  // ---------------------------------------------------------------- 全域研判
  /** 风险格局：横轴 1h 变幅、纵轴当前积水深。 */
  const riskPoints = useMemo<RiskPoint[]>(
    () =>
      list.map((r) => ({
        siteId: r.site.id,
        name: r.site.name,
        level: r.assessment.level,
        depth: Number(r.reading.depth),
        slope: Number(r.reading.trend1h),
      })),
    [list],
  )
  /** 象限线画在「蓝色阈值」上：业务上「算不算有事」的那条线，不是中位数。 */
  const riskBlue = useMemo(() => {
    const bs = list.map((r) => Number(r.site.thresholds.blue) - Number(r.site.baseLevel))
    return bs.length ? bs.reduce((a, b) => a + b, 0) / bs.length : 0.15
  }, [list])

  /**
   * 热力图：横轴 12 个小时桶、纵轴十个站，格色＝该桶的等级。
   *
   * 右边一半（未来）由预测曲线逐桶折算，左边一半（过去）沿用当前等级 ——
   * 因为逐站的历史序列要每站一个请求，十站十请求在轮播屏上不划算。
   * 左半段平坦是**已知的简化**，所以页脚写清「未来段随预测走」，
   * 不让读者以为过去六小时真的没变化。
   */
  const heatRows = useMemo<HeatRow[]>(
    () =>
      list.map((r) => {
        const sf = forecast.data?.sites[r.site.id]
        const base = Number(r.site.baseLevel)
        const t = r.site.thresholds
        const ths = [Number(t.blue) - base, Number(t.yellow) - base, Number(t.orange) - base, Number(t.red) - base]
        const levels: Level[] = []
        for (let i = 0; i < HEAT_COLS; i++) {
          const offset = (i - (HEAT_COLS - 1) + 1) * 60
          const pt = sf ? sf.curve.find((c) => c.offsetMin >= offset) : undefined
          if (offset <= 0 || !pt) {
            levels.push(r.assessment.level)
          } else {
            const d = Number(pt.level) - base
            levels.push(d >= ths[3] ? 'red' : d >= ths[2] ? 'orange' : d >= ths[1] ? 'yellow' : d >= ths[0] ? 'blue' : 'none')
          }
        }
        return { siteId: r.site.id, name: r.site.name, district: r.site.district || '未分区', levels }
      }),
    [list, forecast.data],
  )

  /** 全域趋势：合计积水深 + 预警站数，取过去 24 个整点。 */
  const trendHistory = useMemo<TrendPoint[]>(() => {
    const fc = forecast.data
    if (!fc) return []
    const sums = new Map<number, number>()
    for (const r of list) {
      const sf = fc.sites[r.site.id]
      if (!sf) continue
      const base = Number(r.site.baseLevel)
      for (const c of sf.curve) {
        if (c.offsetMin > 0) continue
        sums.set(c.offsetMin, (sums.get(c.offsetMin) ?? 0) + (Number(c.level) - base))
      }
    }
    const alarm = list.filter((r) => isAlarm(r.assessment.level)).length
    return Array.from(sums.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(-24)
      .map(([offsetMin, sumDepth]) => ({ offsetMin, sumDepth, alarmCount: alarm }))
  }, [forecast.data, list])
  const trendOutlook = useMemo(() => projectTrend(trendHistory, 6), [trendHistory])

  /** 可信度：12h 那条预见期的 90% 区间半宽。 */
  const confidenceRows = useMemo<ConfidenceRow[]>(() => {
    const fc = forecast.data
    if (!fc) return []
    const out: ConfidenceRow[] = []
    for (const r of list) {
      const sf = fc.sites[r.site.id]
      if (!sf || !sf.horizons.length) continue
      const h = sf.horizons.find((x) => x.horizonMin === 720) ?? sf.horizons[sf.horizons.length - 1]
      out.push({
        siteId: r.site.id,
        name: r.site.name,
        district: r.site.district || '未分区',
        level: r.assessment.level,
        halfWidth: (Number(h.upper) - Number(h.lower)) / 2,
        fcLevel: Number(h.level),
      })
    }
    return out.sort((a, b) => b.halfWidth - a.halfWidth)
  }, [forecast.data, list])

  /** 多区对比：每区最深、12h 峰值、超阈占比。 */
  const districtCompare = useMemo<DistrictCompareRow[]>(() => {
    const fc = forecast.data
    const by = new Map<string, OverviewRow[]>()
    for (const r of list) {
      const k = r.site.district || '未分区'
      const arr = by.get(k) ?? []
      arr.push(r)
      by.set(k, arr)
    }
    const out: DistrictCompareRow[] = []
    for (const [district, ms] of by.entries()) {
      let topLevel: Level = 'none'
      let maxDepth = 0
      let alarmCount = 0
      let rain = 0
      let peak: number | null = null
      for (const m of ms) {
        if (LEVEL_RANK[m.assessment.level] > LEVEL_RANK[topLevel]) topLevel = m.assessment.level
        maxDepth = Math.max(maxDepth, Number(m.reading.depth))
        if (isAlarm(m.assessment.level)) alarmCount++
        rain = Math.max(rain, Number(m.reading.rain))
        const sf = fc?.sites[m.site.id]
        if (sf) {
          const base = Number(m.site.baseLevel)
          for (const c of sf.curve) {
            const d = Number(c.level) - base
            peak = peak == null ? d : Math.max(peak, d)
          }
        }
      }
      out.push({ district, topLevel, maxDepth, alarmCount, siteCount: ms.length, peak, rain })
    }
    return out.sort((a, b) => LEVEL_RANK[b.topLevel] - LEVEL_RANK[a.topLevel] || b.maxDepth - a.maxDepth)
  }, [list, forecast.data])

'''

s = s.replace(anchor, BLOCK + anchor, 1)

# HEAT_COLS 常量
old_const = "const STATION_MS = "
i = s.find(old_const)
assert i > 0, 'STATION_MS not found'
line_end = s.find('\n', i)
const_line = "\n/** 热力图的列数：过去 6 小时 + 未来 6 小时，每小时一格。 */\nconst HEAT_COLS = 12\n"
s = s[:line_end + 1] + const_line + s[line_end + 1:]

io.open(P, 'w', encoding='utf-8').write(s)
print('OK, length', len(s))
