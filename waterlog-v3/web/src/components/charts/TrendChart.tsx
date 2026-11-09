import { useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import {
  ALARM_LEVELS,
  fmtClock,
  LEVEL_LABEL,
  thresholdOf,
  type Meters,
  type SimTime,
  type SiteForecast,
  type SiteSeries,
  type Thresholds,
} from '../../domain'
import { FONT, T } from '../../utils/tokens'

/**
 * 历史 + 预测 + 阈值 + 降雨，一张图讲完整件事。
 *
 * 三个必须记住的技术点：
 *
 * 1. **置信带的 stack 是累加语义，不是上下界。**
 *    下界单独一个 series 放 `stack='band'`，上界也必须放同一个 stack，
 *    但值要传 `upper - lower`。传绝对值的话带子的高度会变成 upper 本身，
 *    看起来像第二条预测曲线——v2 时踩过一次，排查了很久。
 *
 * 2. **x 轴锚在预测的 issued_at，不是「现在」。**
 *    仿真时钟 60x 加速，issued_at 与浏览器 Date.now() 差着几十小时，
 *    用 now 当锚点会让预测曲线整体偏移到画布外面。
 *
 * 3. **阈值线画绝对水位**（base + 深度），不是深度。
 *    因为主轴是绝对水位；混着画会让「预测曲线在红线上面」这种判断失效。
 */

export interface TrendChartProps {
  series: SiteSeries
  forecast: SiteForecast | null
  baseLevel: Meters
  thresholds: Thresholds
  issuedAt: SimTime | null
  height?: number
}

export function TrendChart({ series, forecast, baseLevel, thresholds, issuedAt, height = 380 }: TrendChartProps) {
  const option = useMemo(() => {
    const histT = series.points.map((p) => [p.at * 1000, +p.level.toFixed(3)])
    const rainT = series.points.map((p) => [p.at * 1000, +p.rain.toFixed(2)])

    // 预测的锚点：优先 issued_at；退化到历史最后一个点
    const anchor = (issuedAt ?? series.points[series.points.length - 1]?.at ?? 0) * 1000
    const curve = forecast?.curve ?? []
    const fcT = curve.map((c) => [anchor + c.offsetMin * 60_000, +c.level.toFixed(3)])
    const loT = curve.map((c) => [anchor + c.offsetMin * 60_000, +c.lower.toFixed(3)])
    // 关键：上界传差值
    const bandT = curve.map((c) => [anchor + c.offsetMin * 60_000, +Math.max(0, c.upper - c.lower).toFixed(3)])

    const t0 = histT[0]?.[0] ?? anchor
    const t1 = fcT[fcT.length - 1]?.[0] ?? anchor
    const thrSeries = ALARM_LEVELS.map((lv, i) => {
      const abs = +(baseLevel + thresholdOf(thresholds, lv)).toFixed(3)
      return {
        name: `${LEVEL_LABEL[lv]}阈值`,
        type: 'line' as const,
        data: [
          [t0, abs],
          [t1, abs],
        ],
        symbol: 'none',
        lineStyle: {
          type: (i === 3 ? [6, 4] : [3, 3]) as number[],
          width: i === 3 ? 1.6 : 1,
          color: T.level[lv],
          opacity: 0.55,
        },
        silent: true,
        z: 1,
      }
    })

    return {
      animation: false,
      textStyle: { fontFamily: FONT, fontSize: 11 },
      grid: { left: 54, right: 20, top: 36, bottom: 46 },
      legend: {
        top: 2,
        left: 0,
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { color: T.text2, fontSize: 11 },
        data: ['实测水位', '预测水位', '90% 置信区间'],
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: T.borderStrong } },
        backgroundColor: 'rgba(255,255,255,0.97)',
        borderColor: T.border1,
        borderWidth: 1,
        textStyle: { color: T.text1, fontSize: 12 },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? `${v.toFixed(3)} m` : '—'),
      },
      xAxis: [
        {
          type: 'time',
          axisLine: { lineStyle: { color: T.border1 } },
          axisLabel: {
            color: T.text3,
            fontSize: 10,
            hideOverlap: true,
            formatter: (v: number) => fmtClock((v / 1000) as SimTime),
          },
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          type: 'value',
          name: '水位 (m)',
          nameTextStyle: { color: T.text3, fontSize: 10, padding: [0, 0, 0, -30] },
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: T.text3, fontSize: 10, formatter: (v: number) => v.toFixed(2) },
          splitLine: { lineStyle: { color: T.border2 } },
        },
        {
          type: 'value',
          name: '雨 (mm/h)',
          nameTextStyle: { color: T.text3, fontSize: 10 },
          position: 'right',
          min: 0,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: T.text3, fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'band-lo',
          type: 'line',
          data: loT,
          stack: 'band',
          symbol: 'none',
          lineStyle: { opacity: 0 },
          areaStyle: { opacity: 0 },
          silent: true,
          z: 2,
        },
        {
          name: '90% 置信区间',
          type: 'line',
          data: bandT,
          stack: 'band',
          symbol: 'none',
          lineStyle: { opacity: 0 },
          areaStyle: { color: T.fcBand, opacity: 0.28 },
          silent: true,
          z: 2,
        },
        {
          name: '实测水位',
          type: 'line',
          data: histT,
          symbol: 'none',
          lineStyle: { color: T.obsLine, width: 1.8 },
          z: 5,
          markLine: {
            silent: true,
            symbol: 'none',
            label: { show: true, formatter: '现在', position: 'insideEndTop', color: T.text3, fontSize: 10 },
            lineStyle: { color: T.borderStrong, width: 1, type: 'solid' as const },
            data: [{ xAxis: anchor }],
          },
        },
        {
          name: '预测水位',
          type: 'line',
          data: fcT,
          symbol: 'none',
          lineStyle: { color: T.fcLine, width: 2.2 },
          z: 6,
        },
        ...thrSeries,
        {
          name: '降雨',
          type: 'bar',
          yAxisIndex: 1,
          data: rainT,
          itemStyle: { color: T.rainBar, opacity: 0.55 },
          barMaxWidth: 3,
          silent: true,
          z: 1,
        },
      ],
    }
  }, [series, forecast, baseLevel, thresholds, issuedAt])

  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />
}
