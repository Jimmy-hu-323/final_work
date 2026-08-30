param([int]$Port=18120,[switch]$NoBrowser,[string]$AdbPath='')
$ErrorActionPreference='Stop'
$demoUrl="http://127.0.0.1:$Port"
$demoRunning=$false
try { $demoRunning=(Invoke-RestMethod "$demoUrl/api/status" -TimeoutSec 2).service -eq 'lensgo-location-demo' } catch {}
if(-not $demoRunning){
    $demoPython=Join-Path $PSScriptRoot '..\project_backend\middle_stage\Qwen_competion\.venv\Scripts\python.exe'
    if(-not (Test-Path -LiteralPath $demoPython)){
        $demoPython=(Get-Command python.exe -ErrorAction Stop).Source
    }
    $demoRuntime=Join-Path $PSScriptRoot '.runtime'
    New-Item -ItemType Directory -Path $demoRuntime -Force | Out-Null
    $demoArguments=@('-B', ('"'+(Join-Path $PSScriptRoot 'server.py')+'"'), '--port', "$Port")
    if($AdbPath){$demoArguments+=@('--adb', ('"'+$AdbPath+'"'))}
    $demoProcess=Start-Process -FilePath $demoPython -ArgumentList $demoArguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $demoRuntime 'server.out.log') -RedirectStandardError (Join-Path $demoRuntime 'server.err.log') -PassThru
    for($attempt=0;$attempt -lt 16;$attempt++){
        Start-Sleep -Milliseconds 500
        try { $demoRunning=(Invoke-RestMethod "$demoUrl/api/status" -TimeoutSec 2).service -eq 'lensgo-location-demo' } catch {}
        if($demoRunning){break}
        if($demoProcess.HasExited){break}
    }
    if(-not $demoRunning){throw "Controller could not start. Check location_demo\.runtime\server.err.log and port $Port."}
}
Write-Host "Location controller ready: $demoUrl"
Write-Host 'Restore real location after your demo. Use stop.ps1 to restore and stop the server.'
if(-not $NoBrowser){Start-Process $demoUrl}
