// 趋势曲线图 - 基于 ECharts
// 规范：docs/02-design/DESIGN-v2-设计系统规范.md §7（图表）/ §5.2（叙事动机）
// 约定：实际值实线主色，预测值虚线告警色并入图例，预测置信带用浅色填充
import React from 'react'
import ReactECharts from 'echarts-for-react'
import * as echarts from 'echarts/core'
import { useAlertLevels } from '@/hooks/useAlertLevels'
import { CHART } from '@/utils/tokens'

interface TrendSeries {
  name: string
  type: 'line'
  data: [number, number][]
  color: string
  lineStyle?: 'solid' | 'dashed' | 'dotted'
  width?: number
  showConfidence?: boolean
  /** [时间戳, 下界, 上界] */
  confidenceData?: [number, number, number][]
}

interface TrendChartProps {
  series: TrendSeries[]
  height?: number | string
  yLabel?: string
  showThreshold?: boolean
  showRainfall?: boolean
  rainfallData?: [number, number][]
}

// 面积渐变（自上而下淡出）；echarts/core 需注册图形后才可用 graphic
let gradientApi: typeof echarts.graphic | null = null
try { gradientApi = echarts.graphic } catch { /* 降级为纯色 */ }
const areaGradient = (color: string) => {
  if (gradientApi?.LinearGradient) {
    return new gradientApi.LinearGradient(0, 0, 0, 1, [
      { offset: 0, color: color + '38' },
      { offset: 1, color: color + '05' },
    ])
  }
  return color + '20'
}

export const TrendChart: React.FC<TrendChartProps> = ({
  series, height = 380, yLabel = '水位 (m)', showThreshold = true, showRainfall = false, rainfallData = [],
}) => {
  const { getThresholdLines } = useAlertLevels()
  const thresholdLines = showThreshold ? getThresholdLines() : []

  // 预测置信带：上下两条透明线 + 堆叠填充，形成一条带
  // 注意 ECharts 的 stack 是「累加」语义：上界必须传差值 (upper-lower)，
  // 堆叠后的绘制高度才是 lower + (upper-lower) = upper；
  // 若直接传 upper，会被抬高一倍（曾导致 Y 轴被撑到 8m 以上）。
  const confidenceSeries = series.flatMap((s) => {
    if (!s.showConfidence || !s.confidenceData?.length) return []
    const lower = s.confidenceData.map(([ts, lo]) => [ts, lo] as [number, number])
    const upperDelta = s.confidenceData.map(([ts, lo, hi]) => [ts, hi - lo] as [number, number])
    return [
      {
        name: `${s.name} 下界`,
        type: 'line' as const,
        data: lower,
        stack: 'confidence',
        symbol: 'none' as const,
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0 },
        silent: true,
        tooltip: { show: false },
        z: 1,
      },
      {
        name: `${s.name} 置信带`,
        type: 'line' as const,
        data: upperDelta,
        stack: 'confidence',
        symbol: 'none' as const,
        lineStyle: { opacity: 0 },
        areaStyle: { color: s.color + '1F' },
        silent: true,
        tooltip: { show: false },
        z: 1,
      },
    ]
  })

  const option = {
    grid: { left: 60, right: 30, top: 40, bottom: showRainfall ? 90 : 50 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: CHART.tooltipBg,
      borderColor: CHART.tooltipBorder,
      textStyle: { color: CHART.tooltipText, fontSize: 12 },
      axisPointer: { type: 'cross', lineStyle: { color: CHART.axisLabel } },
    },
    legend: {
      top: 5,
      textStyle: { fontSize: 12, color: CHART.legendText },
      icon: 'roundRect',
      itemWidth: 18, itemHeight: 8,
      itemGap: 18,
      data: series.map((s) => s.name),
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: CHART.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: CHART.axisLabel, fontSize: 11, hideOverlap: true },
    },
    yAxis: [
      {
        type: 'value', name: yLabel, nameTextStyle: { color: CHART.axisLabel, fontSize: 12 },
        axisLine: { show: false },
        axisLabel: { color: CHART.axisLabel, fontSize: 11 },
        splitLine: { lineStyle: { color: CHART.splitLine, opacity: 0.9 } },
      },
      ...(showRainfall ? [{
        type: 'value', name: '降雨 (mm)', nameTextStyle: { color: CHART.rain, fontSize: 12 },
        position: 'right',
        axisLine: { show: false },
        axisLabel: { color: CHART.rain, fontSize: 11 },
        splitLine: { show: false },
      }] : []),
    ],
    series: [
      ...series.map((s, idx) => ({
        name: s.name,
        type: 'line',
        data: s.data,
        smooth: 0.35,
        symbol: 'circle',
        symbolSize: 5,
        showSymbol: false,
        z: 3,
        lineStyle: {
          color: s.color,
          width: s.width || 2,
          type: s.lineStyle || 'solid',
          shadowColor: s.width && s.width >= 2.2 ? s.color + '30' : 'transparent',
          shadowBlur: s.width && s.width >= 2.2 ? 6 : 0,
          shadowOffsetY: 2,
        },
        itemStyle: { color: s.color },
        areaStyle: s.showConfidence ? {
          color: areaGradient(s.color),
          origin: 'start',
        } : undefined,
        emphasis: { focus: 'series' },
        markLine: showThreshold && idx === 0 ? {
          symbol: 'none',
          data: thresholdLines.map((t, ti) => ({
            yAxis: t.value, name: t.name,
            // 契约 §7：完整语义标注；四级阈值间距小，左右交替避免标签互相遮挡
            label: {
              formatter: `${t.name} ${t.value.toFixed(2)}m`,
              color: t.color,
              position: ti % 2 === 0 ? 'insideStartTop' : 'insideEndTop',
              fontSize: 10,
            },
            lineStyle: { color: t.color, type: 'dashed', width: 1.2, opacity: 0.85 },
          })),
        } : undefined,
      })),
      ...confidenceSeries,
      ...(showRainfall ? [{
        name: '降雨预报', type: 'bar', yAxisIndex: 1,
        data: rainfallData, itemStyle: { color: CHART.rainSoft, borderRadius: [2, 2, 0, 0] },
        barWidth: 6,
      }] : []),
    ],
  }

  return <ReactECharts option={option} style={{ height, width: '100%' }} notMerge={true} />
}
