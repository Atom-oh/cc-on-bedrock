---
name: code-review
description: Review local changes in this repo (default `git diff`) for real bugs, security issues and violations of CLAUDE.md rules, reporting only high-confidence findings.
---

# Code Review

Review changed code and report only issues you are confident are real, so the author's time goes to findings that matter.

## Scope

By default, review unstaged changes from `git diff`. The user may name other files, a branch or a commit range.

## What to look for

- **Project rules** from the root and module `CLAUDE.md` files. The ones most worth checking here: Terraform-only IaC, no hardcoded account/domain/region, no public ingress (`0.0.0.0/0`, public IPs, new internet-facing LBs), Cognito self sign-up off, BASELINE updated with any ADR/flag change, and the Codex IAM parity rules (no `bedrock-mantle:*`).
- **Bugs**: logic errors, null/undefined handling, race conditions, leaks, error paths that fail open.
- **Security**: OWASP Top 10, authz gaps in API routes (session check, admin/dept scope), IAM wildcards.
- **Quality**: duplication, needless complexity, missing tests for changed behavior, accessibility in UI code.

Verify a suspected issue against the surrounding code before reporting it; pre-existing issues outside the change are out of scope unless the change makes them worse.

## Confidence

Rate each candidate 0-100 and report only those at 75 or above:

- 90-100: confirmed and important; label `CRITICAL`.
- 75-89: verified real issue; label `IMPORTANT` and include a fix.
- Below 75: likely nitpick, speculative or pre-existing; leave it out.

## Output

For each issue:

```
### [CRITICAL|IMPORTANT] <issue title> (confidence: XX)
**File:** `path/to/file.ext:line`
**Issue:** what is wrong and why it matters
**Guideline:** the CLAUDE.md rule or security standard, if one applies
**Fix:** concrete change
```

If nothing reaches the threshold, say so in a sentence or two.
