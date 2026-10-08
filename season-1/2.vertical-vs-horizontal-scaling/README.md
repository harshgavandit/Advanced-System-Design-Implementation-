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
