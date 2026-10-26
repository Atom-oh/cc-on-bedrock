# Local governance module

Inherit the repository baseline and `terraform/CLAUDE.md`. This module remains
deployed in both profiles and governs local one-hour STS credentials and
normalized-token limits.

## Contract and ownership

- Inputs include project/KMS references, the usage-table stream, permission
  boundary ARN/name and root `lambda_src_dir`.
- Outputs expose limits-table name/ARN, STS issuer function name/ARN/URL
  and the alert topic.
- Own the encrypted PK/SK limits table with TTL, PITR and `prevent_destroy`.
  The usage table belongs to usage-tracking.
- Package `sts-issuer.py` together with `role_factory.py`. Enforcer and reset
  handlers have separate packages.

## Change constraints

The issuer Function URL requires `AWS_IAM`. Dashboard performs browser/Cognito
public-client access-token validation before signing its invocation. Session
TTL/max TTL remain `3600`; CLI `credential_process` renews credentials.

Limits use `USER#email`, `LIMIT#period`, `COUNTER#period#bucket` and `DENY#active`.
IAM role suffixes use separately validated subdomains. Preserve policy name
`cc-bedrock-local-token-deny`, KST token periods and tracker weight parity.
Keep Local and EC2 roles separate under common attribution/boundary rules.

Lazy role creation repairs local issuance. This module does not define the
downstream UserRoleProvisioner/EventBridge/DLQ resources. Cognito account disable
alone does not revoke existing dashboard sessions or guarantee issuance stops.

## Validation

From the repository root:

```bash
terraform -chdir=terraform fmt -check modules/local-governance
python3 -m pytest lambda/__tests__/test_role_factory.py lambda/__tests__/test_enforcer_email.py lambda/__tests__/test_limit_reset_email.py -q
```

Tests run offline. Semantic Terraform validation requires the initialized root.
