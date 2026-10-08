# Vertical Scaling Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live Prometheus metrics, provisioned Grafana dashboards, MongoDB and Redis exporters, and Dockerized k6 remote-write output to the vertical scaling topic.

**Architecture:** Each server exposes the same bounded-label Prometheus contract on `/metrics`. A topic-local Docker Compose stack runs Prometheus, Grafana, ephemeral Redis, MongoDB and Redis exporters, while the existing k6 workload can run in the same network and remote-write results to Prometheus.

**Tech Stack:** TypeScript, Node.js test runner, Vitest, prom-client, Go testing, prometheus/client_golang, Docker Compose, Prometheus, Grafana, Redis, k6

**Spec:** `season-1/2.vertical-vs-horizontal-scaling/docs/superpowers/specs/2026-10-01-observability-design.md`

## Global Constraints

- Keep all feature work inside `season-1/2.vertical-vs-horizontal-scaling/`.
- Use `pnpm` for every Node.js dependency or script operation.
- Run one application server at a time.
- Preserve API routes, authentication, MongoDB behavior, compression, clustering, and existing benchmark behavior.
- Do not seed, mutate, clean up, or delete application data.
- Do not change `.env` files.
- Bind all observability ports to `127.0.0.1`.
- Keep Prometheus route labels bounded. Raw URLs, query strings, and entity IDs are forbidden as labels.
- Use only k6 for load testing.

## Review Focus

- A malformed or unknown URL must be recorded as `__unmatched__`, never as a raw path.
- `/metrics` scrapes must not inflate application request metrics.
- A request that returns or throws an error must decrement the in-flight gauge exactly once.
- Prometheus and Grafana must start even when most application targets are down.
- The k6 smoke test must use GET requests only and must not write application data.

---

### Task 1: TypeScript Server Metrics Contract

**Files:**
- Create: `servers/01-node/src/observability/metrics.ts`
- Create: `servers/01-node/src/observability/metrics.test.ts`
- Modify: `servers/01-node/src/app.ts`
- Modify: `servers/01-node/package.json`
- Modify: `servers/01-node/pnpm-lock.yaml`
- Repeat the same observability module and test in `servers/02-express/`, `servers/03-fastify/`, and `servers/04-nestjs/`
- Modify: `servers/02-express/src/app.ts`
- Modify: `servers/03-fastify/src/app.ts`
- Modify: `servers/04-nestjs/src/main.ts`

**Interfaces:**
- Consumes: Existing request lifecycle hooks and each server's fixed port.
- Produces: `createHttpMetrics(implementation, options?)`, `httpMetrics.observe(method, path)`, `observation.finish(statusCode)`, `httpMetrics.contentType`, and `httpMetrics.render()`.

- [ ] **Step 1: Add the `prom-client` dependency and test scripts without implementing metrics**

Run `pnpm add prom-client` in each TypeScript server. Add a Node test script to Node HTTP, Express, and Fastify. NestJS continues using Vitest.

- [ ] **Step 2: Write failing contract tests in all four servers**

Each test must prove that `/products/<24-hex-id>` becomes `/products/:id`, an unknown path becomes `__unmatched__`, `/metrics` is excluded, finished observations decrement in-flight requests once, and rendered output contains `app_http_requests_total` with the fixed implementation label.

- [ ] **Step 3: Run the tests to verify RED**

Run `pnpm test` in all four server directories.

Expected: each metrics test fails because `createHttpMetrics` is not implemented.

- [ ] **Step 4: Implement the minimal reusable metrics module in each server**

Use an isolated `prom-client.Registry`, bounded route templates, a counter, histogram, gauge, and optional runtime default metrics. `finish(statusCode)` must be idempotent.

- [ ] **Step 5: Run the contract tests to verify GREEN**

Run `pnpm test` in all four server directories.

Expected: all metrics contract tests pass.

- [ ] **Step 6: Integrate `/metrics` and lifecycle recording**

Use the native request lifecycle for Node HTTP, Express middleware, Fastify hooks, and the NestJS Fastify adapter. Register `/metrics` before Mongo gating. Exclude `/metrics` from counters.

- [ ] **Step 7: Verify every TypeScript server**

Run `pnpm test`, `pnpm typecheck`, and `pnpm build` in all four server directories.

Expected: every command exits 0.

- [ ] **Step 8: Commit**

Commit message: `feat: expose metrics from TypeScript servers`

---

### Task 2: Go Server Metrics Contract

**Files:**
- Create: `servers/05-go/metrics.go`
- Modify: `servers/05-go/main.go`
- Modify: `servers/05-go/main_test.go`
- Modify: `servers/05-go/go.mod`
- Modify: `servers/05-go/go.sum`

**Interfaces:**
- Consumes: Fiber request lifecycle and existing `/health` and `/products` routes.
- Produces: `newAppMetrics(implementation)`, `(*appMetrics).middleware`, and `(*appMetrics).handler` with the same metric names and labels as Task 1.

- [ ] **Step 1: Write failing Go tests**

Add tests that run a real Fiber app, issue requests to a parameterized route and an unknown route, scrape `/metrics`, and assert bounded labels, status codes, and exclusion of the scrape request.

