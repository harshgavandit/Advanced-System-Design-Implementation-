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
