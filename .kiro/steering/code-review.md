# Code Review

Review changed code with confidence-based scoring.

## Scope
Default: `git diff` (unstaged changes). User may specify different scope.

## Criteria
- Project guidelines (AGENT.md, steering docs conventions)
- Bug detection: logic errors, null handling, race conditions, security (OWASP Top 10)
- Code quality: duplication, complexity, error handling, accessibility

## Confidence Scoring (0-100)
- **< 75**: Do not report
- **75-89**: Report with fix suggestion
- **90-100**: Must report (critical)

## Output
```
### [CRITICAL|IMPORTANT] <title> (confidence: XX)
**File:** `path:line`
**Issue:** Description
**Fix:** Code suggestion
```
