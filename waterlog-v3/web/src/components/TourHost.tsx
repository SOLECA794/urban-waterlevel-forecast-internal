import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tour, type TourStep } from './interactive/Tour'
import { useSession } from '../view/useSession'

/**
 * 演示流程的**内容**与外壳的接线。
 *
 * 内容与组件分开：`Tour.tsx` 只负责「把卡片正确放到某个元素旁边」，
 * 到底讲哪几步、每步说什么，是这个文件的事。改脚本不用碰定位逻辑。
 *
 * ## 九步全在同一屏里
 *
 * 工作台不再分页，所以这九步也不跳页——每一步都指向屏幕上同一个画面的
 * 某个区域（顶栏 / 中舞台的某块 / 左栏 / 右栏）。少数几步会替用户点一下
 * （`click`），因为「讲了但没演示」等于没讲。
 *
 * 顺序是一条值班流程，不是功能清单：
 *
 *   现在什么状况 → 哪里严重 → 三小时后呢 → 谁在管 → 有多严重
 *   → 这一班还剩什么没完 → 模型凭什么可信 → 判据怎么定的 → 链路通不通
 *
 * 答不上来的步骤就不该在流程里——这条原则和面板设计是同一条。
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    anchor: 'wb-facts',
    side: 'bottom',
    title: '一整屏，不再有标签页',
    body:
      '顶栏这四块是**随时都在的事实**：待办几项、几条预警还激活、模型在不在线、'
      + '数据链路通不通。它们本身就是入口——点哪一块，中舞台就换成那一块的内容。'
      + '没有左侧导航，也没有「先去第几页再去第几页」。',
  },
  {
    anchor: 'wb-map',
    side: 'right',
    title: '一张图：先看哪里在报警',
    body:
      '真实路网底图上十个站按预警等级着色，气泡大小＝积水深。可拖、可缩放；'
      + '点任意气泡，**这一屏不跳走**，中舞台换成该站、右栏记下这一步。',
  },
  {
    anchor: 'wb-forecast',
    side: 'left',
    title: '三小时后哪个站会翻红',
    body:
      '这个问题地图答不了。每站一条：实心条是预测峰值、竖线是现在、红竖线是红阈——'
      + '**每条用该站自己的量程**，因为十站红阈从 0.25 到 0.50 不等，'
      + '统一刻度会让浅站看起来全都安全。',
  },
  {
    anchor: 'wb-rail',
    side: 'right',
    title: '左栏是唯一一份站点列表',
    body:
      '排序、搜索、只看预警都在这里。**换舞台它不重置**——'
      + '用户刚筛好的东西不该因为你点了别处就被清掉。'
      + '按 / 可以直接搜。',
  },
  {
    anchor: 'wb-rail',
    side: 'right',
    // 替用户点一下左栏第一行：光说「点一行」他可能不点，后面的两个区域就无从展示。
    click: '[data-rail-row]',
    title: '点一行，什么都不换页',
    body:
      '中舞台换成这个站，右栏记下一层，**地址栏跟着变**（`?on=site&site=S09`）——'
      + '所以这个画面可以直接发给同事，他打开看到的是同一个站。',
  },
  {
    anchor: 'wb-drill',
    side: 'left',
    title: '右栏：你怎么走到这里的',
    body:
      '每点一个对象就叠一层，可以一层层退回去（Esc 退一层）。'
      + '栈底那层「此刻该管什么」是空闲时最该看的东西：'
      + '几条待办，每条写着该谁做、做什么。',
  },
  {
    anchor: 'wb-stage',
    side: 'right',
    title: '同一个对象，三个角度',
    body:
      '以站点为例：多严重 → 为什么会这样（三因子逐行算给你看）→ 谁在管。'
      + '这三问原来分散在三个页面，来回切换时上下文全丢；'
      + '现在它们挨在一起，问下一句不用离开这一屏。',
  },
  {
    anchor: 'wb-stage',
    side: 'right',
    click: '[data-fact="trust"]',
    title: '模型凭什么可信',
    body:
      '四个模型族 × 四个预见期，比 RMSE 也比 skill（比「水位不变」强多少）。'
      + 'skill ≤ 0 意味着不如什么都不做——这种模型不该上线。'
      + '注意「离线指标」和「最近实盘」是两个口径，**离线好看不等于实盘能用**。',
  },
  {
    anchor: 'wb-stage',
    side: 'right',
    click: '[data-trust-link="rules"]',
    title: '判据是什么：规矩是人定的',
    body:
      '模型给水位，规则给等级——水位再准，权重配错了结论一样错。'
      + '权重与分档可改，但改前先预演：系统用**同一条已发布的预测曲线**重判一遍，'
      + '这样变化一定来自规则，不会混进模型重新预测的噪声。',
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
