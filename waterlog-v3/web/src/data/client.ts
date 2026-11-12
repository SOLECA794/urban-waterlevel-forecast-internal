import type {
  AlertDetailRespDTO,
  AlertNoteDTO,
  AuditRespDTO,
  ChannelsRespDTO,
  DecisionRowDTO,
  DeliveriesRespDTO,
  EvalRespDTO,
  ForecastPayloadDTO,
  HealthRespDTO,
  LoginRespDTO,
  MeRespDTO,
  MetricsRespDTO,
  ModelVersionsRespDTO,
  OverviewRespDTO,
  RetrainStatusDTO,
  RulePreviewRespDTO,
  RulesDocDTO,
  SeriesPointDTO,
  SiteDetailRespDTO,
  SiteMetaDTO,
  UserDTO,
  UsersRespDTO,
  WarningEventDTO,
} from './dto'

/**
 * HTTP 传输层：只做 fetch + 解 JSON + 统一抛错，不认识任何业务概念。
 * 把 DTO 变成领域模型是 adapters 的事，在这里做会让传输层耦合业务规则。
 */

const BASE = ''

/** 后端返回 401 时通知外层。见下方 onUnauthorized。 */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

/**
 * 401 的全局出口。
 *
 * 为什么不做成"每个 query 自己 catch"：会话过期的表现必须是一致的——
 * 不管用户停在哪个页面、正在做什么，都应该被送回登录页，并且带上
 * "登录后回到原处"的信息。散在二十个 query 里各写一遍，一定会漏。
 */
let unauthorizedHandler: (() => void) | null = null

export function onUnauthorized(fn: (() => void) | null) {
  unauthorizedHandler = fn
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    // 会话是 HttpOnly cookie，同源请求必须带上（fetch 默认 same-origin，
    // 这里显式写出来是因为以后接跨域部署时这一行就是唯一要改的地方）。
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const text = await r.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { error: text }
  }
  if (!r.ok) {
    // 后端把业务原因放在 error 字段里（比如「已确认，无需重复确认」）。
    // 这层原话必须透出去——前端吞掉它就只能显示 HTTP 409，值班员看不懂。
    const msg =
      (body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : '') || `HTTP ${r.status}`
    if (r.status === 401) {
      unauthorizedHandler?.()
      throw new UnauthorizedError(msg)
    }
    throw new Error(msg)
  }
  return body as T
}

