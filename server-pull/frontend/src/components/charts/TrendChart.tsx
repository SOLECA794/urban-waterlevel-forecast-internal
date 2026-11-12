// 趋势曲线图 - 基于 ECharts
// 支持多预见期叠加、历史同期、阈值线、置信区间
import React from 'react'
import ReactECharts from 'echarts-for-react'
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
      textStyle: { fontSize: 12 },
      itemWidth: 24, itemHeight: 12,
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      axisLabel: { color: '#64748b', fontSize: 11 },
    },
    yAxis: [
      {
        type: 'value', name: yLabel, nameTextStyle: { color: '#64748b', fontSize: 12 },
        axisLine: { lineStyle: { color: '#cbd5e1' } },
        axisLabel: { color: '#64748b', fontSize: 11 },
        splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } },
      },
      ...(showRainfall ? [{
        type: 'value', name: '降雨 (mm)', nameTextStyle: { color: '#0ea5e9', fontSize: 12 },
        position: 'right',
        axisLine: { lineStyle: { color: '#0ea5e9' } },
        axisLabel: { color: '#0ea5e9', fontSize: 11 },
        splitLine: { show: false },
      }] : []),
    ],
    series: [
      ...series.map((s, idx) => ({
        name: s.name,
        type: 'line',
        data: s.data,
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: {
          color: s.color,
          width: s.width || 2,
          type: s.lineStyle || 'solid',
        },
        itemStyle: { color: s.color },
        areaStyle: s.showConfidence ? {
          color: s.color, opacity: 0.15, origin: 'start',
        } : undefined,
        markLine: showThreshold && idx === 0 ? {
          symbol: 'none',
          data: thresholdLines.map((t) => ({
            yAxis: t.value, name: `${t.name}阈值`,
            label: { formatter: `${t.name} ${t.value}m`, color: t.color, position: 'end' },
            lineStyle: { color: t.color, type: 'dashed', width: 1.5 },
          })),
        } : undefined,
      })),
      ...(showRainfall ? [{
        name: '降雨预报', type: 'bar', yAxisIndex: 1,
        data: rainfallData, itemStyle: { color: '#0ea5e9', opacity: 0.55 },
        barWidth: 10,
      }] : []),
    ],
  }

  return <ReactECharts option={option} style={{ height, width: '100%' }} notMerge={true} />
}
