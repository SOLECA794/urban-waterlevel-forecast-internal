#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重建 shots/index.json —— 索引必须反映磁盘上的真实文件与真实字节数。

为什么值得写个脚本而不是手改：截图是迭代出来的，文件名会变（board-dark 删了、
03-detail-S05 换成 S08、prod/ 是另一批），手改必然和磁盘脱节。
索引里存的是当时的字节数，用它可以直接判断截图有没有被重新生成过。
"""
import io
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, os.pardir, 'shots')

# 只要顶层 png（prod/ 是一批单独的线上截图，由 prod-board.png 代表）
files = sorted(
    f for f in os.listdir(SHOTS)
    if f.endswith('.png') and not f.startswith('_')
)

entries = []
for f in files:
    p = os.path.join(SHOTS, f)
    entries.append({'file': 'shots/' + f, 'bytes': os.path.getsize(p)})

out = os.path.join(SHOTS, 'index.json')
io.open(out, 'w', encoding='utf-8', newline='\n').write(
    json.dumps(entries, ensure_ascii=False, indent=1) + '\n'
)
print('index.json 已重建：%d 项 / %.1f MB' % (
    len(entries), sum(e['bytes'] for e in entries) / 1024 / 1024))
for e in entries:
    print('  %-26s %8.1f KB' % (os.path.basename(e['file']), e['bytes'] / 1024))
