# ADR-022: EventBridge pre-provisioning of per-user identity (IAM + Cognito attrs)

**Status:** Accepted
**Date:** 2026-05-14 (v1) · revised 2026-05-15 (v2 — expanded scope)
**Supersedes:** part of [ADR-020 runtime IAM policy upsert](ADR-020-runtime-iam-policy-upsert.md) (lazy create at first login)

## Context

Per-user identity in this project lives across three planes:

- **Cognito**: the user record + custom attributes (`custom:department`, `custom:subdomain`, `custom:dept_manager_sub`)
- **Local Governance IAM**: `cc-on-bedrock-local-user-{sub}` role assumed by the STS Issuer Lambda
- **EC2 DevEnv IAM**: `cc-on-bedrock-task-{subdomain}` role + instance profile attached to per-user EC2 instances

Before this ADR, each plane was filled in at a different moment by a different actor:

- Cognito custom attrs — set by whoever calls `AdminCreateUser` (seed script, dashboard `/api/users`, AWS Console, SDK). Each entry point invented its own subdomain rule.
- Local Governance role — created lazily inside the STS Issuer at the user's first `cc` login.
- EC2 task role — created lazily inside the dashboard at the user's first instance start.

Two classes of bug followed:

1. **Subdomain drift**: the seed script wrote `subdomain="${dept}${NN}"` (e.g. `engineering04`) while users expected the email prefix (`user04`). The dashboard form let admins type any value. There was no single source of truth.

2. **IAM eventual-consistency race**: `CreateRole → AssumeRole` and `CreateInstanceProfile → RunInstances` were called back-to-back inside one Lambda invocation. IAM propagation can exceed the configured retry budget, producing flaky first-use errors:

   > `AccessDenied: ... not authorized to perform: sts:AssumeRole on resource: arn:.../role/cc-on-bedrock-local-user-...`
   > `InvalidParameterValue: Value (cc-on-bedrock-task-user04) for parameter iamInstanceProfile.name is invalid.`

Every user hit each race exactly once — first login for Local Governance, first instance start for EC2 — which is hard to test for and embarrassing in demos.

## Decision

A single **`user-role-provisioner` Lambda** owns user-creation downstream effects.
It is triggered by CloudTrail/EventBridge and is the only thing that writes
identity state. Every entry point that creates a Cognito user (seed script,
dashboard, console, SDK) now does **only** `AdminCreateUser` + `AdminAddUserToGroup`;
the provisioner derives the rest.

```
AdminCreateUser  ──┐
SignUp           ──┤   (cognito-idp.amazonaws.com)
AdminAddUserToGroup─┘
        ↓
CloudTrail (account management trail — EventBridge-bound)
        ↓
EventBridge rule
        ↓
user-role-provisioner Lambda
   │
   ├─ derive subdomain from email local-part (lowercase, [a-z0-9-], 3-30)
   ├─ AdminUpdateUserAttributes  →  custom:subdomain
   ├─ ListUsersInGroup(dept-manager) + filter dept  →  manager's sub
   ├─ AdminUpdateUserAttributes  →  custom:dept_manager_sub
   ├─ role_factory.ensure_role()  →  cc-on-bedrock-local-user-{sub}
   └─ _ensure_ec2_task_role()    →  cc-on-bedrock-task-{subdomain}
                                     + instance profile + role attached
```

When the dept manager themselves is promoted (group membership change):

```
AdminAddUserToGroup (groupName=dept-manager)
        ↓
provisioner:
   ├─ AdminGetUser(promoted user) → sub + custom:department
   └─ for every user in same dept:
        AdminUpdateUserAttributes  →  custom:dept_manager_sub = new manager's sub
```

### Implementation notes

1. **Shared helper module** `cdk/lib/lambda/role_factory.py` factors trust policy / inline policy / `ensure_role()` out of `sts-issuer.py`. Both Lambdas import directly (filename without hyphen → Python-importable). Single source of truth for the per-user IAM contract.

