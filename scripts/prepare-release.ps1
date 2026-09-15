param(
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release\口语跟练室'),
    [string]$PythonRuntimeDirectory = '',
    [string]$ModelDirectory = '',
    [string]$ModelPackageOutputDirectory = '',
    [string]$JavaScriptRuntimePath = '',
    [string]$YtDlpPath = '',
    [string]$FfmpegPath = '',
    [string]$FfprobePath = '',
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$RepoDirectory = Split-Path -Parent $PSScriptRoot
$AppDirectory = Join-Path $RepoDirectory 'apps\speaking-practice'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)

function Assert-Directory([string]$PathValue, [string]$Label) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
        throw "$Label 不存在：$PathValue"
    }
}

function Copy-DirectoryContents([string]$Source, [string]$Target) {
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Target -Recurse -Force
}

function Resolve-Tool([string]$ExplicitPath, [string]$CommandName) {
    if ($ExplicitPath) {
        if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) {
            throw "$CommandName 不存在：$ExplicitPath"
        }
        return [IO.Path]::GetFullPath($ExplicitPath)
    }
    $bundledCandidates = @(
        (Join-Path $AppDirectory "tools\$CommandName"),
        (Join-Path $RepoDirectory "tools\$CommandName")
    )
    $bundled = $bundledCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($bundled) {
        return [IO.Path]::GetFullPath($bundled)
    }
    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if (-not $command) { throw "找不到 $CommandName。请用参数明确指定它。" }
    return $command.Source
}

if (-not (Test-Path -LiteralPath $AppDirectory -PathType Container)) {
    throw "找不到 speaking-practice 应用目录：$AppDirectory"
}
if ($Clean -and (Test-Path -LiteralPath $OutputDirectory)) {
    $resolvedOutput = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $OutputDirectory))
    $releaseParent = [IO.Path]::GetFullPath((Join-Path $RepoDirectory 'release'))
    if ($resolvedOutput -ne $releaseParent -and $resolvedOutput -notlike "$releaseParent\*") {
        throw "为安全起见，-Clean 只能清理 release 目录内的目标：$resolvedOutput"
    }
    Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
}

$runtimeSource = $PythonRuntimeDirectory
if (-not $runtimeSource) {
    $runtimeSource = Join-Path $RepoDirectory 'apps\sensevoice\.venv'
}
Assert-Directory $runtimeSource 'Python 运行环境'

if (-not $JavaScriptRuntimePath) {
    $bundledJavaScriptRuntime = Join-Path $AppDirectory 'runtime\js\deno.exe'
    if (Test-Path -LiteralPath $bundledJavaScriptRuntime -PathType Leaf) {
        $JavaScriptRuntimePath = $bundledJavaScriptRuntime
    }
}

if (-not $ModelDirectory) {
    $bundledModelDirectory = Join-Path $AppDirectory 'models\sensevoice'
    if (Test-Path -LiteralPath (Join-Path $bundledModelDirectory 'model.pt') -PathType Leaf) {
        $ModelDirectory = $bundledModelDirectory
    }
}

$toolSources = @{
    'yt-dlp.exe' = Resolve-Tool $YtDlpPath 'yt-dlp.exe'
    'ffmpeg.exe' = Resolve-Tool $FfmpegPath 'ffmpeg.exe'
    'ffprobe.exe' = Resolve-Tool $FfprobePath 'ffprobe.exe'
}

$appTarget = Join-Path $OutputDirectory 'app'
$runtimeTarget = Join-Path $OutputDirectory 'runtime\python'
$javascriptTarget = Join-Path $OutputDirectory 'runtime\js'
$toolsTarget = Join-Path $OutputDirectory 'tools'
$modelsTarget = Join-Path $OutputDirectory 'models\sensevoice'
$thirdPartyTarget = Join-Path $OutputDirectory 'THIRD_PARTY_LICENSES'
$appScriptsTarget = Join-Path $appTarget 'scripts'
$appSenseVoiceTarget = Join-Path $appTarget 'sensevoice'
$appSenseVoiceUtilsTarget = Join-Path $appSenseVoiceTarget 'utils'
New-Item -ItemType Directory -Path $OutputDirectory, $appTarget, $appScriptsTarget, $appSenseVoiceTarget, $appSenseVoiceUtilsTarget, $runtimeTarget, $javascriptTarget, $toolsTarget, $thirdPartyTarget, (Join-Path $OutputDirectory 'user-data') -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $AppDirectory 'dist') -Destination $appTarget -Recurse -Force
Copy-Item -LiteralPath (Join-Path $AppDirectory 'server.py') -Destination $appTarget -Force
Copy-Item -LiteralPath (Join-Path $AppDirectory 'scripts\build_dataset.py') -Destination $appScriptsTarget -Force
Copy-Item -LiteralPath (Join-Path $RepoDirectory 'apps\sensevoice\model.py') -Destination $appSenseVoiceTarget -Force
Copy-Item -LiteralPath (Join-Path $RepoDirectory 'apps\sensevoice\api.py') -Destination $appSenseVoiceTarget -Force
Copy-DirectoryContents (Join-Path $RepoDirectory 'apps\sensevoice\utils') $appSenseVoiceUtilsTarget
Copy-Item -LiteralPath (Join-Path $AppDirectory 'scripts\start-practice.ps1') -Destination $appScriptsTarget -Force

