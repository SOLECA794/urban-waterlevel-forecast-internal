// 统一错误态（规范 §6 交互态）
// 要点：常驻错误必须就地内联呈现并给出明确重试动作，不能只靠 toast
import React from 'react'
import { Button } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

export const ErrorState: React.FC<{ message?: string; onRetry?: () => void; compact?: boolean }> = ({
  message,
  onRetry,
  compact,
}) => (
  <div className="empty-state" style={compact ? { padding: 'var(--sp-4)' } : undefined}>
    <div className="empty-title" style={{ color: 'var(--danger-ink)' }}>数据加载失败</div>
    <div>{message || '后端服务未响应，请确认服务已启动后重试。'}</div>
    {onRetry && (
      <Button size="small" icon={<ReloadOutlined />} onClick={onRetry} className="press">
        重新加载
      </Button>
    )}
  </div>
)

export default ErrorState
