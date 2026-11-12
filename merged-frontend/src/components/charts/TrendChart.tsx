// 趋势曲线图 - 基于 ECharts（观感升级：面积渐变、圆角雨量柱、柔和网格）
// 支持多预见期叠加、历史同期、阈值线、置信区间
import React from 'react'
import ReactECharts from 'echarts-for-react'
import * as echarts from 'echarts/core'
import { useAlertLevels } from '@/hooks/useAlertLevels'

interface TrendChartProps {
  series: {
    name: string
    type: 'line'
    data: [string, number][]
    color: string
    lineStyle?: 'solid' | 'dashed' | 'dotted'
    width?: number
    showConfidence?: boolean
    confidenceData?: [string, number, number][]
  }[]
  height?: number | string
  yLabel?: string
  showThreshold?: boolean
  showRainfall?: boolean
  rainfallData?: [string, number][]
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

  const option = {
    grid: { left: 60, right: 30, top: 40, bottom: showRainfall ? 90 : 50 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(15, 23, 42, 0.92)',
      borderColor: '#334155',
      textStyle: { color: '#f1f5f9', fontSize: 12 },
      axisPointer: { type: 'cross', lineStyle: { color: '#94a3b8' } },
    },
    legend: {
      top: 5,
      textStyle: { fontSize: 12, color: '#475569' },
      icon: 'roundRect',
      itemWidth: 18, itemHeight: 8,
      itemGap: 18,
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisTick: { show: false },
      axisLabel: { color: '#64748b', fontSize: 11, hideOverlap: true },
    },
    yAxis: [
      {
        type: 'value', name: yLabel, nameTextStyle: { color: '#64748b', fontSize: 12 },
        axisLine: { show: false },
        axisLabel: { color: '#64748b', fontSize: 11 },
        splitLine: { lineStyle: { color: '#EAEFF5', opacity: 0.9 } },
      },
      ...(showRainfall ? [{
        type: 'value', name: '降雨 (mm)', nameTextStyle: { color: '#0ea5e9', fontSize: 12 },
        position: 'right',
        axisLine: { show: false },
        axisLabel: { color: '#0ea5e9', fontSize: 11 },
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
          data: thresholdLines.map((t) => ({
            yAxis: t.value, name: `${t.name}预警线`,
            // 契约 §7：颜色名不作图例文本，标注完整语义「黄色预警线 0.50m」
            label: { formatter: `${t.name}预警线 ${t.value.toFixed(2)}m`, color: t.color, position: 'insideEndTop', fontSize: 11 },
            lineStyle: { color: t.color, type: 'dashed', width: 1.2, opacity: 0.85 },
          })),
        } : undefined,
      })),
      ...(showRainfall ? [{
        name: '降雨预报', type: 'bar', yAxisIndex: 1,
        data: rainfallData, itemStyle: { color: '#0ea5e9', opacity: 0.5, borderRadius: [3, 3, 0, 0] },
        barWidth: 10,
      }] : []),
    ],
  }

  return <ReactECharts option={option} style={{ height, width: '100%' }} notMerge={true} />
}
