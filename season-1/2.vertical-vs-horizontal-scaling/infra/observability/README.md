# Local observability stack

This stack adds Prometheus, Grafana, an ephemeral Redis instance, Redis and MongoDB exporters, and an opt-in k6 runner to the vertical-scaling lab. All published ports bind to `127.0.0.1`; nothing is exposed to the LAN or Internet.

## Prerequisites

- Docker Desktop with Linux containers
- One application server running on its assigned port (`5001` through `5005`)
- The existing MongoDB replica set on host ports `27017` through `27019`
- PowerShell 7 for the static verifier

Only one application server should run at a time. Prometheus still has five fixed scrape jobs so results remain comparable across implementations; inactive implementations appear as down targets.

## Verify configuration

From `season-1/2.vertical-vs-horizontal-scaling`:

```powershell
pwsh -File infra/observability/verify.ps1
docker compose -f infra/observability/compose.yaml config
```

## Start and inspect

```powershell
docker compose -f infra/observability/compose.yaml up -d prometheus grafana redis redis-exporter mongodb-exporter
docker compose -f infra/observability/compose.yaml ps
docker compose -f infra/observability/compose.yaml logs --tail 100 prometheus grafana redis-exporter mongodb-exporter
```

Open:

- Grafana: <http://127.0.0.1:3000/>
- Application dashboard: <http://127.0.0.1:3000/d/vertical-app-overview>
- Infrastructure and load-test dashboard: <http://127.0.0.1:3000/d/vertical-infra-load>
- Prometheus targets: <http://127.0.0.1:9090/targets>
- Prometheus health: <http://127.0.0.1:9090/-/healthy>
- Redis exporter metrics: <http://127.0.0.1:9121/metrics>
- MongoDB exporter metrics: <http://127.0.0.1:9216/metrics>

Grafana permits anonymous local viewer access. Administrative access uses `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD`; the local defaults are `admin` and `vertical-local-admin`.

## Smoke test

With the selected application server running, request its health, product, and metrics endpoints, then confirm the target is up:

```powershell
Invoke-RestMethod http://127.0.0.1:5002/health
Invoke-RestMethod http://127.0.0.1:5002/products
Invoke-WebRequest http://127.0.0.1:5002/metrics -UseBasicParsing
Invoke-RestMethod http://127.0.0.1:9090/api/v1/targets
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

The application metrics middleware observes requests but does not change request or response data. Exporters issue diagnostic/read-only commands. Redis is a disposable lab cache with persistence disabled. The observability stack does not seed, update, or delete application database records.

## Run k6

The `load` profile is opt-in. Use the observed smoke wrapper from the topic root:

```powershell
pwsh -File bench/run-observed-smoke.ps1 -Implementation express -Rate 5 -Duration 10s
```

k6 sends metrics to Prometheus through the remote-write receiver. It does not publish a host port. Use `-DryRun` to inspect the exact GET target and labels before running.

## Stop

```powershell
docker compose -f infra/observability/compose.yaml down
```

Prometheus and Grafana metrics/configuration history use named volumes. To preserve evidence, the normal stop command does not delete volumes. Do not add `--volumes` unless you intentionally want to erase local observability history.
