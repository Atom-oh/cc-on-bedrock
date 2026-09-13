# PR review module

The live CI entrypoints are `run-panel.sh` (legacy panel), `synthesize.sh` (chair)
and `lib.sh` (shared helpers). `agents/pr-review-notools.json` defines the Kiro
no-tools profile. Their current behavior remains authoritative until activation.
See [the runbook](../../docs/runbooks/pr-review-panel.md) and
[legacy tests](../../tests/unit/test-pr-review-panel.sh).

[README.md](README.md) defines the planned specialist contract. The Python library,
its tests and its test workflow arrive in a later implementation PR. Run those
checks only once present. Keep new documentation in English; planned protocol
output becomes English at activation. Preserve source custody, budgets and
current safety controls when integrating the executors.
