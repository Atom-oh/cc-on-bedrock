# WAF module

Inherit the repository baseline and `terraform/CLAUDE.md`. This module produces
a CloudFront-scope WebACL; consumers own distribution associations.

## Contract and ownership

- Inputs: `project_prefix`, `rate_limit_per_5m`.
- Outputs: `web_acl_arn`, `web_acl_id`.
- Root supplies the `aws.us_east_1` provider alias.
- Default action is allow, with AWS Common, KnownBadInputs and SQLi managed rule
  groups plus per-IP rate blocking.

## Change constraints

Root currently passes this ACL only to `ecs-devenv`. The dashboard module has no
WAF association; the `governance` profile can create an unassociated WebACL.
Do not describe the ACL as authentication, DLP or universal distribution
coverage. Inspect consuming modules when changing rules or associations.

## Validation

From the repository root:

```bash
terraform -chdir=terraform fmt -check modules/waf
```

Formatting does not validate rule behavior. Semantic Terraform validation
requires the initialized root; child modules are not independent deployments.
