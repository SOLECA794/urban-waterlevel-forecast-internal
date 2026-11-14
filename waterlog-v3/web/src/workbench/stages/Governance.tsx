import { useMemo, useState } from 'react'
import { useAudit, useChannels, useDeliveries, usePatchUser, useUsers } from '../../data/queries'
import { useWatchlist } from '../../view/useWatchlist'
import { useSession } from '../../view/useSession'
import { Emph } from '../../components/primitives/Rich'
import {
  AUDIT_OUTCOME_LABEL,
  CHANNEL_HINT,
  CHANNEL_LABEL,
  LEVEL_LABEL,
  ROLE_HINT,
  ROLE_LABEL,
  ROLE_RANK,
  ROLES,
  auditOutcome,
  can,
  canDisableChannel,
  fmtTime,
  isChannelLive,
  isSensitiveAuditPath,
  minRoleFor,
  type AuditEntry,
  type Delivery,
  type NotifyChannel,
  type Role,
  type User,
} from '../../domain'
import { Block, Figure, Nothing, Pill, Ruler, Shimmer } from '../kit'
import { W, ease } from '../visual'
import type { StageCtx } from '../ctx'

/**
 * 舞台八：治理。
 *
 * 这一块不是「账号 / 审计 / 推送」三个功能的合集，而是**一条责任链上的三个事实**：
 *
 *     ① 谁能动          ② 动了什么        ③ 通知了谁
 *     （账号与角色）     （审计账本）      （渠道与投递）
 *
 * 排成三列而不是三个标签页，是因为这个**顺序本身就是信息**：出了事要问
 * 「谁有这个权限 → 他到底点了什么 → 通知发出去没有」。标签页会把这条因果链
 * 拆成三个互不相邻的房间，中间那段因果关系就没人负责了。
 * 三列等宽、不留主次——链上三段没有谁的优先级更高；每列的 `sub` 写清它回答哪一问。
 *
 * 权限一律走领域层的 `can()`，这里不重写一遍判断：
 * `user:manage` / `audit:read` / `notify:manage` 都要 admin，所以值班员和只读
 * 进来会看到大半列写着「当前角色不可见」。**那几句话是内容，不是空态**——
 * 空白列表会被读成「系统里没有账号 / 没有审计 / 没有渠道」，而真实原因是
 * 「你没有这个权限」，这两件事的处置方式完全不同。
 */
