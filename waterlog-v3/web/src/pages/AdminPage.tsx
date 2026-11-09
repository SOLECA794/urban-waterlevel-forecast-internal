import { useMemo, useState } from 'react'
import {
  AUDIT_OUTCOME_LABEL,
  auditOutcome,
  can,
  CHANNEL_HINT,
  CHANNEL_LABEL,
  canDisableChannel,
  fmtTime,
  isChannelLive,
  LEVEL_LABEL,
  ROLE_HINT,
  ROLE_LABEL,
  ROLES,
  type Level,
  type NotifyChannel,
  type Role,
} from '../domain'
import {
  useAudit,
  useChannels,
  useCreateUser,
  useDeliveries,
  usePatchUser,
  useSaveChannel,
  useTestChannel,
  useUsers,
} from '../data/queries'
import { useSession } from '../view/useSession'
import { EmptyState, KeyValue, SectionHead, Skeleton } from '../components/primitives/Bits'
import { StatCard } from '../components/primitives/Stat'
import { LevelChip, Tag } from '../components/domain/LevelChip'
import { Icon } from '../components/primitives/Icons'
import { T } from '../utils/tokens'

/**
 * 管理台。
 *
 * 三块内容放一页而不是三个页面：它们都是"一个月看两次"的东西，
 * 分三页只会让侧栏变长、让人多找三次。真正天天用的都在前面几页。
 *
 * 每块都遵循同一个模式：先给结论（统计卡），再给可操作的表。
 */
type Tab = 'users' | 'audit' | 'notify'

const TABS: { key: Tab; label: string; icon: 'shield' | 'database' | 'bell'; hint: string }[] = [
  { key: 'users', label: '账号与角色', icon: 'shield', hint: '谁能登录、能做什么' },
  { key: 'audit', label: '操作审计', icon: 'database', hint: '谁在什么时候改了什么' },
  { key: 'notify', label: '推送渠道', icon: 'bell', hint: '预警怎么送到人手里' },
]

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('users')

  return (
    <div className="space-y-4">
      <div className="card p-3 flex flex-wrap items-center gap-3">
        <div className="seg">
          {TABS.map((t) => (
            <button
              key={t.key}
              className="seg-item"
              data-active={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              <Icon name={t.icon} size={12} />
              {t.label}
            </button>
          ))}
        </div>
        <div className="text-[11.5px] text-ink-3">{TABS.find((t) => t.key === tab)?.hint}</div>
      </div>

      {tab === 'users' && <UsersPanel />}
      {tab === 'audit' && <AuditPanel />}
      {tab === 'notify' && <NotifyPanel />}
    </div>
  )
}

// ---------------------------------------------------------------- 账号

