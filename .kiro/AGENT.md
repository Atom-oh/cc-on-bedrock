# CC-on-Bedrock — Kiro Context

The shared review context is [AGENTS.md](../AGENTS.md), generated from the
canonical [CLAUDE.md](../CLAUDE.md). Kiro loads it through
[steering/project-context.md](steering/project-context.md).

Read the [decision baseline](../docs/decisions/BASELINE.md),
[architecture](../docs/architecture.md), and the relevant directory's `CLAUDE.md`
before changing implementation. Historical ADRs and reports do not establish
current requirements.

- Terraform is the only deployment IaC; use existing VPC/subnet inputs and an S3 backend.
- Default `governance` deploys the dashboard and local installer. `devenv` adds
  per-user ARM64 EC2 environments, nginx routing and native Claude Code telemetry.
- The dashboard runs a Next.js container on an EC2 Auto Scaling group. CloudFront
  VPC origins protect internal load balancers.
- Claude Code and Codex share usage and budget governance. Codex uses the
  `amazon-bedrock-runtime` provider. Kiro uses IAM Identity Center licensing and
  remains outside the Cognito/Bedrock token-control path.
- Persistent `/home/coder` data volumes must survive termination and redeployment.
- New or substantially rewritten documentation/comments use English (ADR-013).
  Operator conversation and product UI may use Korean.

Use [deployment.md](docs/deployment.md) for the canonical deployment entry point;
use scoped instructions for validation commands. Do not maintain another copy of
model IDs, infrastructure definitions or security policy here.
