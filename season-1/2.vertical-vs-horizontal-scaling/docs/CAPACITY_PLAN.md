# Capacity and benchmark interpretation

Use `bench/compare.ps1` for equal-resource catalog comparison. It warms each topology for two minutes, measures ten minutes three times, and summarizes median and spread. `-Smoke` is only a startup sanity check. Do not mix those results with full trials.

`scripts/local/capacity-verify.ps1` selects the immutable tested image and runs the comparison followed by two two-minute cache-on and Redis-outage trials. It refuses to overlap an active owned load generator and restores four replicas with telemetry in its cleanup path. The database summary requires current source contracts and every serving replica to match the same artifact.

If a later database/cache step fails, retain its log and use `-ResumeDatabaseCache` after fixing the cause. Resume is allowed only when the preserved completed comparison passed for the exact tested image and source; a failed or historical comparison cannot skip those trials.

| Resource | Vertical | Horizontal |
|---|---|---|
| Serving layout | One container, four workers | Four containers, one serving process each |
| Total API budget | 4 CPU, 4 GiB | 4 CPU, 4 GiB |
| Gateway | 0.25 CPU, 128 MiB | Same |
| Mongo | 1 CPU, 768 MiB | Same |
| Catalog | Seed 42, 10,000 products | Same manifest/hash |
| Comparison cache/compression | Off/off | Off/off |

The October 7, 2026 comparison passed on the current tested image at 100 catalog requests/s with three ten-minute trials per topology. Both layouts used the equal API/data/generator resources above, the same 10,000-product dataset, compression off and public cache off. The previous-image summary remains retained separately as historical evidence. These trials establish behavior at the tested rate, not a maximum-capacity search or a fourfold throughput gain. Regenerate after changing runtime, query/index/cache policy or task size.

| Current-image topology | Requests across three trials | Client p95 median (trial range), ms | Client p99 median, ms | Failed requests / dropped arrivals |
|---|---|---|---|---|
| Vertical, four workers | 180,003 | 4.467 (3.070-4.593) | 6.080 | 0 / 0 |
| Horizontal, four replicas | 180,002 | 3.800 (3.184-3.927) | 4.741 | 0 / 0 |

The following current-image cache-on and Redis-unavailable trials each completed 12,001 catalog requests over two minutes at 100 requests/s, with zero errors/drops. Their client p95 values were 3.099 ms and 4.481 ms respectively. Current source contract evidence also measures three alternating-order index trials: the compound category/cursor index examined 20 documents for 20 results versus 80 without it, with 270,336 additional index bytes. Median synthetic insert times were 133.142 ms without the compound index and 260.243 ms with it; these tiny local measurements expose the write/storage tradeoff and do not establish production write capacity.

Mixed profiles use 70% catalog, 20% identity, 8% cart/wishlist and 2% ingestion **iterations**, plus separate password-login/refresh/logout journeys. A deterministic permutation preserves those exact proportions per 100 arrivals while spreading expensive writes; the earlier sequential modulo schedule grouped all writes into periodic bursts. Preserve that earlier result as a different scenario. An iteration can make several HTTP requests; the percentages are not HTTP request percentages. `support` is 50 iterations/s for ten minutes, `stress` ramps to 150, `spike` jumps to 100, and `soak` is four hours at 50. These are test targets until the actual latency, correctness, transport and generator gates pass.

Catalog targets: p95 below 150 ms and p99 below 300 ms. Write p95 below 400 ms; authentication p95 below 1,000 ms; observed job completion p95 below ten seconds. Every content/ownership/replay check must pass, no dropped iterations or unexpected failures are accepted, and every durable acknowledgement must reconcile to one product effect. Preserve regressions instead of relaxing the gate.

