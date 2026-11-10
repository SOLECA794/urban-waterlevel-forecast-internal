import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as A from './adapters'
import { transport, UnauthorizedError } from './client'
import { isRole, ROLE_LABEL } from '../domain'
import type {
  AlertDetail,
  AlertEvent,
  AuditEntry,
  DecisionRow,
  Delivery,
  Level,
  NotifyChannel,
  Role,
  User,
  EvalPair,
  Forecast,
  Metrics,
  ModelVersion,
  RetrainState,
  Rules,
  RulesImpact,
  SimTime,
  Site,
  SiteSeries,
  SiteDetailView,
  Reading,
  Assessment,
} from '../domain'

/**
 * 数据访问层：**页面只从这里拿领域模型，永远不碰 DTO。**
 *
 * 每个 hook 的职责就两件事：拉 DTO、交给 adapters。任何派生（排序、取 top5、
 * 汇总计数）都不属于这里——那是 view 层的事，因为派生规则会随界面变。
 */

export const qk = {
  health: ['health'] as const,
  overview: ['overview'] as const,
  sites: ['sites'] as const,
  site: (id: string) => ['site', id] as const,
  history: (id: string, hours: number) => ['history', id, hours] as const,
  forecast: ['forecast'] as const,
  alerts: (activeOnly: boolean) => ['alerts', activeOnly] as const,
  alert: (id: number) => ['alert', id] as const,
  metrics: (windowH: number) => ['metrics', windowH] as const,
  decisions: ['decisions'] as const,
  evalPairs: ['eval-pairs'] as const,
  versions: ['model-versions'] as const,
  rules: ['rules'] as const,
  retrain: ['retrain'] as const,
  me: ['me'] as const,
  users: ['users'] as const,
  audit: (hours: number, username: string) => ['audit', hours, username] as const,
  channels: ['channels'] as const,
  deliveries: ['deliveries'] as const,
}

/** 一张图的一行：站点静态 + 实测 + 研判，三段各自独立，谁也不装谁。 */
export interface OverviewRow {
  readonly site: Site
  readonly reading: Reading
  readonly assessment: Assessment
}

export interface Overview {
  readonly issuedAt: SimTime
  readonly rows: readonly OverviewRow[]
}

// ---------------------------------------------------------------- 读

export function useHealth() {
  return useQuery({
    queryKey: qk.health,
    queryFn: async () => A.adaptHealth(await transport.health()),
    refetchInterval: 15_000,
  })
}

export function useOverview() {
  return useQuery({
    queryKey: qk.overview,
    queryFn: async (): Promise<Overview> => {
      const d = await transport.overview()
      return {
        issuedAt: d.issued_at as SimTime,
        rows: d.sites.map(A.adaptOverviewSite),
      }
    },
    refetchInterval: 30_000,
  })
}

export function useSites() {
  return useQuery({
    queryKey: qk.sites,
    queryFn: async () => (await transport.sites()).sites.map(A.adaptSite),
    staleTime: 300_000,
  })
}

export function useSiteDetail(id: string) {
  return useQuery({
    queryKey: qk.site(id),
    queryFn: async (): Promise<SiteDetailView> => {
      const d = await transport.site(id)
      return A.adaptSiteDetail(d)
    },
    refetchInterval: 30_000,
    enabled: !!id,
  })
}

export function useHistory(id: string, hours = 12) {
  return useQuery({
    queryKey: qk.history(id, hours),
    queryFn: async (): Promise<SiteSeries> => {
      const d = await transport.history(id, hours)
      return A.adaptSeries(d.points, id, hours)
    },
    refetchInterval: 60_000,
    enabled: !!id,
  })
}

export function useForecast() {
  return useQuery({
    queryKey: qk.forecast,
    queryFn: async (): Promise<Forecast> => A.adaptForecast(await transport.forecast()),
    refetchInterval: 60_000,
  })
}

export function useAlerts(activeOnly: boolean) {
  return useQuery({
    queryKey: qk.alerts(activeOnly),
    queryFn: async (): Promise<AlertEvent[]> =>
      (await transport.alerts(activeOnly)).alerts.map(A.adaptAlertEvent),
    refetchInterval: 20_000,
  })
}

