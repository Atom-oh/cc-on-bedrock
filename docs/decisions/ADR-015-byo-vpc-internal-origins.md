---
status: Accepted
date: 2026-10-21
verification_required: true
runtime_required: false
related: [ADR-001, ADR-003, ADR-009]
builds_on: ADR-003
---

# ADR-015: Existing VPC and internal load balancers behind CloudFront VPC origins

## Status

Accepted on 2026-10-21. It was deployed with a full destroy of the previous stack and a fresh
apply into an existing shared VPC. After the deploy, `terraform plan` reports no changes,
the dashboard and DevEnv are reachable through CloudFront, and every LB target is healthy.

## Context

The network module created its own VPC, subnets, NAT/IGW and gateway endpoints, and it
managed the public Route 53 zone `domain_name` as a resource. The dashboard ALB and the
DevEnv NLB were internet-facing and admitted the CloudFront prefix list. That conflicts
with the account policy:
- deploy into an existing VPC and never create one;
- do not use internet-facing load balancers;
- expose services publicly only through CloudFront → **internal** LB via a CloudFront VPC origin.

The apex zone also carries records for other projects, so this stack must not own it.
Because the VPC is shared with other workloads, a security-group rule that trusts the
VPC CIDR trusts those workloads too.

## Decision

1. **Bring your own VPC.**
   - Terraform takes `vpc_id`, `public_subnet_ids`, `private_subnet_ids` (two AZs or more,
     enforced by a precondition) and `isolated_subnet_ids` from tfvars. It never declares
     `aws_vpc`, subnets, NAT/IGW or gateway endpoints.
   - It creates only the interface endpoints the VPC lacks (`interface_endpoint_services`).
   - It looks up the public zone with a data source. A `removed { destroy = false }` block
     makes older states forget the zone resource instead of destroying it.
2. **Internal origins.**
   - The dashboard ALB (HTTPS) and the DevEnv NLB (HTTP) are `internal = true` in the
     private subnets, each reached by an `aws_cloudfront_vpc_origin`.
   - Each LB security group admits only the managed `CloudFront-VPCOrigins-Service-SG`.
   - nginx admits only the NLB security group.
3. **No VPC-CIDR trust.**
   - Locked DevEnv 443 egress targets only interface-endpoint security groups (this
     stack's and `existing_vpc_endpoint_security_group_ids`). A precondition requires at
     least one of them.
   - Each OTEL collector NLB has its own security group, which admits 4318 only from the
     open, restricted and locked DevEnv security groups.
   - Each collector task admits only its NLB.

## Consequences

- **Positive:**
  - No public listener or public IP on any LB or compute resource.
  - The stack no longer owns shared network or DNS.
  - Other workloads in the VPC cannot reach DevEnv-only services.
- **Negative:**
  - Moving an existing deployment is a destroy and fresh apply, not an in-place upgrade. LB
    scheme changes, endpoint re-keying and the new OTEL NLB security group all force
    replacement, and running DevEnvs keep the old collector DNS name in `/etc/environment`.
  - Terraform ≥ 1.7 is required for `removed` blocks.
- **Mitigations:**
  - The migration steps are in `terraform/CLAUDE.md`: back up state, `state rm` the shared
    zone and any repositories to keep, destroy, then apply with the new tfvars.
  - Users re-launch their DevEnvs after the migration.

## Verification

```yaml
files:
  - path: terraform/modules/network/main.tf
    must_contain:
      - "data \"aws_vpc\" \"this\""
      - "removed {"
    must_not_contain:
      - "resource \"aws_vpc\""
  - path: terraform/modules/dashboard/main.tf
    must_contain:
      - "aws_cloudfront_vpc_origin"
      - "internal           = true"
  - path: terraform/modules/ecs-devenv/main.tf
    must_contain:
      - "aws_cloudfront_vpc_origin"
  - path: terraform/modules/ec2-devenv/main.tf
    must_contain:
      - "security_groups = var.vpc_endpoint_security_group_ids"
```