The complete October 7, 2026 local soak passed on the tested immutable image: 14,407.537 measured seconds, 720,001 main iterations plus 481 separate authentication iterations, and 989,230 HTTP requests. Failed requests and dropped iterations were both zero. Catalog p95 was 3.309 ms, write p95 127.916 ms, authentication p95 129.279 ms and observed job-completion p95 801 ms. All 14,400 acknowledgements reconciled to 14,400 successful single effects, with no pending/failed jobs, duplicate effects or leftover cart/wishlist records. The subsequent encrypted local restore passed the full business journey, with RPO 4.248 s, RTO 46.08 s and zero lost recoverable acknowledgements. These are one-host synthetic results; the generated [verification inventory](evidence/VERIFICATION.md) retains image, scenario, raw report paths and hashes.

The separate two-per-minute authentication probe has two preallocated VUs and starts five seconds after the main workload. The earlier single-VU scenario dropped one initial authentication iteration despite passing all application checks; that failed report is retained. The reserve avoids generator startup contention without increasing the main workload VU limit or generator CPU/memory budget. Scenario fingerprints distinguish these runs, and the zero-drop gate is unchanged.

The fixture prepares 102 separate user/operator session pairs because [k6 VU IDs are instance-wide](https://grafana.com/docs/k6/latest/javascript-api/k6-execution/). Mapping wraps are forbidden, so another scenario cannot accidentally share a rotating token family. Complete measured duration and separate main/authentication iteration counters are mandatory. The four-hour gate requires at least 720,000 **main** iterations; authentication probes cannot fill that count. An interrupted run remains failed evidence.

Refresh scheduling starts from the prepared token's actual issuance time, not the first activation of a VU. This preserves the staggered twelve-minute refresh cadence when a reserved VU starts late. The server still verifies token signatures, expiry, ownership and authoritative session state. The short pre-correction soak is retained as interrupted evidence.

Keep the Docker host available for the complete measured interval. A host/session restart ends that run; saved progress is partial evidence, not a completed k6 summary or durable-effect reconciliation. Do not combine separate interrupted runs into a four-hour result. Restart the isolated profile with a new run ID and retain the interrupted report in the diagnostic inventory.

On Windows, `verify.ps1` requires external power for a suite containing the soak and holds a scoped system-execution request until its `finally` block restores the previous thread state. This uses [SetThreadExecutionState](https://learn.microsoft.com/en-us/windows/desktop/api/winbase/nf-winbase-setthreadexecutionstate). Keep external power connected for the full interval; explicit sleep/shutdown still interrupts the measurement. A retained failed run includes a battery-sleep event, traffic interruption and subsequent protected-request errors.

Calculate connection limits before raising task maximums:

```powershell
node scripts/local/pool-budget.mjs --apiTasks=4 --apiWorkers=1 --workerTasks=1 --relayTasks=1 --members=1
```

The default estimate is 57 per-server sockets and a 72-socket minimum with 20% reserve. These are configured upper bounds, not observed connections. Include deployment overlap, monitoring sockets per member, maximum worker count and provider per-server limits. Autoscaling cannot fix an exhausted database.

For a measured per-replica sustainable rate `S` and total declared traffic `R`, required replicas are `ceil(R / (S * utilization_target))`. Surviving capacity after the largest AZ loss is surviving replicas times `S`, adjusted for the declared reserve. No values for `S`, real AZ loss, cloud scale-out delay or cloud maximum load are claimed until those experiments run.

Reports must retain image/source, dataset hash, cache state, limits, client p95/p99, achieved arrival rate, drops, HTTP results, write/job reconciliation and generator saturation. Use client latency and combined histogram buckets, never average replica p95 values. Docker samples include supervisor memory that worker RSS excludes.

The local Mongo shell health probe shares the database container's one-CPU budget. Steady probes now run every 30 seconds with faster startup probes; the former three/five-second intervals consumed avoidable test resources. Mixed reports record the actual database limits and health interval. Application primary/session readiness checks remain bounded on every protected operation. Keep earlier runs as different environment configurations.