export const transport = {
  // ---------------------------------------------------------------- 会话
  login: (username: string, password: string) =>
    req<LoginRespDTO>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => req<MeRespDTO>('/api/auth/me'),

  // ---------------------------------------------------------------- 监测
  health: () => req<HealthRespDTO>('/api/health'),
  sites: () => req<{ sites: SiteMetaDTO[] }>('/api/sites'),
  overview: () => req<OverviewRespDTO>('/api/overview'),
  site: (id: string) => req<SiteDetailRespDTO>(`/api/sites/${id}`),
  history: (id: string, hours = 24) =>
    req<{ site_id: string; hours: number; points: SeriesPointDTO[] }>(
      `/api/sites/${id}/history?hours=${hours}`,
    ),
  /** 所有站的历史序列，一次取回（大屏热力图/全域趋势用，避免十站十请求）。 */
  allHistory: (hours = 24) =>
    req<{ hours: number; sites: Record<string, SeriesPointDTO[]> }>(`/api/history?hours=${hours}`),
  forecast: () => req<ForecastPayloadDTO>('/api/forecast'),

  // ---------------------------------------------------------------- 预警
  alerts: (activeOnly = true, limit = 100) =>
    req<{ alerts: WarningEventDTO[] }>(`/api/alerts?active=${activeOnly ? 1 : 0}&limit=${limit}`),
  alertDetail: (id: number) => req<AlertDetailRespDTO>(`/api/alerts/${id}`),
  ack: (id: number) =>
    req<{ ok: boolean; state: string }>(`/api/alerts/${id}/ack`, { method: 'POST' }),
  /** 派单：把处置责任落到具体的人/单位。 */
  assignAlert: (id: number, assignee: string) =>
    req<{ ok: boolean; event: WarningEventDTO }>(`/api/alerts/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ assignee }),
    }),
  /** 推进处置状态。非法迁移后端返回 409 + 中文原因。 */
  setDisposition: (id: number, disposition: string, note?: string) =>
    req<{ ok: boolean; event: WarningEventDTO }>(`/api/alerts/${id}/disposition`, {
      method: 'POST',
      body: JSON.stringify({ disposition, note: note ?? '' }),
    }),
  addNote: (id: number, payload: { text: string; author?: string; kind?: string }) =>
    req<{ ok: boolean; note: AlertNoteDTO }>(`/api/alerts/${id}/notes`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ---------------------------------------------------------------- 模型
  metrics: (windowH = 6) => req<MetricsRespDTO>(`/api/metrics?window_h=${windowH}`),
  decisions: (limit = 40) => req<{ decisions: DecisionRowDTO[] }>(`/api/decisions?limit=${limit}`),
  evalPairs: (hours = 12) => req<EvalRespDTO>(`/api/eval?hours=${hours}`),

  /** 模型版本治理：列出可采纳的历史版本。 */
  modelVersions: () => req<ModelVersionsRespDTO>('/api/models/versions'),
  adoptModel: (version: string) =>
    req<{ ok: boolean; active: string; reloaded: boolean }>(
      `/api/models/adopt?version=${encodeURIComponent(version)}`,
      { method: 'POST' },
    ),

  rules: () => req<RulesDocDTO>('/api/rules'),
  saveRules: (patch: Partial<RulesDocDTO>) =>
    req<{ ok: boolean; rules: RulesDocDTO }>('/api/rules', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  /** 预演：只计算不落盘，用来在保存前看清影响。 */
  previewRules: (patch: Partial<RulesDocDTO>) =>
    req<RulePreviewRespDTO>('/api/rules/preview', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),

  retrain: () => req<{ status: string }>('/api/retrain', { method: 'POST' }),
  retrainStatus: () => req<RetrainStatusDTO>('/api/retrain/status'),

  // ---------------------------------------------------------------- 管理面
  users: () => req<UsersRespDTO>('/api/users'),
  createUser: (payload: { username: string; display_name: string; role: string; password: string }) =>
    req<{ ok: boolean; user: UserDTO }>('/api/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  patchUser: (
    username: string,
    payload: { display_name?: string; role?: string; password?: string; disabled?: boolean },
  ) =>
    req<{ ok: boolean; user: UserDTO }>(`/api/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  audit: (hours = 24, username = '', limit = 100) =>
    req<AuditRespDTO>(
      `/api/audit?hours=${hours}&limit=${limit}${username ? `&username=${encodeURIComponent(username)}` : ''}`,
    ),

  channels: () => req<ChannelsRespDTO>('/api/notify/channels'),
  saveChannel: (
    name: string,
    payload: { enabled: boolean; endpoint: string; secret: string; min_level: string; debounce_min: number },
  ) =>
    req<{ ok: boolean; channel: ChannelsRespDTO['channels'][number] }>(
      `/api/notify/channels/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify(payload) },
    ),
  deliveries: (limit = 50) => req<DeliveriesRespDTO>(`/api/notify/deliveries?limit=${limit}`),
  testChannel: (channel: string) =>
    req<{ ok: boolean; detail: string }>('/api/notify/test', {
      method: 'POST',
      body: JSON.stringify({ channel }),
    }),

  // ---------------------------------------------------------------- 演练
  // 真实系统没有这两个入口（见 docs/03-架构说明.md 的已知边界）
  storm: (peak = 90, dur = 24) =>
    req<{
      ok: boolean
      storm: { start_step: number; dur_steps: number; peak_mm_h: number; sim_minutes: number }
    }>(`/api/sim/storm?peak=${peak}&dur=${dur}`, { method: 'POST' }),
  resetWater: (clearSky = true) =>
    req<{ ok: boolean; sites: number; clear_sky: boolean; dropped_pending: number }>(
      `/api/sim/reset-water?clear_sky=${clearSky ? 'true' : 'false'}`,
      { method: 'POST' },
    ),
}
