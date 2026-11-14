# -*- coding: utf-8 -*-
"""修验收脚本的「Python 引擎在线」在线上模式下的判定。

问题：脚本无条件直连 $Engine（默认 127.0.0.1:8201）。线上引擎刻意只绑
127.0.0.1（对外只开网关端口），所以拿 -Base http://<公网IP>:8200 跑时
这一条必然失败——它测的是「我的机器能否连到引擎」，不是「线上引擎活着没」。

正确做法：Base 指向本机时才直连引擎（本地开发要看 cycles/pending 细节）；
指向远端时改用 Go API 返回的 engine_ok 判定——那才是线上唯一有意义的信号，
而且顺带验证了「网关→引擎」这条链路是通的。
"""
import io

p = 'scripts/acceptance.ps1'
s = io.open(p, encoding='utf-8-sig').read()

old = '''try {
    $e = (HttpGet "$Engine/health") | ConvertFrom-Json
    Check 'Python 引擎在线' ($e.ok -eq $true) ("model={0} cycles={1} pending={2}" -f $e.model_version, $e.cycles, $e.pending)
} catch {
    Check 'Python 引擎在线' $false $_.Exception.Message
}'''

new = '''# 引擎存活判定分两种跑法：
#   本地（Base 在本机）——直连引擎端口，能看到 cycles/pending 这类运行时细节；
#   远端（Base 是别的机器）——引擎刻意只绑 127.0.0.1，外面连不上，改看 Go API
#   回报的 engine_ok。后者其实更有价值：它同时证明了「网关→引擎」这条链路通。
$localRun = $Base -match '127\\.0\\.0\\.1|localhost'
try {
    if ($localRun) {
        $e = (HttpGet "$Engine/health") | ConvertFrom-Json
        Check 'Python 引擎在线' ($e.ok -eq $true) ("model={0} cycles={1} pending={2}" -f $e.model_version, $e.cycles, $e.pending)
    } else {
        $ok = $h.engine_health.ok -eq $true
        Check 'Python 引擎在线' $ok ("经网关判定 model={0} cycles={1} pending={2}" -f $h.engine_health.model_version, $h.engine_health.cycles, $h.engine_health.pending)
    }
} catch {
    Check 'Python 引擎在线' $false $_.Exception.Message
}'''

assert s.count(old) == 1, '引擎判定块锚点不唯一'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8-sig').write(s)
print('OK 验收脚本引擎判定已按本地/远端分流')