Copy-DirectoryContents $runtimeSource $runtimeTarget
$runtimeSitePackages = Join-Path $runtimeTarget 'Lib\site-packages'
$funasrSitePackage = Join-Path $runtimeSitePackages 'funasr'
$funTextProcessingSitePackage = Join-Path $runtimeSitePackages 'fun_text_processing'
New-Item -ItemType Directory -Path $runtimeSitePackages -Force | Out-Null
Copy-DirectoryContents (Join-Path $RepoDirectory 'apps\funasr\funasr') $funasrSitePackage
Copy-DirectoryContents (Join-Path $RepoDirectory 'apps\funasr\fun_text_processing') $funTextProcessingSitePackage

# The development uv environment may contain an editable FunASR install that
# points back to the author's computer. Remove those markers so the bundled
# source package above is selected on a viewer's computer.
$editableFunASrFiles = Get-ChildItem -LiteralPath $runtimeSitePackages -Force -File -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like '__editable__*funasr*' -or $_.Name -like '__editable___funasr*'
}
foreach ($editableFile in $editableFunAsrFiles) {
    Remove-Item -LiteralPath $editableFile.FullName -Force
}
$funasrDistInfo = Get-ChildItem -LiteralPath $runtimeSitePackages -Force -Directory -Filter 'funasr-*.dist-info' -ErrorAction SilentlyContinue
foreach ($distInfo in $funasrDistInfo) {
    Remove-Item -LiteralPath (Join-Path $distInfo.FullName 'direct_url.json') -Force -ErrorAction SilentlyContinue
}
$runtimeHelperDirectory = Join-Path $runtimeTarget 'Scripts'
foreach ($helperName in @('activate', 'activate.bat', 'activate.csh', 'activate.fish', 'activate.nu', 'jp.py', 'pygrun', 'numba')) {
    Remove-Item -LiteralPath (Join-Path $runtimeHelperDirectory $helperName) -Force -ErrorAction SilentlyContinue
}

Copy-Item -LiteralPath (Join-Path $RepoDirectory 'apps\funasr\LICENSE') -Destination (Join-Path $thirdPartyTarget 'FunASR-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $RepoDirectory 'apps\funasr\MODEL_LICENSE') -Destination (Join-Path $thirdPartyTarget 'FunASR-MODEL_LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $RepoDirectory 'apps\sensevoice\LICENSE') -Destination (Join-Path $thirdPartyTarget 'SenseVoice-LICENSE.txt') -Force
if ($JavaScriptRuntimePath) {
    if (-not (Test-Path -LiteralPath $JavaScriptRuntimePath -PathType Leaf)) { throw "JavaScript 运行时不存在：$JavaScriptRuntimePath" }
    Copy-Item -LiteralPath $JavaScriptRuntimePath -Destination (Join-Path $javascriptTarget 'deno.exe') -Force
} else {
    Write-Warning '未提供 -JavaScriptRuntimePath。完整 YouTube 下载需要随包提供 Deno。'
}
foreach ($tool in $toolSources.GetEnumerator()) {
    Copy-Item -LiteralPath $tool.Value -Destination (Join-Path $toolsTarget $tool.Key) -Force
}

if ($ModelDirectory) {
    Assert-Directory $ModelDirectory 'SenseVoice 模型目录'
    if ($ModelPackageOutputDirectory) {
        $modelPackageModelsTarget = Join-Path ([IO.Path]::GetFullPath($ModelPackageOutputDirectory)) 'models\sensevoice'
        Copy-DirectoryContents $ModelDirectory $modelPackageModelsTarget
        Write-Host "模型包已准备：$([IO.Path]::GetFullPath($ModelPackageOutputDirectory))"
    } else {
        Copy-DirectoryContents $ModelDirectory $modelsTarget
    }
} else {
    New-Item -ItemType Directory -Path $modelsTarget -Force | Out-Null
    Write-Warning '未提供 -ModelDirectory。已生成运行包，但用户需要另行解压模型包到 models\sensevoice。'
}

$launcherSource = Join-Path $RepoDirectory '一键启动口语跟练室.cmd'
Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $OutputDirectory '口语跟练室.cmd') -Force
Copy-Item -LiteralPath (Join-Path $AppDirectory 'README.md') -Destination (Join-Path $OutputDirectory '使用说明.md') -Force

$launcherBuildScript = Join-Path $RepoDirectory 'scripts\build-practice-launcher.ps1'
if (Test-Path -LiteralPath $launcherBuildScript -PathType Leaf) {
    & $launcherBuildScript -OutputDirectory $OutputDirectory
    if ($LASTEXITCODE -ne 0) { throw '口语跟练室启动 EXE 生成失败。' }
}

Write-Host "运行包已准备：$OutputDirectory"
Write-Host '目录结构：app、runtime、tools、models、user-data'
if (-not $ModelDirectory) { Write-Host '当前为无模型运行包；模型包放入 models\sensevoice 后即可启用本地字幕识别。' -ForegroundColor Yellow }
