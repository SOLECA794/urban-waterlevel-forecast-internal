import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  canSeePage,
  fmtTime,
  isUnack,
  LEVEL_FULL,
  maxLevel,
  type Level,
  type SimTime,
} from '../domain'
import { useAlerts, useHealth, useOverview } from '../data/queries'
import { useLive } from '../data/live'
import { useSession } from '../view/useSession'
import { Icon, type IconName } from './primitives/Icons'
import { T } from '../utils/tokens'

/**
 * 应用外壳。
 *
 * 这一层只做三件事：导航、全局链路状态、把 Outlet 装进去。
 * 它**不**做任何领域计算——`worst` 是从 overview 的 rows 归约出来的展示值，
 * 用的是 domain 的 `maxLevel`，而不是在这里手写一遍等级比较。
 */

interface NavEntry {
  to: string
  label: string
  icon: IconName
  end?: boolean
  hint: string
}

const GROUPS: { title: string; items: NavEntry[] }[] = [
  {
    title: '监测',
    items: [
      { to: '/', label: '一张图', icon: 'map', end: true, hint: '全市积水与预警总览' },
      { to: '/sites', label: '站点列表', icon: 'layers', hint: '十个站点的横向对比' },
      { to: '/alerts', label: '预警中心', icon: 'bell', hint: '事件、处置与备注' },
      { to: '/shift', label: '值班台', icon: 'clock', hint: '近 12 小时的交接：还剩什么没完' },
    ],
  },
  {
    title: '模型',
    items: [
      { to: '/model', label: '模型评估', icon: 'cpu', hint: '离线指标、在线滚动、版本治理' },
      { to: '/rules', label: '规则配置', icon: 'sliders', hint: '三因子权重与分档，改前先预演' },
    ],
  },
  {
    title: '系统',
    items: [
      { to: '/system', label: '系统状态', icon: 'activity', hint: '链路、接口与暴雨演练' },
      { to: '/board', label: '大厅大屏', icon: 'activity', hint: '无交互轮换展示，适合常驻大屏' }, { to: '/admin', label: '管理台', icon: 'shield', hint: '账号、审计与推送渠道' },
    ],
  },
]

/**
 * 需要管理员才能看到的入口。
 *
 * 只在前端藏起来是不够的（后端每一条都有 RequireRole），但藏起来仍然必要：
 * 一个点进去必然 403 的菜单项，会让人以为系统坏了。
 */
const ADMIN_ONLY = new Set(['/admin'])

