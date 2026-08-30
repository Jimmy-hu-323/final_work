param([int]$Port=18120)
$ErrorActionPreference='Stop'
$demoUrl="http://127.0.0.1:$Port"
$demoBootstrap=Invoke-RestMethod "$demoUrl/api/bootstrap" -TimeoutSec 10
$demoHeaders=@{'X-Demo-CSRF'=$demoBootstrap.csrf;Origin=$demoUrl}
$null=Invoke-RestMethod -Method Post -Uri "$demoUrl/api/shutdown" -Headers $demoHeaders -ContentType 'application/json' -Body '{}' -TimeoutSec 30
Write-Host 'Mock location restored. Controller stopped.'
