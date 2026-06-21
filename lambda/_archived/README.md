# Archived Lambdas

Lambdas in this directory are no longer wired into any CDK stack but kept in-tree for git history and reference.

## devenv-origin-router/

- **Archived:** 2026-05-12 (per ADR-016 Migration Plan Step 4)
- **Original purpose:** Lambda@Edge (origin-request) that routed `*.dev.{domain}` → NLB and everything else → ALB on the single unified CloudFront from ADR-013.
- **Why archived:** ADR-016 split the unified distribution into two CloudFronts (DevenvCf in Stack 04, DashboardCf in Stack 05). Each CF now has a single origin, so host-based origin selection is unnecessary.
- **Restoration path:** Re-introducing a unified CF would require this router. Refer to `cdk/lib/04-ecs-devenv-stack.ts` `DevenvCf` config to reconstruct the routing rules.
