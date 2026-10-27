# DevEnv access-plane module

Inherit the repository baseline and `terraform/CLAUDE.md`. Root includes this
module for the optional `devenv` profile.

## Contract and ownership

- Inputs include VPC/private subnet IDs, domain/certificate/zone references,
  KMS references, the CloudFront secret, NextAuth SSM parameter ARN,
  `lambda_src_dir` and `web_acl_arn`. Root supplies `aws.us_east_1`.
- Outputs expose the ECS cluster, CloudFront distribution, internal NLB,
  routing table, nginx ECR/config bucket/security group, user-data bucket
  and legacy collector endpoint/security group.
- Own nginx Fargate routing, the private NLB/CloudFront VPC origin,
  `cc-routing-table` (`subdomain` key), stream-driven nginx configuration
  and the published Lambda@Edge session validator.
- Own nginx ECR; import a helper-created repository before Terraform claims it.
  The repository has `prevent_destroy`.

## Change constraints

Preserve the CloudFront-origin SG → NLB SG → nginx SG trust chain and custom
origin header. Publish edge code in `us-east-1`, replace packaging placeholders
and associate a qualified version. Root owns cross-module collector SG rules
to avoid dependency cycles.

The collector here is the legacy `awsemf` path with an `http://` endpoint.
Native Claude Code rollup uses usage-tracking's separate collector, exposed at
root as `otel_rollup_collector_endpoint`. Compatibility subnet/host-type inputs
do not imply public routing or an EC2 nginx host. WAF attaches to this DevEnv
distribution through `web_acl_arn`.

## Validation

From the repository root:

```bash
terraform -chdir=terraform fmt -check modules/ecs-devenv
python3 -m pytest tests/unit/test_terraform_devenv_edge_auth.py -q
```

Tests inspect source/packaging contracts. Terraform semantic validation requires
the initialized root; no deployed edge or routing behavior is proven here.
