---
status: Proposed
date: YYYY-MM-DD
verification_required: true
# Optional:
# runtime_required: false
# related: [ADR-NNN, ADR-NNN]
# superseded_by: ADR-NNN
# builds_on: ADR-NNN
---

# ADR-NNN: <title>

## Status
Proposed

## Context
<왜 결정이 필요한가, 어떤 제약/문제가 있는가>

## Decision
<무엇을 결정했는가, 어떻게 동작하는가>

## Consequences
- Positive: ...
- Negative: ...
- Mitigations: ...

## Verification

```yaml
# Tier 1: Static — deterministic file checks
files:
  - path: <path/or/glob>
    must_contain:
      - "<substring or /regex/>"
    must_not_contain:
      - "<regression guard>"

# Tier 2: Semantic — LLM-judged claims (delete if none)
semantic:
  - claim: "<one-sentence claim>"
    context_files:
      - <path/to/file>

# Tier 3: Runtime — staging-environment assertions (delete if none; staging not yet provisioned as of 2026-05-26)
# runtime:
#   - kind: bedrock-invoke
#     description: "..."
#     role_arn: "arn:aws:iam::${ACCOUNT_ID}:role/..."
#     model_ids: ["..."]
#     expect: success
```
