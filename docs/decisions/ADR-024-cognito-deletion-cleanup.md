# ADR-024: Cognito user deletion → downstream cleanup

**Status:** Accepted
**Date:** 2026-05-15
**Builds on:** [ADR-022 EventBridge pre-provisioning of per-user identity](ADR-022-eventbridge-role-preprovisioning.md)

## Context

ADR-022 made `user-role-provisioner` the single source of truth for everything a
new Cognito user needs downstream. It explicitly listed deletion as out of scope:

> **Role cleanup on `AdminDeleteUser`.** The provisioner only creates; deletion
> is not wired up. Stale roles are inert (no principal can assume them once the
> Cognito sub is gone) but accumulate.

Two operational problems followed:

1. **Asymmetric lifecycle.** Manually deleting a Cognito user (CLI, Console,
   one of our cleanup scripts) leaves behind:
   - `cc-on-bedrock-local-user-{sub}` IAM role
   - `cc-on-bedrock-task-{subdomain}` IAM role + instance profile
   - Running EC2 instance for that subdomain (billable indefinitely)
   - `cc-user-instances` / `cc-user-volumes` / `cc-routing-table` DDB rows
   - `cc-on-bedrock/codeserver/{subdomain}` Secret
   - `cc-on-bedrock-limits` rows keyed `USER#{sub}`

   In the seed-rerun cycles during ADR-022 development this had to be cleaned
   up manually with `aws iam delete-role`/`delete-secret`/`delete-item` loops.

2. **Dangerous "Permanent Delete" button on `/admin`.** The dashboard's
   `/api/users` DELETE handler exposed an `action=permanent` path that called
   `AdminDeleteUser` from the UI. Cognito users may be federated from an
   external IdP (SAML/OIDC), where the source-of-truth identity lives outside
   AWS. Hard-deleting from Cognito breaks resyncability; the IdP would
   re-create the user with a fresh `sub` on next login, leaking the old
   per-user resources and orphaning any history keyed on the old sub.

## Decision

### Deletion handler — symmetric to provisioning

Add `AdminDeleteUser` to the existing EventBridge rule and grow
`user-role-provisioner` with a deletion code path. Same Lambda, opposite
direction. Recovery of the subdomain (needed for EC2-side resource names)
relies on the local-user role's existing `username` tag (email) and the
`derive_subdomain` function — stateless.

```
AdminDeleteUser
        ↓
CloudTrail (additionalEventData.sub exposed even though username is redacted)
        ↓
EventBridge rule
        ↓
user-role-provisioner Lambda → _deprovision_user(sub)
   ├─ read tags of cc-on-bedrock-local-user-{sub} → recover email → derive_subdomain
   ├─ terminate EC2 instances tagged subdomain=… AND managed_by=cc-on-bedrock
   ├─ remove role from instance profile + delete profile (cc-on-bedrock-task-{subdomain})
   ├─ delete inline policies + delete role (cc-on-bedrock-task-{subdomain})
   ├─ delete DDB rows:
   │    cc-user-instances     PK user_id=subdomain
   │    cc-user-volumes       PK user_id=subdomain
   │    cc-routing-table      PK subdomain=subdomain
   ├─ force-delete codeserver secret cc-on-bedrock/codeserver/{subdomain}
   ├─ delete inline policies + delete role (cc-on-bedrock-local-user-{sub})
   └─ query+delete cc-on-bedrock-limits rows where PK=USER#{sub}
```

Each step is idempotent (NoSuchEntity / ResourceNotFound are swallowed) so
re-running on a partially-cleaned sub finishes the job. Direct-invoke contract
`{"action":"deprovision","sub":"…"}` supports manual repair.

### Dashboard `/admin` permanent-delete blocked

`/api/users` DELETE with `action=permanent` now returns HTTP 403 with a
guidance message. (We initially used 405; switched to 403 since the DELETE
method itself is allowed — only the `action=permanent` value is rejected as
a policy decision, not an HTTP method mismatch. 405 would also require an
`Allow` header listing valid methods, which doesn't fit this case.) The
UI's "Delete" button + `handlePermanentDelete` handler
+ `<UsersTable onPermanentDelete=…>` prop are all stripped. The remaining
operations on `/admin` are:

- **Disable** (default for revoking access — Cognito remains addressable for
  re-enabling, federation-safe)
- **Enable**
- **Reset Env** (soft delete — stops the user's instance and clears their
  subdomain attribute; user account stays)

Hard-deleting a Cognito user is intentionally restricted to AWS Console / CLI
by a human who has confirmed the user is not federated. When that happens,
the AdminDeleteUser event still fires and the provisioner reaps cleanly.

### Default group fallback for IdP / Console-created users

A separate but related gap: users created directly via Cognito Console or
through SAML/OIDC federation may arrive with no Cognito group membership. The
dashboard's auth middleware checks group membership (`admin` / `dept-manager`
/ `user`) and rejects users with none. Add a `_ensure_default_group` step at
the end of `_provision_user`: if `AdminListGroupsForUser` returns an empty
list, add to `user`. The seed script already adds explicitly → no-op there.

