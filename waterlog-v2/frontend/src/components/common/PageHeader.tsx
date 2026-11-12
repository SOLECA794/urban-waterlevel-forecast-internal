// 统一页头：大标题 + 副标题 + 右侧操作区（观感升级：替掉孤零零的 h2）
import React from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  extra?: React.ReactNode
}

export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, extra }) => (
  <div className="flex items-end justify-between gap-4 flex-wrap mb-4">
    <div>
      <h2 className="text-xl font-bold leading-tight m-0" style={{ color: 'var(--text-1)' }}>{title}</h2>
      {description && (
        <div className="text-[13px] mt-1" style={{ color: 'var(--text-3)' }}>{description}</div>
      )}
    </div>
    {extra && <div className="flex items-center gap-2 flex-wrap">{extra}</div>}
  </div>
)
