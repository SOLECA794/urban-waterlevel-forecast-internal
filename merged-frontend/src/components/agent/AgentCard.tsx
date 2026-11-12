// Agent 嵌入式辅助卡片 - 按 #52 的 6 个点位结构化呈现
// 形态：结论 + 指标 + 因素 + 建议
// 视觉契约 §4：白底 + 左侧靛青边条 + 「AI 研判」中性标签；禁止紫色渐变
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
  if (trend === 'down') return <ArrowDownOutlined style={{ color: '#16A34A' }} />
  return <MinusOutlined style={{ color: '#94A3B8' }} />
}

export const AgentCard: React.FC<AgentCardProps> = ({ card, compact = false }) => {
  return (
    <Card
      size="small"
      style={{
        borderLeft: '3px solid var(--accent-ai)',
        background: 'var(--bg-surface)',
      }}
      title={
        <div className="flex items-center gap-2">
          <RobotOutlined style={{ color: 'var(--accent-ai)' }} />
          <span className="text-sm font-medium">{card.title}</span>
          <Tag color="cyan" style={{ marginLeft: 'auto', fontSize: 10, lineHeight: '16px' }}>AI 研判</Tag>
        </div>
      }
    >
      <div className="space-y-2">
        <div className="text-sm font-medium" style={{ color: 'var(--text-1)' }}>
          <BulbOutlined style={{ color: 'var(--accent-ai)', marginRight: 6 }} />
          {card.conclusion}
        </div>
        {!compact && (
          <div className="flex flex-wrap gap-3 py-1">
            {card.metrics.map((m, i) => (
              <div key={i} className="flex items-center gap-1 text-xs">
                <span style={{ color: 'var(--text-2)' }}>{m.label}:</span>
                <span className="num font-semibold" style={{ color: 'var(--text-1)' }}>{m.value}</span>
                <TrendIcon trend={m.trend} />
              </div>
            ))}
          </div>
        )}
        {!compact && (
          <div className="text-xs" style={{ color: 'var(--text-2)' }}>
            <div className="font-medium mb-1" style={{ color: 'var(--text-1)' }}>研判因素：</div>
            <ul className="list-disc list-inside space-y-0.5 pl-1">
              {card.factors.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </div>
        )}
        <Tooltip title={card.suggestion}>
          <div
            className="text-xs px-2 py-1.5 rounded"
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}
          >
            💡 {card.suggestion}
          </div>
        </Tooltip>
      </div>
    </Card>
  )
}
