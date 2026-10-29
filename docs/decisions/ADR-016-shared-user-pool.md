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

- **Lookup.** Terraform resolves the pool by name at plan time (`data "aws_cognito_user_pools"` + `data "aws_cognito_user_pool"`). The name lives only in the operator's gitignored `terraform.tfvars`. Postconditions fail the plan when the name does not match exactly one pool, when the pool lacks any of cc's custom attributes, when it allows self sign-up, when it does not use email as the username, or when any client in the pool leaves `WriteAttributes` unset or lets users write a `custom:*` attribute. An unset `WriteAttributes` lets every signed-in user write every mutable attribute, so another app's client would let users set their own `custom:department` (budget) or `custom:subdomain` (IAM role name).
- **What cc owns in the shared pool.** cc creates only its two app clients and its three role groups, `cc-admin`, `cc-dept-manager` and `cc-user`, all in Terraform. Clients and groups are keyed per pool (`own`, plus `shared` in shared mode), so the own pool's clients and groups are never replaced by a mode switch. The owning stack owns the pool, its schema (including cc's custom attributes), triggers, password policy and messages.
- **Gate.** The runtime env `COGNITO_GROUP_PREFIX` (`cc-` in shared mode, empty otherwise) maps group names to cc's internal roles and ignores every other group. In shared mode, a user in no cc role group cannot sign in, gets no fresh-role pass (`requireFreshRole`) and no `/api/local/credentials` response. A user whose access is removed keeps an existing dashboard session (JWT, up to 8h) for session-trusted reads only, as with role changes (ADR-008 amendment 2026-10-24). Privileged writes and credential issuance re-check the group fresh. The user listing shows such users as having no access. An admin grants access by assigning a role and removes it with "No access", which removes every cc role group and revokes the user's Cognito tokens. The dashboard refuses to disable, enable, edit or delete a user with no cc role group (`not_cc_user`); granting a role is the only action on them. A grant is a single group write with no attribute changes, and it cannot be `dept-manager`, which needs a cc-set department: the admin grants `user`, then promotes with a normal edit that writes the department before the role. In own-pool mode, no group still means `user`.
- **Triggers.** cc attaches no trigger to the shared pool. ADR-010's JIT shim stays on the own pool only. In shared mode, the per-user Local role is created lazily by `sts-issuer` (`ensure_role`) on the first credential request. This is the existing fallback, and the event-driven provisioner is not deployed anyway (BASELINE §2).
- **Client write attributes and identity pinning (amendment 2026-10-29).** cc's shared-pool clients allow `name` and `email`, never `custom:*`. Cognito rejects a client that cannot write a required attribute, and a shared pool may require `email`. With `email` writable, a user can change their own email, and the STS issuer used to derive the Local role from the email. So in shared mode `/api/local/credentials` pins the role to `custom:subdomain` (Admin-only write): it reads the attribute fresh and, on first use, writes it from the current email (`pinnedSubdomain`, mirroring `derive_subdomain`), then passes it to the issuer. The first pin requires `email_verified = true`. `ensure_role` refuses a role whose owner email differs, and it also binds the role to the caller's immutable Cognito `sub` (a `sub` tag on the role): a role tagged with another `sub` is refused even when the email matches, and a legacy role without the tag is bound on the first call whose email matches its owner. After a self-service email change, the user therefore gets no credentials, neither a fresh role and budget identity nor another user's role, until an admin re-pins them. The owning pool should also hold an email change until it is verified (`AttributesRequireVerificationBeforeUpdate`).
- **Rollback.** The own pool, its clients, its groups and their memberships stay untouched in shared mode, so clearing the variable restores the previous state. Only the shared-pool clients and `cc-*` groups are destroyed, and memberships granted there are lost. Removing the own pool is a separate cleanup decision.
- **Migration.** The active client IDs change in both directions, so CLI users re-run `cc-bedrock-local setup`. Rotate `NEXTAUTH_SECRET` and clear the `cc-on-bedrock-cli-tokens` table at the switch, so that sessions (8h JWTs) and stored CLI bearer tokens issued against the previous pool end. Privileged writes and credential issuance already re-check groups in the active pool.

## Consequences

- Positive: one directory and one invite flow for both apps. Other apps' users cannot reach cc unless an admin grants a role. The default deployment is unchanged.
- Negative: ADR-001's reproducibility no longer covers the identity directory in shared mode, because the pool and its schema live in another stack. The owning stack's password policy, invite email and pre-sign-up rules (for example, an email-domain allowlist) also apply to users cc creates. Moving to a shared pool changes every user's `sub`, so existing users are re-invited and `custom:dept_manager_sub` is set again. Usage history is keyed by email and is kept.
- IAM reach: Cognito IAM cannot be scoped by group, so the dashboard role's `cognito-idp:Admin*` permissions cover every user in the shared pool, including the other app's groups. The application refuses actions on users outside cc's groups, but the role itself is not limited. A compromised dashboard host could disable, sign out or edit any user of the other app. Treat the dashboard role as an admin of the whole pool.
- Trust in the owning stack: its backends hold Admin* access to the same pool and can write `custom:department` (budgets) and `custom:subdomain` (the name of the IAM role `ensure_role` creates). cc trusts the owning stack as much as its own admins.
- Drift: the client `WriteAttributes` postcondition runs only at plan time. A client the owning stack adds later is not checked until cc's next plan, so re-run `terraform plan` after any change to the shared pool's clients, and at least on every cc release.
- Mitigations: plan-time postconditions catch a missing schema, a self-sign-up pool, a non-email username or a client that allows custom attribute writes before any resource changes. Role groups carry the prefix so they cannot collide with the other app's groups. The rollback path is a single variable, and it leaves the own pool's role assignments intact.

## Verification

```yaml
files:
  - path: terraform/modules/security/main.tf
    must_contain:
      - "shared_user_pool_name"
      - "/group_prefix\\s*=\\s*local.shared_pool \\? \"cc-\" : \"\"/"
      - "required_custom_attributes"
      - "allow_admin_create_user_only"
      - "aws_cognito_user_pool_client\" \"shared\""
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
