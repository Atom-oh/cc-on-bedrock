# Terraform-Only Governed Bedrock Platform Design

## Context

The project is a governed development platform for Claude Code on Bedrock first, with Codex on Bedrock as a later extension. Kiro remains a default tool but uses IAM Identity Center subscription licensing, so it is not part of Cognito-based Bedrock API usage governance.

The canonical runtime modes are:

- EC2 Mode: NLB -> nginx on ECS -> per-user EC2 DevEnv
- Local Mode: `cc-bedrock-local` -> Cognito public client -> Dashboard `/api/local/credentials` -> STS issuer

Terraform is the only active IaC surface. CDK and CloudFormation are removed after their Lambda sources and tests are moved to neutral repository paths.

## Decisions

1. Lambda source lives in `lambda/`, not under an IaC implementation directory.
2. Terraform root wires governance modules directly: `usage-tracking`, `local-governance`, and WAF.
3. EC2 and Local do not share one literal IAM role. They share Bedrock policy shape, permission boundary, tags, and Bedrock Application Inference Profile attribution.
4. Local Mode uses OAuth-like renewal through Cognito refresh tokens and AWS SDK `credential_process`. STS credentials stay 1h because role chaining is hard-capped by AWS.
5. code-server stays on port `8080`; custom app routes must not claim that port.
6. OTEL is a first-class implementation axis for lightweight EC2 productivity metrics. EC2 instances emit Claude session start/end, 5-minute active heartbeat, and successful git commit/push events to an OTEL Collector endpoint; token/cost remains in the Bedrock usage pipeline.
7. Bedrock token usage is sourced from Bedrock Invocation Logs and Application Inference Profiles, aggregated into DynamoDB.

## Non-Goals

- Codex on Bedrock runtime parity in this pass.
- Kiro budget enforcement.
- Longer-than-1h STS sessions for chained local roles.

## Cleanup Rule

Any active deployment, test, or setup path must refer to Terraform, `lambda/`, and `cc-bedrock-local`. Historical ADRs and archived review notes may mention CDK or CloudFormation as past context, but they are not deployment instructions.
