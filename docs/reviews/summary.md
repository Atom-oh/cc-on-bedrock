# Architecture Review Summary

> Generated: 2026-03-26 | Phase: initial | Reviewers: Codex, Kiro, Gemini

## Review Status

| LLM | Status | Findings |
|-----|--------|----------|
| Codex (gpt-5.4) | Completed | 9 issues |
| Kiro (kiro-cli 1.23.1) | Completed | 24 issues |
| Gemini (0.35.0) | Completed | 8 issues |
| Claude (Opus 4.6) | Completed | 11 issues |

---

## Critical Findings (Immediate Action Required)

### 1. Hardcoded AWS Account ID `061525506239`
**Severity**: Critical | **Found by**: Codex, Kiro

Production account ID embedded in 6+ files across CDK, Next.js, Lambda, and cdk.context.json.

| File | Details |
|------|---------|
| `cdk/cdk.context.json:2` | AZ lookup key contains account ID |
| `cdk/lib/05-dashboard-stack.ts:122` | S3 bucket path with account ID |
| `shared/nextjs-app/src/lib/aws-clients.ts:52` | Fallback account ID |
| `shared/nextjs-app/src/app/api/ai/runtime/route.ts:16` | Hardcoded ARN with account ID |
| `agent/lambda/create_targets.py:18` | Default ACCOUNT_ID |
| `agent/CLAUDE.md:30-41` | ECR URIs with account ID |

**Fix**: Replace with `cdk.Aws.ACCOUNT_ID`, `data.aws_caller_identity`, or runtime `sts get-caller-identity`. Add `cdk.context.json` to `.gitignore`.

### 2. Hardcoded Default Password `CcOnBedrock2026!`
**Severity**: Critical | **Found by**: Codex, Kiro

`aws-clients.ts:340` injects a known password for all code-server containers when `CODESERVER_PASSWORD` env var is unset.

**Fix**: Generate per-user random passwords via Secrets Manager or `openssl rand` at container start.

### 3. Unauthenticated Runtime API Endpoint
**Severity**: High | **Found by**: Codex

`route.ts:15-27` allows all requests when `RUNTIME_API_KEY` is unset, with hardcoded ARN/URL pointing at real Bedrock AgentCore environment.

**Fix**: Require API key authentication unconditionally. Remove hardcoded ARN/URL fallbacks.

---

## High Severity Findings

### 4. Wildcard IAM Permissions (Bedrock `Resource: *`)
**Found by**: Codex, Kiro

Multiple roles grant `bedrock:InvokeModel` on `Resource: *`, allowing invocation of any model. ECS Task Role correctly scopes to `anthropic.claude-*` but Instance Role, LiteLLM role, and Dashboard role do not.

**Fix**: Scope to `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`

### 5. CDK DevEnv ALB Publicly Reachable on HTTP
**Found by**: Codex, Kiro

ALB SG allows `0.0.0.0/0` on port 80 while CloudFront uses `HTTP_ONLY` origin. ALB is directly accessible bypassing CloudFront.

**Fix**: Remove `0.0.0.0/0:80` ingress. Restrict port 80 to CloudFront prefix list.

### 6. EFS Shared Root - Cross-User File Access
**Found by**: Codex, Kiro

Task definitions mount entire EFS at `/home/coder`. Entrypoint only creates subdirectories - no kernel-level isolation between users.

**Fix**: Use EFS Access Points with per-user `rootDirectory` and `posixUser` enforcement.

### 7. `unsafeUnwrap()` Exposes Secret in CFN Template
**Found by**: Kiro

`cdk/lib/05-dashboard-stack.ts:196` resolves secret at synth time, embedding plaintext in CloudFormation template.

**Fix**: Use `{{resolve:secretsmanager:...}}` dynamic references.

### 8. Dashboard IAM Role Too Broad
**Found by**: Codex, Kiro

Dashboard EC2 role has `Resource: *` for ECS, ELB, Bedrock, AgentCore, and CloudWatch actions.

**Fix**: Scope to specific cluster ARN and tagged resources.

### 9. Missing CloudFront Origin Secret Enforcement (DevEnv)
**Found by**: Gemini

DevEnv stack does not enforce `X-Custom-Secret` header on ALB, unlike Dashboard stack. Direct ALB access bypasses CloudFront.

**Fix**: Add ALB Listener Rule requiring `X-Custom-Secret` header, return 403 otherwise.

### 10. Hardcoded Domain `whchoi.net` and Prefix List `pl-22a6434b`
**Found by**: Kiro, Gemini

Real domain in CDK config defaults. CloudFront prefix list ID hardcoded (ap-northeast-2 specific).

**Fix**: Use `example.com` as default. Look up prefix list dynamically via `aws_ec2_managed_prefix_list`.

### 10. CloudFront Missing WAF and Custom Domain
**Found by**: Kiro

No WAF protection, no custom SSL certificate, using default `*.cloudfront.net` domain.

**Fix**: Attach ACM certificates with domain aliases. Associate WAF WebACL.

---

## Medium Severity Findings

| # | Issue | Found by |
|---|-------|----------|
| 11 | Dashboard TF module ALB SG `0.0.0.0/0:443` (CDK/CFN use prefix list) | Claude |
| 12 | DLP "Restricted" allows all HTTPS (`0.0.0.0/0:443`) | Codex, Kiro, Claude |
| 12 | Terraform exposes CloudFront secret in state | Codex, Kiro |
| 13 | Containers run as root (no `USER` directive) | Codex, Kiro |
| 14 | No HTTPS between ALB and ECS containers | Kiro |
| 15 | Cognito password policy missing symbol requirement | Kiro |
| 16 | RDS Single-AZ deployment | Kiro |
| 17 | Dashboard UserData embeds Cognito IDs | Kiro |
| 18 | Hardcoded AgentCore ARN/Gateway URL | Kiro |
| 19 | Hardcoded Region `ap-northeast-2` in task definitions | Kiro |
| 20 | `random_password` values stored in Terraform state | Kiro |

## Low Severity Findings

| # | Issue | Found by |
|---|-------|----------|
| 21 | Unpinned packages + `curl\|bash` in Dockerfiles | Codex |
| 22 | ECR image tag mutability (MUTABLE) | Kiro |
| 23 | Missing `readonlyRootFilesystem` on containers | Kiro |
| 24 | Terraform state not configured for remote backend | Kiro |
| 25 | Documentation contains real infrastructure details | Kiro |
| 26 | Cognito domain prefix not unique | Kiro |
| 27 | `.gitignore` may miss `.env.local` files | Kiro |

---

## Top 3 Action Items

1. **Remove hardcoded account ID and default password** from all source files - these are immediately exploitable
2. **Implement EFS Access Points** for per-user isolation - current directory-based isolation is bypassable
3. **Scope IAM wildcard permissions** - especially Bedrock `Resource: *` on instance/dashboard roles

---

## Detailed Reviews

- [Claude Review](claude.md) - 11 findings, cross-IaC consistency analysis with exact line references
- [Codex Review](codex.md) - 9 findings, code-focused analysis
- [Kiro Review](kiro.md) - 24 findings, AWS Well-Architected analysis
- [Gemini Review](gemini.md) - 8 findings, infrastructure security focused
