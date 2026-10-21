---
status: Accepted
date: 2026-09-13
verification_required: true
runtime_required: false
---

# ADR-013: Specialist review protocol and documentation convention

## Status

Accepted, 2026-09-13. Documentation convention: **LIVE**. Specialist protocol:
**INACTIVE** in CI since the 2026-10-18 amendment below (retained behind `ROLE_REVIEW=1`;
active CI path revised by the 2026-10-21 amendment). Runtime service availability and
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

## Amendment 2026-10-18 — simplified review, ADR Compliance CI removed

Owner decisions:

1. **Simplified review.** CI runs the lens panel → chair `VERDICT: PASS|FAIL` path
   (`ROLE_REVIEW=0`), the same shape as the owner's other projects, with a 12,000-line diff
   cap. The specialist protocol stays in the tree and is re-enabled with `ROLE_REVIEW=1`.
   Motivation: the role protocol's 95 KB / 3,000-line request limits and required-role
   timeouts (e.g. a 600 s requirements-role timeout on an 80 KB diff) blocked feature PRs
   without producing findings, and forced splits that reviewers then flagged as
   cross-PR "missing code".
2. **ADR Compliance CI removed.** `adr-verify-pr.yml` and `adr-verify-main.yml` are deleted;
   ADR `## Verification` blocks remain as documentation and can be checked locally. The
   `adr-fail` label path of `issue-auto-implement.yml` has no producer any more.

Safeguards on the simplified path: the chair runs with no tools and no MCP servers
(`--tools "" --strict-mcp-config`) because the job runs under `pull_request_target` with
runner credentials; Kiro cells keep the no-tools agent; a cell that exits non-zero is not
credited as a response; a missing/invalid chair verdict fails closed.

Known gaps (accepted): Codex cells use a `read-only` sandbox that can still read runner
files (output is secret-scrubbed); renames out of an excluded directory are classified by the
old path only; no specialist evidence artifact is retained; legacy prompts request Korean
review output (the English-output rule applies to the specialist path).

## Amendment 2026-10-21 — Codex lens panel, Claude chair, Kiro removed

Owner decision: keep `ROLE_REVIEW=0` and simplify the active path to the same shape as the
owner's other projects (e.g. ttobak). This supersedes the panel roster of the 2026-10-18
amendment; that text is kept as history.

1. **Panel.** Codex only (`PANEL_MODEL`, default `global.openai.gpt-6.1-sol`), one cell per
   lens L2–L5 in parallel, diff on stdin, web search disabled, `read-only` sandbox, an
   allowlisted environment (`AWS_*`/`CODEX_*` only; no `GH_TOKEN`/`GITHUB_TOKEN`/
   `KIRO_API_KEY`), up to `PANEL_RETRIES` attempts. Kiro is removed from the panel and the
   `scripts/pr-review/agents/pr-review-notools.json` agent file is deleted.
2. **Fail-closed coverage.** Any lens Codex did not complete sets `coverage-severe.flag` and
   forces `VERDICT: FAIL`, whatever the chair decided.
3. **Chair.** Claude Opus 5.5 (`global.anthropic.claude-opus-5-5`, fallback
   `global.anthropic.claude-opus-5`), tool-less (`--tools "" --strict-mcp-config
   --setting-sources ""`), reviews the same diff as the second independent reviewer,
   adjudicates the Codex findings and emits exactly one final VERDICT. The PR title reaches
   it on stdin as untrusted data.
4. **Diff custody.** The diff is built with `git diff` from the pinned merge-base/HEAD
   commits. Diffs over 12,000 lines or 512,000 bytes are blocked (fail closed), never
   truncated. A sha256 check confirms the chair sees the bytes the panel reviewed.
5. **Specialist protocol** (`run-specialists.sh`, `ROLE_REVIEW=1`) is retained but inactive.

History: #127 added a Codex + Claude two-reviewer panel path; #131 reverted it because the
Claude panel reviewer kept exiting without the coverage marker. This amendment supersedes
both: Claude reviews only as the chair, so no Claude panel cell or coverage marker is needed.

Known gaps (accepted): with one panel vendor, cross-family checking rests on the chair; the
Codex `read-only` sandbox can still read runner files (output is secret-scrubbed). Lens
prompts and the chair now request English review output.

## Verification

```yaml
files:
  - path: docs/decisions/BASELINE.md
    must_contain:
      - "| **LIVE** | Documentation language"
      - "Specialist review protocol"
  - path: scripts/pr-review/README.md
    must_contain:
      - "ROLE_REVIEW=1"
      - "compatibility identifier"
      - "Terraform/tfvars"
```