function UsersPanel() {
  const { user: me } = useSession()
  const users = useUsers()
  const create = useCreateUser()
  const patch = usePatchUser()
  const [err, setErr] = useState('')
  const [form, setForm] = useState({ username: '', displayName: '', role: 'operator' as Role, password: '' })

  const list = users.data ?? []
  const byRole = useMemo(() => {
    const m: Record<string, number> = { admin: 0, operator: 0, viewer: 0 }
    for (const u of list) if (!u.disabled) m[u.role] = (m[u.role] ?? 0) + 1
    return m
  }, [list])

  const submit = () => {
    setErr('')
    create.mutate(
      { username: form.username.trim(), displayName: form.displayName.trim(), role: form.role, password: form.password },
      {
        onError: (e: Error) => setErr(e.message),
        onSuccess: () => setForm({ username: '', displayName: '', role: 'operator', password: '' }),
      },
    )
  }

  const act = (fn: () => void) => {
    setErr('')
    fn()
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="账号总数" value={list.length} unit="个" icon="shield" tone="neutral" />
        <StatCard label="管理员" value={byRole.admin} unit="个" icon="shield" tone="red" footer="能改规则与账号" />
        <StatCard label="值班员" value={byRole.operator} unit="个" icon="bell" tone="orange" footer="确认与处置预警" />
        <StatCard label="只读" value={byRole.viewer} unit="个" icon="layers" tone="blue" footer="只看不写" />
      </div>

      <div className="card p-4">
        <SectionHead
          title="账号清单"
          sub="角色不是权限等级，是三种工作状态：定规则的、盯屏幕的、旁观的。"
          icon="shield"
          right={<Tag tone="neutral">{list.length} 个</Tag>}
        />

        {err && (
          <div
            className="mt-3 flex items-start gap-2 rounded-control px-2.5 py-2 text-[11.5px]"
            style={{ background: T.levelWeak.red, color: T.levelInk.red }}
          >
            <Icon name="alertTriangle" size={13} className="mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <div className="mt-3 overflow-x-auto">
          {users.isLoading ? (
            <div className="space-y-2">
              <Skeleton h={30} />
              <Skeleton h={30} />
              <Skeleton h={30} />
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">用户名</th>
                  <th className="th">显示名</th>
                  <th className="th">角色</th>
                  <th className="th">状态</th>
                  <th className="th">最近登录</th>
                  <th className="th text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((u) => (
                  <tr key={u.username} className="row-hover">
                    <td className="td mono">{u.username}</td>
                    <td className="td">{u.displayName}</td>
                    <td className="td">
                      <select
                        className="field py-0.5 text-[11.5px]"
                        value={u.role}
                        disabled={!can(me, 'user:manage')}
                        onChange={(e) =>
                          act(() =>
                            patch.mutate(
                              { username: u.username, role: e.target.value as Role },
                              { onError: (e2: Error) => setErr(e2.message) },
                            ),
                          )
                        }
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="td">
                      {u.disabled ? <Tag tone="danger">已停用</Tag> : <Tag tone="ok">正常</Tag>}
                    </td>
                    <td className="td num text-ink-3">
                      {u.lastLoginAt ? fmtTime(u.lastLoginAt, 'MM-DD HH:mm') : '从未登录'}
                    </td>
                    <td className="td text-right">
                      <button
                        className="btn btn-ghost text-[11px]"
                        disabled={!can(me, 'user:manage')}
                        onClick={() =>
                          act(() =>
                            patch.mutate(
                              { username: u.username, disabled: !u.disabled },
                              { onError: (e2: Error) => setErr(e2.message) },
                            ),
                          )
                        }
                      >
                        {u.disabled ? '启用' : '停用'}
                      </button>
                      <button
                        className="btn btn-ghost text-[11px]"
                        disabled={!can(me, 'user:manage')}
                        onClick={() => {
                          const pwd = window.prompt(`为 ${u.username} 设置新口令（至少 6 位）`)
                          if (!pwd) return
                          act(() =>
                            patch.mutate(
                              { username: u.username, password: pwd },
                              { onError: (e2: Error) => setErr(e2.message) },
                            ),
                          )
                        }}
                      >
                        重置口令
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="mt-2 text-[11px] text-ink-3 leading-relaxed">
          改口令或停用会立刻踢掉该账号的全部会话——口令改了但旧 cookie 还能用，等于没改。
          最后一个可用的管理员不能被降级或停用，否则没人能再进系统。
        </div>
      </div>

      <div className="card p-4">
        <SectionHead title="新建账号" sub="口令至少 6 位；显示名留空时用用户名。" icon="sparkles" />
        <div className="mt-3 grid md:grid-cols-5 gap-2 items-end">
          <Field label="用户名">
            <input
              className="field w-full"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </Field>
          <Field label="显示名">
            <input
              className="field w-full"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </Field>
          <Field label="角色">
            <select
              className="field w-full"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="初始口令">
            <input
              className="field w-full"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <button
            className="btn btn-primary justify-center"
            disabled={create.isPending || !form.username.trim() || form.password.length < 6}
            onClick={submit}
          >
            {create.isPending ? '创建中…' : '创建'}
          </button>
        </div>
        <div className="mt-2 text-[11px] text-ink-3">{ROLE_HINT[form.role]}</div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] text-ink-3 mb-1">{label}</div>
      {children}
    </label>
  )
}

// ---------------------------------------------------------------- 审计

function AuditPanel() {
  const [hours, setHours] = useState(24)
  const [who, setWho] = useState('')
  const audit = useAudit(hours, who)
  const rows = audit.data ?? []

  const rejected = rows.filter((r) => auditOutcome(r) !== 'ok').length
  const actors = new Set(rows.map((r) => r.username)).size

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="记录条数" value={rows.length} unit="条" icon="database" footer={`近 ${hours} 小时`} />
        <StatCard label="操作人" value={actors} unit="人" icon="shield" />
        <StatCard
          label="被拒操作"
          value={rejected}
          unit="条"
          icon="alertTriangle"
          tone={rejected > 0 ? 'orange' : 'neutral'}
          footer="4xx：非法迁移、权限不足"
        />
        <StatCard
          label="审计范围"
          value="写操作"
          icon="info"
          footer="读接口不记，否则会埋掉要查的那条"
        />
      </div>

      <div className="card p-4">
        <SectionHead
          title="操作留痕"
          sub="写入时就把路径翻成人话，所以历史记录永远保留当时的说法。"
          icon="database"
          right={
            <div className="flex items-center gap-2">
              <input
                className="field text-[11.5px] w-[120px]"
                placeholder="按用户名过滤"
                value={who}
                onChange={(e) => setWho(e.target.value.trim())}
              />
              <div className="seg">
                {[6, 24, 72].map((h) => (
                  <button key={h} className="seg-item" data-active={hours === h} onClick={() => setHours(h)}>
                    {h}h
                  </button>
                ))}
              </div>
            </div>
          }
        />

        <div className="mt-3 overflow-x-auto max-h-[520px] overflow-y-auto">
          {rows.length === 0 ? (
            <EmptyState
              icon="database"
              title="这段时间没有写操作"
              hint="确认预警、派单、改规则、换模型都会出现在这里。只读浏览不会。"
              compact
            />
          ) : (
            <table className="w-full">
              <thead className="sticky top-0">
                <tr>
                  <th className="th">时间</th>
                  <th className="th">操作人</th>
                  <th className="th">动作</th>
                  <th className="th">对象</th>
                  <th className="th">结果</th>
                  <th className="th text-right">耗时</th>
                  <th className="th">来源 IP</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const out = auditOutcome(r)
                  return (
                    <tr key={r.id} className="row-hover">
                      <td className="td num text-ink-3">{fmtTime(r.at, 'MM-DD HH:mm:ss')}</td>
                      <td className="td mono">{r.username}</td>
                      <td className="td">{r.summary}</td>
                      <td className="td mono text-[11px] text-ink-3">{r.path}</td>
                      <td className="td">
                        <Tag tone={out === 'ok' ? 'ok' : out === 'rejected' ? 'warn' : 'danger'}>
                          {AUDIT_OUTCOME_LABEL[out]} {r.status}
                        </Tag>
                      </td>
                      <td className="td text-right num text-ink-3">{r.durationMs}ms</td>
                      <td className="td mono text-[11px] text-ink-3">{r.ip}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 推送

function NotifyPanel() {
  const channels = useChannels()
  const deliveries = useDeliveries()
  const test = useTestChannel()
  const [note, setNote] = useState('')

  const rows = channels.data ?? []
  const live = rows.filter(isChannelLive).length
  const failed = (deliveries.data ?? []).filter((d) => !d.ok).length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="渠道" value={rows.length} unit="个" icon="bell" />
        <StatCard label="可用渠道" value={live} unit="个" icon="wifi" tone={live > 0 ? 'blue' : 'neutral'} footer="站内永远可用" />
        <StatCard
          label="推送失败"
          value={failed}
          unit="条"
          icon="alertTriangle"
          tone={failed > 0 ? 'orange' : 'neutral'}
          footer="不重试：预警要的是及时"
        />
        <StatCard label="最近推送" value={(deliveries.data ?? []).length} unit="条" icon="activity" />
      </div>

      {note && (
        <div
          className="flex items-start gap-2 rounded-control px-3 py-2 text-[11.5px]"
          style={{ background: T.aiWeak, color: T.aiInk }}
        >
          <Icon name="info" size={13} className="mt-0.5 shrink-0" />
          <span>{note}</span>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        {rows.map((c) => (
          <ChannelCard
            key={c.name}
            channel={c}
            onTest={() =>
              test.mutate(c.name, {
                onSuccess: (r) => setNote(`${CHANNEL_LABEL[c.name] ?? c.name}：${r.detail}`),
                onError: (e: Error) => setNote(e.message),
              })
            }
          />
        ))}
      </div>

      <div className="card p-4">
        <SectionHead
          title="推送记录"
          sub="失败也留痕——值班员要能证明「这条预警确实没推出去」，而不是猜。"
          icon="activity"
        />
        <div className="mt-3 overflow-x-auto max-h-[320px] overflow-y-auto">
          {(deliveries.data ?? []).length === 0 ? (
            <EmptyState icon="bell" title="还没有推送记录" hint="预警升到渠道门槛时会自动推一条。" compact />
          ) : (
            <table className="w-full">
              <thead className="sticky top-0">
                <tr>
                  <th className="th">时间</th>
                  <th className="th">渠道</th>
                  <th className="th">站点</th>
                  <th className="th">等级</th>
                  <th className="th">结果</th>
                  <th className="th">说明</th>
                </tr>
              </thead>
              <tbody>
                {(deliveries.data ?? []).map((d) => (
                  <tr key={d.id} className="row-hover">
                    <td className="td num text-ink-3">{fmtTime(d.at, 'MM-DD HH:mm')}</td>
                    <td className="td">{CHANNEL_LABEL[d.channel] ?? d.channel}</td>
                    <td className="td mono">{d.siteId}</td>
                    <td className="td">
                      <LevelChip level={d.level} />
                    </td>
                    <td className="td">
                      <Tag tone={d.ok ? 'ok' : 'danger'}>{d.ok ? '成功' : '失败'}</Tag>
                    </td>
                    <td className="td text-[11.5px] text-ink-3">{d.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function ChannelCard({ channel, onTest }: { channel: NotifyChannel; onTest: () => void }) {
  const save = useSaveChannel()
  const [endpoint, setEndpoint] = useState(channel.endpoint)
  const [secret, setSecret] = useState('')
  const [minLevel, setMinLevel] = useState<Level>(channel.minLevel)
  const [debounce, setDebounce] = useState(channel.debounceMin)
  const [enabled, setEnabled] = useState(channel.enabled)
  const [err, setErr] = useState('')

  const locked = !canDisableChannel(channel.name)
  const levels: Level[] = ['blue', 'yellow', 'orange', 'red']

  return (
    <div className="card p-4">
      <SectionHead
        title={CHANNEL_LABEL[channel.name] ?? channel.name}
        sub={CHANNEL_HINT[channel.name] ?? '自定义渠道'}
        icon="bell"
        right={
          <Tag tone={isChannelLive(channel) ? 'ok' : 'neutral'}>
            {isChannelLive(channel) ? '可用' : '未启用'}
          </Tag>
        }
      />

      <div className="mt-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-ink-2">启用</span>
          <input
            type="checkbox"
            checked={enabled}
            disabled={locked}
            title={locked ? '站内渠道不允许关闭' : undefined}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </div>

        {channel.name !== 'inapp' && (
          <>
            <Field label="Endpoint（POST JSON）">
              <input
                className="field w-full mono text-[11.5px]"
                value={endpoint}
                placeholder="https://example.com/hooks/waterlog"
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </Field>
            <Field label="签名密钥（留空表示不改）">
              <input
                className="field w-full mono text-[11.5px]"
                value={secret}
                placeholder={channel.secret || '未设置'}
                onChange={(e) => setSecret(e.target.value)}
              />
            </Field>
          </>
        )}

        <Field label="最低推送等级">
          <div className="seg">
            {levels.map((lv) => (
              <button
                key={lv}
                className="seg-item"
                data-active={minLevel === lv}
                onClick={() => setMinLevel(lv)}
              >
                {LEVEL_LABEL[lv]}
              </button>
            ))}
          </div>
        </Field>

        <Field label="去抖（分钟内同站同渠道不重复推）">
          <input
            className="field w-full num"
            type="number"
            min={0}
            max={1440}
            value={debounce}
            onChange={(e) => setDebounce(Number(e.target.value) || 0)}
          />
        </Field>

        {err && <div className="text-[11.5px]" style={{ color: T.levelInk.red }}>{err}</div>}

        <div className="flex items-center gap-2 pt-1">
          <button
            className="btn btn-primary text-[11.5px]"
            disabled={save.isPending}
            onClick={() => {
              setErr('')
              save.mutate(
                { name: channel.name, enabled, endpoint, secret, minLevel, debounceMin: debounce },
                { onError: (e: Error) => setErr(e.message) },
              )
            }}
          >
            {save.isPending ? '保存中…' : '保存'}
          </button>
          <button className="btn text-[11.5px]" onClick={onTest}>
            <Icon name="zap" size={12} />
            发测试
          </button>
          <div className="flex-1" />
          <span className="text-[10.5px] text-ink-3 num">
            {channel.updatedAt ? `更新于 ${fmtTime(channel.updatedAt, 'MM-DD HH:mm')}` : '—'}
          </span>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-line-2">
        <KeyValue k="渠道 ID" v={channel.name} />
        <KeyValue k="当前门槛" v={`${LEVEL_LABEL[channel.minLevel]}及以上`} mono={false} />
      </div>
    </div>
  )
}
