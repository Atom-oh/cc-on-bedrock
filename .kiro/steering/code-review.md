# Code Review

Review changed code with confidence-based scoring.

## Scope
By default, review unstaged changes from `git diff`. User may specify different scope.

## Criteria
- Project guidelines compliance (AGENT.md, steering docs conventions)
- Bug detection: logic errors, null handling, race conditions, security (OWASP Top 10)
- Code quality: duplication, complexity, error handling, accessibility

## Confidence Scoring (0-100)
- **< 75**: Do not report (likely false positive or minor nitpick)
- **75-89**: Report with fix suggestion
- **90-100**: Must report (critical issue)

## Output Format
```
### [CRITICAL|IMPORTANT] <issue title> (confidence: XX)
**File:** `path/to/file.ext:line`
**Issue:** Description
**Fix:** Concrete code suggestion
```

If no high-confidence issues, confirm code meets standards with brief summary.
