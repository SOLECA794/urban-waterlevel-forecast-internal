/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 政务级预警色板（视觉规范 v1.0）
        'alert-blue': '#2563EB',
        'alert-yellow': '#F59E0B',
        'alert-orange': '#EA580C',
        'alert-red': '#DC2626',
        // 深色大屏色板
        'dark-bg': '#0B1120',
        'dark-bg-soft': '#131C2E',
        'dark-border': '#1E2A40',
        'dark-glow-blue': '#60A5FA',
        'dark-glow-yellow': '#FBBF24',
        'dark-glow-orange': '#FB923C',
        'dark-glow-red': '#F87171',
      },
      fontFamily: {
        sans: ['Inter', 'PingFang SC', 'Microsoft YaHei', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      animation: {
        'pulse-warn': 'pulseWarn 1.6s ease-in-out infinite',
      },
      keyframes: {
        pulseWarn: {
          '0%, 100%': { transform: 'scale(1)', opacity: '1' },
          '50%': { transform: 'scale(1.4)', opacity: '0.6' },
        },
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: true,
  },
}
