import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useSession } from '../view/useSession'
import { Skeleton } from './primitives/Bits'
import { T } from '../utils/tokens'

/**
 * 鉴权闸门。
 *
 * 会话是 cookie，前端启动时并不知道自己登没登录，所以先问一次 /api/auth/me。
 * 这一等不能显示空白页：空白页与"系统挂了"在用户眼里是同一件事。
 *
 * 未登录时把当前路径塞进 state，登录成功后回到原处——
 * 值班员点开一个预警链接被弹去登录，登完却落在首页，是很容易被投诉的细节。
 */
export function RequireAuth() {
  const { user, isLoading } = useSession()
  const loc = useLocation()

  if (isLoading) {
    return (
      <div className="min-h-screen p-6 space-y-3" style={{ background: T.bgCanvas }}>
        <Skeleton h={18} w={180} />
        <div className="grid grid-cols-4 gap-3">
          <Skeleton h={82} />
          <Skeleton h={82} />
          <Skeleton h={82} />
          <Skeleton h={82} />
        </div>
        <Skeleton h={420} />
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />
  }

  return <Outlet />
}
