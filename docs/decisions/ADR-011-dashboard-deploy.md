---
status: Accepted
date: 2026-06-24
consolidates: [ADR-017]
---

# 011: 대시보드 배포 (EC2 ASG + Docker)

## Status

Accepted (2026-06-24)

## Context

Dashboard deployment moved from the removed CDK/ECS path to the Terraform-only
`terraform/modules/dashboard/` module. The dashboard must run the real Next.js
standalone app, not a placeholder server, and deployment changes must be
observable by Terraform so an instance refresh can roll the ASG.

The prior ECS rolling-deployment ADR remains consolidated here as history. The
current SSOT for topology is `../architecture.md`.

## Decision

Deploy the dashboard as a Docker container on an EC2 Auto Scaling Group behind
CloudFront and an ALB.

- Terraform creates the dashboard ECR repository in `modules/security` and
  passes the repository URL to `modules/dashboard`.
- `dashboard_image_tag` is injected into launch template user data. Operators
  should set it to an immutable build tag or commit SHA for deterministic
  rollouts; changing it creates a new launch template version and triggers ASG
  instance refresh.
- `NEXTAUTH_SECRET` is not embedded in user data. The dashboard instance role
  reads the existing SSM parameter at boot and writes the process env file on
  the instance.
- DevEnv SSO still lets Lambda@Edge validate the dashboard session cookie, but
  the edge validator strips NextAuth cookies before forwarding requests to
  per-user DevEnv origins.
- The dashboard container uses bounded Docker json-file logs and ECR pull retry
  to reduce boot flakiness and disk exhaustion risk.

## Consequences

Positive:
- Terraform owns the dashboard image repository and instance refresh trigger.
- Deployments can be made deterministic by changing `dashboard_image_tag`.
- The NextAuth signing secret is no longer present in launch template user data.
- User-controlled DevEnv origins do not receive dashboard NextAuth cookies.

Negative / risks:
- ASG rollback semantics are coarser than ECS deployment circuit breakers; failed
  app boots rely on ALB health checks plus ASG instance refresh behavior.
- `dashboard_image_tag = "latest"` remains the compatibility default, but
  production rollouts should use immutable tags.

## Consolidates

- **ADR-017** (Dashboard ECS rolling deployment + circuit breaker)

Legacy bodies live in git tag `adr-legacy-2026-06-23` and
`../history/ADR-MAPPING.md`. 번호 재사용 금지.
