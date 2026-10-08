param([int]$Rate=100,[switch]$Smoke,[string]$Image='')
$ErrorActionPreference='Stop'
$topic=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stack=Join-Path $topic 'scripts/local/stack.ps1'
$runner=Join-Path $topic 'bench/scenarios/run.mjs'
$started=[DateTime]::UtcNow.ToString('o')
$previousImage=$env:LAB_IMAGE
$previousCache=$env:LAB_PUBLIC_CACHE
if (-not $Image) {
  $identity=Get-Content (Join-Path $topic 'infra/compose/artifacts/ci/image-identity.json') -Raw|ConvertFrom-Json
  $Image=$identity.imageId
  if ($Image -notmatch '^sha256:[a-f0-9]{64}$') { throw 'A tested immutable image identity is required' }
}
$env:LAB_PUBLIC_CACHE='false'
$env:LAB_IMAGE=(& docker image inspect $Image --format '{{.Id}}')
if($LASTEXITCODE -ne 0) {throw 'Build the local API image before comparison'}
try {
  foreach($topology in @('Vertical','Horizontal')) {
    $replicas=1
    if($topology -eq 'Horizontal') {$replicas=4}
    & $stack -Action Up -Topology $topology -Replicas $replicas -Observe
    if($LASTEXITCODE -ne 0) {throw 'Topology start failed'}
    & $stack -Action Verify -Topology $topology -Replicas $replicas
    if($LASTEXITCODE -ne 0) {throw 'Topology verification failed'}
    $warmup='2m';$duration='10m';$repeats=3
    if($Smoke) {$warmup='10s';$duration='30s';$repeats=1}
    node $runner "--topology=$($topology.ToLower())" --run=10 "--rate=$Rate" "--duration=$warmup"
    if($LASTEXITCODE -ne 0) {throw 'Warm-up failed'}
    for($run=1;$run -le $repeats;$run++) {
      node $runner "--topology=$($topology.ToLower())" "--run=$run" "--rate=$Rate" "--duration=$duration"
      if($LASTEXITCODE -ne 0) {throw 'Measured run failed'}
    }
  }
  if(-not $Smoke) {
    node (Join-Path $topic 'bench/scenarios/summarize.mjs') "--since=$started"
    if($LASTEXITCODE -ne 0) {throw 'Comparison evidence validation failed'}
  }
} finally {
  try { & $stack -Action Up -Topology Horizontal -Replicas 4 -Observe } finally { $env:LAB_IMAGE=$previousImage; $env:LAB_PUBLIC_CACHE=$previousCache }
}
