param(
    [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$RepoDirectory = Split-Path -Parent $PSScriptRoot
$ReleaseDirectory = Join-Path $RepoDirectory 'release'
if (-not $OutputDirectory) {
    $OutputDirectory = Get-ChildItem -LiteralPath $ReleaseDirectory -Directory | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $OutputDirectory) { throw 'No release directory was found. Pass -OutputDirectory explicitly.' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$BuildDirectory = Join-Path $RepoDirectory '.launcher-build'
$IconSource = Join-Path $PSScriptRoot 'IconBuilder.cs'
$LauncherSource = Join-Path $PSScriptRoot 'PracticeLauncher.cs'
$IconBuilder = Join-Path $BuildDirectory 'IconBuilder.exe'
$LauncherStem = Get-ChildItem -LiteralPath $OutputDirectory -Filter '*.cmd' -File | Select-Object -First 1 -ExpandProperty BaseName
if (-not $LauncherStem) { $LauncherStem = 'PracticeLauncher' }
$IconPath = Join-Path $OutputDirectory ($LauncherStem + '.ico')
$LauncherPath = Join-Path $OutputDirectory ($LauncherStem + '.exe')

$CompilerCandidates = @(
    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
)
$Compiler = $CompilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $Compiler) { throw 'Windows C# compiler was not found.' }
foreach ($source in @($IconSource, $LauncherSource)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Source file was not found: $source" }
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
if (Test-Path -LiteralPath $BuildDirectory) { Remove-Item -LiteralPath $BuildDirectory -Recurse -Force }
New-Item -ItemType Directory -Path $BuildDirectory -Force | Out-Null

try {
    $iconCompileArgs = @('/nologo', '/target:exe', "/out:$IconBuilder", '/reference:System.Drawing.dll', $IconSource)
    & $Compiler @iconCompileArgs
    if ($LASTEXITCODE -ne 0) { throw 'Icon compilation failed.' }
    & $IconBuilder $IconPath
    $iconExitCode = $LASTEXITCODE
    if ($iconExitCode -ne 0) { throw "Icon generation failed with exit code $iconExitCode." }
    if (-not [IO.File]::Exists($IconPath)) { throw 'Icon generation did not create the output file.' }

    $launcherCompileArgs = @(
        '/nologo',
        '/target:winexe',
        "/out:$LauncherPath",
        "/win32icon:$IconPath",
        '/reference:System.dll',
        '/reference:System.Windows.Forms.dll',
        $LauncherSource
    )
    & $Compiler @launcherCompileArgs
    $launcherExitCode = $LASTEXITCODE
    if ($launcherExitCode -ne 0) { throw "Launcher compilation failed with exit code $launcherExitCode." }
    if (-not [IO.File]::Exists($LauncherPath)) { throw 'Launcher compilation did not create the output file.' }
    Write-Host "Launcher EXE created: $LauncherPath"
    Write-Host "Icon created: $IconPath"
}
finally {
    if (Test-Path -LiteralPath $BuildDirectory) { Remove-Item -LiteralPath $BuildDirectory -Recurse -Force -ErrorAction SilentlyContinue }
}
