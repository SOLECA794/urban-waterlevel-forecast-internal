import type { SimTime } from './time'

/**
 * 审计记录。
 *
 * 这是"人做过什么"的账本，和遥测/预测那本"系统看到了什么"的账完全分开：
 * 前者用于事故复盘与责任追溯，后者是模型的输入。
 * 混在一张表里会逼着两边都去理解对方的字段。
 */
export interface AuditEntry {
  readonly id: number
  readonly at: SimTime
  readonly username: string
  readonly role: string
  /** 操作动词，如「确认预警」「切换生效模型」。写入时就翻译好，见 httpapi/authmw.go。 */
  readonly summary: string
  readonly method: string
  readonly path: string
  readonly status: number
  readonly durationMs: number
  readonly ip: string
  readonly requestId: string
}

/** 写操作的结果分类。用 4xx/5xx 的语义，而不是自定义枚举。 */
export type AuditOutcome = 'ok' | 'rejected' | 'failed'

export function auditOutcome(e: AuditEntry): AuditOutcome {
  if (e.status >= 500) return 'failed'
  if (e.status >= 400) return 'rejected'
  return 'ok'
}

export const AUDIT_OUTCOME_LABEL: Record<AuditOutcome, string> = {
  ok: '成功',
  rejected: '被拒',
  failed: '失败',
}

/**
 * 审计里的敏感路径。
 *
 * 账号接口的请求体里有口令，虽然我们只记路径不记 body，但路径里带
 * 用户名的那些行仍然不该被随手下发到只读角色手里——所以这些接口
 * 本身就只有 admin 能看（见 httpapi/router.go 的管理段）。
 */
export function isSensitiveAuditPath(path: string): boolean {
  return path.startsWith('/api/users') || path.startsWith('/api/auth')
}
