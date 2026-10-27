# DevEnv edge session validator

Inherit root and `lambda/CLAUDE.md` guidance. This Node.js Lambda@Edge handler
validates dashboard NextAuth v4 JWE sessions before DevEnv origin forwarding.

## Contract and ownership

- Input: `event.Records[0].cf.request`, including host, cookies, URI/query.
- Packaging substitutes `__DEV_DOMAIN__`, `__DASHBOARD_URL__`, `__SSM_REGION__`.
  Cold start reads `/cc-on-bedrock/nextauth-secret` through signed SSM access.
- Return an authorized request, login redirect `302`, ownership/subdomain
  rejection `403`, or authentication-configuration failure `500`.
- `ecs-devenv` owns packaging, role, published `nodejs20.x` function in
  `us-east-1` and the qualified viewer-request association.

## Change constraints

Always remove viewer-supplied `x-auth-user`; inject trusted identity only after
session and subdomain-owner checks. Strip `next-auth.` and `__Secure-next-auth.`
cookies before DevEnv forwarding; preserve user application cookies.
`/health` and `/nginx-status` bypass authentication after cookie stripping.
Non-DevEnv hosts pass through.

Keep key derivation/cookie prefixes aligned with dashboard `auth.ts` and fail
closed. Built-in crypto/HTTPS and self-contained SigV4 avoid an SDK bundle.
Terraform currently substitutes a fixed `cconbedrock-dashboard` redirect label
despite configurable `dashboard_subdomain`; the SSM path is also fixed.

## Validation

From the repository root:

```bash
(cd shared/nextjs-app && npx vitest run src/lib/__tests__/devenv-session-validator.test.ts)
```

This validates local cookie/header behavior, not deployed Lambda@Edge behavior.
