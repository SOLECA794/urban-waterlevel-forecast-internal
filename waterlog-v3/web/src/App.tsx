import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireAuth } from './components/RequireAuth'
import { LoginPage } from './pages/LoginPage'
import { TourHost } from './components/TourHost'
import BoardPage from './board/BoardPage'
import { NineBoard } from './board/NineBoard'
import { WorkbenchPage } from './workbench/WorkbenchPage'

/**
 * 路由表。
 *
 * 只剩三条：登录、大屏、工作台。**没有侧栏导航，也没有「第几页」**——
 * 业务能力全部收在 `/` 这一屏里，靠点击与层次关系展开（见 `workbench/model.ts`）。
 *
 * 旧的多页入口（/sites、/alerts、/shift、/model、/rules、/system、/admin、/live）
 * 连同 `components/Layout.tsx` 一起删掉了：留着它们就是留着一条没有导航、
 * 却能被地址栏打开的第二套界面，两套界面的口径迟早会分叉。
 * 深链接进来（比如别人发的旧链接）一律落到 `/`，工作台自己从 URL 读 ?on=&site= 复原画面。
 *
 * /board 仍然独立：它是投到大厅的无交互大屏，和工作台是两种用法，不该塞进同一屏。
 */
export default function App() {
  return (
    <>
      {/* 演示流程挂在 <Routes> 外面：它要在任何业务页上都能浮出来，包括没有 Layout 的大屏页。
          **不能放进 <Routes>** —— 那里只接受 <Route> 子节点，混进别的组件会让整棵路由树渲染失败
          （表现为整页白屏，控制台只有一句 Uncaught Error，看不出是这个原因）。 */}
      <TourHost />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          {/* 大厅大屏 = 三屏轮播（全域总览 / 辖区预测 / 全域研判），每屏 3 秒。
              它是值班常驻的那一套，也是用户认定的底子：「在那个的基础上去改」。
              九页放大版留在 /board/nine：它一页只讲一件事，适合站着讲解，
              不适合当墙上的仪表盘。 */}
          <Route path="/board" element={<BoardPage />} />
          <Route path="/board/nine" element={<NineBoard />} />
          <Route path="/board/legacy" element={<Navigate to="/board" replace />} />
          {/* 工作台：整个系统就这一屏 */}
          <Route path="/" element={<WorkbenchPage />} />
          {/* 旧的 /w 别名保留：上一轮交接时发出去的链接还能打开 */}
          <Route path="/w" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  )
}
