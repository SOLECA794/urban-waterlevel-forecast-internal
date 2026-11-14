import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tour, type TourStep } from './interactive/Tour'
import { useSession } from '../view/useSession'

/**
 * 演示流程的**内容**与外壳的接线。
 *
 * 内容与组件分开：`Tour.tsx` 只负责「把卡片正确放到某个元素旁边」，
 * 到底讲哪九步、每步说什么，是这个文件的事。改脚本不用碰定位逻辑。
 *
 * ## 为什么是这九步
 *
 * 它们不是「功能清单」，是**一条值班流程**：
 *
 *   现在有多严重 → 哪里严重 → 有多严重（单站细节）→ 三小时后呢
 *   → 谁在管（预警四态 × 处置五态）→ 这一班还剩什么没完
 *   → 模型凭什么可信 → 嫌太吵就自己调阈值 → 链路是不是都通着
 *
 * 每一步都对应一个真实角色在那个时刻真正会问的问题。
 * 答不上来的一步就不该在流程里——这条原则和面板设计是同一条。
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    route: '/',
    anchor: 'overview-map',
    side: 'right',
    title: '一张图：先看哪里在报警',
    body:
      '真实路网底图上十个监测站按预警等级着色，气泡大小＝积水深。' +
      '可以直接拖、滚轮缩放；点任意气泡，右侧滑出该站的完整详情。' +
      '左边这块是中心调度看的，不是给路人看的。',
  },
  {
    route: '/',
    anchor: 'overview-forecast',
    side: 'top',
    title: '三小时后哪个站会翻红',
    body:
      '这条带子答的是地图答不了的问题：现在还没红、但下一个小时会红的站。' +
      '实心点是现在，三角是预测峰值，底色为四级阈值分区——' +
      '一眼能看出「距离红阈还差 0.12m，按当前涨速约 40 分钟」。',
  },
  {
    route: '/live',
    anchor: 'live-first-row',
    side: 'left',
    title: '实时地图：点一个站点',
    body:
      '左栏是所有站点，可按等级/水深/涨速/雨强排序，按 / 直接搜。' +
      '点任意一行，地图会飞到这个站，右侧抽屉同时打开——' +
      '**地图和列表始终指向同一件事**，不会出现「曲线是 A 站的、阈值是 B 站的」。',
  },
  {
    anchor: 'site-drawer',
    side: 'left',
    // 上一张卡片请用户自己点一行；这一步替他点一下，保证抽屉一定开着。
    // 幂等：点的是同一行，抽屉只是保持打开，不会闪。
    click: '[data-site-row]',
    title: '抽屉里的五个问题',
    body:
      '现在多严重（大数字＋等级）→ 离下一档还差多少（四级阈值距离）→ ' +
      '走势与预测 → 四个预见期分别会到多少 → 是这一站特殊还是整条街都这样。' +
      '最后一条最有用：同街道全在涨，那是面上的雨；只有这一站在涨，才是本地点位的问题。',
  },
  {
    route: '/alerts',
    anchor: 'alerts-table',
    side: 'bottom',
    title: '预警只有两条轴，不能合成一条',
    body:
      '阅读轴（四态）由模型决定：这条预警还成不成立。' +
      '处置轴（五态）由人决定：我们做了什么。' +
      '一条预警可以早就解除了、但处置还停在已派单——合成一条状态，就必然丢掉其中一半事实。',
  },
  {
    route: '/shift',
    anchor: 'shift-handoff',
    side: 'bottom',
    title: '值班交接：这一班还剩什么没完',
    body:
      '只列出真正需要人接手的：仍在报警的，或者派了单还没到场的。' +
      '已解除且没人管的不进这张表——否则交接清单会长到没人读，等于没有交接。',
  },
  {
    route: '/model',
    anchor: 'model-compare',
    side: 'bottom',
    title: '模型凭什么可信',
    body:
      '四个模型族、四个预见期，比 RMSE 也比 skill（比「水位不变」这个基线强多少）。' +
      'skill ≤ 0 意味着不如什么都不做——这种模型不该上线，' +
      '所以版本治理里「看得见指标」和「能不能采纳」是同一件事。',
  },
  {
    route: '/rules',
    anchor: 'rules-weights',
    side: 'bottom',
    title: '嫌太吵就自己调，但先预演',
    body:
      '三因子权重与分档可改，改前先点「影响预演」：' +
      '系统用**同一条已发布的预测曲线**重判一遍再对比，' +
      '这样变化一定来自规则，不会混进模型重新预测的噪声。',
  },
  {
    route: '/system',
    anchor: 'system-chain',
    side: 'bottom',
    title: '链路都通着吗',
    body:
      '遥测 → 引擎 → 决策 → 推送，四层逐段显示。' +
      '某一层断了，后面的数字会**停止更新但不会报错**——' +
      '这正是必须显式看链路、而不是等页面上出现红字的原因。',
  },
]

const SEEN_KEY = 'wl-tour-seen-v1'

export function TourHost() {
  const nav = useNavigate()
  const { user } = useSession()
  const [index, setIndex] = useState<number | null>(null)

  // 首次进入自动放一遍；之后从「演示流程」按钮手动重放。
  // 记「看过」而不是每次自动播：老用户每次刷新都被挡一层遮罩会很烦。
  useEffect(() => {
    // 挂在 <Routes> 外面，所以登录页上也会被渲染 —— 没登录就什么都不做
    if (!user) return
    let seen = true
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === '1'
    } catch {
      /* 隐私模式读不到，就当作没看过——反正只播一次 */
    }
    if (seen) return
    // 只从首页自动开播。
    // 深链接进来的用户（比如在群里点开一条 /alerts）有明确目的，
    // 自动开播的第一步 route 是 `/`，会把他正在看的页面直接抢走。
    if (window.location.pathname !== '/') return
    const t = window.setTimeout(() => setIndex(0), 900)
    return () => window.clearTimeout(t)
  }, [user])

  const start = useCallback(() => setIndex(0), [])
  const exit = useCallback(() => {
    setIndex(null)
    try {
      window.localStorage.setItem(SEEN_KEY, '1')
    } catch {
      /* 同上 */
    }
  }, [])

  // 让外壳上的按钮能触发流程，不必把状态提到 App
  useEffect(() => {
    const onStart = () => start()
    window.addEventListener('wl:tour-start', onStart)
    return () => window.removeEventListener('wl:tour-start', onStart)
  }, [start])

  if (!user || index == null) return null
  return (
    <Tour
      steps={TOUR_STEPS}
      index={index}
      onIndex={setIndex}
      onExit={exit}
      onGo={(r) => nav(r)}
    />
  )
}

/** 手动重放：外壳顶栏上的按钮调它。 */
export function startTour() {
  window.dispatchEvent(new Event('wl:tour-start'))
}