2. **PII redaction handling.** CloudTrail replaces `requestParameters.userAttributes`, `responseElements.user.attributes`, and `responseElements.user.username` with the literal string `"HIDDEN_DUE_TO_SECURITY_REASONS"`. The Cognito `sub` is still exposed under `additionalEventData.sub` (AdminCreateUser) or `responseElements.userSub` (SignUp). The provisioner extracts `sub`, then re-fetches the full record via `AdminGetUser` to recover email + custom attrs.

3. **Subdomain derivation rule** — `derive_subdomain(email)` in `user-role-provisioner.py`:
   - take local-part before `@`
   - lowercase
   - non-`[a-z0-9-]` → `-`
   - collapse repeating dashes, strip leading/trailing dashes
   - pad to ≥3 chars, truncate to 30
   Matches the regex in `shared/nextjs-app/src/lib/validation.ts:3`.

4. **`custom:dept_manager_sub` semantics**:
   - Every user record carries the sub of their department's manager
   - Manager = first member of `dept-manager` Cognito group whose `custom:department` matches
   - Manager's own record self-points (manager of themselves)
   - When the manager changes (group promotion/demotion), all dept members are refreshed
   - Manager identity is **not** encoded in the email — `user01@example.com` can be promoted/demoted freely without email rotation. The email→manager relationship is recoverable only through this attribute.

5. **EC2 task role pre-creation** mirrors `ec2-clients.ts:ensureUserInstanceProfile` but runs ahead of first start. Idempotent: `get_role` → exists-branch updates tags + inline policy; orphan instance profile (a previous run created the profile but crashed before attaching the role) is detected on get_instance_profile and the role is re-attached.

6. **Direct-invoke contract** for backfill / manual repair:
   - `{"action": "ensure", "sub": "..."}` → run the full pipeline for one user
   - Same pipeline as the EventBridge path → behavioral parity
   - Used by `scripts/backfill-local-user-roles.sh`

7. **STS Issuer kept as defense-in-depth.** `sts-issuer.py` no longer owns ensure_role; it imports `role_factory.ensure_role`. Retry budget bumped 4 attempts/7s → 6 attempts/31s. A 3s post-inline-create sleep covers the rare path where the EventBridge event was missed and the role was just created.

8. **Dashboard duplicate-tag fix.** `shared/nextjs-app/src/lib/ec2-clients.ts:ensureUserInstanceProfile` previously included `subdomain` in `costAllocationTags` AND spread that array next to an explicit `{Key: "subdomain", Value: subdomain}`. IAM rejected with "Duplicate tag keys found. Please note that Tag keys are case insensitive." Fix: drop the explicit duplicate. Same file: wrap `RunInstances` in `runInstancesWithIamRetry` with exponential backoff on `InvalidParameterValue` for instance-profile propagation lag.

## Consequences

**Positive**
- Single source of truth for per-user identity. No drift between seed script, dashboard form, console, SDK.
- First `cc` login and first instance start are no longer racy. Both hit exists-branches after EventBridge has had time to settle.
- Manager identity decoupled from email. `dept-manager` group membership is canonical; promotion/demotion is a one-API-call admin action.
- Operational visibility — every provisioning step appears in the provisioner's CloudWatch log with sub / email / dept / what-got-created.
- Idempotent + backward compatible. Re-running on existing users is a no-op. The STS Issuer's lazy path is a complete fallback if EventBridge is dark.

**Negative / trade-offs**
- One additional Lambda + EventBridge rule in Stack 08 (≈ $0 / month at this scale; AWS metering is $1 / million invocations).
- Stack 08 now takes `userPool` via props for the `AdminGetUser` / `AdminUpdateUserAttributes` / `ListUsersInGroup` IAM grants. (`bin/app.ts` wires Stack 02 → 08 deps.)
- CloudTrail management-event delivery to EventBridge must be enabled in the account. Verified by the existing Bedrock-Invoke rule in Stack 03; if a consumer deploys to an account without a management trail, pre-provisioning silently no-ops and the STS Issuer's fallback path carries the load (Local Gov only — EC2 mode would still hit the race).

