// 预警等级徽标 - 动态等级支持
import React from 'react'
import { Tag } from 'antd'
import { useAlertLevels } from '@/hooks/useAlertLevels'

interface AlertBadgeProps {
  rank: number
  size?: 'small' | 'default' | 'large'
  showName?: boolean
}

export const AlertBadge: React.FC<AlertBadgeProps> = ({ rank, size = 'default', showName = true }) => {
  const { getLevelByRank } = useAlertLevels()
  const level = getLevelByRank(rank)
  if (!level) return null
  const padding = size === 'small' ? '0 6px' : size === 'large' ? '2px 10px' : '0 8px'
  const fontSize = size === 'small' ? 10 : size === 'large' ? 14 : 12
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding, borderRadius: 10, fontSize,
      color: '#fff', background: level.color, fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      <span style={{
        display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
        background: '#fff', opacity: 0.85,
      }} />
      {showName ? level.name : ''}{showName ? '预警' : ''}
    </span>
  )
}
