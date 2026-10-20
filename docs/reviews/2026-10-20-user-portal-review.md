# User portal review — 2026-10-20

Scope: the user requested project review and improvement, prioritizing user
features and usability. The review used origin/main `642820b` and followed the
environment start/stop, progress, storage and settings flows. Cloud resources were
not modified or deployed.

## Findings and fixes

| Severity | User-visible problem | Result |
|---|---|---|
| High | Failed initial status queries looked like an absent environment; failed refreshes silently displayed old data | Explicit unavailable/stale states, refresh and sign-in recovery, last-checked time, and disabled start/stop controls while stale |
| High | The status API omitted stopping instances; the stop handler also treated failed polls or an exhausted timer as completion | Keep `STOPPING` visible and use the shared status poll; only a successful status response can confirm completion |
| Medium | A progress stream ending before the final event left an indefinite spinner; Strict Mode effect replay could abort the only start request | Require a terminal event, handle truncated UTF-8/chunks and connection failure, bound tracking time, and defer the start so effect replay sends one POST |
| Medium | “Cancel” closed the stream but could leave the environment starting; storage progress used a different event name from the UI | Rename the action to close progress, explain that startup may continue, refresh status, and align `storage_prepare` |
| Medium | Port settings failed to load silently; failed saves had no network-error recovery; version conflicts automatically discarded edits | Block saves before initial load, retain the draft on network/conflict errors, require explicit reload after conflict, and confirm successful saves |
| Medium | CI ignored every dashboard test failure with `|| true` | Vitest failures now fail CI |

Portal tab labels and recovery messages follow the selected Korean/English locale.
New lifecycle errors use alert semantics. Port fields have accessible names, and
the port editor wraps at narrow viewport widths.

## Verification

- TypeScript validation, a production build, and all 214 dashboard Vitest tests.
- Added contract tests for successful/failed/malformed status responses,
  ownership-preserving lifecycle status, hibernation, authentication, split UTF-8
  progress events, incomplete streams, terminal events and policy errors.
- Thirteen Chromium fixture checks passed: initial failure/retry, stale-state
  protection, expired-session recovery, stop confirmation, interrupted and complete
  progress, Strict Mode single-request behavior, close-tracking behavior, failed
  settings load, draft preservation on conflict/network error, successful retry,
  non-overlapping slow status requests, mobile layout/keyboard navigation, and no uncaught browser errors. Some checks
  combine related assertions.
- The browser exercised the real components with mocked API responses, including a
  390 px mobile viewport. This verifies UI behavior, not live Cognito/EC2 behavior.

## Limited developer-setup check

Applicable file checks: **7/8 (87.5%)**. README, license, ignore rules, architecture
documentation, dashboard guidance, test guidance and the dashboard environment
example exist. Current main has no tracked root `AGENTS.md`; a generated file in
the original working tree remains outside this change. The canonical `CLAUDE.md`
and scoped guidance were used for this review.

This file-presence score is not a product-quality or security score. Optional host
hooks and integrations were not scored; their execution/trust was not verified.
The AWS security review was limited to preserving the touched API's existing
session and per-user boundaries. No live infrastructure audit or penetration test
was performed.

## Remaining opportunities

- Usage and disk widgets still need consistent unavailable/stale states.
- Settings and onboarding retain mixed Korean/English text outside the updated
  portal navigation and recovery controls.
- Clipboard actions still need explicit permission-denied feedback.

These are follow-up improvements; this change focuses on lifecycle recovery and
preserving user edits.
