import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { onUnauthorized } from '../data/client'
import { qk, useLogin, useLogout, useMe } from '../data/queries'
import type { User } from '../domain'

/**
 * 会话视图模型。
 *
 * 不另建 Context 存一份 user：`qk.me` 本身就是全局单例，
 * 再包一层 Provider 只会多一个可能与它不同步的副本。
 *
 * 这里额外做一件事——把传输层的 401 接到缓存上。会话过期时，
 * 任何一次请求都会把 me 置空，界面于是自然回到登录页，
 * 不需要每个页面自己判断 401。
 */
export interface SessionView {
  readonly user: User | null
  readonly isLoading: boolean
  readonly isAuthed: boolean
  readonly login: ReturnType<typeof useLogin>
  readonly logout: ReturnType<typeof useLogout>
}

export function useSession(): SessionView {
  const qc = useQueryClient()
  const me = useMe()
  const login = useLogin()
  const logout = useLogout()

  useEffect(() => {
    onUnauthorized(() => {
      qc.setQueryData(qk.me, null)
    })
    return () => onUnauthorized(null)
  }, [qc])

  const user = me.data ?? null
  return {
    user,
    isLoading: me.isLoading,
    isAuthed: !!user,
    login,
    logout,
  }
}
