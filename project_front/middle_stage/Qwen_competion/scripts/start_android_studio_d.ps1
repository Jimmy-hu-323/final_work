param(
    [string]$AndroidStudioExe = "D:\Android_studio\Android\Android Studio\bin\studio64.exe"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$androidProject = Join-Path $projectRoot "qwen_compitition\console\src-tauri\gen\android"
$cacheRoot = "D:\Android_studio\LensGoCache"
$propertiesFile = Join-Path $PSScriptRoot "android-studio-d.properties"

if (-not (Test-Path -LiteralPath $AndroidStudioExe)) {
    throw "找不到 Android Studio：$AndroidStudioExe"
}

$env:GRADLE_USER_HOME = Join-Path $cacheRoot "gradle"
$env:ANDROID_USER_HOME = Join-Path $cacheRoot "android-user"
$env:ANDROID_HOME = Join-Path $cacheRoot "sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:CARGO_HOME = Join-Path $cacheRoot "cargo-home"
$env:RUSTUP_HOME = Join-Path $cacheRoot "rustup-home"
$env:CARGO_TARGET_DIR = Join-Path $cacheRoot "cargo-target"
$env:npm_config_cache = Join-Path $cacheRoot "npm"
$env:TEMP = Join-Path $cacheRoot "temp"
$env:TMP = $env:TEMP
$env:Path = "$($env:CARGO_HOME)\bin;$env:Path"
$env:STUDIO_PROPERTIES = $propertiesFile

@(
    $env:GRADLE_USER_HOME,
    $env:ANDROID_USER_HOME,
    $env:ANDROID_HOME,
    $env:CARGO_HOME,
    $env:RUSTUP_HOME,
    $env:CARGO_TARGET_DIR,
    $env:npm_config_cache,
    $env:TEMP,
    (Join-Path $cacheRoot "studio\config"),
    (Join-Path $cacheRoot "studio\system"),
    (Join-Path $cacheRoot "studio\plugins"),
    (Join-Path $cacheRoot "studio\log")
) | ForEach-Object {
    New-Item -ItemType Directory -Path $_ -Force | Out-Null
}

Start-Process -FilePath $AndroidStudioExe -ArgumentList @($androidProject)
