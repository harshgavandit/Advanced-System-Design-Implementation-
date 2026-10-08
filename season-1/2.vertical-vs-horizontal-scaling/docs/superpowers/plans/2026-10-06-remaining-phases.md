# Remaining-phase delivery plan

Continue the existing Phase 0 foundation and in-progress implementation without discarding local changes. Canonical backend: Express. Work stays in this topic, with the existing three narrowly scoped root GitHub workflows.

1. Verify the security/container/horizontal/outbox implementations against their existing regression suites. Keep source-bound image identity and explicit unsupported comparison capabilities.
2. Run gates sequentially: static, contracts, built image durability, security/SBOM, mocked Terraform, then operational recovery/rollback/mixed smoke. Performance measurements must not overlap installers, builds or other load generators.
3. Reject local-only, incomplete, overlapping or failed staging evidence during production promotion. Preserve absolute and relative latency gates; require three consecutive complete five-minute windows.
4. Add a Windows-native sequential verification wrapper and an evidence inventory that separates passed, failed, missing, historical and unbound proof. Exclude credential fixtures, keys, database archives and scanner caches from public evidence.
   Include an exact-image runtime suite, preserve telemetry overlays during replica replacement, bind visible browser proof to the serving artifact, and test repeated gateway failover independently.
5. Add architecture, security, capacity, cost, cloud deployment, incident/recovery, ADR and demo guides with actual runnable commands and explicit ownership gaps.
6. Run supported load, stress, spike and a full four-hour soak with persistent-effect reconciliation. Preserve failed runs; do not lower correctness or latency thresholds to obtain a passing report.
7. Regenerate the phase inventory and record remaining cloud exit gates. The user confirmed no cloud setup exists. No AWS apply, registry publication, external notification or real-user deployment is executable until that setup exists.

The user authorized writes to isolated synthetic test databases and test-owned container lifecycle on this turn. Existing data and unrelated services remain outside that authorization.
