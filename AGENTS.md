<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 00aa468fc6c8 · generated-at: 2026-10-26 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> Shared external-review context, distilled from canonical CLAUDE.md.

## Authoritative context

Read `docs/decisions/BASELINE.md`, `docs/architecture.md` and the relevant
scope's `CLAUDE.md`. `docs/history/` and archived decisions are historical.
Source presence and dated operational reports do not establish deployment.

## Stack and profiles

- Terraform is the only IaC (>=1.7; S3 lockfiles need >=1.10). Lambda source is
  root `lambda/`, packaged with `archive_file`; infrastructure is in `terraform/`.
- Default `deployment_mode="governance"` serves the dashboard/local installer.
  `devenv` adds per-user ARM64 EC2, nginx Fargate, OTEL and lifecycle schedules.
  Deprecated `governance_only` overrides the mode; an unset mode with existing
  DevEnv SGs fails planning rather than silently deleting environments.
- Dashboard code is `shared/nextjs-app/`: Next.js App Router, TypeScript,
  Tailwind/Recharts, Cognito and NextAuth. It runs a Docker container on EC2 ASG.
- DevEnvs support Ubuntu/AL2023. Persistent `/home/coder` data is on separate
  GP3 EBS, rediscovered/reattached by stored identity or canonical subdomain tags.
  Do not change data deletion behavior to resolve documentation drift.
- Claude Code and Codex share Bedrock usage/budget governance. Codex uses only
  `amazon-bedrock-runtime` Responses and role attribution, not application
  inference profiles. Kiro subscription licensing is outside that control path.
- Usage is invocation-log based; native Claude Code OTEL supplies productivity
  signals. Do not conflate telemetry with authoritative billing.

## Ownership, portability and security

- Take existing VPC/subnet IDs and a shared public Route 53 zone as inputs; do
  not add VPC/NAT/IGW ownership. Load balancers are internal behind CloudFront
  VPC origins with origin SG restrictions. DevEnv nginx also validates
  `X-Custom-Secret`; the dashboard sends it but has no listener validation.
- No public compute IP/ingress, hardcoded deployment account/domain/region or
  new CDK/CloudFormation path. Preserve open/restricted/locked DLP policies.
- Cognito self-signup stays off. Extra user IAM permissions require admin
  approval and the Terraform-authored boundary. Roles belong in their consuming
  modules; use outputs/data sources/SSM for shared references.
- Secrets belong in Secrets Manager or SecureString SSM, never review examples
  or logs. Configuration uses deployment inputs rather than embedded values.
- Preserve persistent data through termination/redeploy. Review actual root
  lifecycle settings against the explicit discrepancy recorded in the baseline.
- AgentCore helpers and event-driven provisioner wiring have known Terraform
  ownership/implementation gaps; see scoped instructions. They are not a
  supported parallel infrastructure deployment standard.

## Validation

Choose relevant checks and report what actually ran and missing prerequisites:

```bash
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform validate
(cd shared/nextjs-app && npx tsc --noEmit)
(cd shared/nextjs-app && npx vitest run)
bash tests/run-all.sh
bash -n tools/cc-bedrock-local.sh
```

Terraform validate requires initialization; aggregate tests require Python
pytest and dashboard dependencies. Live integration/container checks require
the corresponding environment. The full E2E/Docker `all` paths still reference
removed LiteLLM; use relevant explicit targets and disclose that limitation.

## Review and documentation

New/substantially rewritten docs/comments and review output use English
(ADR-013); conversation and product UI may be Korean. Use conventional commits.
Update architecture/scoped docs when their contracts change. Real new decisions
use the next ADR number (currently 016) and update BASELINE in the same change.
Do not reuse retired numbers or manually edit this generated file.
