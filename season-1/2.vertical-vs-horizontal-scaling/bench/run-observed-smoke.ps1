[CmdletBinding()]
param(
    [ValidateSet('node', 'express', 'fastify', 'nestjs', 'go')]
    [string]$Implementation = 'express',

    [ValidateRange(1, 10000)]
    [int]$Rate = 5,

    [ValidatePattern('^[1-9][0-9]*(ms|s|m)$')]
    [string]$Duration = '10s',

    [ValidateSet('identity', 'gzip', 'br', 'zstd')]
    [string]$Encoding = 'identity',

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$ports = @{
    node = 5001
    express = 5002
    fastify = 5003
    nestjs = 5004
    go = 5005
}

$port = $ports[$Implementation]
$targetUrl = "http://host.docker.internal:$port/products?page=1&limit=20"
$testId = "$Implementation-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$topicRoot = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $topicRoot 'infra/observability/compose.yaml'
$remoteWrite = 'http://prometheus:9090/api/v1/write'

$summary = @(
    "implementation=$Implementation"
    "port=$port"
    "method=GET"
    "url=$targetUrl"
    "rate=$Rate/s"
    "duration=$Duration"
    "encoding=$Encoding"
    "testid=$testId"
    "output=experimental-prometheus-rw"
    "remote_write=$remoteWrite"
) -join ' '

Write-Host $summary

if ($DryRun) {
    exit 0
}

$previous = @{
    URL = $env:URL
    RATE = $env:RATE
    DURATION = $env:DURATION
    ENCODING = $env:ENCODING
    IMPLEMENTATION = $env:IMPLEMENTATION
    K6_TEST_ID = $env:K6_TEST_ID
    K6_PROMETHEUS_RW_SERVER_URL = $env:K6_PROMETHEUS_RW_SERVER_URL
}

try {
    $env:URL = $targetUrl
    $env:RATE = $Rate.ToString()
    $env:DURATION = $Duration
    $env:ENCODING = $Encoding
    $env:IMPLEMENTATION = $Implementation
    $env:K6_TEST_ID = $testId
    $env:K6_PROMETHEUS_RW_SERVER_URL = $remoteWrite

    & docker compose -f $compose --profile load run --rm k6
    if ($LASTEXITCODE -ne 0) {
        throw "k6 exited with code $LASTEXITCODE"
    }
}
finally {
    foreach ($name in $previous.Keys) {
        if ($null -eq $previous[$name]) {
            Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item -Path "Env:$name" -Value $previous[$name]
        }
    }
}
