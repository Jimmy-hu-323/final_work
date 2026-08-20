$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Pythonw = Join-Path $ProjectRoot ".venv\Scripts\pythonw.exe"
$Orchestrator = Join-Path $PSScriptRoot "integrated.py"

if (-not (Test-Path -LiteralPath $Pythonw)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "请先运行 scripts\bootstrap.ps1 初始化项目环境。",
        "LensGo App",
        "OK",
        "Error"
    ) | Out-Null
    exit 2
}

Start-Process `
    -FilePath $Pythonw `
    -ArgumentList @($Orchestrator, "app") `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden
