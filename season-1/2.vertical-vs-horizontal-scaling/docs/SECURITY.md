# Security and trust boundaries

| Boundary | Control | Regression evidence |
|---|---|---|
| Public client to API | Field/body limits, CORS allowlist, request IDs, shared auth quotas, generic errors | Canonical contract/security suite |
| Client concurrency to dependency work | Per-process response admission before parsing/auth, no wait queue, Retry-After, independent pool/query/socket bounds | Real HTTP finish/disconnect tests and owned Mongo-stall containment |
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

Admission is a resource bulkhead, not an identity/IP rate limiter. Do not enable unrestricted proxy trust to work around shared gateway-IP quotas. Keep forwarded headers untrusted until an explicit trusted-edge model and spoofing tests exist. The local learning Grafana viewer and unauthenticated internal Mongo/Redis/queue are isolated behind an internal Docker network and loopback publication; do not publish those service ports to a LAN or treat that lab configuration as public deployment security.

The October 8 fresh scan of source `cb8b379892bafa4273a69309b695ef4abc163f77aa8f26533a98f516baed2920` passed the existing High/Critical gate with no exceptions. It is not vulnerability-free: the report contains 11 Medium, three Low and 12 Unknown-severity package/advisory matches. Matches can repeat across libc packages or advisory aliases and are not a unique-vulnerability count. Current affected packages include the pinned glibc runtime and transitive `fast-uri`/`brace-expansion`; the scanner reports available fixed versions. Review reachability and compatible patched versions, update the frozen package/runtime locks, then rebuild and repeat exact-image tests/scans before public exposure. Unknown severity is not a safe classification. Raw identity, SBOM and findings remain in ignored `infra/compose/artifacts/ci/`; an old clean threshold result never authorizes a changed image.

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

The November 2, 2026 investigation first exposed a Mongo/kernel startup issue.
After fixing startup, the fresh exact-image scan also blocked Node 24.21.0
(`CVE-2026-105482`, `CVE-2026-105483`, `CVE-2026-106069`) and the certificate
bundle (`CVE-2026-91403`). The runtime now pins Node `24.22.1-r0`, c-ares
`1.34.9-r0` and `ca-certificates-bundle=20260909-r3`. Build/telemetry images and
the scaling workflows use Node 24.22.1 as well. See the
[upstream Node security release](https://nodejs.org/en/blog/release/v24.22.1).
Keep real certificate-verified HTTPS, native codec/bcrypt, exact installed
package provenance and the current advisory-database scan as blocking gates.
No automatic vulnerability exception or severity downgrade is permitted.
