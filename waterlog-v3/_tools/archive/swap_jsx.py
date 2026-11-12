# -*- coding: utf-8 -*-
"""替换 BoardPage.tsx 里两屏的 JSX。

做三件事：
1. `districts` 的 Widget 改成 `zonegrid` 六格（同一组件按 scene.grid 渲染六次）；
2. 删掉 quality/latency/delivery/auditfeed/versions 五个平台面板的 Widget；
3. 插入 heatmap / riskmap / trendout / confidence / districtcmp 五个分析面板。

**为什么整块替换而不是逐条 edit**：这些块是几百行的 JSX，中间夹着模板字符串、
注释和嵌套花括号，按锚点改一次改坏一次的代价远高于「整段定位 + 整段写回」。
定位方式：按 `id="xxx"` 的属性行找到开标签，再用 `</Widget>` 配平找块尾 ——
不要靠数缩进或数行号，那些在文件被格式化之后立刻失效。
"""
import io

P = 'web/src/board/BoardPage.tsx'
s = io.open(P, encoding='utf-8').read()


def block_of(widget_id):
    """返回 id="xxx" 的整个 <Widget>...</Widget> 块的 [start, end)。"""
    marker = 'id="%s"' % widget_id
    i = s.find(marker)
    assert i > 0, 'not found: ' + widget_id
    start = s.rfind('<Widget', 0, i)
    assert start > 0, 'no <Widget before: ' + widget_id
    # 从 marker 往后按标签配平找 </Widget>
    depth = 0
    pos = start
    while True:
        nxt_open = s.find('<Widget', pos + 1)
        nxt_close = s.find('</Widget>', pos + 1)
        assert nxt_close > 0, 'unbalanced: ' + widget_id
        if nxt_open != -1 and nxt_open < nxt_close:
            depth += 1
            pos = nxt_open
            continue
        if depth == 0:
            return start, nxt_close + len('</Widget>')
        depth -= 1
        pos = nxt_close


# ---------------------------------------------------------------- 1. districts -> zonegrid
ZG = '''              {/* ---------- 辖区预测：六格等大，每格一个辖区一张 12h 曲线 ---------- */}
              {/* 六格不是六个组件，是同一个 ZoneCellView 按 zoneCells 各渲染一次。
                  纵轴由 zoneDomain 统一给出 —— 各格自带刻度会让「东城看着比西城高」
                  变成纯粹的坐标轴错觉。 */}
              {zoneCells.map((cell, ci) => {
                const grid = scene.grid
                const base = grid && grid.id === 'zonegrid' ? rects[grid.id] : rects.zonegrid
                const nCols = 2
                const nRows = Math.ceil((grid?.count ?? 6) / nCols)
                const gap = 12
                const cw = (base.w - gap * (nCols - 1)) / nCols
                const ch = (base.h - gap * (nRows - 1)) / nRows
                const cellRect: Rect = {
                  x: base.x + (ci % nCols) * (cw + gap),
                  y: base.y + Math.floor(ci / nCols) * (ch + gap),
                  w: cw,
                  h: ch,
                }
                return (
                  <Widget
                    key={`zone-${cell.district}`}
                    id="zonegrid"
                    rect={cellRect}
                    scale={scale}
                    editing={editing}
                    p={p}
                    onChange={(r) => setRect({ ...r }, undefined)}
                    onCommit={() => saveLayout(layoutRef.current)}
                  >
                    <Panel
                      title={cell.district === '全域合计' ? '全域合计' : cell.district}
                      sub={cell.district === '全域合计' ? '十站水位合计 · 看是面上的雨还是点上的雨' : `${cell.series.length} 站 · 12h 预测`}
                      accent={p.level[cell.topLevel]}
                      style={{ height: '100%' }}
                    >
                      <ZoneCellView cell={cell} domain={zoneDomain} p={p} />
                    </Panel>
                  </Widget>
                )
              })}
'''

st, en = block_of('districts')
s = s[:st] + ZG + s[en:]

# ---------------------------------------------------------------- 2. 删掉五个平台面板
for wid in ('versions', 'auditfeed', 'delivery', 'latency', 'quality'):
    st, en = block_of(wid)
    s = s[:st] + s[en:]

# ---------------------------------------------------------------- 3. 插入分析面板
# 插在 trend 之前（右栏渲染区），顺序不影响绝对定位，只要在同一个父容器里。
anchor = '              <Widget\n                id="decision"'
assert s.count(anchor) == 1, s.count(anchor)

ANA = '''              {/* ---------- 全域研判：跨区跨时段的统领性分析 ---------- */}

              <Widget
                id="heatmap"
                rect={rects.heatmap}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="全域水位演进"
                  sub="时间 × 站点 · 同一行连续变色＝该站持续上涨，同一列一起变色＝全城同时上涨"
                  accent={p.level.red}
                  style={{ height: '100%' }}
                >
                  <Heatmap rows={heatRows} columns={Array.from({ length: HEAT_COLS }, (_, i) => (i - 6) * 60)} p={p} />
                </Panel>
              </Widget>

              <Widget
                id="riskmap"
                rect={rects.riskmap}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="风险格局"
                  sub="深度 × 1h 变幅 · 四个象限各有处置含义"
                  accent={p.level.orange}
                  style={{ height: '100%' }}
                >
                  <RiskQuadrant points={riskPoints} blue={riskBlue} p={p} />
                </Panel>
              </Widget>

              <Widget
                id="trendout"
                rect={rects.trendout}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="全域趋势研判"
                  sub="合计水位 + 预警站数 · 实线已发生，虚线是按当前斜率外延"
                  accent={p.accent2}
                  style={{ height: '100%' }}
                >
                  <TrendOutlook history={trendHistory} outlook={trendOutlook} p={p} />
                </Panel>
              </Widget>

              <Widget
                id="confidence"
                rect={rects.confidence}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="预测可信度"
                  sub="12h 预测的 90% 区间半宽 · 越短越敢信"
                  accent={p.forecast}
                  style={{ height: '100%' }}
                >
                  <Confidence rows={confidenceRows} p={p} />
                </Panel>
              </Widget>

              <Widget
                id="districtcmp"
                rect={rects.districtcmp}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="多区对比"
                  sub="五个街道横向比 · 三条各自按全城最大值归一"
                  accent={p.accent}
                  style={{ height: '100%' }}
                >
                  <DistrictCompare rows={districtCompare} p={p} />
                </Panel>
              </Widget>

'''

s = s.replace(anchor, ANA + anchor, 1)

io.open(P, 'w', encoding='utf-8').write(s)
print('JSX replaced, length', len(s))
