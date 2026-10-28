# Usage tracking module

Inherit the repository baseline and `terraform/CLAUDE.md`. Usage, USD budget
enforcement and audit resources remain deployed in both profiles; the native
collector and EC2 schedules depend on `devenv_enabled`.

## Contract and ownership

- Inputs include project/KMS/Cognito references, department-budget table,
  permission-boundary name, USD caps and root `lambda_src_dir`; optional
  DevEnv inputs supply private network, routing and instance-table references.
- Outputs expose usage-table name/ARN/stream, supporting budget/approval/audit
  tables, alert topic, tracker Lambda and native collector/raw-bucket references.
- Invocation-log identity filtering covers platform EC2/local IAM roles.
  Canonical user rows use `USER#lowercase-email`; Codex uses role attribution
  because application inference profiles are unsupported.
- The audit EventBridge path is distinct and account-wide.

## Change constraints

USD budget windows use UTC; normalized-token periods use KST. Keep model rates
and weights aligned with root Lambda sources. DynamoDB/S3-consuming Lambda roles
need CMK permissions.

Native telemetry writes `otlp-metrics/` and scrubbed `otlp-logs/`. Rollup packaging
must include both `otel-metrics-rollup.py` and `otel_rollup.py`; `OTELOBJ#` markers
and transactions enforce idempotence. Collector output is bare `DNS:4318` or
empty, exposed at root as `otel_rollup_collector_endpoint`. The legacy ECS
collector has a different endpoint contract. Root owns collector ingress wiring.

Protected tables/raw storage use `prevent_destroy`; raw storage and rollup
remain even when the collector is absent. Review teardown plans accordingly.

## Validation

From the repository root:

```bash
terraform -chdir=terraform fmt -check modules/usage-tracking
python3 -m pytest tests/unit/test_terraform_otel.py tests/unit/test_otel_collector_config.py -q
```

These are offline source checks. Terraform semantic validation requires the
initialized root; collector delivery and live enforcement need separate checks.
