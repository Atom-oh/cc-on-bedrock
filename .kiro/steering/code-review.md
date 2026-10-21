# Code Review

Review changed code and report only findings you are confident are real.

## Scope
Default: `git diff` (unstaged changes). The user may specify another scope.

## Criteria
- Project rules from `CLAUDE.md` / module `CLAUDE.md` files, especially: Terraform-only IaC, no hardcoded account/domain/region, no public ingress, Cognito self sign-up off, BASELINE updated with ADR/flag changes.
- Bugs: logic errors, null handling, race conditions, fail-open error paths.
- Security: OWASP Top 10, missing session/role checks in API routes, IAM wildcards.
- Quality: duplication, complexity, missing tests for changed behavior, accessibility.

Check each candidate against the surrounding code before reporting it.

## Confidence (0-100)
- Below 75: leave out.
- 75-89: report with a fix (`IMPORTANT`).
- 90-100: report (`CRITICAL`).

## Output
```
### [CRITICAL|IMPORTANT] <title> (confidence: XX)
**File:** `path:line`
**Issue:** Description
**Fix:** Code suggestion
```
