param([switch]$DryRun)
$ErrorActionPreference='Stop'
$topic=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if([IO.Path]::GetPathRoot($topic) -ne 'D:\'){throw 'Browser verification must remain on D:'}
if($PSVersionTable.PSVersion.Major -lt 7){throw 'Use PowerShell 7'}
if($DryRun){Write-Output 'Inspect four exact-image serving replicas, build the pinned browser runner, query the real authenticated Grafana dashboard and save screenshots.';return}
$identity=Get-Content (Join-Path $topic 'infra/compose/artifacts/ci/image-identity.json') -Raw|ConvertFrom-Json
$keys=Get-Content (Join-Path $topic 'infra/compose/artifacts/local-keys.json') -Raw|ConvertFrom-Json
$names=@('LAB_GRAFANA_SECRET','LAB_TESTED_IMAGE','LAB_TESTED_SOURCE');$previous=@{}
foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
$previousLocation=Get-Location
function Check-Exit([string]$step){if($LASTEXITCODE -ne 0){throw "Browser verification failed: $step"}}
try{
  Set-Location -LiteralPath $topic
  $ids=@(& docker ps --filter label=com.docker.compose.project=scaling-production-lab --filter label=com.docker.compose.service=api --format '{{.ID}}');Check-Exit 'serving inventory'
  if($ids.Count -ne 4){throw 'Browser verification requires four actual serving replicas'}
  $containers=@(& docker inspect @ids|ConvertFrom-Json);Check-Exit 'serving image identity'
  foreach($container in $containers){
    if($container.Config.Labels.'scaling.owner' -ne 'production-lab' -or $container.Image -ne $identity.imageId -or $container.Config.Labels.'org.scaling.source.sha256' -ne $identity.sourceTreeSha256){throw 'Serving ownership/image/source differs from the tested artifact'}
    if($container.State.Health.Status -ne 'healthy'){throw 'Every serving replica must be healthy before browser proof'}
  }
  $env:LAB_GRAFANA_SECRET=$keys.grafana;$env:LAB_TESTED_IMAGE=$identity.imageId;$env:LAB_TESTED_SOURCE=$identity.sourceTreeSha256
  & docker build -t scaling-dashboard-test:local tests/browser;Check-Exit 'browser runner build'
  $artifacts=Join-Path $topic 'infra/compose/artifacts';$browserScript=Join-Path $topic 'tests/browser/grafana.mjs'
  & docker run --rm --label scaling.owner=production-lab --network scaling-production-lab_backend --cpus=1 --memory=1g --cap-drop=ALL --security-opt=no-new-privileges:true -e LAB_GRAFANA_SECRET -e LAB_TESTED_IMAGE -e LAB_TESTED_SOURCE -v "${artifacts}:/results" -v "${browserScript}:/tests/grafana.mjs:ro" scaling-dashboard-test:local;Check-Exit 'Grafana browser'
}finally{
  foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}
  Set-Location -LiteralPath $previousLocation
}
