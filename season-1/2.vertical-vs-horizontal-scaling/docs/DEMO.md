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

Cloud staging and production promotion are explainable code paths while the account/domain setup is absent. Present them as undeployed infrastructure and delivery design. A future live demo must use a signed tested digest, real staging acceptance and measured rollback; screenshots cannot substitute for those gates.
