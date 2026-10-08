# Cost inputs and ownership

No current cloud bill or verified service price is claimed. Before provisioning, the platform owner must obtain prices for the actual region, service tiers and traffic, then set a cost ceiling. The example ceiling is an input, not a forecast.

| Component | Monthly quantity to price | Owner |
|---|---|---|
| API tasks | vCPU/GiB hours at normal/min/max scale plus rollout overlap | Platform, unassigned |
| Workers and relay | Independent task hours and scaling ceiling | Backend/platform, unassigned |
| ALB and WAF | Hours, requests, rules and processed bytes | Platform, unassigned |
| Atlas | Tier, storage, PIT retention, snapshots and private endpoints | Data owner, unassigned |
| Redis | Nodes, replicas, TLS/auth tier and memory | Platform, unassigned |
| Network | NAT hours/bytes, endpoint hours/bytes and egress | Platform, unassigned |
| SQS | Send/receive/delete/visibility calls and retention | Backend, unassigned |
| Telemetry | Logs, traces, metrics ingestion/storage, sampling and retention | Reliability, unassigned |
| Delivery and testing | CI minutes, artifact storage and load generators | Platform, unassigned |

`monthly_total = compute + rollout_overlap + edge + data + network + queue + telemetry + backup + delivery + testing`.

Price both staging and production. Scheduled compute shutdown does not remove persistent database/storage/NAT/backup charges. Do not automatically shut down production in response to a cost alert. IaC defines actual-spend notifications at 50%, 80% and 100% of the agreed ceiling plus an 80% forecasted notification. Confirm and test the configured recipient before relying on delivery.

Keep task maxima consistent with the Mongo per-server pool budget. Bound metric labels, logs, trace sampling and benchmark retention. Record normal, peak and recovery headroom before raising limits. A human budget owner and incident owner must accept exceptions and recurring costs.
