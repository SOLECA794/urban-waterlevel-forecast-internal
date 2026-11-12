// 全局错误边界 - 页面渲染异常时兜底（不再白屏），支持一键重试
import React from 'react'
import { Button, Result, Space } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

interface ErrorBoundaryProps {
  children: React.ReactNode
  /** 边界标识（如页面名），用于错误提示定位 */
  label?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.label ?? 'app', error, info.componentStack)
  }

  handleRetry = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return (
        <Result
          status="warning"
          title={`${this.props.label ?? '页面'}渲染出错`}
          subTitle={this.state.error.message || '发生未知错误'}
          extra={
            <Space>
              <Button type="primary" icon={<ReloadOutlined />} onClick={this.handleRetry}>
                重试
              </Button>
              <Button onClick={() => window.location.reload()}>刷新整页</Button>
            </Space>
          }
        />
      )
    }
    return this.props.children
  }
}

/** 页面级懒加载占位 */
export const PageLoading: React.FC = () => (
  <div className="flex items-center justify-center" style={{ height: '60vh' }}>
    <div className="text-slate-400 text-sm animate-pulse">页面加载中…</div>
  </div>
)