- [ ] **Step 2: Run the test to verify RED**

Run: `go test ./...`

Expected: FAIL because `newAppMetrics` does not exist.

- [ ] **Step 3: Implement Fiber Prometheus middleware and handler**

Use a private Prometheus registry, process and Go collectors, the shared application metric names, registered Fiber route templates, `__unmatched__` for 404s, and the built-in Fiber HTTP adaptor for `promhttp`.

- [ ] **Step 4: Integrate metrics into `main()`**

Register middleware before application routes and expose `/metrics` without requiring MongoDB.

- [ ] **Step 5: Verify GREEN**

Run: `go test ./...`

Expected: all Go tests pass.

- [ ] **Step 6: Commit**

Commit message: `feat: expose metrics from Go server`

---

### Task 3: Provisioned Prometheus and Grafana Stack

**Files:**
- Create: `infra/observability/compose.yaml`
- Create: `infra/observability/prometheus/prometheus.yml`
- Create: `infra/observability/grafana/provisioning/datasources/prometheus.yml`
- Create: `infra/observability/grafana/provisioning/dashboards/dashboards.yml`
- Create: `infra/observability/grafana/dashboards/application-overview.json`
- Create: `infra/observability/grafana/dashboards/infrastructure-and-load-test.json`
- Create: `infra/observability/verify.ps1`
- Create: `infra/observability/README.md`

**Interfaces:**
- Consumes: `/metrics` from Tasks 1 and 2, existing MongoDB ports 27017-27019, Redis port 6379, and k6 remote-write metrics.
- Produces: local Grafana at port 3000, Prometheus at 9090, Redis at 6379, Redis exporter at 9121, MongoDB exporter at 9216, and two provisioned dashboard UIDs.

- [ ] **Step 1: Write the failing stack verifier**

The verifier must parse Compose, Prometheus YAML, datasource provisioning, and both dashboard JSON files. It must assert localhost port bindings, five app scrape jobs, remote-write receiver enablement, fixed dashboard UIDs, and required panel titles.

- [ ] **Step 2: Run the verifier to verify RED**

Run: `pwsh -File infra/observability/verify.ps1`

Expected: FAIL because the stack files do not exist.

- [ ] **Step 3: Add the minimal Compose and Prometheus configuration**

Include Prometheus, Grafana, ephemeral Redis, Redis exporter, MongoDB exporter, named metric volumes, health checks, and a profile-gated k6 service. Publish ports only on `127.0.0.1`.

- [ ] **Step 4: Add Grafana provisioning and two dashboards**

Provision the Prometheus data source as default. Add application and infrastructure/load-test dashboards with implementation and test filters.

- [ ] **Step 5: Add operating documentation**

Document exact start, status, smoke-test, and stop commands, expected URLs, local-only security, single-server behavior, and the no-data-write guarantee.

- [ ] **Step 6: Verify configuration GREEN**

Run `pwsh -File infra/observability/verify.ps1` and `docker compose -f infra/observability/compose.yaml config`.

Expected: both exit 0.

- [ ] **Step 7: Commit**

Commit message: `feat: add provisioned observability stack`

---

### Task 4: Dockerized k6 and Live End-to-End Verification

**Files:**
- Create: `bench/run-observed-smoke.ps1`
- Modify: `bench/README.md`
- Modify: `infra/observability/README.md`

**Interfaces:**
- Consumes: the Compose k6 profile from Task 3 and the existing `bench/k6/load.js` workload.
- Produces: a one-command read-only smoke benchmark whose metrics are queryable in Prometheus and visible in Grafana.

- [ ] **Step 1: Write a failing dry-run test for the wrapper**

The script's `-DryRun` output must contain the selected implementation, mapped port, GET-only target URL, rate, duration, and Prometheus remote-write output while rejecting unknown implementation names.

- [ ] **Step 2: Run the dry-run test to verify RED**

Run: `pwsh -File bench/run-observed-smoke.ps1 -Implementation express -DryRun`

Expected: FAIL because the wrapper does not exist.

- [ ] **Step 3: Implement the wrapper and documentation**

Map `node`, `express`, `fastify`, `nestjs`, and `go` to ports 5001-5005. Default to Express, rate 5, and duration 10 seconds. Invoke only the existing GET workload through the Compose k6 service.

- [ ] **Step 4: Verify the dry-run contract GREEN**

Run the Express dry run and an invalid-name run.

Expected: Express exits 0 with the complete command; invalid input exits nonzero before Docker is called.

- [ ] **Step 5: Run the full static suite**

Run all TypeScript tests, type checks, and builds, `go test ./...`, the observability verifier, Compose config validation, and `git diff --check`.

Expected: every command exits 0.

- [ ] **Step 6: Start and verify the live stack**

Start observability Compose services, run the active Express server with `WORKERS=1`, run the Dockerized k6 smoke test, query Prometheus target and metric APIs, query Grafana health and dashboard APIs, and visually verify Grafana in a browser.

Expected: Express, MongoDB, Redis, Prometheus, Grafana, and both exporters are healthy; k6 metrics are queryable; both dashboards load.

- [ ] **Step 7: Commit**

Commit message: `feat: add observed k6 smoke workflow`

