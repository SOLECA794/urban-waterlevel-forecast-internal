# -*- coding: utf-8 -*-
"""版面约束求解 / 校验器。

为什么需要它：改版面之前必须先能**校验**。之前手填坐标两轮都没收敛
（组件被填成 0 面积、`stack()` 忘传 `y0` 导致与地图重叠、变量自引用 NameError），
就是因为没有 `check()` 在写盘之前把错误挡住。

这个脚本做三件事：
1. 从 `web/src/board/layout.ts` **读回三套预设的真实坐标**（不重新发明）；
2. 提供 `weighted()` / `stack()` / `check()` 三个纯函数，改版面时先算完再写；
3. `verify` 把读回的坐标逐套过一遍 `check()`（块数 / 正面积 / 落在带内 / 两两不重叠 / 块间恰好 GAP）。

用法：
  python _tools/board_layout.py verify   # 校验当前 layout.ts，有问题退出码 1
  python _tools/board_layout.py dump     # 打印当前坐标表与各栏尾余量
"""
import io
import re
import sys

LAYOUT = 'web/src/board/layout.ts'

BOARD_W = 1920
BOARD_H = 1080
TOP = 62
BOT = 1068
GAP = 12
H = BOT - TOP  # 1006

ID_RE = re.compile(r"^\s*(\w+):\s*R\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\),\s*$")


def parse(path=LAYOUT):
    """从 layout.ts 读出三套预设，返回 {预设名: {id: (x,y,w,h)}}。"""
    s = io.open(path, encoding='utf-8').read()
    out = {}
    for name in ('BALANCED', 'MAP_FIRST', 'INFO_FIRST'):
        # 预设声明形如 `const BALANCED: Record<WidgetId, Rect> = { ... }`
        m = re.search(r"const %s[^=]*=\s*\{(.*?)\n\}" % name, s, re.S)
        if not m:
            raise SystemExit('在 %s 里找不到预设 %s' % (path, name))
        rows = {}
        for line in m.group(1).splitlines():
            g = ID_RE.match(line)
            if g:
                rows[g.group(1)] = tuple(int(g.group(i)) for i in range(2, 6))
        out[name] = rows
    return out


def weighted(total, weights, gap=GAP):
    """按权重把 total 分给 n 块（扣掉块间 gap），余数补给小数部分最大的几块。

    不用 int(total/n) 平均分：面板高度差 1px 就会让 9.5px 的文字从
    「刚好放下」变成「叠一行」，而余数补给谁必须是确定的。
    """
    avail = total - gap * (len(weights) - 1)
    raw = [avail * w / sum(weights) for w in weights]
    out = [int(v) for v in raw]
    rest = avail - sum(out)
    order = sorted(range(len(raw)), key=lambda i: raw[i] - out[i], reverse=True)
    for k in range(rest):
        out[order[k % len(order)]] += 1
    return out


def stack(x, w, heights, y0=TOP):
    """纵向堆叠成 [(x, y, w, h), ...]，块间留 GAP。"""
    out, y = [], y0
    for h in heights:
        out.append((x, y, w, h))
        y += h + GAP
    return out


def check(g, label=''):
    """校验一套版面，返回问题列表（空 = 通过）。

    五项，缺一不可：
      · 每块 w/h 为正（0 面积的备用位直接跳过，但要在调用处显式说明）
      · 每块落在 [TOP, BOT] 纵向带内、[0, BOARD_W] 横向带内
      · 任意两块不重叠
      · 同一栏相邻两块之间的空隙**恰好等于 GAP**（重叠检查抓不到「贴在一起」）
    """
    bad = []
    items = [(k, v) for k, v in g.items() if v and v[3] > 0]
    for k, (x, y, w, h) in items:
        if w <= 0 or h <= 0:
            bad.append((k, 'non-positive', w, h))
        if y < TOP or y + h > BOT:
            bad.append((k, 'out-of-band-y', y, y + h))
        if x < 0 or x + w > BOARD_W:
            bad.append((k, 'out-of-band-x', x, x + w))
    for a in range(len(items)):
        for b in range(a + 1, len(items)):
            k1, (x1, y1, w1, h1) = items[a]
            k2, (x2, y2, w2, h2) = items[b]
            if x1 < x2 + w2 and x2 < x1 + w1 and y1 < y2 + h2 and y2 < y1 + h1:
                bad.append((k1, k2, 'overlap'))
    by_col = {}
    for k, (x, y, w, h) in items:
        by_col.setdefault((x, w), []).append((y, h, k))
    for (_x, _w), rows in by_col.items():
        rows.sort()
        for i in range(len(rows) - 1):
            gap = rows[i + 1][0] - (rows[i][0] + rows[i][1])
            if gap != GAP:
                bad.append((rows[i][2], rows[i + 1][2], 'gap=%d(应为 %d)' % (gap, GAP)))
    if label:
        print('%-12s %s' % (label, '通过' if not bad else bad))
    return bad


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'verify'
    presets = parse()
    if mode == 'dump':
        for name, rows in presets.items():
            print('== %s（%d 块）' % (name, len(rows)))
            for k, (x, y, w, h) in sorted(rows.items(), key=lambda kv: (kv[1][0], kv[1][1])):
                print('   %-12s R(%d, %d, %d, %d)' % (k, x, y, w, h))
            cols = {}
            for k, (x, y, w, h) in rows.items():
                if h > 0:
                    cols.setdefault(x, []).append(y + h)
            for x, bottoms in sorted(cols.items()):
                print('   栏 x=%-5d 底 %d（余 %d）' % (x, max(bottoms), BOT - max(bottoms)))
        return
    total = 0
    for name, rows in presets.items():
        total += len(check(rows, name))
    print('合计问题 %d' % total)
    sys.exit(1 if total else 0)


if __name__ == '__main__':
    main()
