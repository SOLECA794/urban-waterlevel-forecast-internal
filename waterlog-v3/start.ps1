# waterlog-v3 一键启动
#
# 依次拉起 Python 预测引擎（8201）与 Go API + 前端（8200），并等到两边都健康为止。
# 用法：
#   .\start.ps1                 # 正常启动（首次会自动造数据 + 训练，约 2~3 分钟）
#   .\start.ps1 -SkipBuild      # 不改前端时跳过 vite build，启动更快
#   .\start.ps1 -Reset          # 重新生成 60 天历史数据并重训（约 2 分钟）
#   .\start.ps1 -Stop           # 停掉已启动的服务
#
# 前置：go 1.21+、python 3.10+（需 numpy/pandas/scikit-learn/fastapi/uvicorn）、node 18+。

param(
    [int]$ApiPort = 8200,
    [int]$EnginePort = 8201,
    [switch]$SkipBuild,
    [switch]$Reset,
    [switch]$Stop,
    [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logDir = Join-Path $root 'logs'
$pidFile = Join-Path $logDir 'pids.json'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Stop-Tree([int]$procId) {
    if (-not $procId) { return }
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue
    foreach ($c in $children) { Stop-Tree ([int]$c.ProcessId) }
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 停止
if ($Stop) {
    Write-Step '停止 waterlog-v3'
    if (Test-Path $pidFile) {
        $pids = Get-Content $pidFile -Raw | ConvertFrom-Json
        foreach ($name in @('api', 'engine')) {
            $p = $pids.$name
            if ($p) {
                Stop-Tree ([int]$p)
                Write-Ok "已停止 $name (pid $p)"
            }
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    else {
        # 没有 pid 文件时按端口兜底
        foreach ($port in @($ApiPort, $EnginePort)) {
            $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            foreach ($c in $conn) { Stop-Tree ([int]$c.OwningProcess); Write-Ok "已停止占用 $port 的进程" }
        }
    }
    return
}

# ---------------------------------------------------------------- 前置检查
Write-Step '检查运行环境'
# PATH 里的第一个 python 不一定是装了依赖的那个：装了 sandbox / 便携版工具链的机器上，
# `python` 常常指向一个干净解释器，直到引擎 90 秒后才在 logs/engine.err.log 里报
# ModuleNotFoundError: No module named 'numpy'。所以这里逐个候选验证依赖再采用。
$py = $null
if ($Python) {
    if (-not (Test-Path $Python)) { throw "指定的 python 不存在：$Python" }
    $py = (Resolve-Path $Python).Path
}
else {
    $cands = @()
    if ($env:WL_PYTHON) { $cands += $env:WL_PYTHON }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $cands += $cmd.Source }
    if ($env:CONDA_PREFIX) { $cands += (Join-Path $env:CONDA_PREFIX 'python.exe') }
    $cands += @(
        (Join-Path $env:USERPROFILE 'miniconda3\python.exe'),
        (Join-Path $env:USERPROFILE 'anaconda3\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
        'C:\ProgramData\miniconda3\python.exe'
    )
    foreach ($c in ($cands | Where-Object { $_ } | Select-Object -Unique)) {
        if (-not (Test-Path $c)) { continue }
        & $c -c "import numpy, pandas, sklearn, fastapi, uvicorn" 2>$null
        if ($LASTEXITCODE -eq 0) { $py = $c; break }
        Write-Warn2 "跳过（缺依赖）：$c"
    }
}
if (-not $py) {
    throw '没找到装有 numpy/pandas/scikit-learn/fastapi/uvicorn 的 python。用 .\start.ps1 -Python <路径> 指定，或设置环境变量 WL_PYTHON。'
}
$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) { throw '未找到 go，请先安装 Go 1.21+ 并加入 PATH' }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
Write-Ok "python = $py"
Write-Ok "go     = $go"
if ($node) { Write-Ok "node   = $node" }

# 端口占用检查（只提示，不擅自杀）
#
# 两个坑：
# 1. 刚 -Stop 完的几秒内，`-State Listen` 仍可能返回一条 OwningProcess = 0 的残条，
#    进程其实已经没了。按 pid 判断会被它挡住，于是「停完立刻启」永远失败。
#    所以要求「pid != 0 且该进程确实还在」才算真占用。
# 2. 端口真正释放有延迟，直接 throw 会让重启变成一件需要等两分钟的事。
#    改成最多等 15 秒再确认一次。
function Test-PortBusy([int]$port) {
    $hits = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
        if ($h.OwningProcess -eq 0) { continue }
        if (-not (Get-Process -Id $h.OwningProcess -ErrorAction SilentlyContinue)) { continue }
        return $h.OwningProcess
    }
    return $null
}

foreach ($port in @($ApiPort, $EnginePort)) {
    $owner = Test-PortBusy $port
    for ($i = 0; $i -lt 15 -and $owner; $i++) {
        Start-Sleep -Seconds 1
        $owner = Test-PortBusy $port
    }
    if ($owner) {
        throw "端口 $port 已被占用（pid $owner）。请先 .\start.ps1 -Stop 或换端口：-ApiPort/-EnginePort"
    }
}

# ---------------------------------------------------------------- 数据与模型
$dataDir = Join-Path $root 'engine\data'
$dataset = Join-Path $dataDir 'dataset.npz'
$latest = Join-Path $dataDir 'models\latest.txt'

if ($Reset -or -not (Test-Path $dataset) -or -not (Test-Path $latest)) {
    Write-Step '生成历史数据并训练模型（首次启动需要，约 2 分钟）'
    if ($Reset) {
        Remove-Item $dataset -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $dataDir 'eval.sqlite') -Force -ErrorAction SilentlyContinue
        # 仿真时钟也要清，否则重建的数据集配着旧时钟跑，时间轴会对不上
        Remove-Item (Join-Path $dataDir 'sim_clock.json') -Force -ErrorAction SilentlyContinue
        # Go 的库同样要清：里面存着上次跑出来的遥测与预警，留着会和新时间轴打架
        Remove-Item (Join-Path $root 'api\data\waterlog.db*') -Force -ErrorAction SilentlyContinue
    }
    Push-Location (Join-Path $root 'engine')
    try {
        # 数据集还在就只重训模型，别白花 30s 重造 60 天数据
        $bootArgs = @('-m', 'waterlog.cli.bootstrap')
        if ((Test-Path $dataset) -and -not $Reset) { $bootArgs += '--keep' }
        & $py @bootArgs
        if ($LASTEXITCODE -ne 0) { throw "数据生成/训练失败（exit $LASTEXITCODE），详见上方输出" }
    }
    finally { Pop-Location }
    Write-Ok '数据与模型就绪'
}
else {
    Write-Ok "复用已有数据与模型：$((Get-Content $latest -Raw).Trim())"
}

# ---------------------------------------------------------------- 前端构建
$dist = Join-Path $root 'web\dist'
if (-not $SkipBuild -or -not (Test-Path (Join-Path $dist 'index.html'))) {
    Write-Step '构建前端'
    Push-Location (Join-Path $root 'web')
    try {
        if (-not (Test-Path 'node_modules')) { & npm install }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "前端构建失败（exit $LASTEXITCODE）" }
    }
    finally { Pop-Location }
    Write-Ok '前端已构建到 web/dist'
}
else {
    Write-Ok '跳过前端构建（-SkipBuild）'
}

# ---------------------------------------------------------------- 编译 Go
Write-Step '编译 Go API'
Push-Location (Join-Path $root 'api')
try {
    & go build -o waterlog-api.exe ./cmd/waterlog-api
    if ($LASTEXITCODE -ne 0) { throw "go build 失败（exit $LASTEXITCODE）" }
}
finally { Pop-Location }
Write-Ok 'api/waterlog-api.exe 已就绪'

# ---------------------------------------------------------------- 启动引擎
Write-Step "启动预测引擎 :$EnginePort"
$engineOut = Join-Path $logDir 'engine.log'
$engineErr = Join-Path $logDir 'engine.err.log'
# 子进程继承当前进程环境，因此先设再起（比 -Environment 更可预期）
$env:WL_ENGINE_PORT = "$EnginePort"
$env:WL_GO_API = "http://127.0.0.1:$ApiPort"
$env:PYTHONUNBUFFERED = '1'
$engine = Start-Process -FilePath $py `
    -ArgumentList '-m', 'waterlog.api.app' `
    -WorkingDirectory (Join-Path $root 'engine') `
    -RedirectStandardOutput $engineOut `
    -RedirectStandardError $engineErr `
    -PassThru -WindowStyle Hidden
Write-Ok "pid $($engine.Id)，日志 logs/engine.log"

# ---------------------------------------------------------------- 启动 API
Write-Step "启动 Go API :$ApiPort"
$apiOut = Join-Path $logDir 'api.log'
$apiErr = Join-Path $logDir 'api.err.log'
$env:WL_API_PORT = "$ApiPort"
$env:WL_ENGINE_URL = "http://127.0.0.1:$EnginePort"
$env:WL_WEB_DIR = (Join-Path $root 'web\dist')
$api = Start-Process -FilePath (Join-Path $root 'api\waterlog-api.exe') `
    -WorkingDirectory (Join-Path $root 'api') `
    -RedirectStandardOutput $apiOut `
    -RedirectStandardError $apiErr `
    -PassThru -WindowStyle Hidden
Write-Ok "pid $($api.Id)，日志 logs/api.log"

@{ api = $api.Id; engine = $engine.Id; api_port = $ApiPort; engine_port = $EnginePort } |
    ConvertTo-Json | Set-Content $pidFile -Encoding utf8

# ---------------------------------------------------------------- 等待健康
function Wait-Health([string]$url, [int]$timeoutSec, [string]$label) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod -Uri $url -TimeoutSec 3 -NoProxy
            if ($r.ok) { return $true }
        }
        catch { Start-Sleep -Milliseconds 500 }
    }
    Write-Warn2 "$label 在 ${timeoutSec}s 内未就绪"
    return $false
}

Write-Step '等待服务就绪'
$engineOk = Wait-Health "http://127.0.0.1:$EnginePort/health" 90 '预测引擎'
if ($engineOk) { Write-Ok '引擎在线' } else { Write-Warn2 "引擎未就绪，看 logs/engine.err.log" }

$apiOk = Wait-Health "http://127.0.0.1:$ApiPort/api/health" 45 'Go API'
if ($apiOk) { Write-Ok 'API 在线' } else { Write-Warn2 "API 未就绪，看 logs/api.err.log" }

if (-not ($engineOk -and $apiOk)) {
    Write-Host "`n启动未完全成功。停止请执行：.\start.ps1 -Stop" -ForegroundColor Red
    exit 1
}

# 等首轮预测推送，否则首页会是空图
Write-Host "`n    等待首轮预测推送…" -NoNewline
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
    try {
        $f = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/forecast" -TimeoutSec 3 -NoProxy
        if ($f.sites -and $f.sites.PSObject.Properties.Count -gt 0) { break }
    }
    catch { }
    Start-Sleep -Seconds 2
    Write-Host '.' -NoNewline
}

Write-Host "`n"
Write-Host '============================================================' -ForegroundColor Green
Write-Host "  waterlog-v3 已启动" -ForegroundColor Green
Write-Host "  前端 + API : http://127.0.0.1:$ApiPort" -ForegroundColor Green
Write-Host "  预测引擎   : http://127.0.0.1:$EnginePort/health" -ForegroundColor Green
Write-Host "  日志目录   : logs\" -ForegroundColor Green
Write-Host "  停止服务   : .\start.ps1 -Stop" -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
