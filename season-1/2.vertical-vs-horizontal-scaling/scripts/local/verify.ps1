param(
  [ValidateSet('Core','Runtime','Load','All')][string]$Suite = 'Core',
  [string]$Profiles = 'smoke,support,stress,spike,soak',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$workloads = @($Profiles.Split(',') | ForEach-Object { $_.Trim() })
foreach ($workload in $workloads) { if ($workload -notin @('smoke','support','stress','spike','soak')) { throw "Unknown workload $workload" } }
if (@($workloads | Select-Object -Unique).Count -ne $workloads.Count) { throw 'Choose each workload only once' }
$topic = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ([IO.Path]::GetPathRoot($topic) -ne 'D:\') { throw 'Local test artifacts must remain on D:' }
if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw 'Use PowerShell 7. Locate pwsh.exe with Get-Command pwsh or your installed runtime path, then run pwsh -File scripts/local/verify.ps1.'
}
$steps = @()
if ($Suite -in @('Core','All')) { $steps += @('static','contract','image','security','terraform','operations') }
if ($DryRun) {
  Write-Output "Topic: $topic"
  Write-Output "Sequential CI stages: $($steps -join ', ')"
  if ($Suite -in @('Runtime','All')) { & (Join-Path $PSScriptRoot 'runtime-verify.ps1') -DryRun }
  if ($Suite -in @('Load','All')) { Write-Output "Isolated recovery/load profiles: $($workloads -join ', '); soak duration is four hours." }
  if ($Suite -in @('Load','All') -and $workloads -contains 'soak') { Write-Output 'External power is required; the real Windows run holds and restores a scoped system-execution request.' }
  Write-Output 'Core runs write synthetic owned databases and start/stop test-owned containers. No cloud apply, push or deployment is performed.'
  return
}
$logs = Join-Path $topic 'infra/compose/artifacts/verification'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$failedWorkloads = @()
$previousLocation = Get-Location
$powerGuard = $null
try {
  Set-Location -LiteralPath $topic
  if ($Suite -in @('Load','All') -and $workloads -contains 'soak') {
    . (Join-Path $PSScriptRoot 'power-guard.ps1')
    $powerGuard = Start-VerificationPowerGuard -RequireExternalPower
    Write-Output "VERIFY_POWER_GUARD acquired; AC=$($powerGuard.ACLineStatus), battery=$($powerGuard.BatteryPercent)%"
  }
  foreach ($stage in $steps) {
    Write-Output "VERIFY_PROGRESS $stage, log=$logs\$runId-$stage.log"
    & node scripts/ci/run.mjs "--stage=$stage" *> (Join-Path $logs "$runId-$stage.log")
    if ($LASTEXITCODE -ne 0) { throw "Gate $stage failed. Inspect $logs\$runId-$stage.log" }
  }
  if ($Suite -in @('Runtime','All')) {
    Write-Output "VERIFY_PROGRESS runtime, log=$logs\$runId-runtime.log"
    & pwsh -NoProfile -File scripts/local/runtime-verify.ps1 *> (Join-Path $logs "$runId-runtime.log")
    if ($LASTEXITCODE -ne 0) { throw "Runtime gate failed. Inspect $logs\$runId-runtime.log" }
  }
  if ($Suite -in @('Load','All')) {
    foreach ($profile in $workloads) {
      Write-Output "VERIFY_PROGRESS workload=$profile, log=$logs\$runId-$profile.log"
      & node tests/operations/recovery.mjs "--profile=$profile" *> (Join-Path $logs "$runId-$profile.log")
      if ($LASTEXITCODE -ne 0) {
        $failedWorkloads += $profile
        Write-Output "VERIFY_FAILED workload=$profile. Evidence retained; later isolated profiles still run."
      }
      & node scripts/operations/evidence.mjs
      if ($LASTEXITCODE -ne 0) { throw 'Evidence inventory failed' }
    }
  }
} finally {
  try { & node (Join-Path $topic 'scripts/operations/evidence.mjs') } finally {
    try { Set-Location -LiteralPath $previousLocation } finally {
      if ($null -ne $powerGuard) {
        Stop-VerificationPowerGuard -PreviousState $powerGuard.PreviousState
        Write-Output 'VERIFY_POWER_GUARD restored previous thread state'
      }
    }
  }
}
if ($failedWorkloads.Count) { throw "Workload gates failed: $($failedWorkloads -join ', '). Inspect $logs. No thresholds were relaxed." }
Write-Output 'LOCAL_VERIFICATION_PASS. Read docs/evidence/VERIFICATION.md for the current artifact and remaining cloud/launch gates.'
