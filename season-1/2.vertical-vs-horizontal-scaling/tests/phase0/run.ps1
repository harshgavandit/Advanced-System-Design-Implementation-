param([switch]$Load, [switch]$ResetTestDatabase)
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
  node --test unit/*.test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Phase 0 unit tests failed' }
  docker compose -f compose.yaml up -d --wait
  if ($LASTEXITCODE -ne 0) { throw 'Isolated services failed to start' }
  docker compose -f compose.yaml exec -T mongo mongosh --port 28027 --quiet --eval 'try { rs.status() } catch (e) { if (e.code === 94) { rs.initiate({_id:"phase0",members:[{_id:0,host:"127.0.0.1:28027"}]}) } else { throw e } }'
  if ($LASTEXITCODE -ne 0) { throw 'Isolated replica initialization failed' }
  foreach ($implementation in @('node','fastify','nestjs','express')) {
    $runArgs = @('run-contract.mjs', "--implementation=$implementation")
    if ($ResetTestDatabase -or $implementation -ne 'node') { $runArgs += '--reset-test-db' }
    if ($Load -and $implementation -eq 'express') { $runArgs += '--load' }
    node @runArgs
    if ($LASTEXITCODE -ne 0) { throw "$implementation contract verification failed" }
  }
  $env:PHASE0_MONGO_URI = 'mongodb://127.0.0.1:28027/phase0_contract_test?directConnection=true'
  $previousGoTmp = $env:GOTMPDIR
  $env:GOTMPDIR = Join-Path $PSScriptRoot 'artifacts/go-tmp'
  New-Item -ItemType Directory -Force -Path $env:GOTMPDIR | Out-Null
  Push-Location -LiteralPath '../../servers/05-go'
  try {
    & 'D:\DevTools\Go\bin\go.exe' test ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go contract verification failed' }
  } finally {
    Pop-Location
    $env:GOTMPDIR = $previousGoTmp
    Remove-Item Env:PHASE0_MONGO_URI -ErrorAction SilentlyContinue
  }
} finally { Pop-Location }
