import { useMemo } from 'react'
import { motion } from 'motion/react'
import { useOverview, useSiteDetail, type OverviewRow } from '../../data/queries'
import { LEVEL_FULL, LEVEL_LABEL, isAlarm, type Level } from '../../domain'
import { T } from '../../utils/tokens'
import { Icon } from '../primitives/Icons'
import { UiIconCmp } from './UiIcon'
import { Drawer, DrawerSection } from './Drawer'
import { StationTrend } from './StationTrend'
import { useToast } from './Toast'

/**
 * 站点详情的**唯一实现**，所有页面共用。
 *
 * ## 为什么要抽出来
 *
 * 之前「点开一个站看细节」这件事在四个页面里各写了一遍：
 * 一张图用弹出卡、站点表用展开行、预警页用侧边栏、详情页用整页。
 * 四份实现里量纲换算写了两套、阈值距离算法写了两套，
 * 改一处忘三处——**同一个业务事实在不同页面上显示的数字会不一样**，
 * 这在交付级的系统里是不能接受的。
 *
 * 现在：任何页面想让用户「看一个站的细节」，都用 `<SiteDrawer>`。
 * 差别只在宽度和触发方式，内容与口径完全一致。
 *
 * ## 抽屉里为什么是这五块
 *
 * 用户点一个站，心里其实只问四件事，五块面板一一对应：
 *
 * | 面板 | 回答的问题 |
 * |---|---|
 * | 顶部大数字 + 等级 | 现在多严重 |
 * | 四级阈值距离 | 离下一档还有多远（把"0.63m"翻译成几何距离） |
 * | 水位走势与预测 | 是刚涨起来还是一直这么高、接下来会怎样 |
 * | 模型预测 | 四个预见期分别多少、凭什么这么判 |
 * | 同街道对照 | 是我这一站特殊，还是整条街都这样 |
 *
 * 少任何一块，用户就得跳到别的页面去找——那就不叫"交付级"了。
 */

export function fmtDepth(d: number): string {
  if (d <= 0) return '0.00'
  return d < 0.1 ? d.toFixed(3) : d.toFixed(2)
}

/** 变化量统一带符号；小于 5mm 视作没动，避免显示成「+0.00」 */
export function fmtDelta(v: number): string {
  if (Math.abs(v) < 0.005) return '±0.00'
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`
}

interface Glance {
  row: OverviewRow
  depth: number
  red: number
  ratio: number
  level: Level
  alarm: boolean
}

function toGlance(row: OverviewRow): Glance {
  const depth = row.reading.depth
  const red = row.site.thresholds.red
  return {
    row,
    depth,
    red,
    ratio: red > 0 ? depth / red : 0,
    level: row.assessment.level,
    alarm: isAlarm(row.assessment.level),
  }
}

// ------------------------------------------------------------------ 同街道对照

/**
 * 同街道的其他站点，一行一个，点一下就切过去。
 *
 * 判读口径写在下面一行：同街道一起涨多半是面上的雨，
 * 只有这一站涨才更像本地点位（管道、涵洞）自己的问题。
 */
export function PeerList({
  district,
  currentId,
  onPick,
}: {
  district: string
  currentId: string
  onPick: (id: string) => void
}) {
  const ov = useOverview()
  const peers = useMemo(
    () =>
      (ov.data?.rows ?? [])
        .filter((r) => r.site.district === district)
        .map(toGlance)
        .sort((a, b) => b.depth - a.depth),
    [ov.data, district],
  )

  if (peers.length <= 1) {
    return (
      <div style={{ fontSize: 11.5, color: T.text3, lineHeight: 1.6 }}>
        {district} 只有这一个监测点，没有同街道可对照。
      </div>
    )
  }

  const deepest = peers[0]?.depth ?? 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {peers.map((g) => {
        const cur = g.row.site.id === currentId
        return (
          <button
            key={g.row.site.id}
            type="button"
            onClick={() => !cur && onPick(g.row.site.id)}
            aria-current={cur ? 'true' : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '6px 8px',
              borderRadius: 6,
              border: `1px solid ${cur ? T.borderStrong : 'transparent'}`,
              background: cur ? '#EFF5FB' : 'transparent',
              cursor: cur ? 'default' : 'pointer',
              textAlign: 'left',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: T.level[g.level],
                flexShrink: 0,
                opacity: g.level === 'none' ? 0.45 : 1,
              }}
            />
            <span
              style={{
                width: 108,
                flexShrink: 0,
                fontSize: 12,
                color: T.text1,
                fontWeight: cur ? 700 : 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {g.row.site.name}
            </span>
            <span style={{ flex: 1, height: 4, borderRadius: 2, background: '#E9EFF6', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${deepest > 0 ? Math.min(100, (g.depth / deepest) * 100) : 0}%`,
                  background: T.level[g.level],
                  opacity: 0.8,
                }}
              />
            </span>
            <span
              style={{
                width: 40,
                textAlign: 'right',
                fontSize: 12,
                fontWeight: 700,
                color: T.text1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {fmtDepth(g.depth)}
            </span>
            <span style={{ width: 10, fontSize: 9.5, color: T.text3 }}>m</span>
          </button>
        )
      })}
      <div style={{ fontSize: 10, color: T.text3, marginTop: 3, lineHeight: 1.55 }}>
        同街道一起涨，多半是面上的雨；只有这一站涨，更像本地点位自己的问题。
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 详情正文

