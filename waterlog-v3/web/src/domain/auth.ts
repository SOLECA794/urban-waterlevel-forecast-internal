/**
 * 账号、角色与能力。
 *
 * 这一层只描述「谁能做什么」，不描述「怎么鉴权」——
 * 鉴权是 data 层与后端的事。把两者混在一起，会让「这个按钮该不该亮」
 * 变成一次网络请求。
 *
 * 为什么能力表在领域层而不是散落在页面里：
 * 页面上一个按钮亮不亮、后端一个接口通不通，必须是同一个判断。
 * 各写一遍的结果是「界面上能点，点了 403」——这种错在最需要它的时刻最难解释。
 */

/** 三个角色。它们对应三种工作状态，不是简单的权限等级。 */
export type Role = 'admin' | 'operator' | 'viewer'

export const ROLES: readonly Role[] = ['admin', 'operator', 'viewer'] as const

export const ROLE_LABEL: Record<Role, string> = {
  admin: '系统管理员',
  operator: '值班员',
  viewer: '只读',
}

/** 角色的日常动作描述，用在账号管理页里帮人判断该给哪个角色。 */
export const ROLE_HINT: Record<Role, string> = {
  admin: '定规则、换模型、管账号。一天点几次。',
  operator: '确认预警、派单、推进处置、触发降雨注入。一直在点。',
  viewer: '只看不写：领导、外部门、复盘时的旁观者。',
}

/** 角色权重。用「至少达到」而不是「等于」，admin 天然能做 operator 的事。 */
export const ROLE_RANK: Record<Role, number> = { admin: 3, operator: 2, viewer: 1 }

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v)
}

/** 已登录的调用者。 */
export interface User {
  readonly username: string
  readonly displayName: string
  readonly role: Role
  readonly roleLabel: string
  readonly disabled: boolean
  readonly createdAt: number | null
  readonly lastLoginAt: number | null
}

/**
 * 能力清单。
 *
 * 用具体动作而不是「read/write」两个档：真正需要区分的是
 * 「确认预警」和「改规则」——前者值班员每分钟都在做，后者改错会全城误报。
 */
export type Capability =
  | 'alert:ack' // 确认预警（四态轴的唯一人工动作）
  | 'alert:dispatch' // 派单与推进处置
  | 'alert:note' // 写处置备注
  | 'sim:drill' // 降雨过程注入（会污染评估口径，只给值班员）
  | 'rules:preview' // 预演规则影响（只读计算，但属于值班员的分析动作）
  | 'rules:save' // 落盘规则
  | 'model:adopt' // 切换生效模型
  | 'model:retrain' // 触发重训
  | 'user:manage' // 账号管理
  | 'audit:read' // 审计
  | 'notify:manage' // 推送渠道

const MIN_ROLE: Record<Capability, Role> = {
  'alert:ack': 'operator',
  'alert:dispatch': 'operator',
  'alert:note': 'operator',
  'sim:drill': 'operator',
  'rules:preview': 'operator',
  'rules:save': 'admin',
  'model:adopt': 'admin',
  'model:retrain': 'admin',
  'user:manage': 'admin',
  'audit:read': 'admin',
  'notify:manage': 'admin',
}

/** 判断某角色是否具备某能力。user 为 null（未登录）时一律 false。 */
export function can(user: User | null | undefined, cap: Capability): boolean {
  if (!user) return false
  if (user.disabled) return false
  return ROLE_RANK[user.role] >= ROLE_RANK[MIN_ROLE[cap]]
}

/** 该能力要求的最低角色，用于生成「需要XX及以上」这类提示。 */
export function minRoleFor(cap: Capability): Role {
  return MIN_ROLE[cap]
}

/** 某个页面需要的最低角色（导航按此过滤）。 */
export const PAGE_MIN_ROLE = {
  overview: 'viewer',
  sites: 'viewer',
  alerts: 'viewer',
  model: 'viewer',
  rules: 'viewer',
  system: 'viewer',
  admin: 'admin',
} as const satisfies Record<string, Role>

export function canSeePage(user: User | null | undefined, page: keyof typeof PAGE_MIN_ROLE): boolean {
  if (!user) return false
  return ROLE_RANK[user.role] >= ROLE_RANK[PAGE_MIN_ROLE[page]]
}

/** 登录成功后返回的会话信息。 */
export interface Session {
  readonly user: User
  /** 会话有效期（秒），用于前端提前提示「快过期了」。 */
  readonly expiresIn: number
}
