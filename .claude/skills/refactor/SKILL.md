---
name: refactor
description: Restructure existing code in this repo without changing behavior, in small verified steps.
---

# Refactor

Improve the structure of existing code without changing its behavior.

## Approach

1. **Understand.** Identify the target code, its callers and dependencies, and the tests that cover it. If coverage is thin, suggest adding characterization tests first.
2. **Plan.** Tell the user what will change, what will not, and the risk (low/medium/high). For a small, low-risk change a sentence is enough.
3. **Change in small steps.** Run the relevant tests after each step (`npx vitest run`, `python3 -m pytest ...`, or `bash tests/run-all.sh`). Keep commits atomic.
4. **Verify.** Existing tests pass, behavior is unchanged, and the refactor achieved its goal.

Favor clear single-responsibility units and removing real duplication, but don't add abstractions the code doesn't need yet.
