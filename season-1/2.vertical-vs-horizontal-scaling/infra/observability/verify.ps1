$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$requiredFiles = @(
    'compose.yaml',
    'prometheus/prometheus.yml',
    'grafana/provisioning/datasources/prometheus.yml',
    'grafana/provisioning/dashboards/dashboards.yml',
    'grafana/dashboards/application-overview.json',
    'grafana/dashboards/infrastructure-and-load-test.json'
)

foreach ($relativePath in $requiredFiles) {
    $path = Join-Path $root $relativePath
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing observability file: $relativePath"
    }
}

$compose = Get-Content -LiteralPath (Join-Path $root 'compose.yaml') -Raw
$prometheus = Get-Content -LiteralPath (Join-Path $root 'prometheus/prometheus.yml') -Raw
$datasource = Get-Content -LiteralPath (Join-Path $root 'grafana/provisioning/datasources/prometheus.yml') -Raw
$dashboardProvider = Get-Content -LiteralPath (Join-Path $root 'grafana/provisioning/dashboards/dashboards.yml') -Raw
$application = Get-Content -LiteralPath (Join-Path $root 'grafana/dashboards/application-overview.json') -Raw | ConvertFrom-Json
$infrastructure = Get-Content -LiteralPath (Join-Path $root 'grafana/dashboards/infrastructure-and-load-test.json') -Raw | ConvertFrom-Json

$ports = @('127.0.0.1:3000:3000', '127.0.0.1:9090:9090', '127.0.0.1:6379:6379', '127.0.0.1:9121:9121', '127.0.0.1:9216:9216')
foreach ($port in $ports) {
    if (-not $compose.Contains($port)) {
        throw "Compose is missing localhost binding: $port"
    }
}

foreach ($service in @('prometheus:', 'grafana:', 'redis:', 'redis-exporter:', 'mongodb-exporter:', 'k6:')) {
    if (-not $compose.Contains($service)) {
        throw "Compose is missing service: $service"
    }
}

if (-not $compose.Contains('--web.enable-remote-write-receiver')) {
    throw 'Prometheus remote-write receiver is not enabled'
}
if (-not $compose.Contains('profiles:') -or -not $compose.Contains('- load')) {
    throw 'k6 is not protected by the load profile'
}

$jobs = @('node', 'express', 'fastify', 'nestjs', 'go', 'redis-exporter', 'mongodb-exporter')
foreach ($job in $jobs) {
    if (-not $prometheus.Contains("job_name: $job")) {
        throw "Prometheus is missing scrape job: $job"
    }
}

foreach ($port in 5001..5005) {
    if (-not $prometheus.Contains("host.docker.internal:$port")) {
        throw "Prometheus is missing app target port: $port"
    }
}

if ($datasource -notmatch 'isDefault:\s*true' -or -not $datasource.Contains('http://prometheus:9090')) {
    throw 'Grafana Prometheus datasource is not provisioned as default'
}
if (-not $dashboardProvider.Contains('/var/lib/grafana/dashboards')) {
    throw 'Grafana dashboard provider path is incorrect'
}

if ($application.uid -ne 'vertical-app-overview') {
    throw 'Application dashboard UID must be vertical-app-overview'
}
if ($infrastructure.uid -ne 'vertical-infra-load') {
    throw 'Infrastructure dashboard UID must be vertical-infra-load'
}

$applicationTitles = @($application.panels | ForEach-Object title)
foreach ($title in @('Request rate', 'Error rate', 'Latency p95', 'In-flight requests', 'Runtime memory', 'Event loop or scheduler activity')) {
    if ($title -notin $applicationTitles) {
        throw "Application dashboard is missing panel: $title"
    }
}

$infrastructureTitles = @($infrastructure.panels | ForEach-Object title)
foreach ($title in @('MongoDB availability', 'Redis availability', 'Redis memory', 'k6 virtual users', 'k6 request rate', 'k6 error rate', 'k6 latency p95')) {
    if ($title -notin $infrastructureTitles) {
        throw "Infrastructure dashboard is missing panel: $title"
    }
}

Write-Host 'Observability configuration verification passed.' -ForegroundColor Green
