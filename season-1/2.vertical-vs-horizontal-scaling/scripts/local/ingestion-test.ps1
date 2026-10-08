param([switch]$Build,[switch]$AcceptOnly,[string]$Image='scaling-express:phase6')
$ErrorActionPreference = 'Stop'
$topic = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ([IO.Path]::GetPathRoot($topic) -ne 'D:\') { throw 'Test artifacts must stay on D:' }
$keys = Get-Content -LiteralPath (Join-Path $topic 'infra/compose/artifacts/local-keys.json') -Raw | ConvertFrom-Json
$previousAccess=$env:LAB_ACCESS_SECRET
$previousRefresh=$env:LAB_REFRESH_SECRET
$previousImage=$env:LAB_IMAGE
$previousHash=$env:LAB_SOURCE_TREE_SHA256
$env:LAB_IMAGE=$Image
$env:LAB_SOURCE_TREE_SHA256=& node (Join-Path $PSScriptRoot 'source-hash.mjs')
$env:LAB_ACCESS_SECRET=$keys.access
$env:LAB_REFRESH_SECRET=$keys.refresh
$compose=@('compose','-p','scaling-ingestion-test','-f',(Join-Path $topic 'infra/compose/production-like.yaml'),'-f',(Join-Path $topic 'infra/compose/ingestion.yaml'),'-f',(Join-Path $topic 'infra/compose/ingestion-test.yaml'))
try {
  & docker @compose stop worker outbox
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop owned test consumers before fixture reset' }
  $volume='scaling-ingestion-test_mongo-data'
  $existing=& docker volume ls --format '{{.Name}}'
  if ($LASTEXITCODE -ne 0) { throw 'Volume inventory failed' }
  if ($existing -notcontains $volume) { & docker volume create --label scaling.owner=ingestion-test $volume | Out-Null }
  $volumeJson=& docker volume inspect $volume
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect test volume ownership' }
  $volumeInfo=@($volumeJson | ConvertFrom-Json)
  if ($volumeInfo.Count -ne 1 -or $volumeInfo[0].Labels.'scaling.owner' -ne 'ingestion-test') { throw 'Refusing an unowned test volume' }
  $argsUp=$compose+@('up','-d','--wait','--wait-timeout','120')
  if ($Build) {
    & docker @compose build api
    if ($LASTEXITCODE -ne 0) { throw 'Ingestion image build failed' }
  }
  & docker @argsUp
  if ($LASTEXITCODE -ne 0) { throw 'Ingestion test startup failed' }
  & docker @compose up --no-deps --no-start worker outbox
  if ($LASTEXITCODE -ne 0) { throw 'Test background service creation failed' }
  $testArgs=@((Join-Path $topic 'tests/integration/ingestion-durability.mjs'))
  if ($AcceptOnly) { $testArgs+='--accept-only' }
  & node @testArgs
  if ($LASTEXITCODE -ne 0) { throw 'Ingestion durability test failed' }
} finally {
  $env:LAB_ACCESS_SECRET=$previousAccess
  $env:LAB_REFRESH_SECRET=$previousRefresh
  $env:LAB_IMAGE=$previousImage
  $env:LAB_SOURCE_TREE_SHA256=$previousHash
}
