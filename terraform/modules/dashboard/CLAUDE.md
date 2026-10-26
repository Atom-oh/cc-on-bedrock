# Dashboard hosting module

Inherit the repository baseline and `terraform/CLAUDE.md`. Application/auth/API
code belongs in `shared/nextjs-app`; this module hosts its standalone Docker image
on private ARM64 EC2 Auto Scaling.

## Contract and ownership

- Inputs include VPC/private subnets, security-owned instance profile/ECR/regional
  certificate, immutable `dashboard_image_tag`, domain/zone/NextAuth SSM references,
  Cognito IDs, deployment mode and optional DevEnv references.
- Outputs: `dashboard_url`, `cloudfront_domain`,
  `cloudfront_distribution_id`, `alb_dns`.
- Own the EC2/ASG, internal HTTPS ALB and SGs, CloudFront VPC origin/distribution,
  `us-east-1` CloudFront certificate and dashboard DNS record.
- Consume security/network outputs; do not duplicate ECR, instance profile,
  regional certificate, secret or shared zone.

## Change constraints

Use immutable image tags. Launch-template `latest_version` drives rolling
instance refresh. Fetch the secret from SSM at boot into a mode-600 environment
file; never place secret values in user data. IMDSv2 hop limit 2 supports the
application container's role credentials.

ALB admits the CloudFront VPC-origin SG; EC2 port `3000` admits only ALB SG.
CloudFront sends `X-Custom-Secret`; the current listener has no additional
header-validation rule. This module has no WAF input/association. The DevEnv
router's WebACL does not cover this distribution.

Runtime receives deployment mode, Cognito IDs, Codex model ID and DevEnv
references. `/api/health` is public and shallow; it does not prove Bedrock access.

## Validation

From the repository root:

```bash
terraform -chdir=terraform fmt -check modules/dashboard
```

Formatting does not prove runtime readiness. Terraform semantic validation
requires the initialized root and application changes require scoped app checks.
