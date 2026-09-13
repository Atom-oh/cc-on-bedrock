# ADR-013: Specialist review protocol

## Status

Accepted 2026-09-13. CI activates specialist responsibilities with `ROLE_REVIEW=1`
and retains the project input, runner, coverage and publication safeguards.

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

This supersedes the repeated model-by-lens matrix, permissive dropout floor and
unconditional chair call. Existing security, source-custody, context, ownership
and budget decisions remain in force.
See [the module contract](../../scripts/pr-review/README.md) for current interfaces
and offline checks. Model access and production execution require separate evidence.

Sol intentionally replaces the legacy Terra review slot for fleet consistency;
application inference model configuration remains unchanged.
