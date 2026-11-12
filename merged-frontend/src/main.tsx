// 入口文件 - Ant Design 配置 + QueryClient
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider, App as AntApp } from 'antd'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'

import App from './App'
import './styles/global.css'

dayjs.locale('zh-cn')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30 * 1000,
    },
  },
})

// 主题令牌（契约 §2）：单一主色，与 Tailwind blue-600 同值，语义色独立
const FONT_STACK = "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
const theme = {
  token: {
    colorPrimary: '#2563EB',
    colorSuccess: '#16A34A',
    colorWarning: '#D97706',
    colorError: '#DC2626',
    colorInfo: '#2563EB',
    colorText: '#0F172A',
    colorTextSecondary: '#475569',
    colorTextTertiary: '#94A3B8',
    colorBorder: '#CBD5E1',
    colorBorderSecondary: '#E2E8F0',
    colorBgLayout: '#F5F7FA',
    borderRadius: 6,
    fontSize: 14,
    fontFamily: FONT_STACK,
  },
  components: {
    Card: {
      borderRadiusLG: 8,
      headerFontSize: 14,
    },
    Table: {
      headerBg: '#F1F5F9',
      headerColor: '#475569',
      cellPaddingBlockSM: 10,
    },
    Statistic: {
      contentFontSize: 24,
    },
    Steps: {
      colorPrimary: '#2563EB',
    },
  },
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider locale={zhCN} theme={theme}>
        <AntApp>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
