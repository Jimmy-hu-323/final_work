$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
python (Join-Path $ProjectRoot "scripts\integrated.py") bootstrap @args
