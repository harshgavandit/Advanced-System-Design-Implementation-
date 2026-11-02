# Vertical and horizontal scaling lab

The canonical production-oriented implementation is Express. Node, Fastify, NestJS and Go remain comparison implementations with explicit capabilities in `contracts/capabilities.json`. The original vertical exercise runs one application container with four workers. The named horizontal profile runs four independent Express replicas without sticky sessions.

## Run on Windows

Use Docker Desktop, Node, pnpm and PowerShell 7. Keep generated data and caches on D:. Run commands from this topic folder. No root build/test command is used.

```powershell
# Preview without changing services or writing database records.
pwsh -File scripts/local/stack.ps1 -Action Up -Replicas 4 -Telemetry -DryRun
pwsh -File scripts/local/verify.ps1 -Suite All -DryRun

# Build and start the owned local lab, including worker, relay and telemetry.
pwsh -File scripts/local/stack.ps1 -Action Up -Replicas 4 -Build -Telemetry
pwsh -File scripts/local/stack.ps1 -Action Verify -Replicas 4

# Sequential disposable test gates, including crash/replay, restore and rollback.
pwsh -File scripts/local/verify.ps1 -Suite Core

# Exact-image runtime, replica/drain drills, telemetry and real browser proof.
pwsh -File scripts/local/verify.ps1 -Suite Runtime

# Sequential current-image equal-resource and cache/Redis-outage capacity trials.
# Allow about 70 minutes, and run after other workload generators finish.
pwsh -File scripts/local/capacity-verify.ps1

# Additional mixed workloads. The soak profile really runs for four hours.
pwsh -File scripts/local/verify.ps1 -Suite Load -Profiles 'support,stress,spike,soak'
node scripts/operations/evidence.mjs
```

If `pwsh` is absent from PATH, locate the installed PowerShell 7 executable and pass the same `-File` arguments to its absolute path. `stack.ps1` creates random local signing/dashboard keys in ignored `infra/compose/artifacts/local-keys.json`; never commit or paste them. Verification scripts write only their dedicated synthetic databases and manage only their owned test containers. Core verification leaves the interactive production-lab project intact.

Keep external power connected for the four-hour soak. On Windows the verification wrapper checks AC power and holds a temporary system-execution request, restoring the previous thread state when the run finishes. Interrupted runs remain failed evidence.

| Local URL | Purpose |
|---|---|
| `http://127.0.0.1:18082/products?page=1&limit=20` | Canonical catalog through Nginx |
| `http://127.0.0.1:18082/health` | Process liveness |
| `http://127.0.0.1:18082/ready` | Bounded primary readiness |
| `http://127.0.0.1:13002/d/catalog-production-lab` | Grafana, local authenticated dashboard |
| `http://127.0.0.1:19092` | Local Prometheus |

Public APIs do not expose `/metrics`. Prometheus scrapes every replica on the private network. Existing legacy dashboards on other ports belong to the earlier vertical observability exercise.

## Evidence and operational guides

- [Architecture and data guarantees](docs/ARCHITECTURE.md)
- [Security and trust boundaries](docs/SECURITY.md)
- [Capacity and benchmark interpretation](docs/CAPACITY_PLAN.md)
- [Cloud setup and promotion](docs/CLOUD_DEPLOYMENT.md)
- [Incident, rollback and recovery runbooks](docs/runbooks/OPERATIONS.md)
- [Cost inputs and ownership](docs/COST_MODEL.md)
- [Ten-minute demonstration](docs/DEMO.md)
- [Phase delivery and remaining exit gates](docs/PHASE_STATUS.md)
- [Generated verification inventory](docs/evidence/VERIFICATION.md)

The cloud examples are disabled until actual account, domain, identities, budget and secret references are supplied. Terraform validation uses mocked providers. A local successful drill does not establish multi-AZ resilience, an Atlas PIT restore, or a 30-day production SLO.

## Entirely local learning environment

The small owned learning environment reuses the same canonical Express image, MongoDB, Redis, Nginx, ElasticMQ, k6, Prometheus and Grafana. It does not require PowerShell 7, cloud credentials or paid services. Run from this topic folder:

```powershell
node scripts/local/learning-lab.mjs --list
node scripts/local/learning-lab.mjs --all --duration=30s --rate=20 --repeat=2
node scripts/local/learning-lab.mjs --scenario=capacity --duration=2m --rate=20 --repeat=3
node scripts/local/learning-lab.mjs --scenario=mongo-outage
node scripts/local/learning-lab.mjs --down
```

All eleven scenarios are explicit: baseline, scaling, cache, API loss, Redis loss, worker crash, duplicate delivery, rollback, independent restore, capacity ladder and Mongo network-stall containment. Failure tests mutate only `scaling-learning-lab` containers and the owned synthetic `learning_lab` database. Never repoint them at a real database. `--down` preserves volumes and evidence.

- API: `http://127.0.0.1:18090/products?page=1&limit=20`
- Dashboard: `http://127.0.0.1:13004/d/local-learning-lab`
- Prometheus: `http://127.0.0.1:19094`
- Evidence pointer: ignored `infra/compose/artifacts/learning/latest.json`

Reports bind source/image identity, runner/scenario fingerprint, raw k6 outputs, workload resources and artifact hashes. Scenarios record the expected behavior, observations, limitation and relevant dashboard panels. The runner checks the served dashboard contract, not just Grafana process health. Traffic stops when the workload completes; use another baseline run for fresh dashboard traffic.

This is a single-host learning environment, not a public production deployment. Anonymous Grafana access is Viewer-only and loopback-only. Security scans, full contract, long soak and recovery evidence from earlier images remain historical until rerun for a changed image. Do not treat a new short learning run as those acceptance gates.
