# Ten-minute demonstration

Prepare the owned local stack with four replicas and telemetry. Start with `docs/evidence/VERIFICATION.md`; disclose any historical or failed reports. Synthetic stored profiles are not unique live users, and request rate is not a people count.

| Time | Demonstration | Evidence |
|---|---|---|
| 0-1 min | Architecture, authority and public/private boundary | ARCHITECTURE.md |
| 1-2 min | Exact filtered catalog count, forbidden non-admin mutation and two-user ownership | Canonical 28-operation contract report |
| 2-3 min | Equal total resources, vertical workers versus independent replicas | Full comparison report with median/spread |
| 3-4 min | Direct replica metrics, edge p95/p99 and real container quotas | Authenticated local Grafana |
| 4-5 min | Replica-loss alert firing/resolution and traffic redistribution | Phase 6 trace/alert/load report |
| 5-6 min | Durable 202, crash/duplicate/redrive with one product effect | Exact-image ingestion durability report |
| 6-7 min | PR required gate, archive identity, SBOM and vulnerability block | Root CI workflows and security report |
| 7-8 min | Startup/wrong-business rollback and migration crash/resume | Operations reports |
| 8-9 min | Authenticated encrypted restore and queued-job reconciliation | Recovery RPO/RTO and limitations |
| 9-10 min | Supported workload, open cloud gates, cost and one tradeoff | CAPACITY_PLAN.md and PHASE_STATUS.md |

Commands that restart replicas or write synthetic data require an owned test environment. For a read-only interview walkthrough, show the saved reports and running dashboards. Do not disturb another live application or real-user database to perform a demo.

## Local engineering walkthrough

Use the learning dashboard and the source-bound run report for a cloud-free walkthrough. The full runner contains eleven scenarios; saved evidence lets the interview stay short without pretending a short demo is a long soak.

1. Explain the authority boundaries: Mongo owns sessions and durable effects; Redis is disposable; ElasticMQ transport may duplicate.
2. Show a fixed resource budget, the repeated capacity ladder, client p95/throughput/drops and why a passing top rate is not maximum capacity.
3. Show cache hits versus private bypass, then explain the bounded Mongo fallback and its separate request/loader limits.
4. Freeze the owned Mongo peer through `--scenario=mongo-outage`. Show process health, explicit retryable 503s, actual admission rejections and normal recovery. Explain why retrying every 503 at the gateway would amplify the stall.
5. Show worker crash and duplicate delivery producing one effect, followed by bad-candidate rollback and an independently verified restore.
6. Disclose the limits: one host, one Mongo member, synthetic users, no cloud deployment, no invented capacity or availability claim. Identify the experiment that would justify the next architecture change.

Useful interview answers include why admission precedes body parsing, why socket and server-query timeouts are different, why an HTTP disconnect does not imply transaction rollback, why retries need idempotency, and why database limits can make adding API replicas ineffective. No extra message broker, service mesh or Kubernetes is necessary to demonstrate these tradeoffs.

Cloud staging and production promotion are explainable code paths while the account/domain setup is absent. Present them as undeployed infrastructure and delivery design. A future live demo must use a signed tested digest, real staging acceptance and measured rollback; screenshots cannot substitute for those gates.