export function GovernanceStage({ ctx }: { ctx: StageCtx }) {
  const session = useSession()
  const me = session.user

  return (
    <div
      style={{
        flex: '1 1 0',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <ChainBar me={me} />
      <div
        style={{
          flex: '1 1 0',
          minHeight: 0,
          display: 'grid',
          // 三列等宽：它们是同一条链上的三段，不该有一列看起来更重要。
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12,
        }}
      >
        <AccountColumn me={me} ctx={ctx} />
        <AuditColumn me={me} ctx={ctx} />
        <NotifyColumn me={me} ctx={ctx} />
      </div>
    </div>
  )
}

/**
 * 链头。
 *
 * 三列之间如果没有这根横线，读者会把它们看成「治理页面的三个模块」；
 * 有了它，三列才有方向：左→右是「授权 → 执行 → 告知」。
 * 它同时回答一个实际问题：**以我现在的身份，这条链我能走到第几环**。
 */
function ChainBar({ me }: { me: User | null }) {
  const steps = [
    { mark: '①', label: '谁能动', cap: 'user:manage', ok: can(me, 'user:manage') } as const,
    { mark: '②', label: '动了什么', cap: 'audit:read', ok: can(me, 'audit:read') } as const,
    { mark: '③', label: '通知了谁', cap: 'notify:manage', ok: can(me, 'notify:manage') } as const,
  ]
  const reachable = steps.filter((s) => s.ok).length
  const summary =
    me === null
      ? '还没登录：这条链一环也走不通。'
      : reachable === 3
        ? `你是${ROLE_LABEL[me.role]}，三环都走得通——改权限这件事本身也会被记进审计。`
        : reachable === 0
          ? `你是${ROLE_LABEL[me.role]}，三环都不可达。这不是故障：治理面按设计只对${ROLE_LABEL[minRoleFor('audit:read')]}开放。`
          : `你是${ROLE_LABEL[me.role]}，三环里走得通 ${reachable} 环。`

  return (
    <div
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '7px 10px',
        border: `1px solid ${W.line}`,
        borderRadius: 8,
        background: W.rail,
      }}
    >
      <span style={{ fontSize: 10.5, color: W.ink4, letterSpacing: 0.4 }}>责任链</span>
      {steps.map((s, i) => (
        <span key={s.cap} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Pill
            tone={s.ok ? W.accent : W.ink4}
            fill={s.ok}
            title={s.ok ? '当前角色可达' : `需要${ROLE_LABEL[minRoleFor(s.cap)]}及以上`}
          >
            {s.mark} {s.label}
          </Pill>
          {i < steps.length - 1 && (
            <span style={{ fontSize: 11, color: s.ok ? W.ink3 : W.ink4 }}>→</span>
          )}
        </span>
      ))}
      <span
        style={{
          marginLeft: 'auto',
          fontSize: 10.5,
          color: W.ink3,
          lineHeight: 1.55,
          textAlign: 'right',
        }}
      >
        {summary}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- ① 谁能动

function AccountColumn({ me, ctx }: { me: User | null; ctx: StageCtx }) {
  const canManage = can(me, 'user:manage')
  // 账号清单是 admin 独占接口。`useUsers` 有 enabled 开关，所以权限不够时**不发这个请求**：
  // 一次注定 403 的往返既拿不到数据，还会在浏览器控制台留一条像故障的红字。
  // 看不到的原因用下面那段说明补上，比一条红色的网络错误清楚得多。
  const users = useUsers(canManage)
  const patch = usePatchUser()
  const [openUser, setOpenUser] = useState<string | null>(null)
  // 待确认的角色变更。就地确认而不是弹窗：弹窗会遮住这一行的旧角色，
  // 而改权限最需要同时看见「原来是几级、要改成几级、这个人是谁」。
  const [pending, setPending] = useState<{ user: User; role: Role } | null>(null)

  const list = users.data ?? []

  const byRole = useMemo(() => {
    const m: Record<Role, number> = { admin: 0, operator: 0, viewer: 0 }
    for (const u of list) m[u.role] += 1
    return m
  }, [list])

  const ordered = useMemo(
    () => list.slice().sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.username.localeCompare(b.username)),
    [list],
  )
  const never = list.filter((u) => u.lastLoginAt === null)
  const disabled = list.filter((u) => u.disabled)
  const lastSeen = list.reduce<{ at: number; who: string } | null>((acc, u) => {
    const at = u.lastLoginAt
    if (at === null) return acc
    if (acc && acc.at >= at) return acc
    return { at, who: u.displayName || u.username }
  }, null)

  return (
    <Block
      title="① 谁能动"
      sub="账号与角色：这条链上谁有手"
      aside={<Pill tone={W.ink4}>{canManage ? `${list.length} 个账号` : '受限'}</Pill>}
      grow
      pad={10}
    >
      <div
        style={{
          flex: '1 1 0',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
        }}
      >
        {!canManage && (
          <>
            <NotVisible
              me={me}
              cap="账号清单"
              need={minRoleFor('user:manage')}
              why="这一列记的是「谁被授予了什么角色」，等于把系统的攻击面摊开写。所以它只对能改它的人开放——看得见却改不动，只会让人误以为能改。"
            />
            {/* 权限不够时不等于这一列没有内容：我自己的身份仍然是事实，
                而且它正好回答了「我在链上的什么位置」。 */}
            {me && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10.5, color: W.ink4 }}>你自己的那一行</span>
                <RowLine k={me.displayName || me.username} v={ROLE_LABEL[me.role]} />
                <RowLine k="上次登录" v={fmtTime(me.lastLoginAt, 'MM-DD HH:mm')} />
                <span style={{ fontSize: 10.5, color: W.ink4, lineHeight: 1.6 }}>
                  {ROLE_HINT[me.role]}
                </span>
              </div>
            )}
          </>
        )}

        {canManage && users.isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <Shimmer h={26} w="70%" />
            <Shimmer h={12} />
            <Shimmer h={12} w="85%" />
            <Shimmer h={12} w="60%" />
          </div>
        )}

        {canManage && users.error && (
          <RetryBox
            title="账号清单没取到"
            raw={(users.error as Error).message}
            onRetry={() =>
              void users.refetch().then((r) => {
                if (r.error) ctx.toast('err', (r.error as Error).message)
              })
            }
          />
        )}

        {canManage && users.data && (
          <>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Figure value={list.length} unit="个" label="账号总数" size={24} />
              <Figure
                value={disabled.length}
                unit="个"
                label="已停用"
                size={24}
                tone={disabled.length > 0 ? W.warn : W.ink2}
                hint="停用后 can() 一律 false：号还在，谁也进不来"
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 10.5, color: W.ink4 }}>角色分布</span>
              {ROLES.map((r) => (
                <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 7 }} title={ROLE_HINT[r]}>
                  <span style={{ width: 52, fontSize: 10.5, color: W.ink2, flex: '0 0 auto' }}>
                    {ROLE_LABEL[r]}
                  </span>
                  <span style={{ flex: '1 1 0', minWidth: 30 }}>
                    <Ruler
                      ratio={list.length > 0 ? byRole[r] / list.length : 0}
                      color={r === 'admin' ? W.accent : r === 'operator' ? W.ink2 : W.ink4}
                      height={6}
                    />
                  </span>
                  <span
                    style={{
                      width: 16,
                      textAlign: 'right',
                      fontSize: 12,
                      fontWeight: 600,
                      fontFamily: W.mono,
                      fontVariantNumeric: 'tabular-nums',
                      color: byRole[r] > 0 ? W.ink : W.ink4,
                    }}
                  >
                    {byRole[r]}
                  </span>
                </div>
              ))}
              {/* 角色不是「等级待遇」，是三种工作节奏。人数少的那档不是低权限，是低频。 */}
              <span style={{ fontSize: 10, color: W.ink4, lineHeight: 1.6, marginTop: 2 }}>
                管理员一天点几次，值班员一直在点，只读只看不写——人数多少反映的是节奏，不是级别。
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <RowLine
                k="最近一次登录"
                v={lastSeen ? `${fmtTime(lastSeen.at, 'MM-DD HH:mm')} · ${lastSeen.who}` : '—'}
              />
              {never.length === 0 ? (
                <RowLine k="从未登录" v="没有——每个账号都至少用过一次" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {/* 「给了账号但没人用」是账号管理里唯一真正要处理的信号：
                      要么人走了没回收，要么口令没送到人手上。 */}
                  <span style={{ fontSize: 10.5, color: W.warn }}>
                    {never.length} 个账号从未登录过
                  </span>
                  <span style={{ fontSize: 11, color: W.ink2, lineHeight: 1.65 }}>
                    {never.map((u) => u.displayName || u.username).join('、')}
                  </span>
                  <span style={{ fontSize: 10, color: W.ink4, lineHeight: 1.55 }}>
                    要么口令没送到人手上，要么人已经不在这个岗上了——两种都该在这里处理掉。
                  </span>
                </div>
              )}
            </div>

            <div style={{ borderTop: `1px solid ${W.line}`, paddingTop: 6 }}>
              <span style={{ fontSize: 10.5, color: W.ink4 }}>账号清单（点开可改角色）</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {ordered.map((u) => {
                const open = openUser === u.username
                const self = me !== null && me.username === u.username
                return (
                  <div key={u.username} style={{ borderBottom: `1px solid ${W.lineSoft}` }}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenUser(open ? null : u.username)
                        setPending(null)
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 6,
                        width: '100%',
                        padding: '5px 2px',
                        border: 0,
                        background: open ? W.accentSoft : 'transparent',
                        cursor: 'pointer',
                        font: 'inherit',
                        textAlign: 'left',
                        borderRadius: 4,
                        transition: `background 140ms ${ease}`,
                      }}
                      title={`${u.username} · 最近登录 ${fmtTime(u.lastLoginAt, 'MM-DD HH:mm')}`}
                    >
                      <span
                        style={{
                          fontSize: 11.5,
                          color: u.disabled ? W.ink4 : W.ink,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {u.displayName || u.username}
                        {self && <span style={{ color: W.ink4 }}>（你）</span>}
                      </span>
                      <Pill tone={roleTone(u.role)}>{ROLE_LABEL[u.role]}</Pill>
                      <span
                        style={{
                          marginLeft: 'auto',
                          flex: '0 0 auto',
                          fontSize: 10,
                          fontFamily: W.mono,
                          color: u.lastLoginAt === null ? W.warn : W.ink4,
                        }}
                      >
                        {u.lastLoginAt === null ? '未登录' : fmtTime(u.lastLoginAt, 'MM-DD HH:mm')}
                      </span>
                      {u.disabled && <Pill tone={W.warn}>已停用</Pill>}
                    </button>

                    {open && (
                      <div style={{ padding: '2px 2px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                          {ROLES.map((r) =>
                            r === u.role ? (
                              <Pill key={r} tone={roleTone(r)} fill>
                                现在 · {ROLE_LABEL[r]}
                              </Pill>
                            ) : (
                              <button
                                key={r}
                                type="button"
                                onClick={() => setPending({ user: u, role: r })}
                                title={ROLE_HINT[r]}
                                style={btnStyle(W.stage, W.lineStrong, W.ink2)}
                              >
                                改为{ROLE_LABEL[r]}
                              </button>
                            ),
                          )}
                        </div>

                        {pending && pending.user.username === u.username && (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 6,
                              padding: '7px 8px',
                              border: `1px solid ${W.warn}`,
                              borderRadius: 6,
                              background: W.levelWash.yellow,
                            }}
                          >
                            <span style={{ fontSize: 11, color: W.ink2, lineHeight: 1.6 }}>
                              把 <b>{pending.user.displayName || pending.user.username}</b> 从
                              「{ROLE_LABEL[pending.user.role]}」改为
                              「{ROLE_LABEL[pending.role]}」？
                              {self &&
                                ' 这是你自己的账号：改完你会立刻失去管理账号的能力，如果系统里只有你一个管理员，就没人能改回来了。'}
                              {' '}这一步会被记进中间那一列——「谁改了谁的权限」是整条链上最该留痕的一格。
                            </span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                type="button"
                                disabled={patch.isPending}
                                onClick={() => {
                                  patch.mutate(
                                    { username: pending.user.username, role: pending.role },
                                    {
                                      onSuccess: () => {
                                        const done = `${pending.user.username} → ${ROLE_LABEL[pending.role]}`
                                        setPending(null)
                                        setOpenUser(null)
                                        ctx.toast('ok', `已改角色：${done}`)
                                      },
                                      onError: (e) => {
                                        // 后端那句 409/403 的原话本身就是答案（例如「不能停用最后一个管理员」），
                                        // 改写成「操作失败」等于把唯一有用的信息扔掉。
                                        ctx.toast('err', `改角色失败：${(e as Error).message}`)
                                      },
                                    },
                                  )
                                }}
                                style={btnStyle(W.warn, W.warn, '#fff')}
                              >
                                {patch.isPending ? '提交中…' : '确认改角色'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setPending(null)}
                                style={btnStyle('transparent', W.lineStrong, W.ink2)}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </Block>
  )
}

function roleTone(r: Role): string {
  if (r === 'admin') return W.accent
  if (r === 'operator') return W.ink2
  return W.ink4
}

// ---------------------------------------------------------------- ② 动了什么

function AuditColumn({ me, ctx }: { me: User | null; ctx: StageCtx }) {
  const [hours, setHours] = useState(24)
  const [who, setWho] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  // 这里**故意照发不误**：`useAudit` 没有 enabled 开关，而它失败时后端会回一句
  // 「当前角色（只读）无权执行该操作，需要系统管理员及以上」——
  // 那句话比任何前端自己编的「无权查看」都准确，而且它顺带说明了这条链断在哪一环。
  // （账号那一列不这么做，是因为 `useUsers` 有开关，能省掉一次注定失败的往返。）
  const q = useAudit(hours, who)
  const rows = q.data ?? []

  const stat = useMemo(() => {
    const people = new Set(rows.map((r) => r.username))
    let rejected = 0
    let failed = 0
    for (const r of rows) {
      const o = auditOutcome(r)
      if (o === 'rejected') rejected += 1
      else if (o === 'failed') failed += 1
    }
    return { people: people.size, rejected, failed }
  }, [rows])

  const shown = rows.slice(0, 40)

  return (
    <Block
      title="② 动了什么"
      sub="审计：写操作的账本，只记人、不记机器"
      aside={<Pill tone={W.ink4}>{rows.length} 条</Pill>}
      grow
      pad={10}
    >
      <div
        style={{
          flex: '1 1 0',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10.5, color: W.ink4 }}>窗口</span>
          {[6, 24, 72].map((h) => (
            <Pill
              key={h}
              tone={hours === h ? W.accent : W.ink4}
              fill={hours === h}
              onClick={() => setHours(h)}
              title={`只看最近 ${h} 小时`}
            >
              {h}h
            </Pill>
          ))}
          {who !== '' && (
            <Pill tone={W.ink2} onClick={() => setWho('')} title="点一下取消这个人名过滤">
              只看 {who} ×
            </Pill>
          )}
        </div>

        {q.error && (
          <NotVisible
            me={me}
            cap="审计账本"
            need={minRoleFor('audit:read')}
            why="审计记的是谁在什么时候改了规则、换了模型、动了账号。它是追责用的，不是展示用的——所以能看它的人必须是能被追责的那个人。"
            raw={(q.error as Error).message}
          />
        )}

        {q.error && (
          <RetryBtn
            label="再试一次"
            onClick={() =>
              void q.refetch().then((r) => {
                // 失败时把后端原话交给顶栏那个 toast，不做任何改写与截断。
                if (r.error) ctx.toast('err', (r.error as Error).message)
              })
            }
          />
        )}

        {!q.error && q.isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Shimmer h={22} w="60%" />
            <Shimmer h={30} />
            <Shimmer h={30} />
            <Shimmer h={30} />
          </div>
        )}

        {!q.error && q.data && rows.length === 0 && (
          <Nothing
            why={`这 ${hours} 小时内没有任何写操作${who ? `（限 ${who}）` : ''}`}
            hint="这不是故障：没人改过东西。切到 72h 能看到更早的账；也说明这一班处理预警时只动了状态机，没动配置。"
          />
        )}

        {!q.error && rows.length > 0 && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <MiniStat v={String(rows.length)} label="条写操作" />
            <MiniStat v={String(stat.people)} label="个人动手" />
            <MiniStat
              v={String(stat.rejected + stat.failed)}
              label="被拒/失败"
              tone={stat.rejected + stat.failed > 0 ? W.warn : undefined}
            />
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {shown.map((e) => (
            <AuditRow
              key={e.id}
              e={e}
              open={openId === e.id}
              onToggle={() => setOpenId(openId === e.id ? null : e.id)}
              onFilterUser={() => setWho(e.username)}
            />
          ))}
        </div>

        {rows.length > shown.length && (
          <span style={{ fontSize: 10, color: W.ink4 }}>
            只渲染最近 {shown.length} 条，共 {rows.length} 条——按人名过滤能看得更集中。
          </span>
        )}

        {/* 这一行是设计说明，不是脚注摆设：不写清楚，读者会把「引擎推送没进审计」
            当成漏记，然后去查一个不存在的 bug。 */}
        <div
          style={{
            marginTop: 'auto',
            paddingTop: 6,
            borderTop: `1px solid ${W.lineSoft}`,
            fontSize: 10,
            color: W.ink4,
            lineHeight: 1.65,
          }}
        >
          审计里永远看不到 <code style={{ fontFamily: W.mono }}>/api/ingest/*</code>：
          中间件在那条路径上直接放行，不记。那几条请求是引擎每几秒一次的心跳，
          <Emph
            text={'记进来会把人的操作整段淹没，而这一列要回答的是「**人**做了什么」。这是设计决定，不是缺漏。'}
          />
        </div>
      </div>
    </Block>
  )
}

function AuditRow({
  e,
  open,
  onToggle,
  onFilterUser,
}: {
  e: AuditEntry
  open: boolean
  onToggle: () => void
  onFilterUser: () => void
}) {
  const out = auditOutcome(e)
  const tone = out === 'ok' ? W.ok : out === 'rejected' ? W.warn : W.bad
  const sensitive = isSensitiveAuditPath(e.path)

  return (
    <div style={{ borderBottom: `1px solid ${W.lineSoft}` }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          width: '100%',
          padding: '5px 2px',
          border: 0,
          background: open ? W.accentSoft : 'transparent',
          cursor: 'pointer',
          font: 'inherit',
          textAlign: 'left',
          borderRadius: 4,
          transition: `background 140ms ${ease}`,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span
            style={{
              fontSize: 10,
              color: W.ink4,
              fontFamily: W.mono,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {fmtTime(e.at, 'MM-DD HH:mm:ss')}
          </span>
          <span style={{ fontSize: 11, color: W.ink2 }}>{e.username}</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, flex: '0 0 auto' }}>
            {sensitive && (
              <Pill tone={W.warn} title="账号 / 登录相关路径：路径里带用户名，只给管理员看">
                敏感
              </Pill>
            )}
            <Pill tone={tone} fill={out !== 'ok'}>
              {AUDIT_OUTCOME_LABEL[out]} {e.status}
            </Pill>
          </span>
        </span>
        <span style={{ fontSize: 11.5, color: W.ink, lineHeight: 1.45 }}>{e.summary}</span>
        <span
          style={{
            fontSize: 10,
            color: W.ink4,
            fontFamily: W.mono,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {e.method} {e.path}
        </span>
      </button>

      {open && (
        <div style={{ padding: '2px 2px 8px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <RowLine k="角色" v={e.role || '—'} />
          <RowLine k="耗时" v={`${e.durationMs} ms`} />
          <RowLine k="来源 IP" v={e.ip || '—'} />
          {/* requestId 是追一次事故的把手：拿它去后端日志里能捞到同一次请求的全部输出。 */}
          <RowLine k="requestId" v={e.requestId || '—'} />
          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            <RetryBtn label={`只看 ${e.username}`} onClick={onFilterUser} tone={W.accent} />
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- ③ 通知了谁

function NotifyColumn({ me, ctx }: { me: User | null; ctx: StageCtx }) {
  // 同审计那一列：这两个 hook 没有 enabled 开关，就让 403 说话。
  const ch = useChannels()
  const dl = useDeliveries(50)
  const glance = useWatchlist('level')
  const [openId, setOpenId] = useState<number | null>(null)

  const channels = ch.data ?? []
  const deliveries = dl.data ?? []
  const nameOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of glance) m.set(g.site.id, g.site.name)
    return m
  }, [glance])

  const live = channels.filter(isChannelLive).length
  const failed = deliveries.filter((d) => !d.ok)

  return (
    <Block
      title="③ 通知了谁"
      sub="渠道与投递：这条链最后一段有没有把话送到人"
      aside={<Pill tone={W.ink4}>{channels.length} 个渠道</Pill>}
      grow
      pad={10}
    >
      <div
        style={{
          flex: '1 1 0',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {ch.error && (
          <NotVisible
            me={me}
            cap="推送渠道与投递记录"
            need={minRoleFor('notify:manage')}
            why="渠道配置里有外部地址与密钥；投递记录等于把「哪条预警没送出去」摊开。改它和看它都只给管理员。"
            raw={(ch.error as Error).message}
          />
        )}

        {ch.error && (
          <RetryBtn
            label="再试一次"
            onClick={() =>
              void ch.refetch().then((r) => {
                if (r.error) ctx.toast('err', (r.error as Error).message)
              })
            }
          />
        )}

        {!ch.error && ch.isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Shimmer h={54} />
            <Shimmer h={54} />
            <Shimmer h={30} />
          </div>
        )}

        {!ch.error && ch.data && (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <MiniStat v={String(channels.length)} label="个渠道" />
              <MiniStat
                v={String(live)}
                label="个能发出去"
                tone={live < channels.length ? W.warn : W.ok}
              />
              <MiniStat v={String(deliveries.length)} label="次近期投递" />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {channels.map((c) => (
                <ChannelCard key={c.name} c={c} />
              ))}
            </div>

            <div
              style={{
                borderTop: `1px solid ${W.line}`,
                paddingTop: 6,
                display: 'flex',
                alignItems: 'baseline',
                gap: 6,
              }}
            >
              <span style={{ fontSize: 10.5, color: W.ink4 }}>最近投递</span>
              {failed.length > 0 && (
                <Pill tone={W.bad} fill title="失败也留痕：值班员要能证明这条没推出去">
                  {failed.length} 条失败
                </Pill>
              )}
            </div>

            {dl.error && (
              <RetryBox
                title="投递记录没取到"
                raw={(dl.error as Error).message}
                onRetry={() =>
                  void dl.refetch().then((r) => {
                    if (r.error) ctx.toast('err', (r.error as Error).message)
                  })
                }
              />
            )}

            {!dl.error && dl.data && deliveries.length === 0 && (
              <Nothing
                why="还没有任何一次推送"
                hint="渠道配好了但一次都没用过时是正常的——第一条达到 minLevel 的预警才会产生投递记录。"
              />
            )}

            {deliveries.map((d) => (
              <DeliveryRow
                key={d.id}
                d={d}
                siteName={nameOf.get(d.siteId) ?? d.siteId}
                open={openId === d.id}
                onToggle={() => setOpenId(openId === d.id ? null : d.id)}
                onOpenSite={() => {
                  // 大屏上「这条没推出去」的下一步一定是「那个站现在怎么样」，
                  // 所以点它就往右栏压一层站点，而不是另开一个页面。
                  ctx.openSite(d.siteId, nameOf.get(d.siteId))
                  ctx.toast('info', `右栏已打开 ${nameOf.get(d.siteId) ?? d.siteId} 的钻取`)
                }}
              />
            ))}
          </>
        )}
      </div>
    </Block>
  )
}

function ChannelCard({ c }: { c: NotifyChannel }) {
  const label = CHANNEL_LABEL[c.name] ?? c.name
  const alive = isChannelLive(c)
  const locked = !canDisableChannel(c.name)
  return (
    <div
      style={{
        border: `1px solid ${W.line}`,
        borderRadius: 7,
        padding: '7px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: alive ? 'transparent' : W.levelWash.yellow,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: W.ink }}>{label}</span>
        <Pill tone={alive ? W.ok : W.warn}>{alive ? '可用' : c.enabled ? '缺地址' : '已停用'}</Pill>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: W.ink4 }}>
          {fmtTime(c.updatedAt, 'MM-DD HH:mm')}
        </span>
      </div>
      <span style={{ fontSize: 10, color: W.ink4, lineHeight: 1.55 }}>{CHANNEL_HINT[c.name] ?? ''}</span>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, color: W.ink2 }}>
        <span>
          起点 <b style={{ color: W.levelInk[c.minLevel] }}>{LEVEL_LABEL[c.minLevel]}</b>
        </span>
        <span>去抖 {c.debounceMin}m</span>
        {c.name !== 'inapp' && (
          <span
            style={{
              fontFamily: W.mono,
              maxWidth: 150,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={c.endpoint}
          >
            {c.endpoint || '（未填地址）'}
          </span>
        )}
        {/* 密钥只说有没有配，连打码串都不印在屏幕上：这一列经常被人拍照发群里。 */}
        {c.name !== 'inapp' && (
          <span style={{ color: c.secret ? W.ink3 : W.warn }}>
            {c.secret ? '密钥已配置' : '密钥未配置'}
          </span>
        )}
      </div>
      {locked && (
        <span style={{ fontSize: 10, color: W.ink4, lineHeight: 1.5 }}>
          没有开关：站内弹窗永远启用。关掉它等于把预警的可靠性押在第三方可用性上。
        </span>
      )}
    </div>
  )
}

function DeliveryRow({
  d,
  siteName,
  open,
  onToggle,
  onOpenSite,
}: {
  d: Delivery
  siteName: string
  open: boolean
  onToggle: () => void
  onOpenSite: () => void
}) {
  return (
    <div style={{ borderBottom: `1px solid ${W.lineSoft}` }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          width: '100%',
          padding: '4px 2px',
          border: 0,
          background: open ? W.accentSoft : 'transparent',
          cursor: 'pointer',
          font: 'inherit',
          textAlign: 'left',
          borderRadius: 4,
          transition: `background 140ms ${ease}`,
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: W.ink4,
            fontFamily: W.mono,
            flex: '0 0 auto',
          }}
        >
          {fmtTime(d.at, 'MM-DD HH:mm')}
        </span>
        <span
          style={{
            fontSize: 11,
            color: W.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {siteName}
        </span>
        <span style={{ fontSize: 10, color: W.levelInk[d.level], flex: '0 0 auto' }}>
          {LEVEL_LABEL[d.level]}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, flex: '0 0 auto' }}>
          <Pill tone={W.ink4}>{CHANNEL_LABEL[d.channel] ?? d.channel}</Pill>
          <Pill tone={d.ok ? W.ok : W.bad} fill={!d.ok}>
            {d.ok ? '送达' : '失败'}
          </Pill>
        </span>
      </button>
      {/* 失败原因直接摊开、不藏在展开里：这一列的重点就是「为什么没送到」。 */}
      {!d.ok && d.detail && (
        <span
          style={{
            display: 'block',
            fontSize: 10,
            color: W.bad,
            lineHeight: 1.55,
            padding: '0 2px 5px',
            wordBreak: 'break-all',
          }}
        >
          {d.detail}
        </span>
      )}
      {open && (
        <div style={{ padding: '0 2px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {d.ok && d.detail && (
            <span style={{ fontSize: 10, color: W.ink3, lineHeight: 1.55, wordBreak: 'break-all' }}>
              后端回执：{d.detail}
            </span>
          )}
          <span style={{ fontSize: 10, color: W.ink4, fontFamily: W.mono }}>
            站点 {d.siteId} · 投递 #{d.id}
          </span>
          <div>
            <RetryBtn label={`看 ${siteName} 现在怎么样`} onClick={onOpenSite} tone={W.accent} />
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 共用小件

/** 一行「标签 → 值」。紧凑到能塞进 300px 宽的列里。 */
function RowLine({ k, v }: { k: string; v: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: 10.5, color: W.ink3, flex: '0 0 auto' }}>{k}</span>
      <span
        style={{
          marginLeft: 'auto',
          fontSize: 11,
          color: W.ink,
          fontFamily: W.mono,
          fontVariantNumeric: 'tabular-nums',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {v}
      </span>
    </span>
  )
}

function MiniStat({ v, label, tone }: { v: string; label: string; tone?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
      <span
        style={{
          fontSize: 17,
          fontWeight: 600,
          color: tone ?? W.ink,
          fontFamily: W.mono,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {v}
      </span>
      <span style={{ fontSize: 10, color: W.ink4 }}>{label}</span>
    </span>
  )
}

/**
 * 「当前角色不可见」。
 *
 * 三句话缺一不可：看不见（what）/ 为什么这样设计（why）/ 需要谁才能看（who）。
 * 只说第一句，读者会以为界面坏了；补上后两句，他知道该找谁、以及这不是 bug。
 */
function NotVisible({
  me,
  cap,
  need,
  why,
  raw,
}: {
  me: User | null
  cap: string
  need: Role
  why: string
  raw?: string
}) {
  return (
    <div
      style={{
        border: `1px solid ${W.line}`,
        borderRadius: 6,
        padding: '9px 10px',
        background: W.lineSoft,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <span style={{ fontSize: 11.5, fontWeight: 600, color: W.ink2 }}>当前角色不可见</span>
      <span style={{ fontSize: 11, color: W.ink3, lineHeight: 1.65 }}>{why}</span>
      <span style={{ fontSize: 11, color: W.ink3, lineHeight: 1.65 }}>
        {cap} 需要 <b style={{ color: W.ink2 }}>{ROLE_LABEL[need]}</b> 及以上，你现在是{' '}
        <b style={{ color: W.ink2 }}>{me ? ROLE_LABEL[me.role] : '未登录'}</b>。
      </span>
      {raw && (
        <span
          style={{
            fontSize: 10,
            color: W.ink4,
            fontFamily: W.mono,
            lineHeight: 1.55,
            wordBreak: 'break-all',
          }}
        >
          后端原话：{raw}
        </span>
      )}
    </div>
  )
}

/** 请求失败的兜底：标题 + 后端原话 + 重试。原话一个字都不改。 */
function RetryBox({ title, raw, onRetry }: { title: string; raw: string; onRetry: () => void }) {
  return (
    <div
      style={{
        border: `1px solid ${W.bad}33`,
        borderRadius: 6,
        padding: '8px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <span style={{ fontSize: 11, color: W.bad }}>{title}</span>
      <span style={{ fontSize: 10, color: W.ink3, lineHeight: 1.55, wordBreak: 'break-all' }}>
        {raw}
      </span>
      <div>
        <RetryBtn label="重试" onClick={onRetry} tone={W.ink2} />
      </div>
    </div>
  )
}

function RetryBtn({
  label,
  onClick,
  tone = W.ink2,
}: {
  label: string
  onClick: () => void
  tone?: string
}) {
  return (
    <button type="button" onClick={onClick} style={btnStyle('transparent', W.lineStrong, tone)}>
      {label}
    </button>
  )
}

function btnStyle(bg: string, border: string, ink: string) {
  return {
    border: `1px solid ${border}`,
    borderRadius: 5,
    padding: '3px 8px',
    fontSize: 10.5,
    lineHeight: 1.5,
    color: ink,
    background: bg,
    cursor: 'pointer' as const,
    font: 'inherit',
    whiteSpace: 'nowrap' as const,
  }
}
