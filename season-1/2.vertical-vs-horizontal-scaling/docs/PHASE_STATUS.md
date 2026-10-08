# Phase delivery and exit gates

Implementation and evidence are separate. Regenerate `evidence/VERIFICATION.md` after testing. The checked-in source contains the following delivery packages; a passing older report does not validate a changed image.

| Phase | Implemented package | Exit-gate boundary |
|---|---|---|
| 0 | Actual OpenAPI, production overlay, capability matrix, seeded deterministic fixtures, HTTP suites | Comparative capability proof and baseline retain their original source/runtime |
| 1 | Cache isolation, filtered counts, trusted admin roles, ownership, authoritative sessions, rotating refresh, quotas/redaction | Current canonical HTTP/security regression passed; 28 operations and real database/cache/concurrency checks |
| 2 | Pinned multi-stage non-root image, direct entrypoint, resource-limited Compose, readiness/drain, Windows wrapper | Current exact-image durability, non-root/read-only runtime, dependency outage and drain checks passed |
| 3 | Independent replicas, DNS refresh, direct scrapes, equal-budget vertical/horizontal comparison and replica drills | Current-image three ten-minute trials per topology at 100 catalog requests/s passed with equal resources and zero errors/drops; current replacement and repeated stop/restart proof passed; prior comparison preserved separately |
| 4 | Majority job/outbox, scoped idempotency, leased relay/worker, bounded retries, DLQ/redrive, transport reconciliation | Local crash/replay proof; AWS transport/retention still needs cloud acceptance |
| 5 | Compound cursor index, bounded reads/pools, atomic cart receipts, public cache single-flight/invalidation | Current source contracts cover index cost, cache/races and replay; current-image cache-on and Redis-outage trials each completed 12,001 requests with zero errors/drops; prior summary preserved separately |
| 6 | Metrics/edge aborts, structured logs, API-to-worker traces, Grafana, burn alerts and local webhook | Current visible browser charts, payload-redacted traces/logs, firing/resolved alerts and load reconciliation passed; human paging and cloud alerts remain open |
| 7 | Sequential entrypoints, required CI result, exact tested image archive, scan/SBOM/provenance/signature workflows | Local scans executable; protected GitHub CI and signed publication not run without remote setup |
| 8 | Encrypted state bootstrap, private two-AZ network, ECS/ALB/TLS/WAF, Atlas/Redis/SQS, secret/IAM definitions | Mocked schema/security tests only; real cloud account/domain setup absent |
| 9 | Bounded API/worker target tracking, digest promotion, migrations, business/SLO gating and rollback | Local startup/wrong-business faults restored a distinct compatible previous image; two-user mutation, ownership, revocation and durable-ingestion journeys passed before and after rollback; cloud scaling/rollback pending |
| 10 | Versioned resumable migration ledger/index checks; encrypted snapshot/oplog restore to isolated target; queued-job reconciliation | Full-soak local encrypted restore and restored business journey passed, measured RPO 4.248 s and RTO 46.08 s; Atlas PIT, region loss and real recovery objectives pending |
| 11 | Mixed smoke/support/stress/spike/four-hour soak profiles, correctness and durable-effect reconciliation, launch gate | All five current-scenario local profiles passed; four-hour soak completed 720,001 main iterations, zero failed requests/drops and 14,400 acknowledged jobs with exactly one effect each; lost-AZ and 30-day operational history pending |

Cloud setup was explicitly confirmed absent. No cloud resources were created, external notification sent or production deployment claimed. Platform, backend and reliability are responsible roles; named owners are unassigned until the user selects them.

Required live cloud gates are listed in CLOUD_DEPLOYMENT.md. Required operational acceptance and limitations remain visible in the generated verification inventory. The accurate current description is a production-oriented scaling lab with implemented delivery/recovery paths and explicit open deployment gates.
