---
status: Accepted
date: 2026-09-13
verification_required: true
runtime_required: false
---

# ADR-013: Specialist review protocol and documentation convention

## Status

Accepted, 2026-09-13. Documentation convention and specialist protocol: **LIVE**
in the repository workflow (`ROLE_REVIEW=1`). Runtime service availability and
executed model identity require separate evidence; configuration is not proof.

## Context

Repeated lens requests and conflicting documentation increase review latency and
false positives. The owner selected specialist roles and English-only repository
documentation to reduce duplicated context.

## Decision

Assign distinct responsibilities to the supported model pool instead of repeating
every lens. Codex uses GPT-6 Astra, Kiro uses Opus 5 and GPT-5.6 Sol, and the Claude
role uses Fable 5.1. Require complete, immutable-scope reports and independent
OpenAI/Anthropic primary coverage. Only trusted routing can mark a role inactive.
Terraform/tfvars, IAM, user-data, authentication, network and deployment paths or
content require the AWS and operations roles; unknown scope remains conservative.
Use random-nonce input boundaries and bind invocation nonces into result digests.

A complete report without blocking candidates or uncertainty may receive a
deterministic summary. A chair adjudicates substantive candidates, but cannot
waive missing or invalid coverage. Preserve existing project input exclusions,
secret/state custody, context and budgets. No quota or billing limits are raised.
New or substantially rewritten documentation, ADRs and code comments use English.
Existing Korean-only and bilingual material, including these surrounding project
guides, remains valid until its own maintenance update. A narrow correction does
not require translating the entire file or repository. When replacing a bilingual
section, retain its current meaning in English and remove the stale duplicate.
Immutable historical evidence retains its original text; operator conversation
and product UI localization may remain Korean. Missing Korean duplicates are not defects.
This documentation convention is active now. Automated review output switches to
English with this activation; legacy prompts remain only for compatibility fixtures.

## Consequences and activation

This activation replaces the legacy 12-cell Codex/Kiro matrix and unconditional
chair with one full-change responsibility per required role, strict JSON/nonce
coverage and conditional adjudication. Missing/invalid required roles block;
legacy permissive dropout counts do not authorize specialist coverage. Existing
input exclusions, provider security/custody, regions, budgets and runner pins remain.
The prior cross-repository ADR-015 rationale for excluding `glm-5` remains;
this decision supersedes its 12-cell execution shape.
See [the module contract](../../scripts/pr-review/README.md) and
[project guide](../pr-review-specialists.md).

Sol intentionally replaces the legacy Terra review slot. This is an explicit
CI model selection, not a change to application inference models or proof that
a configured provider/model executed successfully.

A scope containing only files excluded by the existing, base-approved project
input policy may complete as NOT_APPLICABLE with a PASS gate result. The trusted
collector must account for every path and record the policy hash; the report
identifies excluded paths and claims no model review. Any reviewable source,
unknown exclusion, source omission or failed collector remains blocking. New
exclusions require their own reviewed policy change.

BASELINE records the active roster and this replacement of legacy execution rules.
The machine tag `kiro-fable` is a compatibility identifier for the Opus AWS role,
not a model-brand assertion; its requested model is recorded separately. Renaming
receipt keys is outside this policy change.

Static policy, executor and offline protocol tests validate the implementation.
Real provider access and exact-HEAD publication need runtime evidence.

## Verification

```yaml
files:
  - path: docs/decisions/BASELINE.md
    must_contain:
      - "| **LIVE** | Documentation language"
      - "| **LIVE** | Specialist review protocol"
  - path: scripts/pr-review/README.md
    must_contain:
      - "CI selects `ROLE_REVIEW=1`"
      - "compatibility identifier"
      - "Terraform/tfvars"
```
