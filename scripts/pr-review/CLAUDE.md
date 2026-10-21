# PR review module

CI runs the simplified `ROLE_REVIEW=0` path (owner decision 2026-10-21, ADR-013
amendment): `run-panel.sh` runs one Codex (`PANEL_MODEL`, default
`global.openai.gpt-6.1-sol`) cell per lens L2–L5 in parallel, diff on stdin, web search
disabled, allowlisted `AWS_*`/`CODEX_*` env (no GitHub/Kiro tokens), up to
`PANEL_RETRIES` attempts. Any lens Codex did not complete sets `coverage-severe.flag` →
forced `VERDICT: FAIL`. `synthesize.sh` runs the tool-less Claude chair
(`global.anthropic.claude-opus-5-5`, fallback `global.anthropic.claude-opus-5`) as the
second independent reviewer; it adjudicates Codex findings and emits the one final
VERDICT. Kiro is not in this path. `run-panel.sh`/`synthesize.sh` are covered by
`tests/unit/test-pr-review-panel.sh`; the [runbook](../../docs/runbooks/pr-review-panel.md)
covers operations.

[README.md](README.md) and the [project contract](../../docs/pr-review-specialists.md)
own the retained, inactive `ROLE_REVIEW=1` specialist path.

The installed path uses `prepare_roles.py`, `run_role.py`, `run-specialists.sh`,
`role_review.py`, `synthesize_roles.py` and `role-controls.sh`. Executors fetch
Git data and call providers; only the protocol library is offline. Preserve BASE
policy/context checks, source custody, provider bindings, complete required-role
coverage, nonce framing and all budgets. Missing coverage cannot become PASS.

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py'` and the
README shell checks. Maintain review instructions, guides and output in English.
Product localization and historical records have separate language rules.
