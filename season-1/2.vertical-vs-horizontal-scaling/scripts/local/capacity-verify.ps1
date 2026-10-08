param([switch]$DryRun,[switch]$ResumeDatabaseCache)
$ErrorActionPreference = 'Stop'
$topic = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ([IO.Path]::GetPathRoot($topic) -ne 'D:\') { throw 'Capacity verification must remain on D:' }
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Use PowerShell 7' }
if ($DryRun) {
  Write-Output 'Exact tested image: sequential equal-resource comparison, three ten-minute trials per topology; two two-minute cache/Redis-outage trials; restore four replicas with telemetry.'
  Write-Output 'Uses only scaling-production-lab. Never run alongside a soak or another load generator.'
  if ($ResumeDatabaseCache) { Write-Output 'Resume requires a completed equal-resource comparison for the exact tested image and source.' }
  return
}
$identity = Get-Content (Join-Path $topic 'infra/compose/artifacts/ci/image-identity.json') -Raw | ConvertFrom-Json
if ($identity.imageId -notmatch '^sha256:[a-f0-9]{64}$') { throw 'A tested immutable image identity is required' }
$names = @('LAB_IMAGE','LAB_PUBLIC_CACHE')
$previous = @{}; foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$previousLocation = Get-Location
function Check-CapacityExit([string]$step) { if ($LASTEXITCODE -ne 0) { throw "Capacity verification failed: $step" } }
function Owned-RedisCommand([string]$action) {
  $raw = & docker inspect scaling-production-lab-redis-1
  Check-CapacityExit 'inspect Redis owner'
  $container = @($raw | ConvertFrom-Json)
  if ($container.Count -ne 1 -or $container[0].Config.Labels.'com.docker.compose.project' -ne 'scaling-production-lab' -or $container[0].Config.Labels.'com.docker.compose.service' -ne 'redis') { throw 'Refusing an unowned Redis container' }
  & docker $action scaling-production-lab-redis-1
  Check-CapacityExit "Redis $action"
}
$active = & docker ps --format '{{.Names}}'
Check-CapacityExit 'inspect active generators'
if (@($active | Where-Object { $_ -match '^scaling-(mixed|benchmark)-' }).Count) { throw 'An owned load generator is already running. Wait for it to complete.' }
if ($ResumeDatabaseCache) {
  $comparison=Get-Content (Join-Path $topic 'infra/compose/artifacts/benchmarks/comparison-summary.json') -Raw|ConvertFrom-Json
  if ($comparison.passed -ne $true -or $comparison.image -ne $identity.imageId -or $comparison.sourceTreeSha256 -ne $identity.sourceTreeSha256) { throw 'Resume requires a passed comparison for the exact tested artifact' }
}
try {
  Set-Location -LiteralPath $topic
  $env:LAB_IMAGE = $identity.imageId
  if (-not $ResumeDatabaseCache) {
    Write-Output 'CAPACITY_PROGRESS equal-resource comparison'
    & pwsh -NoProfile -File bench/compare.ps1 -Image $identity.imageId
    Check-CapacityExit 'equal-resource comparison'
  }
  $env:LAB_PUBLIC_CACHE = 'true'
  & pwsh -NoProfile -File scripts/local/stack.ps1 -Action Up -Replicas 4 -Observe
  Check-CapacityExit 'cache-enabled startup'
  & pwsh -NoProfile -File scripts/local/stack.ps1 -Action Verify -Replicas 4
  Check-CapacityExit 'cache-enabled runtime'
  Write-Output 'CAPACITY_PROGRESS cache-on cold/warm'
  & node bench/scenarios/run.mjs --topology=horizontal --run=6 --rate=100 --duration=2m --cache=on
  Check-CapacityExit 'cache-on cold/warm'
  Owned-RedisCommand 'stop'
  try {
    Write-Output 'CAPACITY_PROGRESS Redis unavailable'
    & node bench/scenarios/run.mjs --topology=horizontal --run=7 --rate=100 --duration=2m --cache=on
    Check-CapacityExit 'Redis-outage integrity'
  } finally { Owned-RedisCommand 'start' }
  & node tests/integration/summarize-phase5.mjs
  Check-CapacityExit 'database/cache evidence'
  Write-Output 'CAPACITY_VERIFICATION_PASS exact image, equal resource trials and Redis-outage integrity'
} finally {
  try {
    $env:LAB_IMAGE = $identity.imageId
    $env:LAB_PUBLIC_CACHE = 'true'
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'stack.ps1') -Action Up -Replicas 4 -Telemetry
    Check-CapacityExit 'restore four replicas and telemetry'
  } finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') }
    Set-Location -LiteralPath $previousLocation
  }
}