export function useAlertDetail(id: number | null) {
  return useQuery({
    queryKey: qk.alert(id ?? -1),
    queryFn: async (): Promise<AlertDetail> => A.adaptAlertDetail(await transport.alertDetail(id as number)),
    enabled: id != null,
  })
}

export function useMetrics(windowH = 6) {
  return useQuery({
    queryKey: qk.metrics(windowH),
    queryFn: async (): Promise<Metrics> => A.adaptMetrics(await transport.metrics(windowH)),
    refetchInterval: 60_000,
  })
}

export function useDecisions(limit = 40) {
  return useQuery({
    queryKey: qk.decisions,
    queryFn: async (): Promise<DecisionRow[]> =>
      (await transport.decisions(limit)).decisions.map(A.adaptDecisionRow),
    refetchInterval: 30_000,
  })
}

export function useEvalPairs(hours = 12) {
  return useQuery({
    queryKey: qk.evalPairs,
    queryFn: async (): Promise<EvalPair[]> => (await transport.evalPairs(hours)).pairs.map(A.adaptEvalPair),
    refetchInterval: 60_000,
  })
}

export function useModelVersions() {
  return useQuery({
    queryKey: qk.versions,
    queryFn: async (): Promise<{ versions: ModelVersion[]; active: string }> => {
      const d = await transport.modelVersions()
      return { versions: d.versions.map(A.adaptModelVersion), active: d.active }
    },
    refetchInterval: 120_000,
  })
}

export function useRules() {
  return useQuery({
    queryKey: qk.rules,
    queryFn: async (): Promise<Rules> => A.adaptRules(await transport.rules()),
    refetchInterval: 120_000,
  })
}

export function useRetrainStatus() {
  return useQuery({
    queryKey: qk.retrain,
    queryFn: async (): Promise<RetrainState> => {
      const d = await transport.retrainStatus()
      return {
        status: d.status,
        startedAt: d.started_at != null ? (d.started_at as SimTime) : null,
        version: d.version ?? null,
        seconds: d.seconds ?? null,
        error: d.error ?? null,
      }
    },
    refetchInterval: 3_000,
  })
}

// ---------------------------------------------------------------- 写

/**
 * 所有写操作的失效范围都写在 mutation 里，不写在页面里。
 * 理由：页面知道「我点了确认」，但只有这一层知道「确认会改变哪些视图」。
 */
export function useAckAlert() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => transport.ack(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] })
      void qc.invalidateQueries({ queryKey: ['alert'] })
      void qc.invalidateQueries({ queryKey: ['overview'] })
    },
  })
}

export function useAssignAlert() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: number; assignee: string }) => transport.assignAlert(v.id, v.assignee),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] })
      void qc.invalidateQueries({ queryKey: ['alert'] })
    },
  })
}

export function useSetDisposition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: number; disposition: string; note?: string }) =>
      transport.setDisposition(v.id, v.disposition, v.note),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] })
      void qc.invalidateQueries({ queryKey: ['alert'] })
    },
  })
}

export function useAddNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: number; text: string; author?: string; kind?: string }) =>
      transport.addNote(v.id, v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alert'] })
      void qc.invalidateQueries({ queryKey: ['alerts'] })
    },
  })
}

export function useSaveRules() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (r: Rules) => transport.saveRules(A.rulesToDto(r)),
    onSuccess: () => {
      // 规则一改，全城等级都会重算，所以 overview 与 alerts 必须一起失效
      void qc.invalidateQueries({ queryKey: ['rules'] })
      void qc.invalidateQueries({ queryKey: ['overview'] })
      void qc.invalidateQueries({ queryKey: ['alerts'] })
    },
  })
}

export function usePreviewRules() {
  return useMutation({
    mutationFn: async (r: Rules): Promise<RulesImpact> =>
      A.adaptRulesImpact(await transport.previewRules(A.rulesToDto(r))),
  })
}

export function useAdoptModel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (version: string) => transport.adoptModel(version),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['model-versions'] })
      void qc.invalidateQueries({ queryKey: ['metrics'] })
      void qc.invalidateQueries({ queryKey: ['forecast'] })
      void qc.invalidateQueries({ queryKey: ['overview'] })
      void qc.invalidateQueries({ queryKey: ['health'] })
    },
  })
}

