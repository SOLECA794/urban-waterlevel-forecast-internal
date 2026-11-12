// 预测版本对比图 - 实际值 vs 预测值叠加
import React from 'react'
import ReactECharts from 'echarts-for-react'

interface ForecastComparisonChartProps {
  forecastData: [string, number][]
  forecastConfidence?: [string, number, number][]
  actualData: [string, number][]
  height?: number | string
  stationName?: string
}

export const ForecastComparisonChart: React.FC<ForecastComparisonChartProps> = ({
  forecastData, forecastConfidence = [], actualData, height = 360, stationName = '',
}) => {
  const option = {
    title: stationName ? { text: `${stationName} - 预测 vs 实际`, textStyle: { fontSize: 13, color: '#475569' } } : undefined,
    grid: { left: 60, right: 30, top: 50, bottom: 50 },
    tooltip: { trigger: 'axis' },
    legend: { top: 5, textStyle: { fontSize: 12 } },
    xAxis: { type: 'time', axisLabel: { color: '#64748b', fontSize: 11 } },
    yAxis: {
      type: 'value', name: '水位 (m)', nameTextStyle: { color: '#64748b', fontSize: 12 },
      axisLabel: { color: '#64748b', fontSize: 11 },
      splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } },
    },
    series: [
      {
        name: '实际值', type: 'line', data: actualData,
        smooth: false, symbol: 'circle', symbolSize: 6,
        lineStyle: { color: '#0ea5e9', width: 2.5 },
        itemStyle: { color: '#0ea5e9' },
        z: 5,
      },
      {
        name: '预测值', type: 'line', data: forecastData,
        smooth: true, symbol: 'diamond', symbolSize: 5,
        lineStyle: { color: '#F59E0B', width: 2, type: 'dashed' },
        itemStyle: { color: '#F59E0B' },
        z: 4,
      },
      ...(forecastConfidence.length > 0 ? [{
        name: '置信区间', type: 'line', data: forecastConfidence.map(([t, , hi]) => [t, hi]),
        lineStyle: { opacity: 0 }, stack: 'conf-hi',
        symbol: 'none', tooltip: { show: false }, z: 1,
      }, {
        name: '置信下界', type: 'line', data: forecastConfidence.map(([t, lo]) => [t, lo]),
        lineStyle: { opacity: 0 }, areaStyle: { color: '#F59E0B', opacity: 0.18 }, stack: 'conf-lo',
        symbol: 'none', tooltip: { show: false }, z: 2,
      }] : []),
    ],
  }
  return <ReactECharts option={option} style={{ height, width: '100%' }} notMerge={true} />
}
