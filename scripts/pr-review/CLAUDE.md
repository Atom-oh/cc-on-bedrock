# PR review module

CI uses `run-panel.sh`, `simple_review.py` and `synthesize.sh`: one Codex report,
one Claude report and a tool-free Claude chair. All four review checklists must
be covered by both reports. Kiro and the `ROLE_REVIEW` routing switch are removed
from this path. Preserve trusted BASE checkout, immutable diff selection,
nonzero-exit rejection, secret redaction and latest-HEAD publication.

[README.md](README.md) and the [runbook](../../docs/runbooks/pr-review-panel.md)
describe the active path. `tests/unit/test-pr-review-panel.sh` exercises it with
local CLI stubs and no provider calls.

The separately retained specialist tools use `prepare_roles.py`, `run_role.py`, `run-specialists.sh`,
`role_review.py`, `synthesize_roles.py` and `role-controls.sh`. Executors fetch
Git data and call providers; only the protocol library is offline. Preserve BASE
policy/context checks, source custody, provider bindings, complete required-role
coverage, nonce framing and all budgets. Missing coverage cannot become PASS.

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py'` and the
README shell checks. Maintain review instructions, guides and output in English.
Product localization and historical records have separate language rules.
