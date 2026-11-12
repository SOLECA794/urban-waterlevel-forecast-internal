# -*- coding: utf-8 -*-
"""重排大屏第二、三屏的坐标，并校验（写回 scene.tsx 之前先算完）。

第二屏：去掉地图，整屏换成「每区一块 12h 预测曲线」= 2列x3行 六块等大。
第三屏：整屏换成统领性分析 5 块 + 数据质量窄带 = 上2 + 中2 + 下(1大+1窄)。
"""
TOP, BOT, GAP = 62, 1068, 12

groups = {}   # scene -> list of (id, Rect)

def alloc(y, total_h, weights):
    """按权重纵向切分 total_h，返回 [(y,h), ...]，余数补给小数部分最大的。"""
    avail = total_h - GAP * (len(weights) - 1)
    raw = [avail * w / sum(weights) for w in weights]
    hs = [int(v) for v in raw]
    rem = avail - sum(hs)
    order = sorted(range(len(weights)), key=lambda i: -(raw[i] - hs[i]))
    for i in order[:rem]:
        hs[i] += 1
    out, cy = [], y
    for h in hs:
        out.append((cy, h))
        cy += h + GAP
    return out

def cols(x, total_w, weights):
    """按权重横向切分 total_w。"""
    avail = total_w - GAP * (len(weights) - 1)
    raw = [avail * t / sum(weights) for t in weights]
    ws = [int(v) for v in raw]
    rem = avail - sum(ws)
    order = sorted(range(len(weights)), key=lambda i: -(raw[i] - ws[i]))
    for i in order[:rem]:
        ws[i] += 1
    out, cx = [], x
    for t in ws:
        out.append((cx, t))
        cx += t + GAP
    return out

# ---------------- 第二屏：辖区预测（2 列 x 3 行）----------------
rows = alloc(TOP, BOT - TOP, [1, 1, 1])
cells = []
for (cy, ch) in rows:
    for (cx, cw) in cols(12, 1896, [1, 1]):
        cells.append((cx, cy, cw, ch))
groups['forecastzones'] = cells

# ---------------- 第三屏：统领性分析 ----------------
# 上带两块（态势 + 多区对比）：260 与辖区看板同量级
# 中带两块（热力图 + 风险格局）：350，热力图要 12h 宽
# 下带三块（趋势研判 + 可信度 + 质量窄带）
top = alloc(TOP, BOT - TOP, [260, 350, 190])
(cx1, cw1), (cx2, cw2) = cols(12, 1896, [1, 1])
(cx3, cw3), (cx4, cw4) = cols(12, 1896, [1.35, 1])
(cx5, cw5), (cx6, cw6) = cols(12, 1896, [1.9, 1])
groups['analysis'] = [
    (cx1, top[0][0], cw1, top[0][1]),   # situation 此刻态势
    (cx2, top[0][0], cw2, top[0][1]),   # districtcmp 多区对比
    (cx3, top[1][0], cw3, top[1][1]),   # heatmap 全域演进热力图
    (cx4, top[1][0], cw4, top[1][1]),   # riskg rid 风险格局
    (cx5, top[2][0], cw5, top[2][1]),   # trendout 趋势研判
    (cx6, top[2][0], cw6, top[2][1]),   # quality 数据质量窄带
]
# confidence 放哪？—— 下带第三块，拆 trendout 为 trendout + confidence 并排
# 重新算下带：trendout / confidence / quality 三块按 1.6 : 1 : 0.9
(cx5, cw5), (cx6, cw6), (cx7, cw7) = cols(12, 1896, [1.6, 1, 0.9])
groups['analysis'] = [
    (cx1, top[0][0], cw1, top[0][1]),
    (cx2, top[0][0], cw2, top[0][1]),
    (cx3, top[1][0], cw3, top[1][1]),
    (cx4, top[1][0], cw4, top[1][1]),
    (cx5, top[2][0], cw5, top[2][1]),
    (cx6, top[2][0], cw6, top[2][1]),
    (cx7, top[2][0], cw7, top[2][1]),
]

def check(name, rects):
    errs = []
    for (x, y, w, h) in rects:
        if w <= 0 or h <= 0:
            errs.append('zero-size')
        if y < TOP - 0.5 or y + h > BOT + 0.5:
            errs.append(f'out-of-band y={y} h={h}')
    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            ax, ay, aw, ah = rects[i]
            bx, by, bw, bh = rects[j]
            if ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah:
                errs.append(f'overlap {i}-{j}')
    covered = 1896 * (BOT - TOP)
    area = sum(w * h for (_, _, w, h) in rects)
    print(f'{name}: {len(rects)} 块  覆盖 {area/covered*100:.1f}%  ' + ('OK' if not errs else 'ERR ' + '; '.join(errs)))
    for r in rects:
        print('   R(%d, %d, %d, %d)' % r)
    return not errs

ok1 = check('forecastzones', groups['forecastzones'])
ok2 = check('analysis', groups['analysis'])
print('ALL OK' if ok1 and ok2 else 'FAILED')
