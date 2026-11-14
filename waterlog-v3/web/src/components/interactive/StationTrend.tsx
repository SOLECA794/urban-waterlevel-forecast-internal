import { useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import {
  ALARM_LEVELS,
  fmtClock,
  thresholdOf,
  type Meters,
  type SimTime,
  type SiteForecast,
  type SiteSeries,
  type Thresholds,
} from '../../domain'
import { FONT, T } from '../../utils/tokens'

/**
 * 抽屉里的紧凑趋势图。
 *
 * 为什么不直接复用 `charts/TrendChart`：那个是详情页的 380px 大图，
 * 带图例、双轴名、全量刻度。抽屉只有 470px 宽、220px 高，
 * 照搬过来会挤成一团——所以这里只保留三件用户真正要看的：
 * **已经发生的水位 / 接下来要涨到哪 / 四条阈值线**。
 *
 * 与 TrendChart 共用三条同样的技术约束（不重复踩坑）：
 * 1. x 轴锚在 `issuedAt`，不是 `Date.now()`——仿真时钟 60x，用 now 会把预测整体移出画布。
 * 2. 阈值线画**绝对水位**（base + 深度），因为主轴是绝对水位。
 * 3. 置信带用 stack 累加语义：上界传 `upper - lower`。
 *
 * 额外做了两件 TrendChart 没做的事：
 * - 历史段结束处画一条竖线（"现在"），让「哪里是回看、哪里是预测」一眼分开；
 * - 曲线终点打一个圆点 + 数值，不看轴也能读到"最后一刻是多少"。
 */
export function StationTrend({
  series,
  forecast,
  baseLevel,
  thresholds,
  issuedAt,
  height = 208,
}: {
  series: SiteSeries
  forecast: SiteForecast | null
  baseLevel: Meters
  thresholds: Thresholds
  issuedAt: SimTime | null
  height?: number
}) {
  const option = useMemo(() => {
    const hist = series.points.map((p) => [p.at * 1000, +Number(p.level).toFixed(3)])
    const anchor = (issuedAt ?? series.points[series.points.length - 1]?.at ?? 0) * 1000
    const curve = forecast?.curve ?? []
    const fc = curve.map((c) => [anchor + c.offsetMin * 60_000, +c.level.toFixed(3)])
    const lo = curve.map((c) => [anchor + c.offsetMin * 60_000, +c.lower.toFixed(3)])
    // stack 的上界必须是差值，传绝对值会让带子长成第二条曲线
    const band = curve.map((c) => [anchor + c.offsetMin * 60_000, +Math.max(0, c.upper - c.lower).toFixed(3)])

    const t0 = hist[0]?.[0] ?? anchor
    const t1 = fc[fc.length - 1]?.[0] ?? anchor

    const thr = ALARM_LEVELS.map((lv) => {
      const abs = +(baseLevel + thresholdOf(thresholds, lv)).toFixed(3)
      return {
        type: 'line' as const,
        data: [[t0, abs], [t1, abs]],
        symbol: 'none',
        silent: true,
        lineStyle: {
          type: lv === 'red' ? ([5, 3] as number[]) : ([2, 3] as number[]),
          width: lv === 'red' ? 1.4 : 1,
          color: T.level[lv],
          opacity: 0.5,
        },
        z: 1,
      }
    })

    const lastReal = hist[hist.length - 1]

    return {
      animation: true,
      animationDuration: 420,
      animationEasing: 'cubicOut',
      textStyle: { fontFamily: FONT, fontSize: 10 },
      grid: { left: 42, right: 14, top: 14, bottom: 22 },
      legend: { show: false },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: T.borderStrong, width: 1 } },
        backgroundColor: 'rgba(255,255,255,0.98)',
        borderColor: T.border1,
        borderWidth: 1,
        padding: [6, 9],
        textStyle: { color: T.text1, fontSize: 11 },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? `${v.toFixed(3)} m` : '—'),
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: T.border1 } },
        axisTick: { show: false },
        axisLabel: {
          color: T.text3,
          fontSize: 9.5,
          hideOverlap: true,
          formatter: (v: number) => fmtClock((v / 1000) as SimTime),
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: T.text3, fontSize: 9.5, formatter: (v: number) => v.toFixed(2) },
        splitLine: { lineStyle: { color: T.border2, width: 1 } },
      },
      series: [
        { name: 'lo', type: 'line', data: lo, stack: 'b', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true, z: 2 },
        {
          name: '90% 区间',
          type: 'line',
          data: band,
          stack: 'b',
          symbol: 'none',
          lineStyle: { opacity: 0 },
          areaStyle: { color: 'rgba(109,40,217,0.13)' },
          silent: true,
          z: 2,
        },
        {
          name: '实测',
          type: 'line',
          data: hist,
          symbol: 'none',
          smooth: 0.18,
          lineStyle: { width: 2, color: T.obsLine },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(11,37,69,0.16)' },
                { offset: 1, color: 'rgba(11,37,69,0.01)' },
              ],
            },
          },
          z: 5,
        },
        {
          name: '预测',
          type: 'line',
          data: fc,
          symbol: 'none',
          smooth: 0.18,
          lineStyle: { width: 2, color: T.fcLine, type: 'dashed' },
          z: 5,
        },
        ...thr,
        {
          // 「现在」那条竖线：把回看与预测分开，否则读者分不清虚线从哪开始是真的
          type: 'line',
          data: [[anchor, 'min'], [anchor, 'max']],
          symbol: 'none',
          silent: true,
          lineStyle: { width: 1, color: T.borderStrong, type: 'solid', opacity: 0.9 },
          z: 3,
        },
        {
          // 实测末点：标一个实心点 + 数值，不看坐标轴也知道"现在多深"
          type: 'scatter',
          data: lastReal ? [lastReal] : [],
          symbolSize: 7,
          itemStyle: { color: T.obsLine, borderColor: '#fff', borderWidth: 2 },
          label: {
            show: true,
            position: 'left',
            offset: [-4, -10],
            formatter: (p: { value: [number, number] }) => `${p.value[1].toFixed(2)}`,
            color: T.text1,
            fontSize: 10,
            fontWeight: 700,
            backgroundColor: 'rgba(255,255,255,0.86)',
            padding: [1, 3],
            borderRadius: 3,
          },
          z: 8,
          silent: true,
        },
      ],
    }
  }, [series, forecast, baseLevel, thresholds, issuedAt])

  return (
    <ReactECharts
      option={option}
      style={{ height, width: '100%' }}
      opts={{ renderer: 'canvas' }}
      notMerge
      lazyUpdate
    />
  )
}
