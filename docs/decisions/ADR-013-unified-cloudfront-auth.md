# ADR-013: Unified CloudFront + Single Auth Mechanism

## Status
Superseded by [ADR-016](ADR-016-cloudfront-split.md) (2026-05-12). Originally Implemented (2026-04-16). Supersedes ADR-012 (DevEnv Cognito OAuth Lambda@Edge).

> **Supersession note (2026-05-12):** The unified CloudFront design caused two
> operational issues: (1) ACM wildcard certs only cover one sub-domain depth so
> `*.atomai.click` could not also cover `*.dev.atomai.click` as a SAN, blocking
> `CcOnBedrock-Dashboard` updates (2026-04-17 rollback); (2) the unified
> distribution sitting in Stack 05 forced a synth-time dependency on Stack 04
> SGs and NLB DNS, preventing `governanceOnly=true` (ADR-014) from skipping the
> ECS DevEnv stack. ADR-016 splits the CloudFront concerns back into two
> distributions but **preserves the single-sign-on outcome** by keeping the
> NextAuth cookie domain at `.atomai.click`. The session-validator Lambda@Edge
> still pre-validates `*.dev.*` viewer requests; only the origin-router and the
> unified SAN cert are eliminated.

## Context

The platform had **two separate CloudFront distributions** with **two auth mechanisms**:

| Distribution | Domain | Auth |
|---|---|---|
| CF-1 (Stack 04) | `*.dev.atomai.click` | Lambda@Edge Cognito OAuth (345-line devenv-auth-edge) |
| CF-2 (Stack 05) | `cconbedrock-dashboard.atomai.click` | NextAuth.js (Cognito provider) |

Users experienced **double login**: after authenticating on the Dashboard (NextAuth), navigating to their code-server required a second Cognito Hosted UI login via Lambda@Edge. This was confusing and unnecessary since both auth flows used the same Cognito User Pool.

## Decision

Merge into a **single CloudFront distribution** (Stack 05) with **NextAuth as the sole auth mechanism**. Use Lambda@Edge for two purposes:

1. **Viewer Request (Session Validator):** Decrypt the shared NextAuth JWE cookie to validate subdomain ownership
2. **Origin Request (Origin Router):** Route `*.dev.atomai.click` to NLB, dashboard traffic to ALB

### Architecture

```
[After] Single CF + Single Auth
  CF (dashboard + *.dev)
    ├─ viewer-request: session-validator (decrypt NextAuth JWE, check subdomain)
    ├─ origin-request: origin-router (Host header → NLB or ALB)
    ├─ Host=dashboard.*  → ALB origin (Next.js)
    └─ Host=*.dev.*      → NLB origin (Nginx → code-server)
    Auth: NextAuth cookie (.atomai.click domain) shared across subdomains
```

## Implementation

### Cookie Domain Sharing
NextAuth cookie domain set to `.atomai.click` (via `COOKIE_DOMAIN` env var) so the session cookie is readable by both `cconbedrock-dashboard.atomai.click` and `*.dev.atomai.click`.

### Session Validator (`devenv-session-validator/index.js`, ~180 lines)
Replaces the 345-line `devenv-auth-edge` (Cognito OAuth + JWKS + HMAC).

- Reads `__Secure-next-auth.session-token` cookie
- Derives AES-256-GCM key via HKDF (same as NextAuth internals): `crypto.hkdfSync('sha256', secret, '', 'NextAuth.js Generated Encryption Key', 32)`
- Decrypts JWE (`dir` + `A256GCM`) and checks `payload.subdomain === host subdomain`
- No cookie → 302 redirect to Dashboard login with `callbackUrl`
- Wrong subdomain → 403 Forbidden
- NEXTAUTH_SECRET loaded from SSM `/cc-on-bedrock/nextauth-secret` on cold start

### Origin Router (`devenv-origin-router/index.js`, ~70 lines)
- `*.dev.*` requests → dynamically overrides origin to NLB (port 80, HTTP)
- Dashboard requests → passes through to default ALB origin
- NLB DNS and CF secret loaded from SSM `/cc-on-bedrock/devenv-origin-config` on cold start (these come from CloudFormation tokens that can't be baked in at build time)

### CDK Changes

| Stack | Change |
|---|---|
| Stack 02 (Security) | Removed `DevEnvAuthClient` (Cognito app client), `devenvAuthCookieSecret` |
| Stack 04 (ECS DevEnv) | Removed CF distribution, Lambda@Edge, Route 53 wildcard. Kept NLB + Nginx |
| Stack 05 (Dashboard) | Added unified CF with both domains, 2 Lambda@Edge functions, Route 53 wildcard, SSM params |
| `bin/app.ts` | Stack 05 depends on Stack 04 (NLB DNS via `Fn::ImportValue`) |

### Deleted Code
- `cdk/lib/lambda/devenv-auth-edge/` (entire directory) — replaced by session-validator

## Key Design Decisions

### SSM for Lambda@Edge Config
Lambda@Edge cannot use environment variables. Dynamic values (NEXTAUTH_SECRET, NLB DNS, CF secret) are stored in SSM Parameter Store and loaded on cold start with caching. Static values (domain names, SSM region) are baked in via `sed` at build time.

### Build-time vs Deploy-time Token Resolution
NLB DNS comes from `Fn::ImportValue` and CF secret from Secrets Manager — both are CloudFormation tokens that resolve at deploy time. Docker-based `sed` bundling runs at synth time. Solution: store these values in an SSM parameter using `Fn::Sub` (resolves at deploy time) and load at Lambda runtime.

### `Fn::Sub` for SSM Parameter Value
Used `cdk.Fn.sub('{"nlbDns":"${NlbDns}","cfSecret":"${CfSecret}"}', ...)` to compose the SSM parameter value from two CloudFormation tokens. `Fn::Sub` is a CloudFormation intrinsic that resolves at deploy time.

## Consequences

### Positive
- Single login: Dashboard auth automatically grants code-server access
- Simpler architecture: 1 CF distribution instead of 2
- Less code: ~250 lines of Lambda replaces ~345 lines
- No Cognito app client needed for DevEnv (reduces Cognito config surface)
- Cookie-based auth is stateless — no token exchange, no JWKS rotation

### Negative
- NextAuth secret must be synchronized between ECS (via Secrets Manager) and SSM (for Lambda@Edge)
- Cold start latency: origin-router now has SSM call (~50ms) on first devenv request per edge location
- Cookie size: JWE token in cookie is larger than the previous HMAC cookie

### Risks
- If NEXTAUTH_SECRET rotates, both Secrets Manager and SSM param must update simultaneously
- Lambda@Edge SSM calls go to ap-northeast-2 regardless of edge location (latency for distant edges)
