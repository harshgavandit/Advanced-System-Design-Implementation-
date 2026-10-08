# Cloud provisioning, staging and promotion

Cloud execution is disabled. The user confirmed that no AWS setup exists. The repository provides a reviewable reference implementation; there is no deployed domain, cloud account, signed published release or measured AZ resilience to report.

## Required setup

Record an incident owner, account ID, region, two AZs, domain/Route 53 zone, Atlas project, GitHub repository, OIDC provider, confirmed alert destination and monthly cost ceiling. Examples use `ap-south-1`; choose the actual region before provisioning. Staging and production use separate networks, roles and remote-state keys. The current shared-release repository guard supports isolated environments in one account; cross-account promotion needs explicit policies and additional tests.

1. Configure `infra/terraform/bootstrap` with an actual encrypted/versioned S3 state bucket and KMS/locking settings. State and plan files can contain secret material; restrict access and never upload them as public evidence.
2. Copy the appropriate `infra/terraform/environments/<environment>/*.example` into private local configuration. Supply Atlas passwords and Redis credentials out of band through the provider/`TF_VAR_` chain. Supply secret ARNs for runtime Mongo, migration Mongo, signing keys and Redis. Do not put secret values in GitHub variables.
3. Validate without provisioning using `node scripts/ci/run.mjs --stage=terraform`. This invokes pinned Terraform in Docker, schema validation and mocked provider assertions. It never substitutes a real apply for failed mocks.
4. Bootstrap the platform only after reviewing actual identities, costs and the saved plan. Use the exact tested immutable release digest. Resolve initial ECR/secret/Atlas endpoint setup deliberately; do not feed placeholder digests into a live service.
5. Run the migrations with the migration identity before API rollout; runtime roles cannot create production indexes. Check private Atlas DNS/routes, Redis TLS, SQS permissions and log/trace transport. Require a second plan with no unexpected drift.

For a configured environment, Terraform commands are executed from `infra/terraform/platform`:

```text
terraform init -backend-config=../environments/staging/backend.hcl
terraform plan -var-file=../environments/staging/settings.tfvars -out=<restricted-plan-path>
terraform apply <reviewed-plan-path>
terraform output -json release_target
```

The `release_target` output starts with `enabled=false` and an unset measured latency baseline. Fill the actual values and enable execution only after acceptance configuration exists. Application tasks have private networking; only the HTTPS ALB accepts public application traffic. Atlas backup/PIT configuration must be verified on the actual purchased tier.

## GitHub configuration

Set the required check to **Scaling required checks**. PR CI reports success for unrelated paths and runs topic gates for relevant changes. Release only runs after successful trusted main CI and rejects stale main commits. The test image archive, SBOM, scan, Terraform and operations evidence flow from that same CI run.

| Scope | Name | Value |
|---|---|---|
| Repository variable | `SCALING_CLOUD_ENABLED` | `true` only when cloud setup is complete |
| Release/staging/production environment variables | `AWS_REGION`, `AWS_ACCOUNT_ID` | Actual target account/region |
| Release environment variable | `SCALING_RELEASE_ROLE_ARN` | Exact protected release OIDC role |
| Staging/production environment variable | `SCALING_DEPLOY_ROLE_ARN` | Separate deploy OIDC role |
| Environment variable | `SCALING_CLOUD_TARGET_JSON` | Configured target, HTTPS URL, measured baseline and private migration placement |
| Staging/production environment secret | `SCALING_SYNTHETIC_JOURNEY_JSON` | Two dedicated synthetic users and pre-authorized synthetic admin credentials |

Protect the release, staging and production GitHub environments; production requires the human deployment approval configured by its owner. Pin and review Actions. Untrusted PRs receive no cloud roles or deployment credentials.

Dispatch **Scaling digest promotion** for staging with the signed release run ID. The script verifies the signature and source attestation, runs migrations, preserves previous API/worker/relay task revisions, rolls each service, validates the complete business journey and observes three consecutive five-minute SLO windows. Missing/invalid telemetry cannot pass. Startup, business or SLO failure triggers reverse-order rollback to captured task revisions. Restoration is successful only after the previous version passes the complete synthetic business journey again; readiness alone cannot mark the incident recovered.

Dispatch production using the same signed release run ID and the successful staging run ID. The gate now requires `cloud=true`, a successful business journey, a positive measured baseline, three consecutive non-overlapping passing windows and matching source/digest. Local restore/rollback evidence cannot substitute for deployed staging acceptance.

## Cloud exit gates still requiring execution

Real HTTPS/DNS/certificate behavior; private dependency reachability; confirmed incident notification; signed publication and OIDC use; measured task scale-out/scale-in; previous-version rollback; Atlas PIT restore; queue-versus-recovery-point reconciliation; sustained mixed workload; actual lost-AZ capacity; a complete operating SLO window. Each gate needs a named owner and timestamped artifact before launch.
