param(
    [int]$PreferredPort = 4321,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$AppDirectory = Split-Path -Parent $PSScriptRoot
$PackageDirectory = Split-Path -Parent $AppDirectory
$LogDirectory = Join-Path $AppDirectory '.launcher'
$StandardLog = Join-Path $LogDirectory 'speaking-practice.stdout.log'
$ErrorLog = Join-Path $LogDirectory 'speaking-practice.stderr.log'
$ServiceStandardLog = Join-Path $LogDirectory 'speaking-practice-service.stdout.log'
$ServiceErrorLog = Join-Path $LogDirectory 'speaking-practice-service.stderr.log'
$LastLaunchFile = Join-Path $LogDirectory 'last-launch.txt'

function Test-StandalonePythonRuntime {
    param([string]$PythonPath)

    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { return $false }
    $runtimeDirectory = Split-Path -Parent $PythonPath
    $pythonDll = Get-ChildItem -LiteralPath $runtimeDirectory -File -Filter 'python*.dll' -ErrorAction SilentlyContinue | Select-Object -First 1
    $stdlibMarker = Join-Path $runtimeDirectory 'Lib\encodings\__init__.py'
    $dllDirectory = Join-Path $runtimeDirectory 'DLLs'
    $virtualEnvironmentConfig = Join-Path $runtimeDirectory 'pyvenv.cfg'
    return [bool]$pythonDll -and
        (Test-Path -LiteralPath $stdlibMarker -PathType Leaf) -and
        (Test-Path -LiteralPath $dllDirectory -PathType Container) -and
        -not (Test-Path -LiteralPath $virtualEnvironmentConfig -PathType Leaf)
}

$PortablePythonCandidates = @(
    (Join-Path $AppDirectory 'runtime\python\python.exe'),
    (Join-Path $PackageDirectory 'runtime\python\python.exe')
)
$ServerPythonPath = $PortablePythonCandidates | Where-Object { Test-StandalonePythonRuntime $_ } | Select-Object -First 1

# The development tree may still use its uv virtual environment. A package
# that contains runtime\python must never fall back to that external runtime.
$PackageRuntimeDirectory = Join-Path $PackageDirectory 'runtime\python'
if (-not $ServerPythonPath -and -not (Test-Path -LiteralPath $PackageRuntimeDirectory -PathType Container)) {
    $ServerPythonPath = @(
        (Join-Path (Split-Path -Parent $AppDirectory) 'sensevoice\.venv\Scripts\python.exe'),
        (Join-Path $PackageDirectory 'sensevoice\.venv\Scripts\python.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
$UseStaticServer = [bool]$ServerPythonPath -and (Test-Path -LiteralPath (Join-Path $AppDirectory 'dist\index.html'))
$ServicePort = if ($UseStaticServer) { $PreferredPort } else { 50000 }

function Test-PracticePage {
    param([int]$Port)

    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 1
        return $response.StatusCode -eq 200 -and $response.Content -match '口语跟练室'
    }
    catch {
        return $false
    }
}

function Test-PortInUse {
    param([int]$Port)

    return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-LocalService {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$ServicePort/api/health" -UseBasicParsing -TimeoutSec 1
        return $response.StatusCode -eq 200 -and $response.Content -match '"status"\s*:\s*"ok"'
    }
    catch {
        return $false
    }
}

function Start-LocalService {
    if (Test-LocalService) { return }

    if (-not $ServerPythonPath) {
        throw '包内 Python 运行环境不完整。请确认 runtime\python 包含完整的 python.exe、python*.dll、Lib\encodings 和 DLLs；发布包不能使用 Scripts\python.exe 或外部 .venv。'
    }

    Remove-Item -LiteralPath $ServiceStandardLog, $ServiceErrorLog -Force -ErrorAction SilentlyContinue
    $arguments = @('server.py', '--host', '127.0.0.1', '--port', "$ServicePort")
    Start-Process -FilePath $ServerPythonPath -ArgumentList $arguments -WorkingDirectory $AppDirectory -WindowStyle Hidden -RedirectStandardOutput $ServiceStandardLog -RedirectStandardError $ServiceErrorLog | Out-Null

    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Test-LocalService) { return }
    }
    $rawDetails = if (Test-Path -LiteralPath $ServiceErrorLog) { Get-Content -LiteralPath $ServiceErrorLog -Raw } else { '' }
    $details = if ($null -eq $rawDetails) { '' } else { $rawDetails.Trim() }
    throw "本地服务未能在 30 秒内启动。$details"
}

try {
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null

    foreach ($candidatePort in $PreferredPort..($PreferredPort + 9)) {
        if (Test-PracticePage -Port $candidatePort) {
            if ($UseStaticServer) { $ServicePort = $candidatePort }
            Start-LocalService
            $url = "http://127.0.0.1:$ServicePort/"
            "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') existing $url" | Set-Content -LiteralPath $LastLaunchFile -Encoding utf8
            if (-not $NoOpen) { Start-Process $url }
            Write-Host "口语跟练室已经在运行：$url"
            exit 0
        }
    }

    if ($UseStaticServer) {
        $port = $null
        foreach ($candidatePort in $PreferredPort..($PreferredPort + 9)) {
            if (-not (Test-PortInUse -Port $candidatePort)) {
                $port = $candidatePort
                break
            }
        }
        if ($null -eq $port) {
            throw "Ports $PreferredPort-$($PreferredPort + 9) are all occupied. Close an unused local service and try again."
        }
        $ServicePort = $port
        Start-LocalService
        $url = "http://127.0.0.1:$ServicePort/"
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') started $url" | Set-Content -LiteralPath $LastLaunchFile -Encoding utf8
        if (-not $NoOpen) { Start-Process $url }
            Write-Host "口语跟练室已启动：$url"
        exit 0
    }

    $pnpmCommand = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
    if (-not $pnpmCommand) {
        throw 'pnpm.cmd was not found. Open Codex and ask it to repair the project environment.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $AppDirectory 'node_modules'))) {
        throw 'Project dependencies are missing. Open Codex and ask it to install the speaking-practice dependencies.'
    }

    Start-LocalService

    $port = $null
    foreach ($candidatePort in $PreferredPort..($PreferredPort + 9)) {
        if (-not (Test-PortInUse -Port $candidatePort)) {
            $port = $candidatePort
            break
        }
    }
    if ($null -eq $port) {
        throw "Ports $PreferredPort-$($PreferredPort + 9) are all occupied. Close an unused local service and try again."
    }

    Remove-Item -LiteralPath $StandardLog, $ErrorLog -Force -ErrorAction SilentlyContinue
    $arguments = @('run', 'dev', '--host', '127.0.0.1', '--port', "$port", '--strictPort')
    Start-Process -FilePath $pnpmCommand.Source -ArgumentList $arguments -WorkingDirectory $AppDirectory -WindowStyle Hidden -RedirectStandardOutput $StandardLog -RedirectStandardError $ErrorLog | Out-Null

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Test-PracticePage -Port $port) { $ready = $true }
        if ($ready) { break }
    }
    if (-not $ready) {
        $rawDetails = if (Test-Path -LiteralPath $ErrorLog) { Get-Content -LiteralPath $ErrorLog -Raw } else { '' }
        $details = if ($null -eq $rawDetails) { '' } else { $rawDetails.Trim() }
        throw "The page did not become ready within 30 seconds. $details"
    }

    $url = "http://127.0.0.1:$port/"
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') started $url" | Set-Content -LiteralPath $LastLaunchFile -Encoding utf8
    if (-not $NoOpen) { Start-Process $url }
    Write-Host "口语跟练室已启动：$url"
    exit 0
}
catch {
    Write-Host ''
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Logs: $LogDirectory"
    exit 1
}
