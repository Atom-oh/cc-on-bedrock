---
status: Accepted
date: 2026-09-13
verification_required: true
runtime_required: false
---

# ADR-013: Specialist review protocol and documentation convention

## Status

Accepted, 2026-09-13. Documentation language convention: **LIVE** with the
incremental migration rule below. Specialist protocol: **GATED**, offline library staged; legacy execution and review-output language remain active until a
separate reviewed activation. No provider or application behavior changes here.

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
English with protocol activation; the current legacy prompts remain in force until then.

## Consequences and activation

This records the approved protocol design; it does not supersede the live legacy
workflow yet. The activation change must identify which older execution/coverage
rules it replaces and preserve their remaining security and ownership decisions.
See [the module contract](../../scripts/pr-review/README.md) for library interfaces
and offline checks. Model access and production execution require separate evidence.

The target Sol configuration intentionally replaces the legacy Terra review slot
for consistent fleet configuration. This is an explicit target selection, not a
claim that Sol is already LIVE or a change to the application inference models.

A scope containing only files excluded by the existing, base-approved project
input policy may complete as NOT_APPLICABLE with a PASS gate result. The trusted
collector must account for every path and record the policy hash; the report
identifies excluded paths and claims no model review. Any reviewable source,
unknown exclusion, source omission or failed collector remains blocking. New
exclusions require their own reviewed policy change.

Activation must update the BASELINE live roster row and identify superseded
execution rules while retaining their remaining security/custody requirements.
The machine tag `kiro-fable` is a compatibility identifier for the Opus AWS role,
not a model-brand assertion; its requested model is recorded separately. Renaming
receipt keys is outside this policy change.

Static policy checks and offline protocol tests apply to the staged library.
Provider access and runtime activation evidence belong to the later activation.

## Verification

```yaml
files:
  - path: docs/decisions/BASELINE.md
    must_contain:
      - "| **LIVE** | Documentation language"
      - "| **GATED** | Specialist review protocol"
  - path: scripts/pr-review/README.md
    must_contain:
      - "The legacy review pipeline remains active."
      - "compatibility identifier"
      - "Terraform/tfvars"
```
