# Specialist review protocol

CI selects `ROLE_REVIEW=1`: trusted project inputs feed specialist executors,
validated results feed aggregation, and substantive findings reach the chair.
See [the project contract](../../docs/pr-review-specialists.md).

| Tag | Requested model | Responsibility |
| --- | --- | --- |
| `codex` | `global.openai.gpt-6-astra` | Implementation, concurrency, tests |
| `kiro-fable` | `claude-opus-5` | AWS, IAM, networking |
| `kiro-sol` | `gpt-5.6-sol` | Deployment, contracts, recovery |
| `claude-self` | `global.anthropic.claude-fable-5-1` | Auth, data, API, ADR requirements |

`kiro-fable` means Opus. Kiro aliases differ from Bedrock profile IDs. `ROLES`
governs specialists; existing roster files govern legacy execution. Prompts request
English (not mechanically validated). Configuration does not attest model weights.

## API

Run `python3 scripts/pr-review/role_review.py COMMAND --help` for flags.

| Command | Input and output |
| --- | --- |
| `prepare` | Diff/context, HEAD/base, work; optional paths/provenance. Writes `role-plan.json`, `roles/TAG.txt/.diff`; invalidates old results. |
| `issue` | Work/tag → fresh nonce, `requests/TAG.prompt/.input`, `slot/TAG-request.json` receipt; call before every attempt. |
| `record` | Tag, output/stderr, exit code, issued `--nonce` → receipt validation and scrubbed `slot/TAG-result.json`. |
| `aggregate` | Validates results/receipts → `role-summary.json`, `responded.txt`, `chair-mode.txt`, applicable flag/report. |

The executor sends issued bytes and retains receipts. Hashes bind input,
provenance and results, not actual transport. The collector owns source completeness.

## Collector input

`--paths`: UTF-8 JSON array of unique repository-relative paths, e.g.
`["src/api.ts"]`, matching the patch. Renames use destinations; the collector
checks both sides. Omit only for authoritative, unambiguous patch paths.

`--provenance` names a JSON object. Required `head_sha` and `base_sha` equal the
40-character lowercase CLI revisions; `diff_sha256` hashes the exact raw diff
bytes before framing/scrubbing. Minimal example, with illustrative values:

```json
{"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","base_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","diff_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
```

Optional `input_failures` is a list of codes matching `[a-z][a-z0-9_:.-]{0,63}`;
any code blocks input. Invalid provenance is discarded and blocks. Persisted
provenance values are scrubbed. Optional `path_only: list[str]` identifies
collector-approved metadata-only deletions: verify deletion eligibility before
withholding bodies. This hook does not authorize omitting arbitrary changes.

## Coverage and exceptions

Codex/Claude remain required across families for reviewable source. Trusted
routing may deactivate clearly irrelevant Kiro roles; App Router React files
remain conservative. Failed, missing, stale or invalid output never means N/A.

An existing, BASE-approved exclusions-only policy may mark all roles
NOT_APPLICABLE and return PASS without model calls. The collector must verify
that policy and account for all Git paths. Provenance requires
`scope_exception: "configured_exclusions_only"`, a 64-character lowercase
`input_policy_sha256`, and matching nonempty, unique, safe `scope_paths` and
`excluded_paths` lists; the prepared diff and `--paths` must be empty. The report
shows excluded paths/hash and claims no model review. Missing or accidentally
empty input never qualifies. New exclusions require a reviewed policy change.
Project-specific collectors retain their own exception rules.

Parsing rejects incomplete hunks but cannot detect whole omitted files or all
cut prefixes. Validate source scope/hashes upstream; retain required collectors.

## Lifecycle and outcomes

Start with fresh work before collecting input. `prepare` clears owned results,
receipts, timings, claims, duplicate/terminal flags and histories; upstream flags
remain. Old request copies lack valid receipts. Duplicate records retain the first
result and block; finish all writers before aggregation.

Reissue archives up to 32 results in `slot/TAG-attempts.json`. Model-selection,
fallback, quota and agent-preflight failures stay blocking until new preparation.
Summaries retain history. All work-tree `*.flag` files block except the engine's
root `coverage-severe.flag`. `failure_codes` is canonical (`failures` is an alias).

Exit 2 means blocked. After aggregate exit 0, `chair-mode.txt` is `deterministic`
for complete results with no blocking candidate/uncertainty (Minor/Info remain),
or `review` for required adjudication. Blocked input yields a deterministic FAIL;
a chair cannot waive missing coverage. Scope attestation is not proof of no bugs.

Never upload raw `roles/*.diff` or `requests/*.input/.prompt`. Upload only selected
scrubbed reports, issued receipts and safe source metadata.

## Limits and verification

Limits: 95,000 UTF-8 diff bytes, 3,000 lines, context up to 24,000 bytes, complete
request below 128 KiB. Projects may lower these. Oversized input blocks; there is
no chunk coordinator and separate PASS results cannot establish larger coverage.
Preserve existing source exclusions, custody and budget controls.

Verify: `python3 -m unittest discover -s scripts/pr-review -p test_role_review.py`.
Offline CI: `.github/workflows/pr-review-roles-tests.yml`. Also run all `test_*role*.py` tests for executors/adapters, limits and publication.
Offline tests do not prove live provider success.

The target Sol slot intentionally replaces this repository's legacy Terra slot
in the active protocol; application inference models remain unchanged.
