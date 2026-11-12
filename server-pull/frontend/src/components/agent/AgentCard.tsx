// Agent 嵌入式辅助卡片 - 按 #52 的 6 个点位结构化呈现
// 形态：结论 + 指标 + 因素 + 建议
import React from 'react'
import { Card, Tag, Tooltip } from 'antd'
import { RobotOutlined, ArrowUpOutlined, ArrowDownOutlined, MinusOutlined, BulbOutlined } from '@ant-design/icons'
import type { AgentCard as AgentCardType } from '@/types'

interface AgentCardProps {
  card: AgentCardType
  compact?: boolean
}

const TrendIcon: React.FC<{ trend?: 'up' | 'down' | 'stable' }> = ({ trend }) => {
  if (trend === 'up') return <ArrowUpOutlined style={{ color: '#DC2626' }} />
  if (trend === 'down') return <ArrowDownOutlined style={{ color: '#10b981' }} />
  return <MinusOutlined style={{ color: '#94a3b8' }} />
}

export const AgentCard: React.FC<AgentCardProps> = ({ card, compact = false }) => {
  return (
    <Card
      size="small"
      style={{
        borderLeft: '3px solid #7c3aed',
        background: 'linear-gradient(135deg, #faf5ff 0%, #f3e8ff 100%)',
      }}
      title={
        <div className="flex items-center gap-2">
          <RobotOutlined style={{ color: '#7c3aed' }} />
          <span className="text-sm font-medium">{card.title}</span>
          <Tag color="purple" style={{ marginLeft: 'auto', fontSize: 10 }}>AI Agent</Tag>
        </div>
      }
    >
      <div className="space-y-2">
        <div className="text-sm font-medium text-slate-800">
          <BulbOutlined style={{ color: '#7c3aed', marginRight: 6 }} />
          {card.conclusion}
        </div>
        {!compact && (
          <div className="flex flex-wrap gap-3 py-1">
            {card.metrics.map((m, i) => (
              <div key={i} className="flex items-center gap-1 text-xs">
                <span className="text-slate-500">{m.label}:</span>
                <span className="font-semibold text-slate-800">{m.value}</span>
                <TrendIcon trend={m.trend} />
              </div>
            ))}
          </div>
        )}
        {!compact && (
          <div className="text-xs text-slate-600">
            <div className="font-medium text-slate-700 mb-1">研判因素：</div>
            <ul className="list-disc list-inside space-y-0.5 pl-1">
              {card.factors.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </div>
        )}
        <Tooltip title={card.suggestion}>
          <div className="text-xs text-purple-700 bg-white/60 px-2 py-1.5 rounded border border-purple-200">
            💡 {card.suggestion}
          </div>
        </Tooltip>
      </div>
    </Card>
  )
}
