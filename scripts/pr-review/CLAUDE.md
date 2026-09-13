# PR review module

[README.md](README.md) owns this module's interfaces and limits. The live workflow
still uses `run-panel.sh`, `synthesize.sh` and `lib.sh`; keep their lens definitions
synchronized until activation replaces that path.

The installed specialist path uses `prepare_roles.py`, `run_role.py`,
`run-specialists.sh`, `role_review.py`, `synthesize_roles.py` and
`role-controls.sh`. Executors fetch Git data and call provider CLIs; only the
protocol library is offline. The README documents BASE policy/context checks,
optional adapters and environment settings. Workflow activation is separate.

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py'` and the
README shell checks. Keep new documentation in English; automated output changes
at activation. Preserve source custody, configured providers and all budgets.
