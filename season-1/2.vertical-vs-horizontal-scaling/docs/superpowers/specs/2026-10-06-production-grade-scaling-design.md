# Production Readiness and Scaling Roadmap

Date: 2026-10-06

Status: Reference roadmap with local implementation packages in place; cloud and sustained operational exit gates remain pending.

Implementation record: [PHASE_STATUS.md](../../PHASE_STATUS.md). Runnable commands: [README.md](../../../README.md). Artifact-specific results: [VERIFICATION.md](../../evidence/VERIFICATION.md). The baseline findings and proposed file map below describe the original review, not a fresh claim about today's code.

Scope: Season 1, vertical versus horizontal scaling topic

Source baseline: `8cad37f` on `main`, inspected during this review

## 1. Outcome and recommended direction

Evolve the current scaling lab into a service that can be deployed repeatedly, scaled across independent instances, secured, measured under realistic traffic, and recovered after failure. Keep its teaching purpose: every important architecture claim should have a reproducible experiment and evidence.

Use Express as the canonical production API. Keep raw Node, Fastify, NestJS, and Go as comparison implementations with explicit capability matrices. This choice reduces the maintenance surface while preserving framework comparisons. It is a delivery decision, not a claim that Express is the fastest implementation.

Build a modular monolith with separate API and ingestion-worker processes. Deploy containers on AWS ECS Fargate, use MongoDB Atlas for durable data, Redis for disposable cache, and SQS for asynchronous delivery. Add Terraform, GitHub Actions, and Grafana-based operational visibility. Start with one region and multiple availability zones.

This document establishes requirements and exit gates. Implementation and verification are tracked in the delivery record above; writing source or local tests does not deploy cloud resources or certify production readiness. Cloud account, region, domain, budget, and operational owner must be recorded before cloud provisioning. Use `ap-south-1` as the provisional reference region, subject to service availability and user/data location requirements.

## 2. Original implementation baseline and gaps

All source paths below are relative to `season-1/2.vertical-vs-horizontal-scaling/`.

| Area | Source evidence | Consequence and required action |
|---|---|---|
| Backend variants | `servers/01-node` through `servers/05-go` | Preserve the comparison lab; establish one production contract and one release artifact. Go currently has a smaller route surface. |
| Proxy topology | `servers/nginx/nginx.conf` has one upstream per implementation | Five frameworks behind different prefixes do not demonstrate horizontal replication of one service. |
| Proxy caching | Broad prefix locations use `proxy_cache`; the key has no user identity | Private responses may be shared if cache eligibility allows them. Disable broad caching and prove isolation through the proxy. |
| Product pagination | Express `src/features/products/products.controller.ts` always uses `estimatedDocumentCount()` | Filtered totals are wrong. Use matching counts when the contract promises exact filtered totals. |
| Product authorization | Express `products.router.ts` registers create, update, delete, and ingest without authorization middleware | Introduce administrator authorization before public exposure. |
| Ingestion | Express `products.ingest.ts` stores accepted work in a process-local array, flushing every 300 ms | `202` does not establish durability. Crashes and failed writes can lose accepted work. |
| Sessions | Express `src/shared/session.ts` stores sessions in MongoDB and accepts Redis cache hits | Failed invalidation and cache-fill races can undermine revocation. Define and test the consistency guarantee. |
| Refresh | Express `users.controller.ts` refreshes the access token without rotating the refresh token | Add rotation and reuse detection, with atomic concurrency handling. |
| MongoDB | Express `bootstrap/database.ts`: pool size 10, majority writes, `primaryPreferred` reads | Pools multiply with workers and replicas. Security-sensitive reads need a stronger policy than fallback to a stale secondary. |
| Indexes | Express product model declares text-name and category indexes | Validate query plans and compound indexes against the actual filter plus sort workloads. |
| API middleware | Express `app.ts` has Helmet, default CORS, default JSON parsing, readiness, and metrics | Add explicit origin policy, endpoint limits, rate limits, tracing, and structured request context. |
| Process model | Express `server.ts` starts a cluster primary and forks `WORKERS` workers | `WORKERS=1` still includes a supervisor process. Add a direct container entrypoint for one serving process. |
| Observability | `infra/observability/` provisions Prometheus, Grafana, exporters, and k6 | Good foundation; add replica discovery, resource metrics, traces, alerts, and operational runbooks. |
| Local infrastructure | Observability Compose uses several mutable image tags, anonymous Grafana viewing, and nonpersistent Redis | Keep local convenience isolated; pin release images and require authenticated cloud access. |
| Testing | Express `test` runs metrics tests; existing benchmark scripts cover additional load experiments | Add business, integration, contract, isolation, concurrency, and recovery tests. |
| Delivery | No root `.github` directory or topic Terraform/Dockerfile deployment stack found during review | Implement CI, reproducible images, staging, promotion, rollback, and infrastructure state management. |

The previously recorded smoke run completed 2,400 GET requests at approximately 20 requests/second over two minutes, with p95 6.06 ms and no failures. That run used an empty products collection. It demonstrates the earlier local request and telemetry path, not populated-dataset capacity. These are historical results from 2026-10-01, not a fresh runtime test performed for this document.

Two repository conventions need explicit reconciliation during implementation: scoped API rules mention `/items` while code uses `/products`, and phase 1 intentionally runs one application server at a time. Preserve phase 1 and introduce a named horizontal experiment profile. GitHub workflows must live at repository root; keep their scripts topic-local and document that narrow repository-level integration.

## 3. Working targets and capacity model

These are proposed acceptance targets, not measured capabilities or business commitments. First validate 100 RPS, then 500 RPS, then 1,000 RPS. Treat 5,000 RPS as a later capacity experiment whose infrastructure budget must be calculated first.