## Consequences

**Positive**
- Lifecycle symmetry: deletion fans out cleanup the same way creation fans out
  provisioning. Manual deletion via AWS Console / CLI / scripts is safe.
- Federation-safe: dashboard cannot accidentally hard-delete a federated user.
- Operational sanity: no more orphan IAM roles / running EC2 / stale Secrets
  draining the account after a test cycle.
- Console-created users can log into the dashboard immediately. Previously
  required an admin to manually `admin-add-user-to-group`.

**Negative / trade-offs**
- Provisioner Lambda's blast radius widens. It now holds delete permissions on
  IAM roles / instance profiles, DDB rows, Secrets, and EC2 terminate. Scoped
  by ARN prefix + tag conditions, but a Lambda compromise has higher impact.
  Mitigated by the existing reserved-prefix patterns (`cc-on-bedrock-*`) and
  the `managed_by=cc-on-bedrock` tag condition on TerminateInstances.
- The default-group fallback assumes `user` is always the right least-privilege
  group. Admins promoted via Console still need explicit `admin-add-user-to-group
  admin` — there's no signal in the AdminCreateUser event to detect intent.
- EC2 termination is unconditional on delete. If an admin deletes a Cognito user
  while their instance has unsaved work, it's gone. Documented operational
  warning, not a code mitigation.
- **TerminateInstances vs DeleteRole race.** TerminateInstances is async — the
  instance enters `shutting-down` immediately but only releases its instance-
  profile reference once it reaches `terminated`. `DeleteRole` /
  `DeleteInstanceProfile` rejected with `DeleteConflict` while a running
  instance still references the profile. `_safe_delete_role` /
  `_safe_delete_instance_profile` swallow the conflict and return
  `error: DeleteConflict` in the result dict (visible in the Lambda log and
  the direct-invoke return value). Re-invoking `{"action":"deprovision","sub":"…"}`
  after the instance fully terminates completes the cleanup. A future
  improvement is a short waiter (`ec2.get_waiter("instance_terminated")`)
  but it would push Lambda runtime past the 30s timeout for the
  shutting-down → terminated transition (~minutes). Documented as known
  partial-completion behavior.

**Out of scope (separate follow-ups)**
- **EBS snapshot before terminate.** Not a destructor we want by default
  (cost), but a knob like `{"action":"deprovision","preserveEbs":true}` could
  snapshot before terminate.
- **Configurable group-assignment policy.** Default `user` is fine for the
  current install; enterprises with different role taxonomies should be able
  to map IdP claims → groups via a config setting (ties into the configurable
  attribute keys discussion from ADR-022's out-of-scope).
- **Audit trail of deletions.** Currently only the Lambda's CloudWatch logs.
  Push to a dedicated SNS topic or DDB audit table if SOC2/SOX coverage is
  required.

## Files

- `cdk/lib/lambda/user-role-provisioner.py` — `_deprovision_user`,
  `_ensure_default_group`, and EventBridge `AdminDeleteUser` dispatch.
- `cdk/lib/08-local-governance-stack.ts` — extended EventBridge rule + IAM
  perms (delete-side IAM, DDB Delete/Query, SecretsManager Delete,
  EC2 Describe/Terminate, additional Cognito read/write).
- `shared/nextjs-app/src/app/api/users/route.ts` — `permanent` returns 403.
- `shared/nextjs-app/src/app/admin/user-management.tsx` — removed
  `handlePermanentDelete` + `onPermanentDelete` prop wiring.

## Verification

Deploy Stack 08, then:

```bash
# 1) Console-created user gets default group + auto-provisioned downstream.
aws cognito-idp admin-create-user --user-pool-id $POOL --username probe-idp@example.com \
  --user-attributes Name=email,Value=probe-idp@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS --region $REGION
# wait ~15s
aws cognito-idp admin-list-groups-for-user --user-pool-id $POOL --username probe-idp@example.com \
  --region $REGION --query "Groups[].GroupName" --output text
# expect: user

# 2) Delete that user → all per-user resources reaped.
aws cognito-idp admin-delete-user --user-pool-id $POOL --username probe-idp@example.com --region $REGION
SUB=<...>  # from earlier
# wait ~15s
aws iam get-role --role-name "cc-on-bedrock-local-user-${SUB}"  # expect: NoSuchEntity
aws iam get-role --role-name "cc-on-bedrock-task-probe-idp"     # expect: NoSuchEntity
aws iam get-instance-profile --instance-profile-name "cc-on-bedrock-task-probe-idp"
                                                                # expect: NoSuchEntity
aws secretsmanager describe-secret --secret-id cc-on-bedrock/codeserver/probe-idp
                                                                # expect: ResourceNotFoundException

# 3) Dashboard /admin "Delete" button is gone; /api/users?action=permanent returns 403.
curl -X DELETE 'https://<dashboard>/api/users?username=foo&action=permanent' \
  --cookie ... # expect: 403 with "Permanent delete is disabled" message
```
