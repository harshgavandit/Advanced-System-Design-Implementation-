# Incident and recovery runbooks

These procedures apply to the canonical Express service. Assign a primary and backup incident owner before cloud deployment. The local owner label is a demo role, not a human paging assignment.

## First response

Record UTC start, environment, affected routes, current image/source, release ID, request/trace IDs and scope. Read readiness, edge error/latency, direct-replica saturation, Mongo pool wait, cache fallback, outbox age and queue/DLQ state. Preserve redacted evidence before changing configuration. Compare client/edge/app counts; a quiet graph with missing targets is not healthy traffic.

## Application rollback

1. Stop promotion when startup, ownership, business-content or SLO gates fail. Do not reuse a failed staging report.
2. Restore captured previous task definitions for changed roles in reverse order. `scripts/operations/deploy.mjs` performs this and waits for readiness; failed restoration remains a failed incident outcome.
3. Verify two-user catalog/cart/wishlist, revocation and durable ingestion with synthetic credentials. An HTTP-ready process alone is insufficient.
4. Preserve image digests, timeline and rollback failures. Do not run destructive schema contraction until the rollback window has expired.

Rollback reports retain both the original release failure and any separate readiness/restored-journey errors. The local proxy fixture closes keep-alive connections across nginx reloads, so a pooled client does not reuse a retiring worker socket. This fixture detail does not establish cloud load-balancer behavior.

Rehearse with `node tests/operations/recovery.mjs --profile=smoke`. The local drill injects startup and ready-but-wrong-business faults into owned fixtures. The recovery runner supplies two users and a synthetic operator, so the previous-version journey verifies cart/wishlist replay, ownership, revocation and durable ingestion before and after rollback. Standalone catalog-only or two-user-only runs retain their narrower `journeyScope`. This is a local proxy drill; cloud rollback requires its own acceptance. The default local previous/candidate image may be identical; set `ROLLBACK_PREVIOUS_IMAGE` to an actual known compatible earlier local image and inspect `crossVersion` before claiming version compatibility.

## Mongo primary loss or unavailability

Check primary topology, election timeline and bounded pool/selection failures. Protected requests must fail closed; no successful mutation/202 is allowed without the authoritative commit. Retry ambiguous writes using their original idempotency keys, never fresh keys. Reconcile receipts, effects and accepted jobs before declaring recovery. A one-member local replica set cannot prove real primary election or AZ failover.

## Redis failure

Keep session authorization on Mongo. Public catalog misses use bounded fallback and may return controlled 503 when the read budget is exhausted. Compare fallback rate, Mongo wait/latency and connection budget before changing concurrency. Recover Redis, validate namespace invalidation and the maximum 30-second catalog staleness bound. Do not cache private requests to conceal overload.

## Queue outage, poison messages and redrive

Check committed accepted jobs versus outbox rows and transport visibility. A queue outage retains accepted work in Mongo. Admission limits must bound backlog growth. After transport recovery, verify each acknowledged job reaches a terminal state and has one product effect.

Investigate DLQ cause and attempt/generation history before redrive. Correct the durable cause, use the authorized audited job redrive route, and reconcile its single new generation/effect. Never purge a queue or repeatedly redrive a poison message as routine cleanup. Source visibility is 60 seconds, maximum receives five, source retention four days and DLQ retention fourteen days. The local emulator does not prove AWS retention enforcement.

## Corruption or database restore

1. Establish the last safe recovery point and preserve the corrupted cluster for investigation. Restore into a new isolated cluster with separate credentials, never overwrite the active database.
2. Pause affected consumers and new writes. Authenticate backup material before any restore writes. Keep encryption keys separate and recover them through the restricted operational channel.
3. Verify schema ledger, checksum and indexes, counts and sampled content, owner relationships, session policy and complete synthetic journeys.
4. Reconcile jobs/outbox and transport against the restored cutoff. Messages newer than the restored DB are not automatically valid. Preserve idempotency receipts for the supported replay window. Reapply account-deletion records where required.
5. Resume bounded relay/worker processing, verify every recoverable acknowledgement and record unrecoverable intervals. Publish measured RPO/RTO and limitations.

The local recovery script tests abrupt migration exit, lease expiry/resume, authenticated AES-256-GCM archive/oplog replay into a separate owned volume, complete durable-collection count/hash reconciliation and recovery of queued acknowledgements. It also runs the full two-user mutation, ownership, revocation and ingestion journey against the restored service before recording RTO. It measures one-host snapshot recovery; Atlas PIT and regional recovery remain separate drills.

Each workload writes a separate `recovery-<profile>.json` report as well as the latest `recovery.json`. Retain the full-soak recovery report when later smoke checks run, so its larger snapshot and reconciliation proof remain available.

## Credential compromise and region loss

Revoke affected sessions and short-lived cloud identities, rotate secrets through a restricted channel, roll tasks, review audit records and determine data exposure. Preserve evidence outside the compromised boundary. For region loss, recreate infrastructure from reviewed IaC and restore the safe backup/secret recovery set into the alternate region; separately measure its recovery objectives. No regional RTO is inherited from a local restore time.

## Cadence

Review service errors, queue age, DLQ and spend daily. Review dependencies, capacity and unresolved failed jobs weekly. Rehearse restore, access review and retention monthly initially. Every incident review records trigger, customer/data impact, detected versus actual start, mitigation, measured restore time, contributing cause and owned follow-up date.
