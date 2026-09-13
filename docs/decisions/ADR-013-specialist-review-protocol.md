# ADR-013: Specialist review protocol

## Status

Accepted, 2026-09-13 (design; not live activation). Protocol library staged; the legacy workflow is still
active. Activation must be reviewed separately with its input and runner controls.

## Decision

Assign distinct responsibilities to the supported model pool instead of repeating
every lens. Codex uses GPT-6 Astra, Kiro uses Opus 5 and GPT-5.6 Sol, and the Claude
role uses Fable 5.1. Require complete, immutable-scope reports and independent
OpenAI/Anthropic primary coverage. Only trusted routing can mark a role inactive.
Use random-nonce input boundaries and bind invocation nonces into result digests.

A complete report without blocking candidates or uncertainty may receive a
deterministic summary. A chair adjudicates substantive candidates, but cannot
waive missing or invalid coverage. Preserve existing project input exclusions,
secret/state custody, context and budgets. No quota or billing limits are raised.
Review instructions and output are English to avoid duplicate translations.

This records intent and the new library; it does not supersede the live legacy
workflow yet. The activation change must identify which older execution/coverage
rules it replaces and preserve their remaining security and ownership decisions.
See [the module contract](../../scripts/pr-review/README.md) for current interfaces
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
