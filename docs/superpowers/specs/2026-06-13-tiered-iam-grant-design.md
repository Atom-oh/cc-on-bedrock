# Design — Tiered IAM grant model (ADR-026 evolution)

- **Date:** 2026-06-13
- **Status:** Approved (brainstorming) → spec
- **Supersedes/amends:** ADR-026 (narrow 9-service allowlist) → new ADR-030.
- **Problem:** AWS has 200+ services; the request system's `DEFAULT_SERVICE_ALLOWLIST`
  (9 services) + the boundary's per-service `GrantCeiling` are too narrow — every new
  service needs an admin code-change + redeploy. Users can't get common reads.

## Decision — 4 tiers (encoded in BOTH the request validator and the permission boundary)

| Tier | Actions | Resource scope | Gate |
|---|---|---|---|
| **1. Metadata** | `Describe*`, `List*`, non-data `Get*` (GetFunctionConfiguration, GetBucketLocation, …) | `Resource:*` allowed, **all services** | auto (low risk) |
| **2. Data read** | `GetObject`, `GetItem`/`Query`/`Scan`/`BatchGetItem` (content reads) | **concrete ARN required** (`bucket/*`, table ARN — suffix wildcard OK) | request + approve |
| **3. Secret/decrypt** | `secretsmanager:GetSecretValue`, `ssm:GetParameter*` (SecureString), `kms:Decrypt` | **concrete ARN, NO path wildcard** (single secret/param/key; the secret's full contents come with GetSecretValue) | request + approve |
| **4. Write/mutate** | `Put*`/`Update*`/`Delete*`/`Create*`/… | concrete ARN | request + approve, **narrow write-allowlist** |
| **Always deny** | iam·org·account·`*:*ResourcePolicy`·`*:*Permission`·kms key delete/schedule-deletion·cross-account | — | rejected (both layers) |

Tier classification is action-shape based (verb prefix/suffix + a small data-read / secret set), not a per-service table — so it scales to new services automatically.

## Components

### C1 — Request validator (`shared/nextjs-app/src/lib/iam-request-validation.ts`)
- Add `classifyTier(action): "metadata"|"dataRead"|"secret"|"write"|"dangerous"`.
  - dangerous: existing `DEFAULT_DANGEROUS` regexes (kept) + kms key-deletion + cross-account (existing).
  - secret: `secretsmanager:GetSecretValue`, `ssm:GetParameter*`, `kms:Decrypt`.
  - dataRead: `s3:GetObject*`, `dynamodb:GetItem|Query|Scan|BatchGetItem`, `*:GetObject` … (curated data-read set).
  - metadata: `*:Describe*`, `*:List*`, `*:Get*` NOT in dataRead/secret.
  - write: everything else not dangerous.
- Per-tier validation:
  - metadata → allow `Resource:*`; **no service-allowlist check** (any service).
  - dataRead → require concrete ARN (reject `Resource:*`); allow across a **broad read service set**.
  - secret → require concrete ARN with **no `*` in the resource path** (reject `secret:…/*`, `parameter/…*`); single resource.
  - write → require concrete ARN **and** service ∈ `WRITE_SERVICE_ALLOWLIST` (narrow; = current 9 minus pure-read additions).
  - dangerous → reject.
- Split `DEFAULT_SERVICE_ALLOWLIST` → keep for **writes** (rename `WRITE_SERVICE_ALLOWLIST`, narrow) + introduce broad read handling (no list — tier-gated).
- Keep `WILDCARD_OK_ACTIONS` for resource-level-unsupported actions (already metadata-ish).

### C2 — Permission boundary (`cdk/lib/02-security-stack.ts` `cc-on-bedrock-task-boundary`)
- **Read ceiling (broad):** new statements —
  - `*:Describe*`, `*:List*`, `*:Get*` on `Resource:*` **scoped to account/region** where possible (metadata). (Tier-1 ceiling.)
  - data-read + secret-read actions on `arn:aws:*:{region}:{account}:*` (so a *scoped* grant works for many services; the request layer enforces the concrete-ARN/no-wildcard rules — boundary is the ceiling, not the scoper).
- **Write ceiling (narrow):** keep existing per-service `GrantCeiling*` (sqs/sns/dynamodb/lambda/states/eks) write actions only.
- **Always-deny:** boundary simply does NOT grant iam/org/account/resource-policy/permission/kms-delete/cross-account (a boundary is allow-list; absence = deny). Cross-account already prevented by account-scoped ARNs.
- Keep bedrock (claude+embed) + infra statements as-is.

### C3 — Terraform parity (`terraform/modules/security/main.tf`)
The boundary also lives in Terraform (CLAUDE.md 3-way IaC mandate). Mirror C2's boundary
statements there.

### C4 — CI invariant (`scripts/check-policyset-boundary.py`)
Update the T6 check: boundary must ⊇ the (now broader read) request surface. Add
action-level coverage for the metadata/data-read tiers; keep write-allowlist ⊆ write ceiling.

### C5 — ADR-030 (new) + ADR-026 amendment note
Document the tiered model, the security rationale (read-broad/write-narrow/secret-strict/
dangerous-deny), and that the boundary remains the hard ceiling (defense-in-depth with the
validator). Note ADR-026's allowlist is superseded by tiers.

## Security analysis
- **Tier-1 metadata broad** is low-risk (no data/secrets) and is the big flexibility win.
- **Tier-2/3 data/secret reads** stay request+approve and concrete-ARN — no cross-tenant
  bulk read. Secrets are strictest (no path wildcard).
- **Tier-4 writes** stay narrow (curated allowlist) — high-risk mutations remain gated.
- **Dangerous always denied** at both layers — privilege-escalation paths (iam, resource
  policies, cross-account, kms deletion) blocked.
- Two-layer defense (validator at request time + boundary at runtime) preserved; both encode
  the same tier rules. Boundary is the last line — if the validator is bypassed, the boundary
  still caps to read-broad/write-narrow/no-dangerous.

## Testing (TDD)
`iam-request-validation` unit tests per tier: metadata Resource:* allowed (arbitrary service);
data-read rejects Resource:* / requires concrete ARN; secret rejects path wildcard; write
requires write-allowlist + concrete ARN; dangerous rejected; cross-account rejected.
`check-policyset-boundary.py --self-test` updated. `cdk synth` + `terraform validate` green.

## Out of scope
- Auto-expiry of grants (ADR-005, separate).
- Embedding/model ceiling (done in #69, separate axis).
- token-limit-enforcer embed weight (follow-up noted in #69 review).

## File-by-file
| File | Change |
|---|---|
| `shared/nextjs-app/src/lib/iam-request-validation.ts` | `classifyTier` + per-tier rules; split read/write allowlists |
| `shared/nextjs-app/src/lib/__tests__/iam-request-validation.test.ts` | extend: tier cases |
| `cdk/lib/02-security-stack.ts` | boundary: broad read ceiling + narrow write ceiling |
| `terraform/modules/security/main.tf` | mirror boundary (parity) |
| `scripts/check-policyset-boundary.py` | T6 invariant for tiers |
| `docs/decisions/ADR-030-tiered-iam-grant.md` | new ADR + ADR-026 amendment note |
| `shared/nextjs-app/src/app/.../settings-tab.tsx` (if UI hints tiers) | optional copy update |
