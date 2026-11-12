# -*- coding: utf-8 -*-
"""文档：把「画布适配」这条写进 README 与验收报告。"""
import io

p = 'README.md'
s = io.open(p, encoding='utf-8').read()
anchor = '### 大屏不是一屏铺满，是三轮播一遍'
assert anchor in s
add = """### 画布适配：宁可两侧留边，也不裁掉一格内容

大屏是 1920×1080 的固定画布，靠 `transform: scale()` 适配实际屏幕。踩过一轮，
记录在这里：

**症状**：同事在 1410×628（宽高比 2.245）的窗口里打开，说「整个页面上就显示了一点」。

**两次误修**

1. **先用 `Math.min`（contain）**——保证不裁，但 2.245 的窗口下 `scale = 628/1080 = 0.581`，
   画布只渲染 1116px 宽，右侧空 294px。看上去就像"没铺满"。
2. **改成"宽度定 scale、画布高度随视口浮动"**——宽度确实铺满了，但把逻辑高度从 1080
   压到 855，`rects` 的 y/h 同比压缩了 21%，而**面板内部的 flex 内容并不会跟着缩小**，
   结果是底部整行面板被裁掉一半。这是更糟的错：数据看不见了。

**最终做法**：回到 contain 缩放（`Math.min`），但把外层从
`position: fixed; inset: 0; overflow: hidden` 改成**居中布局 + 外圈同色底**。
- 内容一格不少（16:9 的版面在任何比例下都完整）；
- 画布居中，外圈用版面底色的最浅一档，读起来是「版面外缘」而不是「没渲染」；
- 不再用 `inset: 0 + overflow: hidden` 钉死外层——那会把超出视口高度的部分
  直接剪掉（1410×628 下 1080 逻辑高会变成 793px，比视口高 165px）。

**一句话**：宽高比不匹配是物理事实，`contain` + 居中 + 同色外圈是唯一
「不裁内容、不压变形、不显得没铺满」的解法。**不要为了填满去压缩版面高度——
面板内容不会跟着缩，只会被裁。**

"""
s = s.replace(anchor, add + anchor, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('README ok')

p2 = 'docs/02-验收报告.md'
s2 = io.open(p2, encoding='utf-8').read()
a2 = '## 5.3'
assert a2 in s2
add2 = """### 5.2.16 画布适配：修「整页只显示了一点」

**用户反馈**（1410×628 窗口，宽高比 2.245）：整页只显示左上角一小块。

**误修两轮（都要记）**
1. `Math.min` contain 本身没错，但外层是 `position: fixed; inset: 0; overflow: hidden`——
   它把外层盒子钉死在视口高度上，而缩放后的画布比视口高（0.734 比例下 1080 逻辑高
   → 793px 实际高，视口只有 628px），超出的 165px 被 `overflow` 直接剪掉，底部整行面板消失。
2. 试图用「宽度定 scale + 画布逻辑高度随视口浮动 + rects 的 y/h 归一化」铺满，
   结果把逻辑高度从 1080 压到 855（k=0.79），面板盒子变矮而内部 flex 内容不变，
   底部被裁得更狠。**面板内部内容不会随盒子等比缩小，压缩版面高度只会裁内容。**

**最终做法**：`scale = Math.min(innerW/1920, innerH/1080)`（contain，内容一格不少）
+ 外层改 flex 居中 + 外圈同色底（`linear-gradient(180deg,#E7F0F9,#D9E8F5 60%,#CFE2F3)`）。

**验证**：`npx tsc --noEmit` 干净 · `npm run build` ✓（`index-DmyuSUOV.js`）·
`node scripts/measure-overflow.mjs --scene=0/1/2` **三屏均零溢出** ·
`python _tools/board_layout.py verify` 三套预设通过 · 1410×628 实测画布居中
（`canvas [1116,628] left=147`）且内容完整 · 1920×1080 截图无裁切 ·
`scripts/acceptance.ps1 -SkipStorm` **PASS 59 / FAIL 0**（`logs/acceptance-20261112-184040.tsv`）。

"""
s2 = s2.replace(a2, add2 + a2, 1)
io.open(p2, 'w', encoding='utf-8').write(s2)
print('docs ok')
