# PR review module

[README.md](README.md) and the [project contract](../../docs/pr-review-specialists.md)
own the active `ROLE_REVIEW=1` path. Keep legacy entrypoints for compatibility;
the [runbook](../../docs/runbooks/pr-review-panel.md) and
`tests/unit/test-pr-review-panel.sh` retain their historical/legacy scope.

The installed path uses `prepare_roles.py`, `run_role.py`, `run-specialists.sh`,
`role_review.py`, `synthesize_roles.py` and `role-controls.sh`. Executors fetch
Git data and call providers; only the protocol library is offline. Preserve BASE
policy/context checks, source custody, provider bindings, complete required-role
coverage, nonce framing and all budgets. Missing coverage cannot become PASS.

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py'` and the
README shell checks. Maintain review instructions, guides and output in English.
Product localization and historical records have separate language rules.
