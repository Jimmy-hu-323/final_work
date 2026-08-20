param(
    [string]$CacheRoot = "D:\Android_studio\LensGoCache",
    [int]$QwenPawPort = 18088,
    [int]$CrowdPort = 18099,
    [string]$CrowdProjectRoot = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$qwenpaw = Join-Path $projectRoot ".venv\Scripts\qwenpaw.exe"
$workingDir = Join-Path $projectRoot "workspace\qwenpaw"
$logDir = Join-Path $projectRoot "workspace\logs"
$adb = Join-Path $CacheRoot "sdk\platform-tools\adb.exe"
$integratedEnv = Join-Path $projectRoot ".env.integrated"

if (-not $CrowdProjectRoot -and (Test-Path -LiteralPath $integratedEnv)) {
    $crowdSetting = Get-Content -Encoding UTF8 -LiteralPath $integratedEnv |
        Where-Object { $_ -match "^\s*LENSGO_CROWD_PROJECT_ROOT\s*=" } |
        Select-Object -First 1
    if ($crowdSetting) {
        $CrowdProjectRoot = (($crowdSetting -split "=", 2)[1]).Trim().Trim('"').Trim("'")
    }
}

if (-not (Test-Path -LiteralPath $qwenpaw)) {
    throw "QwenPaw is not installed. Run: python .\scripts\integrated.py bootstrap"
}
if (-not (Test-Path -LiteralPath (Join-Path $workingDir "config.json"))) {
    throw "QwenPaw workspace is not initialized. Run bootstrap first."
}

$env:QWENPAW_WORKING_DIR = $workingDir
$env:COPAW_WORKING_DIR = $workingDir
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$crowdRun = if ($CrowdProjectRoot) { Join-Path $CrowdProjectRoot "run.py" } else { "" }
$crowdListener = Get-NetTCPConnection -LocalPort $CrowdPort -State Listen -ErrorAction SilentlyContinue
if (-not $crowdListener -and $crowdRun -and (Test-Path -LiteralPath $crowdRun)) {
    Start-Process `
        -FilePath (Join-Path $projectRoot ".venv\Scripts\python.exe") `
        -ArgumentList @($crowdRun, "--host", "127.0.0.1", "--port", "$CrowdPort") `
        -WorkingDirectory $CrowdProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir "crowd-mobile.out.log") `
        -RedirectStandardError (Join-Path $logDir "crowd-mobile.err.log")
}

$listener = Get-NetTCPConnection -LocalPort $QwenPawPort -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
    Start-Process `
        -FilePath $qwenpaw `
        -ArgumentList @("app", "--host", "127.0.0.1", "--port", "$QwenPawPort") `
        -WorkingDirectory (Join-Path $projectRoot "qwen_compitition") `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir "qwenpaw-mobile.out.log") `
        -RedirectStandardError (Join-Path $logDir "qwenpaw-mobile.err.log")
}

$ready = $false
$deadline = (Get-Date).AddSeconds(120)
do {
    Start-Sleep -Milliseconds 600
    try {
        $response = Invoke-WebRequest `
            -UseBasicParsing `
            -Uri "http://127.0.0.1:$QwenPawPort/api/version" `
            -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {
        # Continue waiting while QwenPaw loads its workspace.
    }
} while ((Get-Date) -lt $deadline)

if (-not $ready) {
    throw "QwenPaw startup timed out. Check workspace\logs\qwenpaw-mobile.err.log"
}

$crowdReady = $false
$crowdDeadline = (Get-Date).AddSeconds(20)
do {
    try {
        $crowdResponse = Invoke-WebRequest `
            -UseBasicParsing `
            -Uri "http://127.0.0.1:$CrowdPort/api/health" `
            -TimeoutSec 2
        if ($crowdResponse.StatusCode -eq 200) {
            $crowdReady = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 400
    }
} while ((Get-Date) -lt $crowdDeadline)

if (-not $crowdReady) {
    Write-Warning "Crowd API is not running on port $CrowdPort. Configure LENSGO_CROWD_PROJECT_ROOT in .env.integrated."
}

if (Test-Path -LiteralPath $adb) {
    $devices = & $adb devices
    if ($devices -match "\sdevice(\s|$)") {
        & $adb reverse "tcp:$QwenPawPort" "tcp:$QwenPawPort" | Out-Null
        & $adb reverse "tcp:$CrowdPort" "tcp:$CrowdPort" | Out-Null
        $crowdStatus = if ($crowdReady) { "ready" } else { "unavailable" }
        Write-Host "LensGo mobile is ready: QwenPaw $QwenPawPort, crowd $CrowdPort ($crowdStatus)"
        exit 0
    }
}

Write-Host "QwenPaw is ready. No USB debug device was detected; reconnect the phone and rerun this script."
