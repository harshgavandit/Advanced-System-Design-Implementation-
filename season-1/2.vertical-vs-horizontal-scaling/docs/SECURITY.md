# Security and trust boundaries

| Boundary | Control | Regression evidence |
|---|---|---|
| Public client to API | Field/body limits, CORS allowlist, request IDs, shared auth quotas, generic errors | Canonical contract/security suite |
| Token to authority | Issuer/audience/algorithm/key ID validation; hashed refresh tokens; authoritative session reads | Refresh races, completed revocation and authority-loss checks |
| Principal to private record | Ownership in every cart, wishlist and job query | Two-user reads and writes |
| Principal to administrator operation | Trusted database role; signup/profile cannot assign roles | Forbidden public product mutations and ingestion |
| Catalog cache to private data | Public allowlist, Authorization/Cookie bypass, proxy cache disabled | Two-user proxy test and outage checks |
| Queue to committed state | Versioned message validation, leased processing, transaction and idempotency indexes | Crash-before/after-effect and duplicate-delivery drills |
| GitHub to AWS | Protected environments and exact OIDC trust; separate release/deploy roles | Mocked Terraform and workflow policy checks |
| Telemetry to private information | Redaction, bounded labels, route templates and validated trace/request context | Redaction tests, trace/log payload checks |

`JWT_KEY_ID` and previous-key variables support controlled key overlap. Rotate access and refresh keys together through a separately approved secret-manager version, roll serving tasks, validate both versions during the short overlap, then retire the previous key. A credential-compromise response also revokes affected sessions; changing a signing key alone does not reconcile stolen data or audit events.

Admin changes, mutation receipts, token-family revocations and redrives produce restricted audit records. Do not add public audit endpoints. Production account deletion/export, retention and reapplication of deletion records after restore require a named owner and operational policy before onboarding real users.

Local `.env` files, generated keys, `sessions.json`, backups, backup keys and scanner working directories are private ignored artifacts. Share only the generated allowlisted report inventory and selected screenshots. Redacted secret scans, workflow lint, static security rules, SBOM and image vulnerability checks are blocking CI gates. A scan for an older image cannot authorize publication of a rebuilt image.

Open operational gates: a human incident owner, confirmed notification destination, secret rotation rehearsal, HTTPS staging acceptance and real access review. The local alert webhook records delivery but does not page a human operator.

## Scheduled dependency failures

Scheduled CI scans the frozen image against the current advisory database, so
new advisories can fail an unchanged commit. Do not disable the High/Critical
gate, add automatic exceptions, or reuse a previous image's scan to make it
green. Inspect the uploaded `image-vulnerabilities.json`, patch the affected
runtime/package locks, rebuild, and run contracts, durability, operations and
the exact-image scan again.

The October 26, 2026 failure identified Brotli `1.2.0-r5`
(`CVE-2026-111497`), Express's `body-parser` `2.3.0`
([compressed-body process crash](https://github.com/advisories/GHSA-27r3-jxmh-p828))
and Zod `4.5.4`
([collection validation resource exhaustion](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)).
Runtime Brotli is pinned to `1.2.0-r7`, the resolved parser to `2.4.0`, and Zod
to `4.6.7`. A subprocess regression checks that a gzip JSON body with trailing
garbage cannot terminate the resolved Express parser, and that ordinary gzip
JSON and subsequent health requests still work. Frozen installation and the
image's installed-package provenance check remain mandatory.
