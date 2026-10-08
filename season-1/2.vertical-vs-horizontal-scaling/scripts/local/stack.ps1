param(
  [ValidateSet('Up','Down','Status','Verify','Drill')][string]$Action = 'Up',
  [ValidateSet(1,2,4)][int]$Replicas = 1,
  [ValidateSet('Horizontal','Vertical')][string]$Topology = 'Horizontal',
  [switch]$Build,
  [switch]$Observe,
  [switch]$Ingest,
  [switch]$Telemetry,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$topic = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ([IO.Path]::GetPathRoot($topic) -ne 'D:\') { throw 'Local artifacts must remain on D:' }
$compose = Join-Path $topic 'infra/compose/production-like.yaml'
if($Telemetry){$Observe=$true;$Ingest=$true;if($Topology -ne 'Horizontal'){throw 'Advanced telemetry currently requires the horizontal profile; vertical comparison remains independently available.'}}
if ($Topology -eq 'Vertical' -and $Replicas -ne 1) { throw 'Vertical topology uses one container with four serving workers.' }
$composeArgs = @('compose','-f',$compose)
if ($Ingest) { $composeArgs += @('-f',(Join-Path $topic 'infra/compose/ingestion.yaml')) }
if ($Topology -eq 'Vertical') { $composeArgs += @('-f',(Join-Path $topic 'infra/compose/vertical.yaml')) }
if ($Observe) { $composeArgs += @('-f',(Join-Path $topic 'infra/compose/observability.yaml')) }
if ($Observe -and $Topology -eq 'Vertical') { $composeArgs += @('-f',(Join-Path $topic 'infra/compose/observability-vertical.yaml')) }
if($Telemetry){$composeArgs+=@('-f',(Join-Path $topic 'infra/compose/telemetry.yaml'))}
if ($DryRun) {
  Write-Output "Isolated project: scaling-production-lab; Action=$Action; Replicas=$Replicas; Build=$Build"
  Write-Output "Config: $compose; Gateway: http://127.0.0.1:18082; database volumes are preserved by Down."
  return
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop CLI is required.' }
$artifacts = Join-Path $topic 'infra/compose/artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$keyFile = Join-Path $artifacts 'local-keys.json'
if (-not (Test-Path -LiteralPath $keyFile)) {
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes); $access = [Convert]::ToBase64String($bytes)
    $rng.GetBytes($bytes); $refresh = [Convert]::ToBase64String($bytes)
    @{access=$access;refresh=$refresh} | ConvertTo-Json | Set-Content -LiteralPath $keyFile -Encoding UTF8
  } finally { $rng.Dispose() }
  # Grant this Windows user only; Compose injects these local-only credentials.
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true,$false)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $keyFile -AclObject $acl
}
$keys = Get-Content -LiteralPath $keyFile -Raw | ConvertFrom-Json
$previousAccess = $env:LAB_ACCESS_SECRET
$previousRefresh = $env:LAB_REFRESH_SECRET
$env:LAB_ACCESS_SECRET = $keys.access
$env:LAB_REFRESH_SECRET = $keys.refresh
$previousGrafana=$env:LAB_GRAFANA_SECRET
if($Telemetry){
  if(-not $keys.grafana){
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$bytes=New-Object byte[] 32;$rng.GetBytes($bytes);$keys|Add-Member -NotePropertyName grafana -NotePropertyValue ([Convert]::ToBase64String($bytes));$keys|ConvertTo-Json|Set-Content -LiteralPath $keyFile -Encoding UTF8}finally{$rng.Dispose()}
  }
  $env:LAB_GRAFANA_SECRET=$keys.grafana
  New-Item -ItemType Directory -Force -Path (Join-Path $artifacts 'telemetry')|Out-Null
}
$previousSourceHash = $env:LAB_SOURCE_TREE_SHA256
try {
  switch ($Action) {
    'Up' {
      if ($Build) {
        $env:LAB_SOURCE_TREE_SHA256 = & node (Join-Path $PSScriptRoot 'source-hash.mjs')
        if ($LASTEXITCODE -ne 0 -or $env:LAB_SOURCE_TREE_SHA256 -notmatch '^[a-f0-9]{64}$') { throw 'Source hash failed' }
        & docker @composeArgs build api
        if ($LASTEXITCODE -ne 0) { throw 'Canonical image build failed' }
      }
      $volume = 'scaling-production-lab_mongo-data'
      $knownVolumes = & docker volume ls --format '{{.Name}}'
      if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect local Docker volumes' }
      if ($knownVolumes -notcontains $volume) {
        & docker volume create --label scaling.owner=production-lab $volume | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Local Mongo volume creation failed' }
      } else {
        # Windows PowerShell 5.1 removes inner quotes in native Go-template
        # arguments. Read Docker JSON instead, keeping the ownership check.
        $volumeJson = & docker volume inspect $volume
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Mongo volume ownership' }
        $volumeInfo = @($volumeJson | ConvertFrom-Json)
        if ($volumeInfo.Count -ne 1 -or $volumeInfo[0].Labels.'scaling.owner' -ne 'production-lab') { throw 'Refusing an unowned Mongo volume' }
      }
      $arguments = $composeArgs + @('up','-d','--wait','--wait-timeout','120','--scale',"api=$Replicas")
      & docker @arguments
      if($LASTEXITCODE -eq 0){
        # Bind-mounted config changes do not recreate a container. Reload also
        # refreshes the syslog destination after the owned receiver is replaced.
        & docker @composeArgs exec -T gateway nginx -t
        if($LASTEXITCODE -ne 0){throw 'Gateway configuration validation failed'}
        & docker @composeArgs exec -T gateway nginx -s reload
      }
    }
    'Down' { & docker @composeArgs down }
    'Status' { & docker @composeArgs ps }
    'Verify' { node (Join-Path $topic 'tests/container/verify.mjs') }
    'Drill' { node (Join-Path $topic 'tests/container/drill.mjs') }
  }
  if ($LASTEXITCODE -ne 0) { throw "$Action failed ($LASTEXITCODE)" }
} finally {
  $env:LAB_ACCESS_SECRET = $previousAccess
  $env:LAB_REFRESH_SECRET = $previousRefresh
  $env:LAB_SOURCE_TREE_SHA256 = $previousSourceHash
  $env:LAB_GRAFANA_SECRET=$previousGrafana
}
