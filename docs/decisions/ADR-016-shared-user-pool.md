---
status: Accepted
date: 2026-10-29
verification_required: true
related: [ADR-001, ADR-004, ADR-008, ADR-010]
---

# ADR-016: Optional shared Cognito user pool

## Status
Accepted

## Context

cc-on-bedrock creates its own Cognito user pool (ADR-004). An operator who already runs a sibling app with an admin-invite-only pool wants one account directory: the same people sign in to both apps with one password, and the operator invites them once.

Pointing cc at a pool it does not own has four consequences:

1. Every user of the other app would see cc. `roleFromGroups` treats a user with no role group as `user`, so they would get a dashboard session and, through `/api/local/credentials`, per-user Bedrock credentials.
2. Pool-wide settings belong to the owning stack: the schema (cc's nine `custom:*` attributes), the Lambda triggers (one slot per trigger type), the password policy and the invite message.
3. Terraform can no longer recreate the pool on `destroy` + `apply`, which is the ADR-001 invariant.
4. The repository is public, so the shared pool's ID or name must not appear in code, docs or tests.

## Decision

**An optional root variable, `shared_user_pool_name`, makes cc use an existing pool in the same account and region. In that pool, membership of a `cc-` prefixed role group is the access gate. When the variable is empty, cc's own pool is used exactly as before.**

- **Lookup.** Terraform resolves the pool by name at plan time (`data "aws_cognito_user_pools"` + `data "aws_cognito_user_pool"`). The name lives only in the operator's gitignored `terraform.tfvars`. Postconditions fail the plan when the name does not match exactly one pool, when the pool lacks any of cc's custom attributes, or when it allows self sign-up.
- **What cc owns in the shared pool.** cc creates only its two app clients and its three role groups, `cc-admin`, `cc-dept-manager` and `cc-user`, all in Terraform. The owning stack owns the pool, its schema (including cc's custom attributes), triggers, password policy and messages.
- **Gate.** The runtime env `COGNITO_GROUP_PREFIX` (`cc-` in shared mode, empty otherwise) maps group names to cc's internal roles and ignores every other group. In shared mode, a user in no cc role group gets no session, no fresh-role pass (`requireFreshRole`) and no `/api/local/credentials` response. The user listing shows such users as having no access, and an admin grants access by assigning a role. In own-pool mode, no group still means `user`.
- **Triggers.** cc attaches no trigger to the shared pool. ADR-010's JIT shim stays on the own pool only. In shared mode, the per-user Local role is created lazily by `sts-issuer` (`ensure_role`) on the first credential request. This is the existing fallback, and the event-driven provisioner is not deployed anyway (BASELINE §2).
- **Rollback.** The own pool is kept, unused, in shared mode, so clearing the variable restores it. Removing it is a separate cleanup decision.

## Consequences

- Positive: one directory and one invite flow for both apps. Other apps' users cannot reach cc unless an admin grants a role. The default deployment is unchanged.
- Negative: ADR-001's reproducibility no longer covers the identity directory in shared mode, because the pool and its schema live in another stack. The owning stack's password policy, invite email and pre-sign-up rules (for example, an email-domain allowlist) also apply to users cc creates. Moving to a shared pool changes every user's `sub`, so existing users are re-invited and `custom:dept_manager_sub` is set again. Usage history is keyed by email and is kept.
- Mitigations: plan-time postconditions catch a missing schema or a self-sign-up pool before any resource changes. Role groups carry the prefix so they cannot collide with the other app's groups. The rollback path is a single variable.

## Verification

```yaml
files:
  - path: terraform/modules/security/main.tf
    must_contain:
      - "shared_user_pool_name"
      - "/group_prefix\\s*=\\s*local.shared_pool \\? \"cc-\" : \"\"/"
      - "required_custom_attributes"
      - "allow_admin_create_user_only"
  - path: terraform/modules/dashboard/main.tf
    must_contain:
      - "COGNITO_GROUP_PREFIX"
  - path: shared/nextjs-app/src/lib/roles.ts
    must_contain:
      - "COGNITO_GROUP_PREFIX"
semantic:
  - claim: "In shared mode a user with no cc-prefixed role group cannot obtain a dashboard session or local CLI credentials."
    context_files:
      - shared/nextjs-app/src/lib/auth.ts
      - shared/nextjs-app/src/lib/role-admin.ts
      - shared/nextjs-app/src/app/api/local/credentials/route.ts
  - claim: "No Cognito user pool ID or shared pool name is committed to the repository."
    context_files:
      - terraform/terraform.tfvars.example
```
