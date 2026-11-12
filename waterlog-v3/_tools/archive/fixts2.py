# -*- coding: utf-8 -*-
"""清掉换屏后留下的一堆 TS6133/TS2345。

分四类：
1. AnalysisBoard 里 `line()` 的取值函数签名写成了 (v:number)=>number，
   实际传进去的是 TrendPoint；改成泛型。
2. 未使用的 import / 常量 / hook：平台面板撤屏后它们没有调用点了。
   注意 `useHealth()` 之类的 **hook 不能删调用**（删了是引入 bug），
   只能删变量绑定并把调用保留为副作用——但 React 不允许裸调用 setState hook，
   所以正确做法是保留变量名并加下划线前缀，或者干脆不再调用。
   这里选「不再调用」：数据没人用了，继续每 3 秒拉一次是浪费。
3. `zonegrid` 的 onChange：六格共享一个 id，拖拽回调必须带 id，
   否则 setRect 无法定位到哪一格。
"""
import io
import re

# ---------------------------------------------------------------- 1. AnalysisBoard
P = 'web/src/board/AnalysisBoard.tsx'
s = io.open(P, encoding='utf-8').read()

s = s.replace(
    "  const line = (pts: readonly TrendPoint[], f: (x: TrendPoint) => number) =>\n"
    "    pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${sx(pt.offsetMin).toFixed(2)},${f(pt).toFixed(2)}`).join(' ')\n",
    "  const line = (pts: readonly TrendPoint[], f: (x: TrendPoint) => number) =>\n"
    "    pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${sx(pt.offsetMin).toFixed(2)},${f(pt).toFixed(2)}`).join(' ')\n",
)

# 调用点原本传的是 syD/syN —— 它们收 number，这里补一层包装
s = s.replace("<path d={line(history, syD)}", "<path d={line(history, (x) => syD(x.sumDepth))}")
s = s.replace("d={line([lastHist, ...outlook], syD)}", "d={line([lastHist, ...outlook], (x) => syD(x.sumDepth))}")

# 未使用
s = s.replace("import type { ZoneCell } from './ZoneGrid'\n", "")
s = s.replace(
    "function whenLabel(atMin: number): string {\n"
    "  if (atMin <= 0) return '此刻'\n"
    "  if (atMin < 60) return `${Math.round(atMin)}min 后`\n"
    "  const h = atMin / 60\n"
    "  return `${Number.isInteger(h) ? h : h.toFixed(1)}h 后`\n"
    "}\n\n",
    "",
)
io.open(P, 'w', encoding='utf-8').write(s)
print('AnalysisBoard ok')

# ---------------------------------------------------------------- 2. BoardPage
P = 'web/src/board/BoardPage.tsx'
s = io.open(P, encoding='utf-8').read()

# 平台面板整屏撤掉 -> import 与 hooks 一起删
s = s.replace("import { DistrictBoard } from './DistrictBoard'\n", "")
s = s.replace(
    "import { AuditFeed, DeliveryPanel, LatencyPanel, QualityPanel, VersionTrack } from './PlatformPanels'\n",
    "",
)
s = re.sub(
    r"  // 「平台运行」屏的数据源：全部是运行记录而不是监测值。\n"
    r"  const health = useHealth\(\)\n"
    r"  const audit = useAudit\(24\)\n"
    r"  const deliveries = useDeliveries\(60\)\n"
    r"  const versions = useModelVersions\(\)\n",
    "  // 平台运维类面板已从大屏撤掉（它们在管理页里更合适），\n"
    "  // 对应的 useHealth/useAudit/useDeliveries/useModelVersions 一并停止调用 ——\n"
    "  // 没人看的数据每几秒拉一次是纯浪费。\n",
    s,
)
s = s.replace("  useAudit,\n", "")
s = s.replace("  useDeliveries,\n", "")
s = s.replace("  useHealth,\n", "")
s = s.replace("  useModelVersions,\n", "")

# OFFLINE_HEALTH 常量
s = re.sub(r"/\*\*[^/]*?\*/\nconst OFFLINE_HEALTH[^\n]*\n", "", s)
s = re.sub(r"const OFFLINE_HEALTH[^\n]*\n", "", s)

# zonegrid 的 onChange
s = s.replace(
    "                    onChange={(r) => setRect({ ...r }, undefined)}",
    "                    onChange={(r) => setRect(r, 'zonegrid')}",
)

io.open(P, 'w', encoding='utf-8').write(s)
print('BoardPage ok')
