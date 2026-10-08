param([switch]$DryRun)
$ErrorActionPreference='Stop'
$topic=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if([IO.Path]::GetPathRoot($topic) -ne 'D:\'){throw 'Runtime verification must remain on D:'}
if($PSVersionTable.PSVersion.Major -lt 7){throw 'Use PowerShell 7'}
if($DryRun){Write-Output 'Exact tested image: one-replica runtime/drain, four-replica replacement, telemetry/alert/trace and real Grafana browser verification. Synthetic owned databases only.';return}
$identity=Get-Content (Join-Path $topic 'infra/compose/artifacts/ci/image-identity.json') -Raw|ConvertFrom-Json
$keys=Get-Content (Join-Path $topic 'infra/compose/artifacts/local-keys.json') -Raw|ConvertFrom-Json
$names=@('LAB_IMAGE','LAB_ACCESS_SECRET','LAB_REFRESH_SECRET','LAB_GRAFANA_SECRET','LAB_TESTED_IMAGE','LAB_TESTED_SOURCE')
$previous=@{};foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
$previousLocation=Get-Location
function Check-Exit([string]$step){if($LASTEXITCODE -ne 0){throw "Runtime verification failed: $step"}}
try{
  Set-Location -LiteralPath $topic
  $env:LAB_IMAGE=$identity.imageId
  $env:LAB_ACCESS_SECRET=$keys.access;$env:LAB_REFRESH_SECRET=$keys.refresh;$env:LAB_GRAFANA_SECRET=$keys.grafana
  & pwsh -NoProfile -File scripts/local/stack.ps1 -Action Up -Replicas 1 -Telemetry;Check-Exit 'single-replica startup'
  & node tests/container/verify.mjs;Check-Exit 'single-replica runtime'
  & node tests/container/drill.mjs;Check-Exit 'drain and dependency recovery'
  & pwsh -NoProfile -File scripts/local/stack.ps1 -Action Up -Replicas 4 -Telemetry;Check-Exit 'four-replica startup'
  & node tests/container/verify.mjs;Check-Exit 'four-replica runtime'
  & node tests/container/replica-drill.mjs --telemetry;Check-Exit 'replica replacement'
  & node tests/container/gateway-failover.mjs;Check-Exit 'repeated gateway failover'
  & node tests/container/observability.mjs;Check-Exit 'metrics, alerts and traces'
  & pwsh -NoProfile -File scripts/local/browser-verify.ps1;Check-Exit 'Grafana browser'
  Write-Output 'RUNTIME_VERIFICATION_PASS exact serving artifact, private runtime, drain, replacement, telemetry and visible dashboard'
}finally{
  foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}
  Set-Location -LiteralPath $previousLocation
}
