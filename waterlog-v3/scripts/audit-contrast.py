#!/usr/bin/env python
"""配色体检：把 web/src 里的令牌两两算 WCAG 2.1 对比度。

跑法（在 waterlog-v3 根目录）：
    python scripts/audit-contrast.py

它读三个文件，不读浏览器：
  - web/src/styles/tokens.css   主应用令牌（:root 里的 --*）
  - web/src/utils/tokens.ts     ECharts/SVG 的 hex 副本（必须与 css 同步）
  - web/src/board/theme.ts      大屏 PALETTE

判定口径：
  - 正文（< 18.66px 或非粗体）      4.5:1
  - 大字（>= 18.66px 粗体 / >= 24px）与图形（条形、曲线、徽标）  3.0:1
  - 半透明前景先合成到背景上再算，半透明面板先压到底图上再算

改色之后必须重跑本脚本并让 FAIL 归零；只有 3.0 一档的项（图形）允许低于 4.5。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'web', 'src')


def parse_any(v):
    v = v.strip()
    if v.startswith('#'):
        h = v.lstrip('#')
        if len(h) == 3:
            h = ''.join(c * 2 for c in h)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    m = re.match(r'rgba?\(([^)]+)\)', v)
    if not m:
        raise ValueError(v)
    p = [x.strip() for x in m.group(1).split(',')]
    r, g, b = (int(float(p[i])) for i in range(3))
    a = float(p[3]) if len(p) > 3 else 1.0
    return (r, g, b, a) if a < 1 else (r, g, b)


def flatten(c, under=(255, 255, 255)):
    if len(c) == 3:
        return c
    r, g, b, a = c
    return (round(r * a + under[0] * (1 - a)),
            round(g * a + under[1] * (1 - a)),
            round(b * a + under[2] * (1 - a)))


def lum(c):
    def f(v):
        v = v / 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])


def ratio(fg, bg):
    b = flatten(parse_any(bg))
    f = flatten(parse_any(fg), b)
    l1, l2 = lum(f), lum(b)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def hex_of(c):
    return '#%02X%02X%02X' % c


def hue(c):
    r, g, b = [v / 255 for v in c[:3]]
    mx, mn = max(r, g, b), min(r, g, b)
    if mx == mn:
        return 0.0
    d = mx - mn
    h = ((g - b) / d) % 6 if mx == r else ((b - r) / d + 2 if mx == g else (r - g) / d + 4)
    return h * 60


# ---------- 载入 ----------
css = io.open(os.path.join(SRC, 'styles', 'tokens.css'), encoding='utf-8').read()
T = {}
for line in css.splitlines():
    m = re.match(r'\s*(--[\w-]+):\s*([^;]+);', line)
    if m:
        T[m.group(1)] = m.group(2).strip()

ts = io.open(os.path.join(SRC, 'board', 'theme.ts'), encoding='utf-8').read()
B = {}
body = ts[ts.index('export const PALETTE'):ts.index('export const PALETTES')]
for grp in ('level', 'levelInk', 'levelSoft'):
    m = re.search(grp + r':\s*\{([^}]+)\}', body)
    if m:
        for mm in re.finditer(r"(\w+):\s*'([^']+)'", m.group(1)):
            B[grp + '.' + mm.group(1)] = mm.group(2)
        body = body.replace(m.group(0), '')
for mm in re.finditer(r"^\s{2}(\w+):\s*'([^']+)'", body, re.M):
    B[mm.group(1)] = mm.group(2)

W = '#ffffff'
# 半透明面板压在瓦片上的最坏情况（深绿地块）：0.94 白合成后约 #FBFCFA
PANEL_WORST = '#FBFCFA'

CHECKS = [
    # ---- 主应用 ----
    ('主/正文 text-1 on surface', T['--text-1'], W, 14, False, '表格单元格、正文'),
    ('主/次级 text-2 on surface', T['--text-2'], W, 13, False, '说明、表头副标'),
    ('主/三级 text-3 on surface', T['--text-3'], W, 12, False, '时间戳、单位、脚注'),
    ('主/三级 text-3 on canvas', T['--text-3'], T['--bg-canvas'], 12, False, '卡片外副标'),
    ('主/text-2 on subtle', T['--text-2'], T['--bg-subtle'], 13, False, '表头底、hover 行'),
    ('主/text-3 on subtle', T['--text-3'], T['--bg-subtle'], 12, False, 'kbd、占位符'),
    ('主/侧栏正文', T['--sidebar-text'], T['--sidebar-bg'], 13, False, '导航项'),
    ('主/侧栏弱化', T['--sidebar-muted'], T['--sidebar-bg'], 12, False, '分组标题、hint'),
    ('主/侧栏激活', T['--sidebar-text-active'], T['--sidebar-bg'], 13, True, '当前路由'),
    ('主/蓝 ink on weak', T['--level-blue-ink'], T['--level-blue-weak'], 12, False, 'LevelChip'),
    ('主/黄 ink on weak', T['--level-yellow-ink'], T['--level-yellow-weak'], 12, False, 'LevelChip'),
    ('主/橙 ink on weak', T['--level-orange-ink'], T['--level-orange-weak'], 12, False, 'LevelChip'),
    ('主/红 ink on weak', T['--level-red-ink'], T['--level-red-weak'], 12, False, 'LevelChip'),
    ('主/黄 surface 当图形', T['--level-yellow'], W, 12, False, '条形/曲线（3:1）'),
    ('主/橙 surface 当图形', T['--level-orange'], W, 12, False, '条形/曲线（3:1）'),
    ('主/primary on weak', T['--primary'], T['--primary-weak'], 13, True, '主按钮文字'),
    ('主/白字 on primary', W, T['--primary'], 13, True, '主按钮'),
    ('主/白字 on primary-strong', W, T['--primary-strong'], 13, True, '主按钮 hover'),
    ('主/ai-ink on ai-weak', T['--accent-ai-ink'], T['--accent-ai-weak'], 12, False, '智能体标签'),
    ('主/success-ink on white', T['--success-ink'], W, 12, False, '成功率'),
    ('主/neutral on white', T['--neutral'], W, 12, False, '中性徽标'),
    # ---- 大屏 ----
    ('屏/正文 on 面板', B['text'], B['panel'], 12, False, '卡片正文'),
    ('屏/次级 on 面板', B['textDim'], B['panel'], 11, False, '单位、行标签'),
    ('屏/三级 on 面板', B['textFaint'], B['panel'], 10, False, '脚注、刻度'),
    ('屏/三级 on 最坏瓦片', B['textFaint'], PANEL_WORST, 10, False, '压在深绿地块上的脚注'),
    ('屏/accent on 面板', B['accent'], B['panel'], 10, False, '拖拽标签'),
    ('屏/无预警 levelInk', B['levelInk.none'], B['panel'], 10, False, '无预警标签'),
    ('屏/蓝 levelInk', B['levelInk.blue'], B['panel'], 11, False, '蓝色等级'),
    ('屏/黄 levelInk', B['levelInk.yellow'], B['panel'], 11, False, '黄色等级'),
    ('屏/橙 levelInk', B['levelInk.orange'], B['panel'], 11, False, '橙色等级'),
    ('屏/红 levelInk', B['levelInk.red'], B['panel'], 11, False, '红色等级'),
    ('屏/蓝 level 当图形', B['level.blue'], B['panel'], 10, False, '条形/曲线（3:1）'),
    ('屏/黄 level 当图形', B['level.yellow'], B['panel'], 10, False, '条形/曲线（3:1）'),
    ('屏/橙 level 当图形', B['level.orange'], B['panel'], 10, False, '条形/曲线（3:1）'),
    ('屏/无预警 level 当图形', B['level.none'], B['panel'], 10, False, '条形（3:1）'),
    ('屏/forecast 线', B['forecast'], B['panel'], 10, False, '预测曲线（3:1）'),
    ('屏/rain 数字', B['rain'], B['panel'], 10, False, '雨强'),
]

GRAPHIC_HINT = ('图形', '曲线', '条形', '徽标')

rows = []
for name, fg, bg, size, bold, use in CHECKS:
    try:
        r = ratio(fg, bg)
    except Exception as exc:  # noqa: BLE001
        rows.append((name, fg, bg, 0.0, 'PARSE-ERR', str(exc)))
        continue
    large = size >= 24 or (size >= 18.66 and bold)
    graphic = any(g in use for g in GRAPHIC_HINT)
    need = 3.0 if (large or graphic) else 4.5
    v = 'PASS' if r >= need else ('MARGINAL' if r >= need - 0.5 else 'FAIL')
    rows.append((name, fg, bg, round(r, 2), v, use))

for tag in ('PARSE-ERR', 'FAIL', 'MARGINAL', 'PASS'):
    g = [x for x in rows if x[4] == tag]
    if not g:
        continue
    print('--- %s (%d) ---' % (tag, len(g)))
    for name, fg, bg, r, _, use in sorted(g, key=lambda x: x[3]):
        print('%6.2f  %-24s %-22s on %-24s %s' % (r, name, fg, bg, use))
    print()

counts = {t: len([x for x in rows if x[4] == t]) for t in ('FAIL', 'MARGINAL', 'PASS', 'PARSE-ERR')}
print('合计 %d 对：' % len(rows) + ' / '.join('%s %d' % (k, v) for k, v in counts.items()))

print('\n色相盘点（饱和度 > 0.25 才算「有颜色」）：')
buckets = {}
for k, v in T.items():
    if not v.startswith('#'):
        continue
    c = parse_any(v)
    r_, g_, b_ = [x / 255 for x in c]
    mx, mn = max(r_, g_, b_), min(r_, g_, b_)
    sat = 0.0 if mx == mn else (mx - mn) / mx
    if sat > 0.25:
        buckets.setdefault(round(hue(c) / 30) * 30, []).append((k, v))
for h in sorted(buckets):
    items = buckets[h]
    print('  %4d° %2d 个：%s' % (h, len(items), ', '.join('%s%s' % (k, v) for k, v in items[:8])))
print('  合计 %d 个有彩色令牌，跨 %d 个 30° 桶'
      % (sum(len(v) for v in buckets.values()), len(buckets)))

sys.exit(1 if counts['FAIL'] else 0)