export function useRetrain() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => transport.retrain(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['retrain'] })
    },
  })
}

export function useSimStorm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { peak: number; dur: number }) => transport.storm(v.peak, v.dur),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['overview'] })
      void qc.invalidateQueries({ queryKey: ['alerts'] })
    },
  })
}

export function useResetWater() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => transport.resetWater(true),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['overview'] })
      void qc.invalidateQueries({ queryKey: ['alerts'] })
      void qc.invalidateQueries({ queryKey: ['forecast'] })
    },
  })
}

// ---------------------------------------------------------------- 会话与管理面

/**
 * 当前会话。
 *
 * 401 不是错误，是「没登录」——所以 retry 关掉、并把 UnauthorizedError
 * 折成 null。如果把它当错误抛给界面，每个页面都要写一遍「加载失败」
 * 的处理，而实际上什么都没坏。
 */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async (): Promise<User | null> => {
      try {
        const d = await transport.me()
        return {
          username: d.user.username,
          displayName: d.user.display_name || d.user.username,
          role: isRole(d.user.role) ? d.user.role : 'viewer',
          roleLabel: d.user.role_label || ROLE_LABEL[isRole(d.user.role) ? d.user.role : 'viewer'],
          disabled: false,
          createdAt: null,
          lastLoginAt: null,
        }
      } catch (e) {
        if (e instanceof UnauthorizedError) return null
        throw e
      }
    },
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { username: string; password: string }) =>
      transport.login(v.username, v.password),
    onSuccess: (d) => {
      // 登录后把整个缓存作废：上一个用户的 overview/alerts 不该留在内存里。
      qc.clear()
      qc.setQueryData(qk.me, A.adaptUser(d.user))
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => transport.logout(),
    onSettled: () => {
      qc.clear()
      qc.setQueryData(qk.me, null)
    },
  })
}

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: qk.users,
    queryFn: async () => (await transport.users()).users.map(A.adaptUser),
    enabled,
    staleTime: 30_000,
  })
}

export function useCreateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { username: string; displayName: string; role: Role; password: string }) =>
      transport.createUser({
        username: v.username,
        display_name: v.displayName,
        role: v.role,
        password: v.password,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  })
}

export function usePatchUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: {
      username: string
      displayName?: string
      role?: Role
      password?: string
      disabled?: boolean
    }) =>
      transport.patchUser(v.username, {
        display_name: v.displayName,
        role: v.role,
        password: v.password,
        disabled: v.disabled,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] })
      // 改的可能是自己（改口令），会话会被后端踢掉，重新问一次
      void qc.invalidateQueries({ queryKey: ['me'] })
    },
  })
}

export function useAudit(hours = 24, username = '') {
  return useQuery({
    queryKey: qk.audit(hours, username),
    queryFn: async (): Promise<AuditEntry[]> =>
      (await transport.audit(hours, username)).entries.map(A.adaptAuditEntry),
    refetchInterval: 30_000,
  })
}

export function useChannels() {
  return useQuery({
    queryKey: qk.channels,
    queryFn: async (): Promise<NotifyChannel[]> =>
      (await transport.channels()).channels.map(A.adaptChannel),
    refetchInterval: 60_000,
  })
}

export function useSaveChannel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: {
      name: string
      enabled: boolean
      endpoint: string
      secret: string
      minLevel: Level
      debounceMin: number
    }) =>
      transport.saveChannel(v.name, {
        enabled: v.enabled,
        endpoint: v.endpoint,
        secret: v.secret,
        min_level: v.minLevel,
        debounce_min: v.debounceMin,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['channels'] }),
  })
}

export function useDeliveries(limit = 50) {
  return useQuery({
    queryKey: qk.deliveries,
    queryFn: async (): Promise<Delivery[]> =>
      (await transport.deliveries(limit)).deliveries.map(A.adaptDelivery),
    refetchInterval: 30_000,
  })
}

export function useTestChannel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (channel: string) => transport.testChannel(channel),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['deliveries'] }),
  })
}
