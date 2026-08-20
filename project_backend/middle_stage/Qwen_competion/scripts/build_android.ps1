param(
    [switch]$Initialize,
    [switch]$DebugBuild,
    [switch]$Aab,
    [string]$CacheRoot = "D:\Android_studio\LensGoCache"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$consoleDir = Join-Path $projectRoot "qwen_compitition\console"
$npm = Get-Command npm -ErrorAction Stop

# Keep Android/Gradle/Rust/npm build caches off the small C: drive and away
# from the source checkout. Android Studio uses the same D: cache root via
# scripts\start_android_studio_d.ps1.
$env:GRADLE_USER_HOME = Join-Path $CacheRoot "gradle"
$env:ANDROID_USER_HOME = Join-Path $CacheRoot "android-user"
$env:ANDROID_HOME = Join-Path $CacheRoot "sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:CARGO_HOME = Join-Path $CacheRoot "cargo-home"
$env:RUSTUP_HOME = Join-Path $CacheRoot "rustup-home"
$env:CARGO_TARGET_DIR = Join-Path $CacheRoot "cargo-target"
$env:npm_config_cache = Join-Path $CacheRoot "npm"
$env:TEMP = Join-Path $CacheRoot "temp"
$env:TMP = $env:TEMP
$env:Path = "$($env:CARGO_HOME)\bin;$env:Path"
@(
    $env:GRADLE_USER_HOME,
    $env:ANDROID_USER_HOME,
    $env:ANDROID_HOME,
    $env:CARGO_HOME,
    $env:RUSTUP_HOME,
    $env:CARGO_TARGET_DIR,
    $env:npm_config_cache,
    $env:TEMP
) | ForEach-Object {
    New-Item -ItemType Directory -Path $_ -Force | Out-Null
}

if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
    throw "Android SDK is not configured. Set ANDROID_HOME first."
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "Rust/Cargo is not installed. Install it from https://rustup.rs first."
}

Push-Location $consoleDir
try {
    $androidProject = Join-Path $consoleDir "src-tauri\gen\android"
    if ($Initialize -or -not (Test-Path -LiteralPath $androidProject)) {
        & $npm.Source run android:init
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    $format = if ($Aab) { "--aab" } else { "--apk" }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    if ($DebugBuild) {
        & $npm.Source run android:build -- $format --debug 2>&1 |
            Tee-Object -Variable capturedBuildOutput
    } else {
        & $npm.Source run android:build -- $format 2>&1 |
            Tee-Object -Variable capturedBuildOutput
    }
    $buildExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($buildExitCode -eq 0) {
        exit 0
    }

    # Tauri uses a symlink from Cargo target to jniLibs on Windows. Machines
    # without Windows Developer Mode cannot create it even though Rust compiled
    # successfully. For an ARM64 debug APK, copy that exact library and let
    # Gradle package it while skipping the already-completed Rust task.
    $capturedText = ($capturedBuildOutput | Out-String)
    if (
        $DebugBuild -and
        -not $Aab -and
        $capturedText.Contains("Creation symbolic link is not allowed")
    ) {
        $rustLibrary = Join-Path $env:CARGO_TARGET_DIR "aarch64-linux-android\release\libapp_lib.so"
        if (-not (Test-Path -LiteralPath $rustLibrary)) {
            exit $buildExitCode
        }
        $jniDirectory = Join-Path $androidProject "app\src\main\jniLibs\arm64-v8a"
        New-Item -ItemType Directory -Path $jniDirectory -Force | Out-Null
        Copy-Item -LiteralPath $rustLibrary -Destination (Join-Path $jniDirectory "libapp_lib.so") -Force

        $studioJdk = "D:\Android_studio\Android\Android Studio\jbr"
        if (Test-Path -LiteralPath $studioJdk) {
            $env:JAVA_HOME = $studioJdk
        }
        Push-Location $androidProject
        try {
            & ".\gradlew.bat" :app:assembleArm64Debug -x :app:rustBuildArm64Debug --no-daemon --console=plain
            exit $LASTEXITCODE
        } finally {
            Pop-Location
        }
    }
    exit $buildExitCode
} finally {
    Pop-Location
}
