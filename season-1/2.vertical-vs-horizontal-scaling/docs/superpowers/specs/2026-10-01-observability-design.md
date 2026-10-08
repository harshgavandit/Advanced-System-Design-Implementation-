# Vertical Scaling Observability Design

**Date:** 2026-10-01

**Status:** Approved

## Goal

Add a reproducible local observability stack for the vertical scaling topic. The stack must show live application and infrastructure metrics and visualize k6 benchmark results without changing existing API behavior or writing application data.

## Scope

- Instrument the Node HTTP, Express, Fastify, NestJS, and Go implementations with a Prometheus `/metrics` endpoint.
- Run one application server at a time, matching the topic's vertical Phase 1 rule.
- Add Prometheus and provisioned Grafana dashboards.
- Add MongoDB and Redis exporters.
- Run Redis as an ephemeral local cache service.
- Run the existing k6 workload from Docker and send its metrics to Prometheus.
- Bind observability ports to `127.0.0.1` only.
- Preserve all routes, authentication, MongoDB configuration, compression, clustering, and benchmark behavior.
- Do not seed, mutate, or delete application data.

## Architecture

Prometheus scrapes each server's fixed local port. Only the active implementation is expected to be up. Separate scrape jobs provide a stable `implementation` label for Node HTTP, Express, Fastify, NestJS, and Go.

Grafana reads Prometheus through an automatically provisioned data source. Dashboards are checked into the repository as JSON and loaded at container startup. MongoDB and Redis exporters expose infrastructure metrics to Prometheus. k6 uses its built-in Prometheus remote-write output so benchmark data appears in the same data source.

The local stack lives under `infra/observability/`. It reuses the existing MongoDB replica set and does not own or stop MongoDB containers.

## Application Metrics Contract

The TypeScript servers use `prom-client`. The Go server uses the official Prometheus Go client.

Each implementation exposes:

- `app_http_requests_total{implementation,method,route,status_code}`
- `app_http_request_duration_seconds{implementation,method,route,status_code}`
- `app_http_requests_in_flight{implementation}`
- language runtime and process metrics supplied by the client library

The `/metrics` scrape itself is excluded from application request metrics. Route labels use registered route templates or a fixed `__unmatched__` value. Raw URLs, query strings, user IDs, product IDs, and other unbounded values must never become labels.

## Local Services

| Service | Local port | Responsibility |
|---|---:|---|
| Grafana | 3000 | Provisioned dashboards |
| Prometheus | 9090 | Metrics storage, scraping, and k6 remote write |
| Redis | 6379 | Ephemeral optional application cache |
| Redis exporter | 9121 | Redis metrics |
| MongoDB exporter | 9216 | Replica-set metrics |

All published ports bind to `127.0.0.1`. Grafana allows anonymous local viewer access. Administrative credentials remain configurable through process environment variables and are not stored in `.env` files.

## Dashboards

### Application Overview

- target health by implementation
- requests per second
- p50, p95, and p99 latency
- error ratio and status-code distribution
- in-flight requests
- process CPU, resident memory, heap, garbage collection, and event-loop metrics when available

### Infrastructure and Load Test

- MongoDB exporter availability and replica-set member health where exposed
- Redis exporter availability, memory, connections, and operations
- k6 virtual users, iterations, request rate, p95 latency, and failed checks

## Benchmark Flow

The existing `bench/k6/load.js` remains the workload source. A PowerShell wrapper runs the official `grafana/k6` Docker image with:

- `URL=http://host.docker.internal:<active-port>/products?page=1&limit=20`
- a short smoke-test rate and duration by default
- `K6_OUT=experimental-prometheus-rw`
- `K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write`
- a stable test label identifying the implementation

The wrapper performs read-only HTTP requests. It never seeds or cleans up data.

## Failure Behavior

- Grafana and Prometheus remain usable when an application target is down.
- A missing exporter appears through Prometheus `up == 0`; it does not block Grafana startup.
- Application readiness continues to depend on MongoDB reads, not Redis.
- Metrics collection must not throw into request handling. The response lifecycle records metrics only after a status code is known.
- The stack must not claim that multi-worker counters are aggregated. The live observability demo runs with `WORKERS=1`; k6 metrics remain valid independently of application process metrics.

## Verification

- Unit tests prove bounded route labels, metric recording, and `/metrics` output.
- Existing server tests, type checks, and production builds remain green.
- `docker compose config` validates the observability stack.
- Prometheus reports the active app and exporters as up.
- Grafana API reports both dashboards provisioned.
- A Dockerized k6 smoke run writes queryable metrics to Prometheus.
- Browser verification captures the live Grafana dashboard.

