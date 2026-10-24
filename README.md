# System Design Journey

A system-design study repository with runnable examples and an expanded backend scaling lab. The Season 1 topics began as video-study exercises; the lab documents implementation decisions, failure tests and remaining deployment gates rather than presenting coursework as a deployed commercial service.

**Start with the [vertical and horizontal scaling lab](season-1/2.vertical-vs-horizontal-scaling/README.md).** It has a canonical Express service, separate comparison backends, repeatable Docker environments, durable ingestion, observability and operational drills.

## What the scaling lab explores

| Area | Implementation |
|---|---|
| Application scaling | Four workers in one container versus four independent Express replicas with an equal API resource budget. |
| Data integrity | MongoDB-authoritative sessions, owner-scoped mutations, transactional idempotency receipts and majority-committed job/outbox records. |
| Asynchronous ingestion | Leased relay and worker processes, at-least-once queue delivery, idempotent effects, bounded attempts and audited redrive. |
| Caching | Rebuildable public-catalog Redis cache, bounded staleness, invalidation and database fallback during cache failure. Authorization bypasses the cache. |
| Observability | Prometheus replica scrapes, OpenTelemetry traces, structured logs and Grafana dashboards. |
| Delivery and recovery | Non-root container images, readiness/drain, exact-image checks, rollback and isolated restore exercises. |
| Cloud reference | Terraform definitions and deployment gates for ECS, ALB, Atlas, Redis and SQS. Real cloud acceptance is still open. |

Node, Fastify, NestJS and Go are comparison implementations. Their supported operations are explicit in the [capability matrix](season-1/2.vertical-vs-horizontal-scaling/contracts/capabilities.json); they should not be assumed to have the canonical Express service's complete behavior.

## Architecture

```text
Client → Nginx → Express replicas → MongoDB
                         ├──────→ Redis public catalog cache
                         └──────→ Transactional job + outbox
                                      ↓
                              Relay → Queue → Worker
                                              ├─ Idempotent product effect
                                              └─ Bounded retry / dead-letter path

API, relay and worker → metrics / logs / traces → Grafana
```

The important boundary is acknowledgment: ingestion returns `202` after the durable job, idempotency scope and outbox event commit. Queue messages can arrive more than once; one committed logical effect is the intended contract, rather than a claim of exactly-once transport.

Read the [architecture](season-1/2.vertical-vs-horizontal-scaling/docs/ARCHITECTURE.md), [security model](season-1/2.vertical-vs-horizontal-scaling/docs/SECURITY.md) and [canonical-service ADR](season-1/2.vertical-vs-horizontal-scaling/docs/adr/0001-canonical-service-and-durable-effects.md) for the consistency and authorization tradeoffs.

## Run the lab

Use Windows, Docker Desktop, Node.js, pnpm and PowerShell 7, with the checkout on `D:` as required by the local wrapper. Run commands from the topic folder; there is no root application build or test command.

```powershell
cd season-1/2.vertical-vs-horizontal-scaling

# Preview owned containers and verification commands without changing services.
pwsh -File scripts/local/stack.ps1 -Action Up -Replicas 4 -Telemetry -DryRun
pwsh -File scripts/local/verify.ps1 -Suite All -DryRun

# Start the local lab after reviewing the preview.
pwsh -File scripts/local/stack.ps1 -Action Up -Replicas 4 -Build -Telemetry
pwsh -File scripts/local/stack.ps1 -Action Verify -Replicas 4
```

The wrapper creates local signing/dashboard keys in ignored storage. Keep credentials and generated datasets out of Git. Detailed prerequisites, local ports, sequential test suites, capacity trials and the four-hour soak command remain in the [topic README](season-1/2.vertical-vs-horizontal-scaling/README.md).

## Tests and evidence

- [GitHub CI](.github/workflows/vertical-scaling-ci.yml) separates static checks, contract tests, tested-image construction, scanning, operations and mocked Terraform validation.
- [Verification inventory](season-1/2.vertical-vs-horizontal-scaling/docs/evidence/VERIFICATION.md) records source/image identity, workload configuration and retained local results, including failed and historical runs.
- [Phase status](season-1/2.vertical-vs-horizontal-scaling/docs/PHASE_STATUS.md) separates implemented code from exit gates.
- [Operations guide](season-1/2.vertical-vs-horizontal-scaling/docs/runbooks/OPERATIONS.md) covers incident, rollback and recovery procedures.
- [Capacity plan](season-1/2.vertical-vs-horizontal-scaling/docs/CAPACITY_PLAN.md) explains benchmark interpretation; [cost model](season-1/2.vertical-vs-horizontal-scaling/docs/COST_MODEL.md) records assumptions.

Local containers share one host and a local Mongo member. These tests do not establish independent availability zones, managed-database point-in-time recovery, or a 30-day production SLO. Cloud examples remain disabled until real account, domain, identities, secret references and budget are configured. See [cloud acceptance requirements](season-1/2.vertical-vs-horizontal-scaling/docs/CLOUD_DEPLOYMENT.md).

## Topics

| Path | Topic |
|---|---|
| `season-1/1.compressions/` | Compressions |
| `season-1/2.vertical-vs-horizontal-scaling/` | Vertical versus horizontal scaling |

New topic path: `season-1/<number>.<topic-name>/`. Keep each topic's notes and code inside its own folder, and follow that topic's configuration.

<details>
<summary>Contributor and agent tooling</summary>

The repository's existing agent and safety instructions are unchanged. Edit `rules/always/`, then run `scripts/sync-agent-rules.sh` to rebuild `AGENTS.md`; do not edit the generated file by hand. Scoped contracts stay in `rules/scoped/` and load only for their matching paths.

| File | Readers |
|---|---|
| `AGENTS.md` | Codex, Claude through `CLAUDE.md`, and Antigravity through `GEMINI.md` |
| `.cursor/rules/` | Cursor |
| `.qoder/rules/` | Qoder |
| `.agents/rules/` | Antigravity |

`hooks/block-dangerous.sh` runs before agent shell commands in Cursor and Claude. It blocks database writes, `rm -rf`, process kills and Git rewrites. Check it with `bash hooks/self-check.sh`.

Git rejects a non-fast-forward push when this repository uses `.githooks`. Existing one-time setup, scoped to this repository:

```bash
git config core.hooksPath .githooks
```

</details>