export function StationDetail({
  id,
  onPick,
  onOpenArchive,
}: {
  id: string
  onPick: (id: string) => void
  /** 不给就不显示「打开完整档案」——抽屉里已经是全部信息了 */
  onOpenArchive?: () => void
}) {
  const detail = useSiteDetail(id)
  const toast = useToast()

  if (detail.isLoading) {
    return (
      <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: i === 0 ? 62 : 14,
              borderRadius: 7,
              background: 'linear-gradient(90deg,#EEF3F9 25%,#F7FAFD 37%,#EEF3F9 63%)',
              backgroundSize: '400% 100%',
              animation: 'wl-shimmer 1.35s ease-in-out infinite',
            }}
          />
        ))}
      </div>
    )
  }

  if (detail.isError || !detail.data) {
    return (
      <div style={{ padding: '22px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text1 }}>这一站的数据没能取回来</div>
        <div style={{ fontSize: 12, color: T.text2, marginTop: 4, lineHeight: 1.6 }}>
          {detail.isError ? String((detail.error as Error)?.message ?? '网络或服务异常') : '服务返回了空数据'}
        </div>
        <button
          type="button"
          onClick={() => detail.refetch()}
          style={{
            marginTop: 12,
            height: 30,
            padding: '0 12px',
            borderRadius: 7,
            border: `1px solid ${T.border1}`,
            background: T.surface,
            cursor: 'pointer',
            fontSize: 12.5,
            color: T.text1,
            fontWeight: 600,
          }}
        >
          重试
        </button>
      </div>
    )
  }

  const { site, series, forecast } = detail.data
  const now = series.points[series.points.length - 1]
  const base = site.baseLevel
  const depth = now ? Number(now.level) - Number(base) : 0
  const level =
    forecast?.assessment.level ??
    (depth >= site.thresholds.red
      ? 'red'
      : depth >= site.thresholds.orange
        ? 'orange'
        : depth >= site.thresholds.yellow
          ? 'yellow'
          : depth >= site.thresholds.blue
            ? 'blue'
            : 'none')
  const color = T.level[level] ?? T.level.none
  const ink = T.levelInk[level] ?? T.levelInk.none
  const ratio = site.thresholds.red > 0 ? depth / site.thresholds.red : 0

  const rows = [
    { level: 'blue' as Level, label: '蓝', v: site.thresholds.blue },
    { level: 'yellow' as Level, label: '黄', v: site.thresholds.yellow },
    { level: 'orange' as Level, label: '橙', v: site.thresholds.orange },
    { level: 'red' as Level, label: '红', v: site.thresholds.red },
  ]
  const maxThr = Math.max(...rows.map((r) => r.v), depth, 0.05)

  return (
    <div>
      {/* 顶部：大数字 + 等级。数字变化时轻微上浮，让"刷新了"这件事看得见 */}
      <div style={{ padding: '14px 16px 12px', display: 'flex', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <motion.span
              key={fmtDepth(depth)}
              initial={{ opacity: 0.4, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24 }}
              style={{
                fontSize: 40,
                fontWeight: 700,
                color: T.text1,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: -1.4,
              }}
            >
              {fmtDepth(depth)}
            </motion.span>
            <span style={{ fontSize: 14, color: T.text3, fontWeight: 600 }}>m</span>
          </div>
          <div style={{ fontSize: 11.5, color: T.text2, marginTop: 5 }}>
            绝对水位 {now ? Number(now.level).toFixed(3) : '—'} m · 基准 {Number(base).toFixed(3)} m
          </div>
        </div>
        <span
          style={{
            padding: '4px 9px',
            borderRadius: 999,
            fontSize: 11.5,
            fontWeight: 700,
            color: ink,
            background: T.levelWeak[level] ?? T.levelWeak.none,
            border: `1px solid ${color}44`,
            whiteSpace: 'nowrap',
          }}
        >
          {LEVEL_FULL[level]}
        </span>
      </div>

      {/* 阈值尺：把"离下一档还有多远"画成几何距离 */}
      <DrawerSection title="四级阈值距离">
        <div style={{ position: 'relative', height: 46, marginTop: 2 }}>
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 21,
              height: 4,
              borderRadius: 2,
              background: 'linear-gradient(90deg,#E7F3FB,#FBF3E0,#FCEDE4,#FCE9E9)',
            }}
          />
          {rows.map((r) => {
            const x = (r.v / maxThr) * 100
            return (
              <div
                key={r.level}
                style={{
                  position: 'absolute',
                  left: `${x}%`,
                  top: 14,
                  transform: 'translateX(-50%)',
                  textAlign: 'center',
                }}
              >
                <div style={{ width: 2, height: 16, background: T.level[r.level], borderRadius: 1, margin: '0 auto' }} />
                <div style={{ fontSize: 10, color: T.levelInk[r.level], fontWeight: 700, marginTop: 1 }}>{r.label}</div>
                <div style={{ fontSize: 9.5, color: T.text3, fontVariantNumeric: 'tabular-nums' }}>{r.v.toFixed(2)}</div>
              </div>
            )
          })}
          <motion.div
            initial={false}
            animate={{ left: `${Math.min(100, (depth / maxThr) * 100)}%` }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            style={{
              position: 'absolute',
              top: 6,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <div style={{ fontSize: 9.5, fontWeight: 700, color: ink, whiteSpace: 'nowrap' }}>现在</div>
            <div
              style={{
                width: 0,
                height: 0,
                borderLeft: '4px solid transparent',
                borderRight: '4px solid transparent',
                borderTop: `5px solid ${ink}`,
                marginTop: 1,
              }}
            />
          </motion.div>
        </div>
        <div style={{ fontSize: 11.5, color: T.text2, marginTop: 2, lineHeight: 1.55 }}>
          {ratio >= 1 ? (
            <>
              已超红阈 <b style={{ color: T.levelInk.red }}>{(depth - site.thresholds.red).toFixed(2)} m</b>（
              {ratio.toFixed(2)} 倍）
            </>
          ) : (
            <>
              距红阈还有 <b style={{ color: T.text1 }}>{(site.thresholds.red - depth).toFixed(2)} m</b>（已达{' '}
              {Math.round(ratio * 100)}%）
            </>
          )}
        </div>
      </DrawerSection>

      {/* 实测 + 预测 + 阈值：抽屉里最关键的一块 */}
      <DrawerSection
        title="水位走势与预测"
        aside={
          <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 9.5, color: T.text3 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 11, height: 2, background: T.obsLine, borderRadius: 1 }} />
              实测
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 11, height: 2, background: T.fcLine, borderRadius: 1 }} />
              预测
            </span>
          </span>
        }
      >
        <StationTrend
          series={series}
          forecast={forecast}
          baseLevel={site.baseLevel}
          thresholds={site.thresholds}
          issuedAt={detail.data.issuedAt}
          height={214}
        />
        <div style={{ fontSize: 10, color: T.text3, marginTop: 1, lineHeight: 1.55 }}>
          实线是已发生的，虚线是模型预测，浅紫色是 90% 置信区间，横线是四级阈值。
        </div>
      </DrawerSection>

      {/* 四个预见期 */}
      {forecast ? (
        <DrawerSection
          title="模型预测"
          aside={<span style={{ fontSize: 10, color: T.text3 }}>{forecast.horizons[0]?.model ?? ''}</span>}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {forecast.horizons.map((h) => {
              const hv = Number(h.level) - Number(base)
              const hl =
                hv >= site.thresholds.red
                  ? 'red'
                  : hv >= site.thresholds.orange
                    ? 'orange'
                    : hv >= site.thresholds.yellow
                      ? 'yellow'
                      : hv >= site.thresholds.blue
                        ? 'blue'
                        : 'none'
              return (
                <div key={h.horizonMin} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 30, fontSize: 11, color: T.text2, fontWeight: 600 }}>
                    {h.horizonMin >= 60 ? `${h.horizonMin / 60}h` : `${h.horizonMin}m`}
                  </span>
                  <span style={{ width: 52, fontSize: 12.5, fontWeight: 700, color: T.text1, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtDepth(hv)}
                  </span>
                  <span style={{ width: 44, fontSize: 10.5, color: T.levelInk[hl], fontWeight: 600 }}>{LEVEL_LABEL[hl]}</span>
                  <div style={{ flex: 1, height: 4, borderRadius: 2, background: '#E9EFF6', overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.min(100, (hv / site.thresholds.red) * 100)}%`,
                        background: T.level[hl],
                        opacity: 0.85,
                      }}
                    />
                  </div>
                  <span style={{ width: 40, fontSize: 10, color: T.text3, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    ±{h.sigma.toFixed(3)}
                  </span>
                </div>
              )
            })}
          </div>
          {forecast.assessment.reason ? (
            <div
              style={{
                fontSize: 11.5,
                color: T.text2,
                marginTop: 9,
                lineHeight: 1.6,
                paddingTop: 8,
                borderTop: `1px solid ${T.border2}`,
              }}
            >
              {forecast.assessment.reason}
            </div>
          ) : null}
        </DrawerSection>
      ) : null}

      {/* 同街道对照：判断"是我这一站特殊，还是整条街都这样" */}
      <DrawerSection title="同街道对照" aside={<span style={{ fontSize: 9.5, color: T.text3 }}>点一行即切换</span>}>
        <PeerList district={site.district} currentId={site.id} onPick={onPick} />
      </DrawerSection>

      <DrawerSection title="操作">
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => {
              const url = `${window.location.origin}${window.location.pathname}?site=${site.id}`
              void navigator.clipboard?.writeText(url).then(
                () => toast.ok('链接已复制', '贴给同事打开就是这一站'),
                () => toast.err('复制失败', '浏览器拒绝了剪贴板权限'),
              )
            }}
            style={{
              height: 30,
              padding: '0 11px',
              borderRadius: 7,
              border: `1px solid ${T.border1}`,
              background: T.surface,
              cursor: 'pointer',
              fontSize: 12,
              color: T.text1,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <UiIconCmp name="pin" size={13} />
            复制链接
          </button>
          {onOpenArchive ? (
            <button
              type="button"
              onClick={onOpenArchive}
              style={{
                height: 30,
                padding: '0 11px',
                borderRadius: 7,
                border: `1px solid ${T.primary}55`,
                background: `${T.primary}0F`,
                cursor: 'pointer',
                fontSize: 12,
                color: T.primary,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Icon name="external" size={12} />
              打开完整档案
            </button>
          ) : null}
        </div>
      </DrawerSection>
    </div>
  )
}

// ------------------------------------------------------------------ 组合好的抽屉

/**
 * 「点一个站 → 右边出抽屉」的完整实现。
 *
 * 任何页面想加这个交互，只需要：
 * ```tsx
 * const [sel, setSel] = useState<string | null>(null)
 * ...
 * <SiteDrawer siteId={sel} onClose={() => setSel(null)} onPick={setSel} />
 * ```
 * 地图、列表、卡片只要调 `setSel(id)` 就行——**交互的入口可以有很多个，
 * 出口只有一个**，这样才不会出现"这里点开是抽屉、那里点开是弹窗"。
 */
export function SiteDrawer({
  siteId,
  onClose,
  onPick,
  onOpenArchive,
  width,
}: {
  siteId: string | null
  onClose: () => void
  onPick: (id: string) => void
  onOpenArchive?: () => void
  width?: number
}) {
  const ov = useOverview()
  const row = siteId ? (ov.data?.rows ?? []).find((r) => r.site.id === siteId) : null

  return (
    <Drawer
      open={!!siteId}
      onClose={onClose}
      width={width}
      title={row?.site.name ?? siteId ?? ''}
      subtitle={row ? `${row.site.district} · ${row.site.id} · ${row.site.kind}` : undefined}
    >
      {siteId ? <StationDetail id={siteId} onPick={onPick} onOpenArchive={onOpenArchive} /> : null}
    </Drawer>
  )
}
