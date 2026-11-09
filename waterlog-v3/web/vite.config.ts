import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发时 /api 代理到本机 Go 服务；生产由 Go 直接托管 dist（同源，无需代理）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8200',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
})