**Out of scope (separate follow-ups)**
- **Configurable attribute keys.** Different enterprises will use different attribute names to identify departments (`custom:department` vs `custom:org_unit`) and managers (`custom:dept_manager_sub` vs `custom:reports_to`). Today these are hardcoded; future work should externalize the key names via SSM Parameter Store + a dashboard admin settings page so a deployment can map onto an existing SAML/OIDC schema without code changes.
- **Dashboard `/api/users` POST refactor.** The form still accepts a user-typed `subdomain` field. Now redundant — the provisioner derives the canonical value. Form should drop the field and rely on the event-driven path.
- **Role cleanup on `AdminDeleteUser`.** The provisioner only creates; deletion is not wired up. Stale roles are inert (no principal can assume them once the Cognito sub is gone) but accumulate.
- **Cognito list-users Filter limits.** `_list_dept_members` had to scan all users and filter client-side because Cognito's `Filter` parameter does not support custom attributes for `list-users` (it does for `list-users-in-group`). Acceptable while the user pool stays under ~thousands of users; a paginated server-side index would be needed at much larger scale.

## Files

- `cdk/lib/lambda/role_factory.py` — NEW shared helpers
- `cdk/lib/lambda/user-role-provisioner.py` — NEW Lambda (EventBridge + direct-invoke)
- `cdk/lib/lambda/sts-issuer.py` — refactored to import role_factory; retry 4→6 attempts
- `cdk/lib/02-security-stack.ts` — added `custom:dept_manager_sub` to user pool schema
- `cdk/lib/08-local-governance-stack.ts` — provisioner Lambda + IAM perms + EventBridge rule
- `cdk/bin/app.ts` — pass `securityStack.userPool` to Stack 08
- `shared/nextjs-app/src/lib/ec2-clients.ts` — duplicate-tag fix + `runInstancesWithIamRetry`
- `scripts/create-enterprise-test-data.sh` — Cognito-only; subdomain/managers no longer hardcoded
- `scripts/backfill-local-user-roles.sh` — direct-invoke backfill helper

## Verification

Deployed 2026-05-15. End-to-end test:

1. Nuked all Cognito users + per-user IAM roles + instance profiles + stale codeserver secrets → pristine.
2. Re-ran `bash scripts/create-enterprise-test-data.sh` → 31 Cognito users created (`AdminCreateUser` + `AdminAddUserToGroup` only; nothing else).
3. Waited 60s for EventBridge → Lambda chain to settle.

Result:

| Check | Result |
|---|---|
| Cognito users | 31 (1 admin + 30 regulars, 6 per dept) |
| `custom:subdomain` populated by provisioner | 31/31 (email local-part: `user04` → `user04`) |
| `custom:dept_manager_sub` populated | 30/30 regular users point to their dept's manager; managers self-point; admin omits (no dept) |
| `cc-on-bedrock-local-user-{sub}` IAM roles | 31/31 |
| `cc-on-bedrock-task-{subdomain}` IAM roles | 31/31 |
| `cc-on-bedrock-task-{subdomain}` instance profiles | 31/31 |
| Manual fixup needed | 0 |

EC2 mode probe (user04, engineering, dept_manager_sub=user01's sub):
- Dashboard "Start" → `ensureUserInstanceProfile` hits exists-branch, no `CreateRole`/`CreateInstanceProfile`, no propagation wait → `runInstancesWithIamRetry` succeeds on attempt #1.

Local Governance probe (`cc login` as user07 = data-science manager):
- STS Issuer → `_ensure_role` exists-branch → `AssumeRole` succeeds attempt #1, no retry needed.
