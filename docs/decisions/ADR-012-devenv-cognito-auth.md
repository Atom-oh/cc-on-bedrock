# ADR-012: DevEnv Cognito Authentication via Lambda@Edge

## Status
Superseded by [ADR-013](ADR-013-unified-cloudfront-auth.md) (2026-04-16)

## Context
The `*.dev.atomai.click` DevEnv path had no user authentication at the CloudFront or Nginx layer. Anyone who knew a valid subdomain could reach that user's code-server login page. While code-server has built-in password auth, this exposed the login surface to the internet without identity verification.

## Decision
Add Cognito OAuth authentication using **Lambda@Edge (Viewer Request) + Nginx subdomain enforcement** as a defense-in-depth strategy.

### Architecture
```
Browser → CloudFront + Lambda@Edge → NLB → Nginx → EC2 code-server
           ↓                                ↓
    Cognito OAuth cookie            X-Auth-User == subdomain check
```

### Why Lambda@Edge + Nginx (not alternatives)
| Option | Rejected Because |
|--------|------------------|
| CloudFront Functions | Cannot make network calls (JWKS fetch, token exchange impossible) |
| Nginx Lua/njs | Unauthenticated traffic enters VPC before rejection |
| OAuth2 Proxy Fargate | Unnecessary infrastructure cost, extra failure point |
| Lambda@Edge alone | Single layer; bug = bypass. Nginx provides independent validation |

### Key Design Choices
1. **Separate Cognito UserPoolClient** for DevEnv (not shared with Dashboard) — avoids wildcard callback URL limitation
2. **`auth.dev.atomai.click/_auth/callback`** as single callback URL — covered by existing `*.dev.atomai.click` wildcard DNS
3. **HMAC-signed cookie** (`.dev.atomai.click` domain) with `custom:subdomain` claim — one login covers all requests to user's subdomain
4. **Config injection at CDK synth time** — Lambda@Edge cannot use env vars; placeholders in JS source are replaced during build

### Security Layers
1. **Lambda@Edge**: Validates Cognito auth, extracts subdomain from JWT, injects `X-Auth-User` header
2. **Nginx**: Validates `X-Auth-User` matches the server block's subdomain, strips header before proxy
3. **code-server**: Built-in password auth (unchanged, serves as final layer)

## Consequences
- Unauthenticated requests are rejected at CloudFront edge (never enter VPC)
- Users can only access their own subdomain
- ~200-400ms cold start on first request to new edge location
- Cookie rotation requires Lambda@Edge redeployment
- Cost: ~$3/month incremental (Lambda@Edge invocations + Secrets Manager)
