import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useSession } from '../view/useSession'
import { Icon } from '../components/primitives/Icons'
import { T } from '../utils/tokens'

/**
 * 登录页。
 *
 * 没有"忘记密码"、没有"注册"：这是一个内部系统，账号由管理员建。
 * 摆一个点了没反应的链接，比不摆更容易让人以为系统坏了。
 */
export function LoginPage() {
  const { user, login } = useSession()
  const nav = useNavigate()
  const loc = useLocation()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')

  // 已登录的人不该停在登录页（比如手敲地址、或登录后按了后退）
  if (user) {
    const from = (loc.state as { from?: string } | null)?.from
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    login.mutate(
      { username: username.trim(), password },
      {
        onError: (e: Error) => setErr(e.message),
        onSuccess: () => {
          const from = (loc.state as { from?: string } | null)?.from
          nav(from && from !== '/login' ? from : '/', { replace: true })
        },
      },
    )
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1fr_460px]" style={{ background: T.bgCanvas }}>
      {/* 左侧品牌面板：复用侧栏渐变，让登录页与主界面是同一个系统 */}
      <div
        className="hidden lg:flex flex-col justify-between p-10 relative overflow-hidden"
        style={{ background: 'var(--grad-sidebar)', color: '#c7d2e4' }}
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'var(--sidebar-glow)' }}
        />
        <div className="relative flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-control grid place-items-center"
            style={{ background: 'rgba(96,165,250,0.16)', color: '#93c5fd' }}
          >
            <Icon name="droplet" size={20} />
          </div>
          <div>
            <div className="text-[15px] font-semibold text-white leading-tight">内涝预测预警</div>
            <div className="text-[10px] tracking-[0.16em] text-[#64748b] num">WATERLOG · v3</div>
          </div>
        </div>

        <div className="relative max-w-[420px]">
          <div className="text-[26px] font-semibold text-white leading-snug">
            看见积水之前，
            <br />
            先把雨算清楚。
          </div>
          <p className="mt-4 text-[12.5px] leading-relaxed text-[#94a3b8]">
            多源数据融合 → 47 维特征 → 四个预见期预测 → 三因子研判 → 四态预警 → 处置闭环。
            每一次等级变化都留着依据，每一个操作都留痕。
          </p>
        </div>

        <div className="relative grid grid-cols-3 gap-4 text-[11px]">
          {[
            ['10', '监测站点'],
            ['1/3/6/12h', '预见期'],
            ['4', '预警等级'],
          ].map(([v, k]) => (
            <div key={k}>
              <div className="text-[17px] font-semibold text-white num">{v}</div>
              <div className="text-[#64748b]">{k}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 右侧表单 */}
      <div className="flex items-center justify-center p-6">
        <form
          onSubmit={submit}
          className="card w-full max-w-[360px] p-6 space-y-4"
          style={{ boxShadow: 'var(--shadow-lg)' }}
        >
          <div>
            <div className="text-[15px] font-semibold" style={{ color: T.text1 }}>
              登录
            </div>
            <div className="text-[11.5px] mt-1" style={{ color: T.text3 }}>
              账号由系统管理员分配
            </div>
          </div>

          <label className="block">
            <div className="text-[11.5px] mb-1.5" style={{ color: T.text2 }}>
              用户名
            </div>
            <input
              className="field w-full"
              value={username}
              autoFocus
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>

          <label className="block">
            <div className="text-[11.5px] mb-1.5" style={{ color: T.text2 }}>
              口令
            </div>
            <input
              className="field w-full"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {err && (
            <div
              className="flex items-start gap-2 rounded-control px-2.5 py-2 text-[11.5px]"
              style={{ background: T.levelWeak.red, color: T.levelInk.red }}
            >
              <Icon name="alertTriangle" size={13} className="mt-0.5 shrink-0" />
              <span>{err}</span>
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary w-full justify-center"
            disabled={login.isPending || !username.trim() || !password}
          >
            {login.isPending ? '验证中…' : '登录'}
          </button>

          <div className="text-[10.5px] leading-relaxed" style={{ color: T.text3 }}>
            首次启动会自动创建 admin 账号，初始口令见启动日志（可用
            <span className="mono"> WL_BOOTSTRAP_ADMIN_PASSWORD </span>覆盖）。登录后请立即改掉。
          </div>
        </form>
      </div>
    </div>
  )
}
