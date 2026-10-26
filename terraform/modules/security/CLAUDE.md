# Security module

Inherit the repository baseline and `terraform/CLAUDE.md`. This module owns
shared identity, encryption, secrets and governance permissions.

## Contract and ownership

- Inputs include domain/subdomain names, the shared hosted zone ID,
  `project_prefix`, `lambda_src_dir`, callback URL and `devenv_enabled`.
- Outputs expose Cognito pool/browser/public CLI client IDs, KMS references,
  the task permission boundary, dashboard EC2 instance profile/ECR repository,
  department-budget table, NextAuth SSM parameter ARN and certificates.
- `cloudfront_secret_value` and `nextauth_secret_value` are sensitive outputs.
  Never include their values in logs, documentation or review context.
- This module owns the dashboard ECR repository. Bootstrap it before pushing
  an immutable dashboard image; consuming modules must not recreate it.

## Change constraints

The boundary combines account-scoped `AllowInAccount`, operational allows and
the 63-pattern `DenyEscalation` floor. Embedding inference remains an operational
allow. Source-floor parity alone does not prove planned or deployed permissions.

Keep Cognito self signup disabled and app-client writable attributes restricted.
The post-confirmation/post-authentication shim is wired here; its downstream
UserRoleProvisioner, EventBridge rule and DLQ remain outside current Terraform.
`devenv_enabled = false` gates DevEnv certificates and dashboard permissions.
`lambda_src_dir` points to root `lambda/`.

## Validation

From the repository root:

```bash
terraform -chdir=terraform fmt -check modules/security
python3 -m pytest tests/unit/test_bedrock_iam_codex_parity.py -q
```

The test checks offline source parity. Semantic validation requires the
initialized Terraform root; it does not inspect deployed policies.