export function Layout() {
  const loc = useLocation()
  const health = useHealth()
  const overview = useOverview()
  const alerts = useAlerts(true)
  const live = useLive()
  const { user, logout } = useSession()

  const rows = overview.data?.rows ?? []
  const worst: Level = maxLevel(rows.map((r) => r.assessment.level))
  const unack = (alerts.data ?? []).filter((e) => isUnack(e.state)).length
  const simNow = overview.data?.issuedAt ?? health.data?.now ?? null
  const title = findTitle(loc.pathname)

  return (
    <div className="flex min-h-screen" style={{ background: T.bgCanvas }}>
      {/* ── 侧栏 ── */}
      <aside
        className="w-[212px] shrink-0 flex flex-col relative"
        style={{ background: 'var(--grad-sidebar)', color: '#c7d2e4' }}
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'var(--sidebar-glow)' }}
        />
        <div className="relative px-4 pt-5 pb-4 flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-control grid place-items-center shrink-0"
            style={{ background: 'rgba(96,165,250,0.16)', color: '#93c5fd' }}
          >
            <Icon name="droplet" size={17} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-white leading-tight truncate">
              内涝预测预警
            </div>
            <div className="text-[9.5px] tracking-[0.14em] text-[#64748b] num">WATERLOG · v3</div>
          </div>
        </div>

        <nav className="relative flex-1 overflow-y-auto px-2 pb-3">
          {GROUPS.map((g) => (
            <div key={g.title} className="mb-3">
              <div className="px-2.5 mb-1 text-[9.5px] tracking-[0.16em] text-[#4b5b74]">
                {g.title}
              </div>
              {g.items
                .filter((it) => !ADMIN_ONLY.has(it.to) || canSeePage(user, 'admin'))
                .map((it) => (
                  <NavItem
                    key={it.to}
                    entry={it}
                    badge={it.to === '/alerts' && unack > 0 ? unack : undefined}
                  />
                ))}
            </div>
          ))}
        </nav>

        <div className="relative px-3 py-2.5 border-t border-white/5">
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-full grid place-items-center text-[10.5px] font-semibold shrink-0"
              style={{ background: 'rgba(96,165,250,0.18)', color: '#bfdbfe' }}
            >
              {(user?.displayName ?? '?').slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] text-[#dbe4f3] truncate leading-tight">
                {user?.displayName ?? '未登录'}
              </div>
              <div className="text-[9.5px] text-[#64748b] leading-tight">
                {user?.roleLabel ?? '—'}
              </div>
            </div>
            <button
              className="text-[10px] px-1.5 py-0.5 rounded text-[#93a4bd] hover:text-white transition-colors"
              title="退出登录"
              onClick={() => logout.mutate()}
            >
              <Icon name="external" size={11} />
            </button>
          </div>
        </div>

        <div className="relative px-3 py-3 border-t border-white/5 space-y-1.5">
          <StatusLine
            label="Go API"
            ok={health.data?.apiOk === true}
            detail={health.data?.service ?? 'waterlog-v3-api'}
            pulse
          />
          <StatusLine
            label="Python 引擎"
            ok={health.data?.engineOk === true}
            detail={
              health.data?.engineOk
                ? `${health.data.engine.modelVersion || '—'} · ${health.data.engine.cycles} 轮`
                : '未连通'
            }
            pulse
          />
          <StatusLine
            label="SSE"
            ok={live.connected}
            detail={live.connected ? `${live.events} 事件` : '重连中'}
            pulse
          />
        </div>
      </aside>

      {/* ── 主区 ── */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header
          className="h-14 shrink-0 sticky top-0 z-20 flex items-center gap-3 px-5 border-b"
          style={{
            background: 'rgba(255,255,255,0.82)',
            backdropFilter: 'saturate(180%) blur(12px)',
            borderColor: T.border1,
          }}
        >
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold text-ink leading-tight truncate">
              {title}
            </div>
            <div className="text-[10.5px] text-ink-3 leading-tight truncate">{titleHint(loc.pathname)}</div>
          </div>

          <div className="flex-1" />

          {worst !== 'none' && (
            <span
              className="hidden lg:inline-flex items-center gap-1.5 h-7 px-2.5 rounded-pill text-[11.5px] font-medium"
              style={{ background: T.levelWeak[worst], color: T.levelInk[worst] }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse-ring"
                style={{ background: T.level[worst] }}
              />
              最高 {LEVEL_FULL[worst]}
            </span>
          )}

          {simNow != null && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] text-ink-3">
              <Icon name="clock" size={12} />
              <span className="num">仿真时钟 {fmtTime(simNow as SimTime, 'MM-DD HH:mm')}</span>
            </span>
          )}

          <span className="hidden md:inline-flex items-center gap-1.5 text-[11px] text-ink-3">
            <Icon name="database" size={12} />
            <span className="num">
              待结算 {health.data?.engine.pending ?? 0} · SSE {live.connected ? '通' : '断'}
            </span>
          </span>
        </header>

        <main className="flex-1 min-w-0 p-4">
          <div key={loc.pathname} className="page-enter">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

function NavItem({ entry, badge }: { entry: NavEntry; badge?: number }) {
  return (
    <NavLink
      to={entry.to}
      end={entry.end}
      className="group relative flex items-center gap-2.5 h-8 px-2.5 rounded-control text-[12.5px] transition-colors"
      style={({ isActive }) => ({
        color: isActive ? '#e2ecff' : '#93a4bd',
        background: isActive ? 'rgba(96,165,250,0.13)' : undefined,
        boxShadow: isActive ? 'inset 0 0 0 1px rgba(96,165,250,0.22)' : undefined,
      })}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-r"
              style={{ background: '#60a5fa' }}
            />
          )}
          <Icon
            name={entry.icon}
            size={14}
            className={isActive ? 'text-[#93c5fd]' : 'text-[#6b7f9b] group-hover:text-[#93a4bd]'}
          />
          <span className="flex-1 truncate">{entry.label}</span>
          {badge != null && (
            <span
              className="min-w-[17px] h-[17px] px-1 grid place-items-center rounded-pill text-[9.5px] font-semibold num"
              style={{ background: T.level.red, color: '#fff' }}
            >
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}

function StatusLine({
  label,
  ok,
  detail,
  pulse,
}: {
  label: string
  ok: boolean
  detail: string
  pulse?: boolean
}) {
  return (
    <div className="flex items-center gap-2 text-[10.5px]">
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${ok && pulse ? 'animate-pulse-ring' : ''}`}
        style={{ background: ok ? '#34d399' : '#f87171' }}
      />
      <span className="text-[#93a4bd] shrink-0">{label}</span>
      <span className="text-[#64748b] truncate num">{detail}</span>
    </div>
  )
}

function findTitle(pathname: string): string {
  // 先判详情：/sites/S01 也 startsWith('/sites')，顺序反了就会一直显示「站点列表」
  if (pathname.startsWith('/sites/')) return '站点详情'
  if (pathname === '/admin') return '管理台'
  for (const g of GROUPS) {
    for (const it of g.items) {
      if (it.end ? pathname === it.to : pathname.startsWith(it.to)) return it.label
    }
  }
  return '内涝预测预警'
}

function titleHint(pathname: string): string {
  if (pathname.startsWith('/sites/')) return '单站点的历史、预测、研判与决策溯源'
  if (pathname === '/admin') return '账号与角色、操作审计、推送渠道'
  for (const g of GROUPS) {
    for (const it of g.items) {
      if (it.end ? pathname === it.to : pathname.startsWith(it.to)) return it.hint
    }
  }
  return ''
}