| Requirement | Proposed starting target | Measurement |
|---|---|---|
| Availability | 99.9% over a rolling 30-day window | Eligible requests successfully served at the edge; include service-caused timeouts and overload rejection |
| Product read latency | p95 <= 150 ms, p99 <= 300 ms | Client-observed, per operation, within the deployment region |
| Ordinary write latency | p95 <= 300 ms, p99 <= 750 ms | From client send to durable success response |
| Login latency | p95 <= 750 ms | Separate class because password hashing has intentional CPU cost |
| Ingest acceptance | p95 <= 300 ms | Response after the durable job transaction commits |
| Ingest completion | 99% within 30 seconds under supported steady load | Durable acceptance to terminal successful state |
| Load-test service failures | <= 0.1% during steady supported traffic | Count 5xx, timeouts, and capacity-related 429s; report expected negative-test 4xx separately |
| Recovery point | <= 5 minutes for database disaster recovery | Timestamp difference between incident and last recovered durable record |
| Recovery time | <= 30 minutes for tested database restore scenario | Incident declaration to validated service restoration |
| Correctness | Zero cross-user leakage and zero lost acknowledged writes in bounded drills | Reconcile identities, idempotency keys, and committed records |

Availability denominator: valid supported business requests reaching the service edge. Exclude health checks, monitoring scrapes, known invalid credentials, and intentionally malformed security tests. Publish exclusions alongside the SLI. A successful `202` only contributes to acceptance availability; ingestion completion has its own SLI. At 99.9%, the error budget is 0.1% of eligible requests. The equivalent time budget is 43.2 minutes in a 30-day period only for a time-based availability measure.

Use synthetic datasets with manifests: 10,000 products for CI, 100,000 for routine load tests, and 1,000,000 for a capacity experiment. Include category skew, long descriptions, empty results, hot products, and many distinct users. Dataset size is independent of registered-user or concurrency claims.

Capacity calculations:

```text
safe_RPS_per_replica = measured sustained throughput meeting all SLOs
replicas_for_load = ceil(peak_RPS / safe_RPS_per_replica)
replicas_with_headroom = ceil(replicas_for_load * 1.30)
AZ_failure_capacity = remaining replicas after largest AZ loss * safe_RPS_per_replica
DB_connections ~= API replicas * clients per replica * pool limit per server
                  + worker pools + monitoring connections + rollout overlap
concurrent_requests ~= arrival_RPS * mean_response_time_seconds
```

The database equation is a conservative planning aid; drivers maintain per-server pools and monitoring connections. Measure actual connections during failover and deployment. With two equally sized AZs, maintaining peak service through an AZ loss generally needs substantially more reserve than 30%. State whether the design survives peak load or only normal load during an AZ outage.

Do not convert a k6 virtual-user count into registered users or RPS. Use arrival-rate scenarios for throughput, record dropped iterations, and demonstrate that the load generator has spare CPU/network capacity.

## 4. Target architecture and decisions

```text
Clients
  -> DNS + TLS certificate
  -> WAF + Application Load Balancer
       -> Express API replicas across at least two AZs
            -> MongoDB Atlas: products, users, carts, sessions, jobs, outbox
            -> Redis: disposable public-product cache
            -> MongoDB transaction: ingestion job + outbox event

Outbox relay -> SQS Standard -> ingestion workers -> MongoDB
                                 |
                                 +-> dead-letter queue after bounded retries

API and workers -> metrics + structured logs + OTLP traces -> telemetry backends
Telemetry backends -> authenticated Grafana dashboards + delivered alerts

GitHub Actions -> tests -> ECR image digest -> staging -> production promotion
Terraform -> network, roles, queues, services, telemetry, backup configuration
```

| Decision | Recommendation | Reason / tradeoff |
|---|---|---|
| Application structure | Modular monolith, separate worker entrypoint | Keeps transactions and debugging understandable while workers scale independently. |
| Compute | ECS Fargate | Managed container scheduling fits this service without cluster administration. |
| Database | Dedicated Atlas replica set with private networking | Managed failover and backups; baseline cost must be budgeted. Private endpoints require a supported dedicated tier. |
| Cache | Managed Redis, separate from durable work storage | Cache eviction must not lose accepted jobs or authoritative session state. |
| Queue | SQS Standard plus transactional outbox and idempotent consumer | Handles at-least-once delivery; adds explicit relay and reconciliation work. |
| Local queue | SQS-compatible local emulator, version pinned | Fast contract testing; AWS staging remains required for IAM and actual queue semantics. |
| Release strategy | Rolling deployment first, health and metric rollback gates | Simpler operations and lower temporary resource cost. |
| Later release option | Blue/green after rolling rollback is proven | Supports pre-traffic testing; needs parallel capacity and compatible autoscaling metrics. |
| Telemetry | Prometheus-compatible metrics, JSON logs, OpenTelemetry traces | Preserves existing Grafana work and supports alternative backends. |
| Global distribution | Single region initially; CDN only for static/media or explicitly public catalog data | Multi-region writes need separate consistency and conflict decisions. |

For AWS, start with Amazon Managed Service for Prometheus, CloudWatch Logs, an AWS-compatible OpenTelemetry collector exporting traces to X-Ray, and Amazon Managed Grafana with configured data sources. Local development uses Prometheus/Grafana, with Tempo for traces and a local log backend when needed. Verify the selected collector components, IAM policies, Grafana plugins, quotas, and regional availability in staging before standardizing. Do not scrape the same replica through both a central collector and a sidecar.

