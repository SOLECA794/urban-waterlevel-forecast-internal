# waterlog-v3 端到端验收脚本
#
# 用法：
#   .\scripts\acceptance.ps1                 # 完整验收（会注入暴雨、约 8 分钟）
#   .\scripts\acceptance.ps1 -SkipStorm      # 只验接口契约与前端页面
#   .\scripts\acceptance.ps1 -Shots          # 顺带截图
#
# 设计原则：每一步都打印"期望 vs 实际"，失败不中断（除了服务不可用），
# 最后汇总 PASS/FAIL 计数，退出码 0 表示全通过。

param(
    [string]$Base = 'http://127.0.0.1:8200',
    [string]$Engine = 'http://127.0.0.1:8201',
    [string]$User = 'admin',
    # 不能叫 $Pass：PowerShell 变量名大小写不敏感，它会和下面的
    # $script:pass 计数器撞成同一个变量，于是 `$script:pass++` 变成
    # 对字符串自增，报「'++' 运算符仅适用于数字」——而且报错点在计数函数里，
    # 完全看不出是参数名的锅。
    [string]$Password = 'admin123',
    [switch]$SkipStorm,
    [switch]$Shots
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0
$script:notes = New-Object System.Collections.Generic.List[string]

function Section($t) {
    Write-Host ''
    Write-Host ('=' * 66) -ForegroundColor DarkGray
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('=' * 66) -ForegroundColor DarkGray
}

function Check($name, $ok, $detail) {
    if ($ok) {
        $script:pass++
        Write-Host ("  [PASS] {0}" -f $name) -ForegroundColor Green
    } else {
        $script:fail++
        Write-Host ("  [FAIL] {0}" -f $name) -ForegroundColor Red
    }
    if ($detail) { Write-Host ("         {0}" -f $detail) -ForegroundColor DarkGray }
    $script:notes.Add(("{0}`t{1}`t{2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, $detail))
}

# 会话 cookie：接口加了鉴权之后，验收脚本自己也要登录。
# 用 cookie jar 文件而不是手拼 Cookie 头——jar 会跟着 Set-Cookie 走，
# 以后换成刷新令牌也不用改脚本。
$script:jar = Join-Path $env:TEMP ('wl-accept-' + [guid]::NewGuid().ToString('N') + '.cookies')
$script:loggedIn = $false

function Login {
    $f = Join-Path $env:TEMP ('wl-accept-login-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        $json = '{"username":"' + $User + '","password":"' + $Password + '"}'
        [IO.File]::WriteAllText($f, $json, [Text.UTF8Encoding]::new($false))
        $raw = & curl.exe --noproxy '*' -s -m 20 -c $script:jar -H 'Content-Type: application/json' --data-binary "@$f" -w "`n%{http_code}" "$Base/api/auth/login" 2>$null
        $lines = @($raw)
        $code = $lines[-1]
        $body = ($lines[0..([Math]::Max(0, $lines.Count - 2))] -join "`n")
        return @{ code = $code; body = $body }
    } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}

# 统一走 curl.exe 并显式 --noproxy '*'：本机代理会拦 127.0.0.1
function HttpGet($url) {
    $body = & curl.exe --noproxy '*' -s -m 30 -b $script:jar $url 2>$null
    return ($body -join "`n")
}

function HttpPost($url) {
    $body = & curl.exe --noproxy '*' -s -m 60 -b $script:jar -X POST $url 2>$null
    return ($body -join "`n")
}

function HttpCode($url, $method) {
    # 只要状态码的场景（验 401/409 这类"必须失败"的断言）
    return (& curl.exe --noproxy '*' -s -m 30 -b $script:jar -o NUL -w '%{http_code}' -X $method $url 2>$null)
}

function J($json, $path) {
    # 极简取值：支持 a.b.c 与 a[0].b
    $cur = $json
    foreach ($seg in $path.Split('.')) {
        if ($null -eq $cur) { return $null }
        if ($seg -match '^(\w+)\[(\d+)\]$') {
            $cur = $cur.($Matches[1])[[int]$Matches[2]]
        } elseif ($seg -match '^(\w+)\[(\d+):\]$') {
            $cur = @($cur.($Matches[1]) | Select-Object -Skip ([int]$Matches[2]))
        } else {
            $cur = $cur.$seg
        }
    }
    return $cur
}

# ---------------------------------------------------------------- 0. 服务健康
Section '0. 服务健康'

try {
    $h = (HttpGet "$Base/api/health") | ConvertFrom-Json
    Check 'Go API 在线' ($h.ok -eq $true) ("service={0} engine={1}" -f $h.service, $h.engine)
    Check 'Go API 能连上引擎' ($h.engine_ok -eq $true) ("engine_health.cycles={0}" -f $h.engine_health.cycles)
} catch {
    Check 'Go API 在线' $false $_.Exception.Message
    Write-Host '  服务没起来，先执行 .\start.ps1' -ForegroundColor Yellow
    exit 2
}

try {
    $e = (HttpGet "$Engine/health") | ConvertFrom-Json
    Check 'Python 引擎在线' ($e.ok -eq $true) ("model={0} cycles={1} pending={2}" -f $e.model_version, $e.cycles, $e.pending)
} catch {
    Check 'Python 引擎在线' $false $_.Exception.Message
}

# ---------------------------------------------------------------- 0.5 鉴权
Section '0.5 鉴权（未登录必须被挡住）'

# 先确认"没登录真的进不来"，再登录。顺序不能反：
# 如果先登录再测未登录，jar 里已经有 cookie，这一条就永远通过、等于没测。
$anon = & curl.exe --noproxy '*' -s -m 20 -o NUL -w '%{http_code}' "$Base/api/overview" 2>$null
Check '未登录读接口返回 401' ($anon -eq '401') ("HTTP $anon")

$anonW = & curl.exe --noproxy '*' -s -m 20 -o NUL -w '%{http_code}' -X POST "$Base/api/sim/storm?peak=40&dur=8" 2>$null
Check '未登录写接口返回 401' ($anonW -eq '401') ("HTTP $anonW")

$bad = Login
# 口令错误时 Login 用的是对的口令，所以单独发一次错的
$f = Join-Path $env:TEMP ('wl-accept-bad-' + [guid]::NewGuid().ToString('N') + '.json')
try {
    [IO.File]::WriteAllText($f, ('{"username":"' + $User + '","password":"definitely-wrong"}'), [Text.UTF8Encoding]::new($false))
    $badCode = & curl.exe --noproxy '*' -s -m 20 -o NUL -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$f" "$Base/api/auth/login" 2>$null
} finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
Check '口令错误返回 401' ($badCode -eq '401') ("HTTP $badCode")

$li = Login
$script:loggedIn = ($li.code -eq '200')
Check ('登录成功（{0}）' -f $User) $script:loggedIn $(if ($script:loggedIn) { ($li.body | ConvertFrom-Json).user.role_label } else { "HTTP $($li.code) $($li.body)" })
if (-not $script:loggedIn) {
    Write-Host '  登录失败，后续需要鉴权的检查都会失败；先确认账号口令（默认 admin / admin123）' -ForegroundColor Yellow
}

$me = (HttpGet "$Base/api/auth/me") | ConvertFrom-Json
Check '会话可查询当前账号' ($null -ne $me.user.username) ("{0} / {1}" -f $me.user.username, $me.user.role)

# ---------------------------------------------------------------- 1. 接口契约
Section '1. 接口契约（状态码 + 结构 + 关键字段）'

$spec = @(
    @{ path = '/api/overview';       min = 500;  key = 'sites' },
    @{ path = '/api/sites';          min = 500;  key = 'sites' },
    @{ path = '/api/forecast';       min = 5000; key = 'sites' },
    @{ path = '/api/metrics';        min = 500;  key = 'latest' },
    @{ path = '/api/eval?hours=24';  min = 2;    key = 'pairs' },
    @{ path = '/api/alerts';         min = 2;    key = 'alerts' },
    @{ path = '/api/rules';          min = 100;  key = 'weights' },
    @{ path = '/api/decisions';      min = 2;    key = 'decisions' },
    @{ path = '/api/retrain/status'; min = 2;    key = 'status' }
)
foreach ($s in $spec) {
    $raw = HttpGet ($Base + $s.path)
    $ok = $false; $detail = ''
    try {
        $obj = $raw | ConvertFrom-Json
        $hasKey = $null -ne $obj.($s.key)
        $bigEnough = $raw.Length -ge $s.min
        $ok = $hasKey -and $bigEnough
        $detail = "len={0}B key={1}={2}" -f $raw.Length, $s.key, $(if ($hasKey) { 'present' } else { 'MISSING' })
    } catch {
        $detail = "非 JSON 或解析失败: " + $raw.Substring(0, [Math]::Min(80, $raw.Length))
    }
    Check ("GET " + $s.path) $ok $detail
}

# 概览必须覆盖全部 10 个站点，且每个站点带齐静态属性 + 实测 + 预警字段
$ov = (HttpGet "$Base/api/overview") | ConvertFrom-Json
Check '一张图覆盖 10 个站点' (@($ov.sites).Count -eq 10) ("count={0}" -f @($ov.sites).Count)
$s0 = $ov.sites[0]
$fields = 'site_id', 'name', 'lon', 'lat', 'base_level', 'thresholds', 'level', 'depth', 'warn_level', 'warn_score', 'spark'
$missing = @($fields | Where-Object { $null -eq $s0.$_ })
Check '站点字段齐全' ($missing.Count -eq 0) ("缺失: " + ($missing -join ','))
Check '四级阈值是 4 个值' (@($s0.thresholds).Count -eq 4) ("thresholds=" + (@($s0.thresholds) -join '/'))
Check '迷你曲线有数据' (@($s0.spark).Count -gt 0) ("spark 点数=" + @($s0.spark).Count)
$ranked = $true
for ($i = 1; $i -lt @($ov.sites).Count; $i++) {
    $order = @{ none = 0; blue = 1; yellow = 2; orange = 3; red = 4 }
    if ($order[$ov.sites[$i].warn_level] -gt $order[$ov.sites[$i - 1].warn_level]) { $ranked = $false }
}
Check '站点按预警等级降序排列' $ranked '值班员第一眼看到最急的'

# 单站详情：历史 + 预测 + 研判三段都要在
$sid = $ov.sites[0].site_id
$dt = (HttpGet "$Base/api/sites/$sid") | ConvertFrom-Json
Check '详情含历史序列' (@($dt.history).Count -gt 0) ("history 点数=" + @($dt.history).Count)
Check '详情含预测' ($null -ne $dt.forecast) ("horizons=" + @($dt.forecast.horizons).Count)
Check '预测含 4 个预见期' (@($dt.forecast.horizons).Count -eq 4) ((@($dt.forecast.horizons | ForEach-Object { $_.horizon_min }) -join '/') + ' min')
Check '预测曲线带置信带' (@($dt.forecast.curve).Count -gt 0) ("curve 点数=" + @($dt.forecast.curve).Count + "，每点 [offset,level,lower,upper]")

# 置信区间必须包住点预测（自洽性检查，防止上下界写反）
$bad = 0
foreach ($hh in $dt.forecast.horizons) {
    if ($hh.lower -gt $hh.level -or $hh.upper -lt $hh.level) { $bad++ }
}
Check '置信区间包住点预测' ($bad -eq 0) ("越界 $bad 个")

# 物理钳制：预测水位不能低于基准高程、不能超过 base+1.5
$phys = 0
foreach ($hh in $dt.forecast.horizons) {
    if ($hh.level -lt $dt.site.base_level - 1e-6 -or $hh.level -gt $dt.site.base_level + 1.5 + 1e-6) { $phys++ }
}
Check '预测水位在物理约束内' ($phys -eq 0) ("越界 $phys 个（base={0}）" -f $dt.site.base_level)

# 静态前端深链必须回退到 index.html（SPA 路由）
$deep = & curl.exe --noproxy '*' -s -m 20 -o NUL -w '%{http_code}' "$Base/sites/$sid"
Check 'SPA 深链可直达' ($deep -eq '200') ("HTTP $deep")

# 登录页必须能匿名打开，否则谁也没法登录
$loginPage = & curl.exe --noproxy '*' -s -m 20 -o NUL -w '%{http_code}' "$Base/login" 2>$null
Check '登录页可匿名访问' ($loginPage -eq '200') ("HTTP $loginPage")

# ---------------------------------------------------------------- 2. 模型评估
Section '2. 模型评估口径'

$m = (HttpGet "$Base/api/metrics") | ConvertFrom-Json
$L = $m.latest
Check '离线指标有版本' ($null -ne $L.version) ("version={0} 训练耗时={1}s" -f $L.version, $L.train_seconds)
Check '样本量足够' ($L.n_train -gt 100000) ("n_train={0} n_valid={1} folds={2}" -f $L.n_train, $L.n_valid, $L.folds)
Check '特征维度 47' ($L.n_features -eq 47) ("n_features={0}" -f $L.n_features)
Check '四模型对比齐全' (@($L.metrics.PSObject.Properties.Name).Count -eq 4) ("模型族: " + ($L.metrics.PSObject.Properties.Name -join '/'))
$blend = @($L.metrics.blend)
Check '上线模型 4 个预见期都有指标' ($blend.Count -eq 4) ("预见期: " + (@($blend | ForEach-Object { $_.horizon_min }) -join '/'))
$skillOk = (@($blend | Where-Object { $_.skill_vs_persistence -gt 0 }).Count -eq 4)
Check '融合模型全面优于持久化基线' $skillOk (($blend | ForEach-Object { "{0}min skill=+{1:N3}" -f $_.horizon_min, $_.skill_vs_persistence }) -join ' | ')
$picpOk = (@($blend | Where-Object { $_.picp90 -ge 88 -and $_.picp90 -le 98 }).Count -eq 4)
Check '90% 区间标定合理(88~98%)' $picpOk (($blend | ForEach-Object { "{0}min PICP90={1:N1}%" -f $_.horizon_min, $_.picp90 }) -join ' | ')
$lin = @($L.metrics.linear)
$linWorse = (@($lin | Where-Object { $_.skill_vs_persistence -lt 0 }).Count -eq 4)
Check '线性外推劣于基线（证明预测有价值）' $linWorse (($lin | ForEach-Object { "{0}min skill={1:N3}" -f $_.horizon_min, $_.skill_vs_persistence }) -join ' | ')
$ev = @($blend | Where-Object { $_.event_n -gt 0 })
Check '事件样本指标已单报' ($ev.Count -eq 4) (($ev | ForEach-Object { "{0}min event_skill=+{1:N3}" -f $_.horizon_min, $_.event_skill }) -join ' | ')
Check '特征重要性有数据' (@($L.feature_importance).Count -gt 0) ("top1=" + $L.feature_importance[0].name + " " + [Math]::Round($L.feature_importance[0].importance, 3))

# 在线评估要等一个预见期走完才有样本：模拟器 60x 加速，1h 预见期约 60s 墙钟。
# 刚重启就跑验收时这里会是空的，所以先等，而不是把空结果当成失败。
Write-Host '  等待 1h 预见期走完、在线评估结算（最多 3 分钟）…' -ForegroundColor DarkGray
$r60 = $null
$waitUntil = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $waitUntil) {
    $m = (HttpGet "$Base/api/metrics") | ConvertFrom-Json
    $r60 = $m.rolling.'60'
    if ($r60 -and $r60.n -gt 0) { break }
    Start-Sleep -Seconds 15
}
Check '在线滚动评估已结算' ($null -ne $r60 -and $r60.n -gt 0) $(if ($r60) { "1h n={0} rmse={1:N4} 基线={2:N4} skill={3:N3}" -f $r60.n, $r60.rmse, $r60.baseline_rmse, $r60.skill } else { '无已结算样本' })
if ($r60) {
    $skillSane = ($r60.skill -lt 0.95)
    Check '在线 skill 口径可信（未被高程差虚抬）' $skillSane ("skill={0:N3}，基线用发布时刻实测而非实际值标准差" -f $r60.skill)
}

# 预测-实际配对要带 origin_level，前端才能算"相对发布时刻涨了多少"
$ep = (HttpGet "$Base/api/eval?hours=24") | ConvertFrom-Json
if (@($ep.pairs).Count -gt 0) {
    $p0 = $ep.pairs[0]
    Check '评估配对含发布锚点与基准高程' (($null -ne $p0.origin_level) -and ($null -ne $p0.base_level)) ("origin={0:N3} base={1:N3}" -f $p0.origin_level, $p0.base_level)
} else {
    Check '评估配对含发布锚点与基准高程' $false '暂无配对（等待一个预见期走完）'
}

# ---------------------------------------------------------------- 3. 暴雨演练
if (-not $SkipStorm) {
    Section '3. 暴雨演练：注入 → 研判 → 落库 → 四态'

    # 先把现场清干净：模拟器退水很慢（管网满负荷、有漫溢拓宽），
    # 若沿用上一轮遗留的积水，下面“等解除”会一直等不到。
    # 这两个接口只存在于演练模式，真实系统没有（雨不是人能停的）。
    $rs = (HttpPost "$Base/api/sim/reset-water?clear_sky=true") | ConvertFrom-Json
    Check '演练清零积水并停雨' ($rs.ok -eq $true) ("清零 {0} 个站点，clear_sky={1}" -f $rs.sites, $rs.clear_sky)
    Start-Sleep -Seconds 8
    $o0 = (HttpGet "$Base/api/overview") | ConvertFrom-Json
    $stillWarn = @($o0.sites | Where-Object { $_.warn_level -ne 'none' })
    Check '清零后无残留预警' ($stillWarn.Count -eq 0) ("仍报预警的站点: " + (($stillWarn | ForEach-Object { $_.site_id }) -join ','))

    $inj = (HttpPost "$Base/api/sim/storm?peak=160&dur=30") | ConvertFrom-Json
    Check '暴雨注入成功' ($inj.ok -eq $true) ("start_step={0} dur={1}步 peak={2}mm/h 时长={3}min" -f $inj.storm.start_step, $inj.storm.dur_steps, $inj.storm.peak_mm_h, $inj.storm.sim_minutes)

    Write-Host '  等待降雨落地并触发研判（最多 6 分钟）…' -ForegroundColor DarkGray
    $seen = @{}
    $timeline = New-Object System.Collections.Generic.List[string]
    $deadline = (Get-Date).AddMinutes(6)
    $maxLevel = 'none'
    $order = @{ none = 0; blue = 1; yellow = 2; orange = 3; red = 4 }
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 15
        $o = (HttpGet "$Base/api/overview") | ConvertFrom-Json
        $active = @($o.sites | Where-Object { $_.warn_level -ne 'none' })
        foreach ($a in $active) {
            $k = "$($a.site_id)|$($a.warn_level)"
            if (-not $seen.ContainsKey($k)) {
                $seen[$k] = $true
                $timeline.Add(("{0}  {1} → {2} (score={3:N3} 峰值={4:N3}m 持续={5}min)" -f (Get-Date -Format 'HH:mm:ss'), $a.site_id, $a.warn_level, $a.warn_score, $a.peak_value, $a.duration_min))
                if ($order[$a.warn_level] -gt $order[$maxLevel]) { $maxLevel = $a.warn_level }
            }
        }
        if ($maxLevel -eq 'red' -and $timeline.Count -ge 6) { break }
    }
    foreach ($t in $timeline) { Write-Host ("    " + $t) -ForegroundColor DarkGray }

    Check '暴雨触发多站点预警' ($timeline.Count -gt 0) ("共 {0} 次站点-等级首次出现" -f $timeline.Count)
    Check '研判达到红色等级' ($maxLevel -eq 'red') ("最高等级={0}" -f $maxLevel)

    $al = (HttpGet "$Base/api/alerts?active_only=true") | ConvertFrom-Json
    $act = @($al.alerts)
    Check '预警已落库' ($act.Count -gt 0) ("活跃事件 {0} 条" -f $act.Count)

    if ($act.Count -gt 0) {
        $one = $act[0]
        Check '初始态为 ACTIVE_UNACK' ($one.state -eq 'ACTIVE_UNACK') ("id={0} {1} state={2}" -f $one.id, $one.site_id, $one.state)

        # 合法迁移：ACTIVE_UNACK → ACTIVE_ACK
        $ack = (HttpPost "$Base/api/alerts/$($one.id)/ack") | ConvertFrom-Json
        Check '确认预警 ACTIVE_UNACK→ACTIVE_ACK' ($ack.ok -eq $true -and $ack.state -eq 'ACTIVE_ACK') ("id={0} state={1}" -f $one.id, $ack.state)

        # 非法迁移必须被拒绝，且是 409 而不是静默成功
        $code = & curl.exe --noproxy '*' -s -m 20 -b $script:jar -o _ack_err.json -w '%{http_code}' -X POST "$Base/api/alerts/$($one.id)/ack"
        $errBody = Get-Content _ack_err.json -Raw
        Check '重复确认返回 409' ($code -eq '409') ("HTTP {0} 响应: {1}" -f $code, $errBody.Trim())
        Remove-Item _ack_err.json -Force -ErrorAction SilentlyContinue

        # ---- 处置轴（与四态轴无关的第二套状态机）
        function PostJson($url, $obj) {
            $f = Join-Path $env:TEMP ('wl-post-' + [guid]::NewGuid().ToString('N') + '.json')
            try {
                [IO.File]::WriteAllText($f, ($obj | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
                $raw = & curl.exe --noproxy '*' -s -m 30 -b $script:jar -H 'Content-Type: application/json' --data-binary "@$f" -w "`n%{http_code}" -X POST $url 2>$null
                $lines = @($raw)
                $code = $lines[-1]
                $body = ($lines[0..([Math]::Max(0, $lines.Count - 2))] -join "`n")
                return @{ code = $code; body = $body }
            } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
        }

        $asg = PostJson "$Base/api/alerts/$($one.id)/assign" @{ assignee = '排水公司 张工' }
        Check '派单成功' ($asg.code -eq '200') ("HTTP {0} {1}" -f $asg.code, $asg.body.Trim())

        $d1 = PostJson "$Base/api/alerts/$($one.id)/disposition" @{ disposition = 'dispatched'; note = '已通知泵站'; author = '值班员 1' }
        Check '处置推进 待处置→已派单' ($d1.code -eq '200') ("HTTP {0}" -f $d1.code)

        # 同态重复：不能假装又推进了一次
        $d2 = PostJson "$Base/api/alerts/$($one.id)/disposition" @{ disposition = 'dispatched'; note = ''; author = '值班员 1' }
        Check '同态重复推进被拒(409)' ($d2.code -eq '409') ("HTTP {0} {1}" -f $d2.code, $d2.body.Trim())

        # 非法迁移：已派单不能直接退回待处置（已经发生的事不能当没发生）
        $d3 = PostJson "$Base/api/alerts/$($one.id)/disposition" @{ disposition = 'open'; note = ''; author = '值班员 1' }
        Check '非法处置迁移被拒(409)' ($d3.code -eq '409') ("HTTP {0} {1}" -f $d3.code, $d3.body.Trim())

        $nt = PostJson "$Base/api/alerts/$($one.id)/notes" @{ text = '泵站已启动，路面积水开始下降'; author = '张工'; kind = 'note' }
        Check '添加处置备注' ($nt.code -eq '200') ("HTTP {0}" -f $nt.code)

        $ad = (HttpGet "$Base/api/alerts/$($one.id)") | ConvertFrom-Json
        $noteKinds = (@($ad.notes | ForEach-Object { $_.kind }) -join '/')
        Check '处置卷宗留痕完整' (@($ad.notes).Count -ge 3) ("{0} 条备注，类型 {1}（派单/状态/手工）" -f @($ad.notes).Count, $noteKinds)
        Check '派单人与处置状态已落库' ($ad.event.assignee -eq '排水公司 张工' -and $ad.event.disposition -eq 'dispatched') ("assignee={0} disposition={1}" -f $ad.event.assignee, $ad.event.disposition)

        # 等条件消失：ACTIVE_ACK → CLEARED_ACK
        # 用演练接口把积水排空（等价于雨停 + 管网排完），否则要等十几个小时仿真时间。
        Write-Host '  排空积水，等待条件消失（最多 4 分钟）…' -ForegroundColor DarkGray
        $null = HttpPost "$Base/api/sim/reset-water?clear_sky=true"
        $cleared = $false
        $finalState = ''
        $deadline2 = (Get-Date).AddMinutes(4)
        while ((Get-Date) -lt $deadline2) {
            Start-Sleep -Seconds 15
            $al2 = (HttpGet "$Base/api/alerts?active_only=false&limit=50") | ConvertFrom-Json
            $mine = @($al2.alerts | Where-Object { $_.id -eq $one.id })
            if ($mine.Count -gt 0) {
                $finalState = $mine[0].state
                if ($finalState -like 'CLEARED*') { $cleared = $true; break }
            }
        }
        Check '条件消失后自动解除 ACTIVE_ACK→CLEARED_ACK' ($cleared -and $finalState -eq 'CLEARED_ACK') ("id={0} 终态={1}" -f $one.id, $finalState)

        # 未被确认的那批应直接落到 CLEARED_UNACK
        $al3 = (HttpGet "$Base/api/alerts?active_only=false&limit=100") | ConvertFrom-Json
        $unack = @($al3.alerts | Where-Object { $_.state -eq 'CLEARED_UNACK' })
        Check '未确认事件落到 CLEARED_UNACK' ($unack.Count -gt 0) ("{0} 条（另一条迁移路径）" -f $unack.Count)
    }
}

# ---------------------------------------------------------------- 4. 规则热更新
Section '4. 规则热更新'

$r0 = (HttpGet "$Base/api/rules") | ConvertFrom-Json
Check '规则可读取' ($null -ne $r0.weights) ("weights peak={0} duration={1} trend={2}" -f $r0.weights.peak, $r0.weights.duration, $r0.weights.trend)
Check '规则含最短持续门槛' ($null -ne $r0.min_duration_min) ("red 需持续 {0}min" -f $r0.min_duration_min.red)

$origCut = $r0.score_cutoffs.red
$tmpObj = $r0 | ConvertTo-Json -Depth 8 | ConvertFrom-Json

# 多行 JSON 直接当命令行参数传给 curl.exe 会被 PowerShell 截断（5.1 尤其严重，
# 且 curl 的报错被 2>$null 吞掉，表现为「PUT 成功但值没变」）。一律落临时文件 + @file。
function PutRules($obj) {
    $f = Join-Path $env:TEMP ('wl-rules-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        [IO.File]::WriteAllText($f, ($obj | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        & curl.exe --noproxy '*' -s -m 30 -b $script:jar -X PUT -H 'Content-Type: application/json' --data-binary "@$f" "$Base/api/rules" 2>$null | Out-Null
    } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}

$tmpObj.score_cutoffs.red = 0.99
PutRules $tmpObj
$r1 = (HttpGet "$Base/api/rules") | ConvertFrom-Json
Check 'PUT 规则即时生效' ($r1.score_cutoffs.red -eq 0.99) ("red 分档 0.78 → {0}" -f $r1.score_cutoffs.red)

# 复原，别把验收现场改坏
$tmpObj.score_cutoffs.red = $origCut
PutRules $tmpObj
$r2 = (HttpGet "$Base/api/rules") | ConvertFrom-Json
Check '规则已复原' ([Math]::Abs($r2.score_cutoffs.red - $origCut) -lt 1e-9) ("red 分档回到 {0}" -f $r2.score_cutoffs.red)

# ---------------------------------------------------------------- 4.5 账号与治理
Section '4.5 账号角色 / 审计 / 推送渠道'

$us = (HttpGet "$Base/api/users") | ConvertFrom-Json
$admins = @($us.users | Where-Object { $_.role -eq 'admin' -and -not $_.disabled })
Check '存在可用管理员' ($admins.Count -ge 1) ("admin 账号 {0} 个，角色目录 {1} 条" -f $admins.Count, @($us.roles).Count)
Check '角色目录含三种角色' (@($us.roles).Count -eq 3) ((@($us.roles | ForEach-Object { $_.label })) -join '/')

# 审计：刚刚这一串写操作（改规则、确认预警、演练注入）都应该留痕，且带操作人
$au = (HttpGet "$Base/api/audit?hours=24&limit=50") | ConvertFrom-Json
$entries = @($au.entries)
Check '审计有记录' ($entries.Count -gt 0) ("{0} 条" -f $entries.Count)
$withUser = @($entries | Where-Object { $_.username })
Check '审计记录操作人' ($withUser.Count -gt 0) $(if ($withUser.Count -gt 0) { "最近一条：{0} {1} {2} → {3}" -f $withUser[0].username, $withUser[0].method, $withUser[0].path, $withUser[0].summary } else { '全部为空（身份没传进审计中间件）' })
$writes = @($entries | Where-Object { $_.method -ne 'GET' })
Check '审计只记写操作' ($writes.Count -eq $entries.Count) ("{0}/{1} 条是写操作" -f $writes.Count, $entries.Count)

# 推送渠道：站内弹窗不可关闭，webhook 默认关闭且必须有 endpoint 才能开
$ch = (HttpGet "$Base/api/notify/channels") | ConvertFrom-Json
$inapp = @($ch.channels | Where-Object { $_.name -eq 'inapp' })[0]
$hook = @($ch.channels | Where-Object { $_.name -eq 'webhook' })[0]
Check '推送渠道已初始化' ($null -ne $inapp -and $null -ne $hook) ("渠道: " + ((@($ch.channels | ForEach-Object { $_.name })) -join '/'))
Check '站内弹窗始终启用' ($inapp.enabled -eq $true) ("inapp enabled={0} 最低等级={1}" -f $inapp.enabled, $inapp.min_level)
Check 'webhook 密钥不外泄' ($null -eq $hook.secret -or $hook.secret -notmatch '^[0-9a-f]{16}') ("secret 显示为 '{0}'" -f $hook.secret)

# 越权：建一个只读账号，用它的会话去改规则，必须 403 而不是 200
$qa = 'qa_viewer'
$bodyFile = Join-Path $env:TEMP ('wl-qa-user-' + [guid]::NewGuid().ToString('N') + '.json')
try {
    [IO.File]::WriteAllText($bodyFile, ('{"username":"' + $qa + '","display_name":"验收只读账号","role":"viewer","password":"qa-viewer-2026"}'), [Text.UTF8Encoding]::new($false))
    & curl.exe --noproxy '*' -s -m 20 -b $script:jar -H 'Content-Type: application/json' --data-binary "@$bodyFile" "$Base/api/users" 2>$null | Out-Null
} finally { Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue }

$vjar = Join-Path $env:TEMP ('wl-viewer-' + [guid]::NewGuid().ToString('N') + '.cookies')
$vbody = Join-Path $env:TEMP ('wl-viewer-' + [guid]::NewGuid().ToString('N') + '.json')
try {
    [IO.File]::WriteAllText($vbody, ('{"username":"' + $qa + '","password":"qa-viewer-2026"}'), [Text.UTF8Encoding]::new($false))
    $vcode = & curl.exe --noproxy '*' -s -m 20 -c $vjar -o NUL -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$vbody" "$Base/api/auth/login" 2>$null
    Check '只读账号可登录' ($vcode -eq '200') ("HTTP $vcode")

    $readCode = & curl.exe --noproxy '*' -s -m 20 -b $vjar -o NUL -w '%{http_code}' "$Base/api/overview" 2>$null
    Check '只读账号可看一张图' ($readCode -eq '200') ("HTTP $readCode")

    $ruleFile = Join-Path $env:TEMP ('wl-viewer-rules-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        [IO.File]::WriteAllText($ruleFile, '{"score_cutoffs":{"red":0.5}}', [Text.UTF8Encoding]::new($false))
        $forbid = & curl.exe --noproxy '*' -s -m 20 -b $vjar -o NUL -w '%{http_code}' -X PUT -H 'Content-Type: application/json' --data-binary "@$ruleFile" "$Base/api/rules" 2>$null
    } finally { Remove-Item $ruleFile -Force -ErrorAction SilentlyContinue }
    Check '只读账号改规则被拒(403)' ($forbid -eq '403') ("HTTP $forbid（不是 200，说明后端真的在拦）")

    $auditForbid = & curl.exe --noproxy '*' -s -m 20 -b $vjar -o NUL -w '%{http_code}' "$Base/api/audit" 2>$null
    Check '只读账号看审计被拒(403)' ($auditForbid -eq '403') ("HTTP $auditForbid")
} finally {
    Remove-Item $vjar -Force -ErrorAction SilentlyContinue
    Remove-Item $vbody -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 5. 前端页面
if ($Shots) {
    Section '5. 前端页面截图'
    $before = @(Get-ChildItem shots\*.png -ErrorAction SilentlyContinue).Count
    & node scripts\shoot.mjs 2>&1 | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkGray }
    $after = @(Get-ChildItem shots\*.png -ErrorAction SilentlyContinue).Count
    Check '九页截图全部产出' ($after -ge 9) ("shots/ 共 {0} 张（含登录页与管理台）" -f $after)
}

# ---------------------------------------------------------------- 汇总
Section '验收汇总'
Write-Host ("  PASS {0}   FAIL {1}" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })
$log = Join-Path (Get-Location) ('logs\acceptance-{0}.tsv' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$script:notes | Set-Content -Path $log -Encoding UTF8
Write-Host ("  明细已写入 {0}" -f $log) -ForegroundColor DarkGray

Remove-Item $script:jar -Force -ErrorAction SilentlyContinue

if ($script:fail -eq 0) { exit 0 } else { exit 1 }