Atlas private endpoint availability and tier restrictions are documented in [Atlas private networking](https://www.mongodb.com/docs/atlas/security-private-endpoint/). OpenTelemetry's [Node.js setup](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/) explains initializing instrumentation before application modules are loaded.

## 5. Execution phases

Each phase is an independently reviewable delivery milestone. Keep a small pull request per behavior, with regression tests and evidence. Backend owner, platform owner, and reliability owner are roles; one developer may fill all three, but record the responsible person before a release.

### Phase 0: Freeze contracts and create a trustworthy baseline

Owner: backend. Dependency: none.

1. Record Git SHA, runtime versions, package-manager version, CPU/memory limits, Docker allocation, and dataset state in `docs/evidence/baseline.md`.
2. Create `contracts/openapi.yaml` for actual supported `/products`, `/users`, `/cart`, and `/wishlist` operations. Specify validation, error bodies, auth requirements, cursor behavior, and exact versus estimated totals.
3. Create `contracts/capabilities.json` identifying each implementation's supported operations. Missing Go routes must appear as unsupported, never silently pass parity tests.
4. Add a deterministic dataset generator and manifest with seed, schema version, counts, category distribution, and content hash. Target a dedicated test database selected by an explicit environment allowlist.
5. Write black-box contract tests against the canonical service. Run each comparison implementation against only its advertised capabilities.
6. Save the populated-data single-replica baseline and current failure cases before optimization.

Deliverables: contract, capability matrix, synthetic fixture generator, baseline report. Exit gate: identical fixtures generate identical manifests; supported routes match the contract; every baseline records resource limits and dataset size. Database writes for fixture creation belong to the implementation/test workflow and must follow repository state-safety rules.

### Phase 1: Correctness and security before exposure

Owner: backend. Dependency: phase 0.

1. Disable broad Nginx cache locations. Initially cache nothing at the proxy. If later enabled, allowlist public product GETs, bypass Authorization/Cookie requests, honor `private`/`no-store` and `Set-Cookie`, and bound query variants.
2. Fix filtered counts using `countDocuments(baseFilter)` where exact totals are promised. Label unfiltered estimates explicitly or change the contract to cursor-only totals. Bound expensive offset pages and count timeouts.
3. Add an administrator permission for product mutations and ingestion. Preserve public catalog reads. Derive permissions from trusted server-side data, not request bodies.
4. Enforce ownership on cart, wishlist, profile, and job-status access. Test user A attempting every operation on user B's identifiers.
5. Make MongoDB the authoritative session check on every protected request initially. Remove positive-cache authorization bypasses, use primary reads with an explicit consistency policy, and return unavailable when the authority cannot be checked. Public catalog caching can still use Redis.
6. Rotate refresh tokens atomically, store only their hashes, detect reuse, and revoke the token family on confirmed reuse. Define behavior for concurrent refresh: one succeeds; the other receives the documented conflict/re-authentication result. Test that policy rather than assuming a library supplies it.
7. Configure CORS allowlists, explicit payload and field limits, generic public errors, request IDs, login/signup throttling, and per-principal write quotas. If browser auth later uses cookies, add Secure/HttpOnly/SameSite settings and CSRF protection.
8. Configure JWT issuer, audience, expiry, allowed algorithms, and key rotation. Ensure disabled accounts cannot refresh credentials. Add secret scanning and redact tokens, passwords, session IDs, and connection strings from logs.
9. Document trust boundaries and abuse cases for public clients, administrators, deployment identities, data services, and queue consumers. Audit administrator changes, permission changes, token-family revocation, and DLQ redrive with actor, action, target, time, and outcome in restricted storage.

Primary files: Express `src/app.ts`, `src/shared/auth.ts`, `src/shared/session.ts`, `src/shared/jwt.ts`, product/user controllers and routers, and `servers/nginx/nginx.conf`.

Exit gate: automated two-user proxy-cache test shows no leakage; unauthorized mutations fail; exact filtered totals match fixture counts; revoked sessions cannot authorize requests beginning after revocation completes, including Redis failure/recovery scenarios. In-flight requests authorized before revocation have an explicitly documented policy. Correctness failures block release regardless of throughput.

### Phase 2: Reproducible containers and local environment

Owner: platform. Dependency: phases 0-1.

1. Add a multi-stage Express `Dockerfile` with a compatible supported Node runtime, pinned image digest, frozen pnpm lockfile install, build stage, and minimal non-root runtime.
2. Add `src/container-main.ts` to start one serving process directly. Retain the existing cluster entrypoint for vertical experiments. Do not run a build during container startup.
3. Add `.dockerignore` excluding secrets, Git metadata, local caches, results, and `node_modules`. Verify native dependencies such as bcrypt work on the selected Linux base and CPU architecture.
4. Create `infra/compose/production-like.yaml` with independent API/worker/relay services, test Mongo replica set, Redis, queue emulator, and observability profiles. Avoid fixed `container_name` on services that must scale.
5. Publish only the local gateway and chosen localhost dashboards. Give API containers internal ports and explicit CPU/memory limits, read-only filesystems where feasible, and bounded temporary storage.
6. Define separate liveness, readiness, and capability status. Readiness must be cheap, bounded, and false during startup/draining. Redis failure must not remove healthy catalog replicas; unavailable Mongo must fail protected operations closed.
7. Implement shutdown: mark draining, stop new work, stop receiving queue messages, finish bounded work, close connections, and exit. Make the container stop timeout exceed the drain deadline.
8. Add PowerShell startup/verification wrappers with dry-run support. Resolve PowerShell 7 explicitly and print an actionable path when `pwsh` is absent; do not assume Bash or POSIX environment-variable assignment works in Windows PowerShell.

Exit gate: a fresh checkout builds the image and starts the isolated stack with documented commands; readiness behaves correctly during dependency loss; SIGTERM drains under load. All local caches, generated files, Docker data, and installed project tools remain on D: per the workspace requirement.

### Phase 3: Real horizontal scaling and fair experiments

Owner: backend + platform. Dependency: phase 2.

1. Create a horizontal experiment profile with 1, 2, and 4 replicas of the same Express image behind one Nginx endpoint. Keep the five-framework prefix experiment separate.
2. Keep sessions and all durable state outside the API process. Use no sticky sessions. Log replica identity internally to prove load distribution.
3. Configure upstream membership refresh and recovery. Verify that replacement container IPs are discovered. Account for the selected Nginx edition's actual health-check capabilities; do not assume passive checks provide active readiness probes.
4. Scrape each replica directly through discovery. Scraping a randomly selected replica through the load balancer produces misleading counters.
5. Compare equal total API resources: one container with 4 serving workers at 4 CPU/4 GiB versus four containers with one serving process each at 1 CPU/1 GiB. Include supervisor overhead, fixed gateway resources, identical data-service resources, and identical cache policy.
6. For each topology, warm for 2 minutes, measure for at least 10 minutes, repeat 3 times, and report median plus spread. Run a separate growing-resource experiment when evaluating scale-out efficiency.
7. Record throughput, client p95/p99, CPU, RSS, event-loop delay, GC, network bytes, Mongo pool wait, query latency, cache hits, and generator saturation. Use client latency for multi-worker comparisons until all worker metrics are correctly aggregated.
8. In an authorized test environment, remove one replica under steady load, then restore it. Capture errors, recovery time, redistribution, and remaining headroom.

Exit gate: requests reach every healthy replica; cross-replica login/cart behavior remains correct; one-replica failure causes no acknowledged data loss; the report explains the measured bottleneck. Do not assume four replicas produce four times throughput.

### Phase 4: Durable ingestion, retries, and idempotency

Owner: backend. Dependency: phases 1-2; independent of completing performance comparison.

1. Replace the process-local ingest array with a MongoDB transaction creating an ingestion job and an outbox event. Use majority write concern. Return `202` only after commit.
2. Accept an `Idempotency-Key` scoped to authenticated principal and operation. Store its request hash and job ID under a unique index. Repeated identical input returns the same job; a changed payload with the same key returns `409`.
3. Return `{jobId, status: "accepted"}` and expose an authorized `GET /ingestion-jobs/:id` endpoint. State progression is accepted, processing, succeeded, or failed; timestamps and attempt counts make it auditable.
4. Implement an outbox relay with atomic leases and expiry. Publish versioned messages to SQS, then mark the event sent. A crash after send can republish the message, so consumers must tolerate duplicates.
5. Process the job with an atomic MongoDB transaction for product effects and completion state. If already completed, acknowledge the duplicate without applying effects again. Keep unique business/idempotency keys long enough to cover queue retention, retries, and supported replay windows.
6. Delete a queue message only after durable commit. Start with a 60-second visibility timeout for jobs bounded to 30 seconds and extend it with heartbeats for approved longer work. Bound concurrency, database batch size, and retry attempts.
7. Start with 5 receives before DLQ routing, source retention 4 days, DLQ retention 14 days, and a DLQ alert for any message. Classify transient versus permanent failures and provide an audited redrive tool after the cause is corrected.
8. Reconcile accepted jobs against outbox, queue processing, and terminal status. Alert on unsent outbox age and overdue jobs, including items that expired from transport storage. Apply backlog admission limits before accepting more work.

Proposed files: Express `src/features/ingestion/`, `src/queue/`, `src/worker-main.ts`, `src/outbox-main.ts`, and `tests/integration/ingestion-durability.test.ts`.

Exit gate: crashes after API commit, queue send, product commit, and before queue acknowledgement lose no accepted job in the test; duplicate delivery produces one logical product effect; poison messages reach DLQ; redrive does not duplicate effects. This is at-least-once transport with idempotent effects, not an exactly-once delivery claim.

SQS [visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) and [dead-letter queue guidance](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) describe the queue mechanisms. The outbox and transactional effect rules above are application design decisions.

### Phase 5: Database and cache capacity

Owner: backend. Dependency: phases 1-4.

1. Capture `explain("executionStats")` for hot product queries on representative data. Evaluate `{category: 1, _id: 1}` for category-filtered cursor pagination; measure write and storage overhead before adopting it.
2. Bound filters, sort options, page size, and query execution time. Use cursor pagination for deep traversal. Exact text-search totals may remain expensive even after the count bug is fixed.
3. Set per-route consistency: primary reads for auth, session revocation, job state, and operations requiring read-after-write; explicitly tolerate bounded staleness only for public catalog reads.
4. Preserve atomic cart updates and uniqueness constraints. Add parallel increment, delete/update race, duplicate signup, and retry-after-timeout tests. Store monetary values with defined currency and precision if the project evolves into checkout.
5. Calculate Mongo pool budgets for maximum API tasks, workers, relay, and deployment overlap. Make limits configurable, set pool wait timeouts, and use backpressure instead of unlimited pending operations.
6. Add public-product cache-aside only after baseline measurement. Use a starting maximum TTL of 30 seconds with downward jitter, bounded keys, size limits, and single-flight protection for hot misses.
7. On product writes, invalidate exact item keys and version/invalidate affected list namespaces. Treat invalidation failure as observable bounded staleness. Keep authoritative stock/checkout decisions outside cached catalog reads.
8. Test cold-cache bursts and Redis outages at supported load. Bound fallback traffic to MongoDB; overload should return a controlled response rather than exhaust all connections.

Exit gate: query plans and latency evidence justify each index; DB pool wait stays within the request budget; cache correctness and stale-data bounds are tested; Redis loss preserves data integrity. Add sharding only after measured primary capacity or working-set constraints require it and a shard-key study is complete.

### Phase 6: Grafana, tracing, SLOs, and delivered alerts

Owner: reliability. Dependency: phases 2-4; evolve alongside all later phases.

1. Preserve the existing metrics contract. Add stable environment, service, version, and replica resource labels. Never use user IDs, emails, product IDs, raw URLs, job IDs, or test IDs with unbounded retention as metric dimensions.
2. Instrument request aborts and early middleware failures. Current finish-based metrics can omit disconnected requests or errors before registration; compare app metrics with edge and k6 measurements.
3. Add Mongo pool/query timing, Redis hit/miss/error counters, outbox lag, job completion latency, retry/DLQ counts, and task resource metrics. Use platform/container metrics for CPU limits and throttling.
4. Emit structured JSON logs with request ID, trace ID, route template, status, duration, service version, and replica. Validate inbound correlation IDs and redact personal data. Do not log query strings wholesale.
5. Initialize OpenTelemetry before framework/database imports. Propagate trace context through the outbox message into workers. Sample routine successful traffic and retain enough error traces to debug failures within the telemetry budget.
6. Provision dashboards and alerts from files. Dashboards: service/SLO overview, per-replica saturation, MongoDB, Redis, queue/outbox, deployment comparisons, and benchmark evidence.
7. Configure multi-window availability burn alerts: initial page thresholds of 14.4x budget burn over both 1 hour and 5 minutes, and 6x over both 6 hours and 30 minutes. Tune with recorded traffic; use synthetic checks for low-traffic detection.
8. Add actionable alerts for missing telemetry, unavailable replicas, sustained queue age, DLQ messages, pool saturation, certificate expiry, backup failure, and cost anomalies. Each alert needs an owner, runbook, and tested notification destination.

Example aggregation using existing metric names, with health/readiness excluded:

```promql
sum(rate(app_http_requests_total{implementation="express",route!~"/health|/ready|/api-docs/.*"}[5m]))

histogram_quantile(0.95,
  sum by (le) (
    rate(app_http_request_duration_seconds_bucket{
      implementation="express",method="GET",route="/products"
    }[5m])
  )
)
```

The latency expression combines histogram buckets across replicas. Averaging replica p95 values is invalid. Align histogram buckets to the chosen latency targets before using bucket-based latency SLOs. Define recording rules for eligible traffic and include edge failures that never reach application middleware.

Exit gate: a test request is traceable from API to worker; every replica is visible; a deliberate staging failure delivers an alert with a usable runbook; recovered state resolves the alert. Grafana must label synthetic traffic clearly. Request rate is not a count of unique people; any future active-user metric requires a defined privacy-aware aggregation method.

### Phase 7: Continuous integration and software supply chain

Owner: backend + platform. Dependency: phase 2; expand gates as phases 4-6 land.

1. Add topic-local `scripts/ci/` entrypoints for install, lint, typecheck, unit tests, integration tests, contract tests, and container verification. Do not invoke the root placeholder `test` script as a real gate.
2. Add minimal root GitHub workflows with topic path filtering and an always-reporting required status job. Skipped unrelated changes must not leave required checks permanently pending.
3. On PRs, run frozen installs and parallel independent checks. Start disposable service dependencies in CI and test real transactions, indexes, and Redis behavior. Cache dependencies by OS, toolchain version, and lockfile hash.
4. Run secret scanning, dependency and container vulnerability scanning, static security checks, Dockerfile checks, and Terraform validation. Block confirmed exploitable high/critical issues; any exception requires a reason, owner, expiry, and compensating control.
5. Build the Linux runtime image and execute black-box tests against that exact image. Scan the built image, not just the source dependency list.
6. On trusted main commits, publish an immutable ECR digest with Git SHA, SBOM, provenance, and signature. Record all test artifacts and build identity. Deploy that digest to staging and promote it unchanged to production.
7. Use short-lived GitHub OIDC credentials with exact repository/environment trust conditions and separate deploy roles. Limit permissions per job, pin third-party Actions to reviewed commit SHAs, and give untrusted PR jobs no cloud secrets or deployment roles.
8. Serialize deployment jobs per environment. Cancel obsolete PR checks, but do not interrupt a production rollout halfway without an explicit rollback procedure.

| Pipeline | Trigger | Required result |
|---|---|---|
| PR validation | Topic or workflow changes | Lint/typecheck, unit/integration/contract checks, security scans, image build, artifact report |
| Build and publish | Protected main commit after validation | Signed image digest, SBOM/provenance, release manifest |
| Staging deployment | Successful trusted build | Migrations, deployment, smoke/user journeys, bounded load gate, dashboard annotation |
| Production promotion | Approved release manifest | Same tested digest, compatible schema, gradual rollout, health and SLO gates |
| Scheduled validation | Daily/weekly as appropriate | Dependency scan, infrastructure drift, synthetic journey; bounded performance regression checks |

GitHub [OIDC with AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws) avoids stored long-lived AWS access keys. Match the repository's actual subject-claim format, including environment binding where used. Docker [build attestations](https://docs.docker.com/build/metadata/attestations/) supports SBOM and provenance; generating metadata alone does not enforce signature verification.

Exit gate: a failing contract blocks merge; an untrusted PR cannot assume a deploy role; an image is traceable to source and tests; a staging release uses the published digest. Validate repository plan support for required reviews and environment protection before depending on those controls.

### Phase 8: Infrastructure as code and staging deployment

Owner: platform. Dependency: phases 5-7.

1. Record the region, budget ceiling, AWS/Atlas accounts, domain owner, and incident owner. Separate staging and production accounts or use strongly isolated projects, roles, networks, and state as a minimum.
2. Bootstrap encrypted, versioned remote Terraform state with locking and least-privilege access. Treat state and saved plan files as potentially sensitive.
3. Provision a VPC across at least two AZs, public load-balancer subnets, private application subnets, and controlled egress. Plan NAT and VPC endpoints explicitly, including image pull, logging, queue, secrets, and Atlas DNS connectivity.
4. Provision ECR, ECS API/worker/relay services, target groups, DNS, TLS, WAF, and autoscaling. Only the ALB accepts public application traffic; API task ports accept traffic from the ALB security group.
5. Provision private Atlas connectivity, separate application/monitoring/migration identities, backup policies, managed Redis with TLS/authentication, SQS/DLQ policies, and encryption keys.
6. Inject secrets through the secret manager and task roles. Never bake them into images, put them in Terraform outputs, or expose telemetry/admin ports publicly. Rehearse rotation and application restart/reload behavior.
7. Start with two API tasks across two AZs, one worker, and a relay with safe leasing. Actual HA and peak capacity require sizing beyond these minimum counts. Set maximum task counts from DB connection and cost budgets.
8. Run staging acceptance from outside the VPC and test private dependency connectivity separately. Verify HTTPS, auth, data persistence, queue completion, metrics, trace correlation, and DNS/certificate behavior.

Exit gate: a documented Terraform workflow can recreate staging; a second plan reports no unexpected changes; data services and admin interfaces are not public; a complete synthetic user journey works over HTTPS. Local Compose is not evidence of AZ resilience.

### Phase 9: Autoscaling, continuous delivery, and rollback

Owner: platform + reliability. Dependency: phase 8.

1. Measure the sustainable RPS of one production-sized task with the intended workload and data. Identify whether CPU, event loop, memory, database, or external latency limits it.
2. For rolling ECS deployments, begin with CPU target tracking at 60% and, where appropriate, a request-per-target policy derived from measurements. Convert RPS to the metric's period units. Treat memory as a limit/alert and add a memory policy only if it actually scales with load per task.
3. Start with 60-second scale-out and 300-second scale-in cooldowns, then tune using burst experiments. Maintain minimum healthy capacity and pre-scale predictable peaks.
4. Scale workers independently using backlog per worker and processing time. Derive a backlog target from acceptable queue wait; use oldest-message age as an alert. Cap worker concurrency to protect MongoDB.
5. Implement rolling API deployment with readiness gating, healthy-capacity preservation, drain timeouts, startup grace period, and deployment failure rollback. Ensure quotas/IP addresses allow the temporary overlap.
6. After deploy, run synthetic auth/cart/catalog/ingestion journeys and inspect SLOs for 15 minutes. Fail on any data-isolation failure, service error rate above 1% for 5 minutes, or p95 above its absolute SLO and 20% above the recorded baseline for 5 minutes. Require sufficient requests or extend the gate with controlled synthetic traffic.
7. Automate rollback to the previous digest and compatible configuration. Test rollback when a new image fails startup and when it passes readiness but returns wrong business results. Preserve incident evidence.
8. Add blue/green later only when its additional capacity and routing controls are justified. AWS documents that `ALBRequestCountPerTarget` target tracking is unsupported with blue/green deployments; switch to a supported measured signal and retest scaling before changing release strategy.

References: [ECS target tracking and constraints](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-targettracking.html), [ECS capacity scaling guidance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/capacity-autoscaling-best-practice.html), and [ECS blue/green setup](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deploy-blue-green-service.html).

Exit gate: scale-out occurs before sustained SLO breach in the validated workload; scale-in drains safely; a bad deployment rolls back within a proposed 5-minute recovery target. Record actual times. Autoscaling cannot repair a saturated database or a memory leak by itself.

### Phase 10: Migrations, backup restore, and disaster recovery

Owner: backend + reliability. Dependency: phase 8; required before production launch.

1. Add versioned migrations with a migration ledger, bounded batches, resumability, and one migration runner. Disable uncontrolled production index creation during application startup.
2. Use expand/migrate/contract releases: add compatible fields/indexes, deploy dual-compatible code, backfill and verify, then remove old behavior only after the rollback window closes.
3. Enable Atlas cloud backups and point-in-time recovery. Propose a 7-day PIT window plus retained daily snapshots; confirm service tier, regional availability, cost, and recovery objective before applying.
4. Restore into an isolated new cluster, never overwrite the active production cluster during a drill. Verify schema versions, counts, unique indexes, sampled hashes, and complete user journeys.
5. Include job/outbox reconciliation in recovery. A queue may contain events newer than the restored DB. Pause consumers, reconcile against the recovery point and authoritative records, then replay with idempotency protection.
6. Define Redis as rebuildable. Keep dashboard, alert, infrastructure, and application configuration in Git; keep secret recovery/rotation procedures in restricted operational documentation.
7. Measure actual RPO and RTO with timestamped drill logs. A backup marked successful does not establish restore time. If the target fails, revise capacity/process or publish the weaker measured objective.
8. Document separate runbooks for application rollback, Mongo failover, logical corruption, queue outage, credential compromise, and region loss. Regional restoration from backups has its own measured RTO; do not inherit the 30-minute database scenario target automatically.

Atlas [disaster recovery guidance](https://www.mongodb.com/docs/atlas/architecture/current/disaster-recovery/) describes continuous backups and recovery options. Application reconciliation remains the team's responsibility.

Exit gate: complete one restore drill and one migration/rollback drill, including queued work. Record recovered data cutoff, elapsed time, unrecoverable interval if any, and follow-up actions.

### Phase 11: Realistic load, failure testing, and launch decision

Owner: reliability + backend. Dependency: phases 3-10.

1. Build a traffic mix with 70% catalog list/detail, 20% authenticated reads, 8% cart/wishlist mutations, and 2% privileged ingestion. Run login/refresh separately as a CPU/security workload. Add realistic think time and hot-key skew.
2. Run smoke, supported-load, stress-to-breakpoint, spike, and 4-hour soak tests in isolated staging. Record arrival rate, concurrency, dataset manifest, image digest, task resources, cache state, generator resources, and all failed/dropped iterations.
3. Run both warm-cache and cold-cache cases. Validate response contents and persistent effects, not only HTTP success codes.
4. Conduct bounded failure drills using the matrix below. Do not run destructive experiments against real-user data without an approved operational procedure.
5. Reconcile writes and accepted jobs after every run. Include refresh-token races, retry after ambiguous timeout, duplicate queue delivery, and write followed by immediate read on another replica.
6. Produce a capacity envelope: maximum measured supported load, limiting resource, reserve at normal load, scale-out delay, and failure-mode capacity. Report regressions as well as improvements.
7. Complete launch gates, release to a small controlled audience, and observe at least one full 30-day SLO window before claiming sustained SLO attainment.

| Drill | Expected behavior | Required evidence |
|---|---|---|
| API replica loss | Remaining capacity serves traffic; replacement joins | Client errors/latency, task timeline, no lost committed writes |
| Redis failure | Cache misses use bounded DB fallback; auth remains authoritative | DB load, error rates, revocation test |
| Mongo primary failover | Bounded retries; no duplicate mutations | Election duration, client failures, write reconciliation |
| Mongo unavailable | Protected requests fail closed; writes/acceptance fail clearly | No false durable success responses |
| Worker crash after commit | Redelivery creates no second effect | Job ID, attempt history, product record count |
| Queue unavailable | Outbox retains committed jobs; backlog alarms and admission controls operate | Accepted-job reconciliation and completion after recovery |
| Poison message | Bounded retries and DLQ isolation | Attempt count, alert delivery, safe redrive |
| Bad release | Gate stops rollout and restores previous version | Image digests, timeline, business journey recovery |
| Lost AZ capacity | Defined reduced/full capacity target is met | Real cloud distribution and measured surviving throughput |
| Corruption/restore | Restore/reconcile procedure meets measured RPO/RTO | Timestamped recovery report and validation results |

Exit gate: all mandatory launch checks pass at the declared supported load; remaining limitations have owners and explicit operational acceptance.

## 6. Launch checklist and ongoing operation

- [ ] Private data and administrator operations pass isolation and authorization tests.
- [ ] Secrets rotate without exposure; external endpoints use HTTPS; dashboard access requires authentication.
- [ ] PR checks block broken releases; published artifacts have a verified source/test chain.
- [ ] Staging and production deploy the same image digest with separate configuration.
- [ ] Horizontal scaling and replica replacement work under realistic traffic.
- [ ] Idempotency, outbox reconciliation, DLQ handling, and retry budgets are tested.
- [ ] Database indexes, pools, cache behavior, and overload response have measured limits.
- [ ] Rollback and schema compatibility are proven with the previous application version.
- [ ] Restore drills establish actual recovery objectives, including queued work.
- [ ] SLO dashboards, alert delivery, runbooks, and an incident owner are in place.
- [ ] Resource quotas, cost ceiling, retention, dependency patching, and access review have owners.
- [ ] Capacity and failure reports state the exact dataset, workload, environment, and limitations.

Operational cadence: review alerts, queue age, errors, and unexpected spend daily; review dependency updates, capacity trends, and failed jobs weekly; rehearse restore and review access/retention monthly at first. Re-run a focused capacity test after changes to runtime, indexes, cache policy, request mix, or task size.

Initial telemetry retention proposal: 30 days for application logs, 7 days for routine traces, 90 days for operational metrics, and 90 days for restricted administrative audit events. Validate these against cost and actual business obligations before enabling them. Keep personal data out of telemetry, document account deletion/export behavior before real-user onboarding, and ensure deletion procedures account for caches, derived records, and backup expiry. Recovery procedures must reapply applicable deletion records after restoration.

Track deployment frequency, change failure rate, time to restore service, incident recurrence, and actual error-budget consumption. Assign a primary and backup responder; define severity levels, escalation contacts, and a short incident-review template. Production readiness includes the ability of an operator to act on the dashboards.

Treat public WAF limits as a coarse abuse layer and application per-principal quotas as the correctness layer. [AWS WAF rate rules](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html) aggregate traffic over evaluation windows; they do not replace transactional or user-specific application controls.

## 7. Proposed file map

This is the original proposed file map. Actual implementation paths and executable commands are maintained in the topic README and PHASE_STATUS.md; some test and Terraform folders use different names from this design sketch.

```text
Repository root
  .github/workflows/
    vertical-scaling-ci.yml
    vertical-scaling-release.yml
    vertical-scaling-deploy.yml

Topic folder
  contracts/openapi.yaml
  contracts/capabilities.json
  servers/02-express/Dockerfile
  servers/02-express/.dockerignore
  servers/02-express/src/container-main.ts
  servers/02-express/src/worker-main.ts
  servers/02-express/src/outbox-main.ts
  servers/02-express/src/features/ingestion/
  servers/02-express/src/queue/
  servers/02-express/src/observability/tracing.ts
  tests/contract/
  tests/integration/
  tests/security/
  tests/resilience/
  scripts/ci/
  scripts/local/
  scripts/migrations/
  bench/fixtures/
  bench/scenarios/
  infra/compose/production-like.yaml
  infra/nginx/horizontal.conf
  infra/terraform/modules/
  infra/terraform/environments/staging/
  infra/terraform/environments/production/
  infra/observability/alerts/
  infra/observability/collector/
  docs/adr/
  docs/runbooks/
  docs/evidence/
  docs/CAPACITY_PLAN.md
  docs/COST_MODEL.md
  docs/DEMO.md
```

Keep platform-specific commands in wrappers. Local tooling, downloaded artifacts, fixtures, and caches stay on D:. Verify Docker storage placement before large builds or fixture generation. Prune only identified disposable images/results after checking what is in use; never use volume deletion as routine setup.

## 8. Delivery schedule and first implementation backlog

Planning estimate for one developer: 8-12 focused weeks, subject to available hours, cloud access, and test findings. This is a sequencing estimate, not a delivery promise.

| Window | Focus | Reviewable output |
|---|---|---|
| Week 1 | Phases 0-1 | Contract, fixtures, launch-blocker regression tests and fixes |
| Week 2 | Phase 2 and initial phase 7 | Repeatable container build and PR checks |
| Week 3 | Phase 3 | True replica comparison with resource evidence |
| Week 4 | Phase 4 | Durable ingest, idempotency, crash/replay proof |
| Week 5 | Phases 5-6 | Query/cache evidence, traces, SLO dashboards, delivered alerts |
| Weeks 6-7 | Phases 7-9 | Trusted release pipeline, Terraform staging, autoscaling, rollback |
| Week 8 | Phase 10 | Migration and restore reports |
| Weeks 9-10 | Phase 11 | Load/soak/failure results and launch review |
| Weeks 11-12 | Buffer and operational refinement | Fixes from drills, cost tuning, interview demo |

First five pull requests:

1. Contract and deterministic test foundation, including the two-user cache regression and filtered-count regression.
2. Fix cache/count behavior and secure product mutations, with route ownership tests.
3. Harden session/refresh behavior and bounded request handling, with concurrency and failure tests.
4. Build the canonical image and isolated local stack; add PR build/test checks.
5. Add horizontal profile, per-replica metrics, and the first fair 1-versus-4 report.

Follow with separate work packages for ingestion durability, observability, infrastructure, delivery, and recovery. Each package should have a short detailed implementation plan identifying exact interfaces and tests before code changes. This master roadmap establishes dependencies and acceptance criteria across packages.

## 9. Cost model, alternatives, and expansion triggers

Calculate monthly cost as API/worker task hours + rollout overlap + load balancer + Atlas + Redis + network/NAT/endpoints + queue requests + telemetry ingest/storage + backups + CI + traffic transfer. Include staging and load generators. Price the chosen region and service tiers immediately before provisioning; this document does not quote unverified prices.

Set budget notifications at 50%, 80%, and 100% of the agreed ceiling. Cap autoscaling, set log/trace retention, sample traces, bound label cardinality, and expire old benchmark artifacts. Do not stop production automatically solely because a budget alert fires. For a learning environment, schedule disposable compute down and document persistent charges that continue.

| Option | Use when | Main tradeoff |
|---|---|---|
| Local Docker lab | Learning, regression tests, interview demos | Low cost; no proof of real cloud fault domains |
| VM plus Compose | Small controlled pilot with modest availability needs | Simpler bill; host patching, failover, and scheduling become team responsibilities |
| ECS Fargate reference design | Managed deployment and multiple independent replicas | More cloud components and a recurring cost baseline |
| Kubernetes | A real cluster/platform requirement or explicit learning objective emerges | Adds operational surface; should follow working service/reliability foundations |

Introduce Kafka when replayable ordered event streams and multiple independent consumer groups are demonstrated needs. Introduce microservices when separate ownership, release cadence, or measured isolation needs justify distributed transactions and additional failure modes. Introduce search infrastructure when measured search requirements exceed the current indexed Mongo query design. Introduce sharding or multi-region writes only with a documented data distribution and consistency model.

Orders, payments, inventory reservations, and a customer frontend are separate product extensions. The current catalog/user/cart/wishlist service can reach its own production readiness criteria without claiming a complete commerce platform. If checkout is added, design reservation expiry, atomic stock rules, payment webhook idempotency, reconciliation, and financial audit trails as a new work package.

## 10. Interview presentation and evidence standard

A strong interview presentation explains why a decision was made, shows a failure, and demonstrates the measured outcome. Prepare a 10-minute walkthrough:

1. Show the architecture and current supported workload.
2. Explain one correctness issue found in the original code and its regression test.
3. Compare equal-resource vertical and horizontal runs on the same populated dataset.
4. Remove a test replica and show latency, errors, and recovery in Grafana.
5. Demonstrate a retried ingestion job producing one logical effect.
6. Show a PR check failure, successful staging release, and rollback evidence.
7. Show a restore report, capacity limit, cost model, and one deliberate tradeoff.

Every report in `docs/evidence/` should record timestamp, Git SHA/image digest, environment, dataset manifest, resource budget, commands/scenario version, raw result location, summarized result, and limitations. Redact personal data and secrets. Save Grafana screenshots together with query/time-range context; screenshots alone cannot establish correctness or capacity.

Use claims that match evidence:

| Claim | Minimum supporting proof |
|---|---|
| Horizontally scalable | Same service on multiple independent replicas, measured distribution and scaling/failure behavior |
| CI/CD implemented | Actual successful and failed workflow runs, immutable promotion, verified rollback |
| Durable ingestion | Reconciliation across crash points, duplicates, retries, DLQ, and recovery |
| Supports a stated RPS | Populated dataset, realistic workload, duration, latency/error SLOs, resource and generator evidence |
| Production ready for a stated scope | Completed launch gates, operating owner, recovery/security evidence, deployed environment |
| Meets 99.9% availability | Defined SLI with a complete measured observation window |
| Serves real users | Actual authorized usage data with a clear counting method; synthetic k6 traffic is labeled synthetic |

The immediate milestone is a correct, reproducible, observable four-replica Express deployment with CI and a fair benchmark report. The subsequent cloud delivery, recovery, and operational phases turn that milestone into a service that can be maintained in production.
