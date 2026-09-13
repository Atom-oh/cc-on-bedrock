# Specialist review protocol

CI selects `ROLE_REVIEW=1`: the installed provider executors prepare immutable
inputs, run specialists and conditionally invoke the chair. The legacy scripts
remain compatibility entrypoints. See [the project contract](../../docs/pr-review-specialists.md).
Only `role_review.py` is offline; executors fetch Git data and invoke provider CLIs.

| Tag | Requested model | Scope |
| --- | --- | --- |
| codex | `global.openai.gpt-6-astra` | Implementation/tests |
| kiro-fable | `claude-opus-5` | AWS/IAM/network |
| kiro-sol | `gpt-5.6-sol` | Deployment/contracts/recovery |
| claude-self | `global.anthropic.claude-fable-5-1` | Auth/data/API/ADR |

`kiro-fable` is a stable compatibility identifier for the Opus AWS role, not a
model name. Receipt/file keys retain it; the model column is the requested model.
`ROLES` governs specialists; legacy files govern legacy execution. Kiro/Bedrock
IDs differ. English is requested, not validated; configured IDs do not attest weights.

## Installed executors

`run-specialists.sh DIFF LENSES WORK` prepares input, runs required roles and
aggregates results. `LENSES` is retained for legacy call compatibility. The
workflow separately calls `synthesize_roles.py` when adjudication is
required. `run_role.py` invokes the configured provider; `role-controls.sh` strips
control bytes. These are executable provider paths, not offline-only utilities.

`prepare_roles.py` requires the trusted BASE checkout, calls `gh api` for the
merge base and fetches immutable Git objects without checking out PR-head code.
Inputs use `HEAD_SHA`, `BASE_SHA`, and `GH_REPO` or `GITHUB_REPOSITORY`.
`REVIEW_CONTEXT_CAP`, `PANEL_TIMEOUT`, `PANEL_RETRIES` and
`KIRO_PREFLIGHT_TIMEOUT` retain their bounded settings. Chair defaults are
`global.anthropic.claude-fable-5-1` and `global.anthropic.claude-opus-5`;
project policy/legacy settings still own time, turn and fallback budgets.

Base `AGENTS.md` takes precedence over `CLAUDE.md`. A generated co-agent marker
must carry the matching first 12 SHA-256 characters of its CLAUDE source;
missing, stale or oversized context blocks preparation. Candidate context is
checked but never becomes trusted instructions.

`role-input-scope.json` schema 1 mirrors the existing lockfile, binary and
build/dependency exclusions. Its string arrays are `basenames`, `extensions`,
parent `directories`, `prefixes` and optional `path_regexes`; only BASE policy
narrows scope, and provenance discloses excluded paths. Optional
`role-project.json` selects the base-verified `prepare_project_roles.py` adapter
and chair/context policy. Without an adapter, an optional
`prepare_context_roles.py` hook must match BASE bytes and cannot raise the
context cap. This repository currently uses generic preparation.

## API and input

`python3 scripts/pr-review/role_review.py COMMAND --help` lists flags.

| Command | Contract |
| --- | --- |
| prepare | Diff/context, HEAD/base, work; optional paths/provenance → `role-plan.json`, `roles/TAG.txt/.diff`. |
| issue | Work/tag → nonce, exact `requests/TAG.prompt/.input`, `slot/TAG-request.json`. Call before each attempt. |
| record | Tag, output/stderr, exit code, issued nonce → validated, scrubbed `slot/TAG-result.json`. |
| aggregate | Validate results/receipts → `role-summary.json`, `responded.txt`, `chair-mode.txt`, applicable report/flag. |

The executor sends issued bytes; hashes bind inputs, not transport. Keep tool data
out of diagnostics.

`--paths`: a file containing a UTF-8 JSON array of unique repository-relative paths matching the patch,
e.g. `["src/api.ts"]`. Renames use destinations; the collector checks both sides.
Omit only for authoritative, unambiguous patch paths.

`--provenance`: a file containing a JSON object. Required `head_sha`/`base_sha` equal the lowercase
40-character CLI revisions; `diff_sha256` hashes exact raw diff bytes. Example:

```json
{"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","base_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","diff_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
```

Optional `input_failures` contains codes matching `[a-z][a-z0-9_:.-]{0,63}`; any code
blocks. Invalid provenance is discarded and blocks; stored values are scrubbed.
Optional `path_only: list[str]` identifies collector-approved metadata-only
deletions. Verify eligibility before withholding bodies.

## Coverage and lifecycle

Codex/Claude are required for reviewable source; trusted routing may deactivate
irrelevant Kiro roles. App Router React is conservative. Failed output is never
N/A. Parsing misses whole omissions/some cut prefixes: verify Git scope/hashes.
Terraform/tfvars, IAM, user-data, authentication, network and deployment paths or
content require AWS and operations review; routing cannot deactivate those roles.
Unclassified source remains conservative rather than receiving an irrelevant label.

BASE-approved exclusions-only scope may yield NOT_APPLICABLE/PASS without models.
Require empty diff/paths, `scope_exception: configured_exclusions_only`, lowercase
64-character `input_policy_sha256`, and identical nonempty unique safe
`scope_paths`/`excluded_paths`. The collector verifies policy/all paths; the report
shows exclusions/hash. Accidental empty input never qualifies. New exclusions
need policy review; project-specific exceptions remain.

Start fresh work before collection. `prepare` clears owned results/receipts, claims,
duplicate/terminal flags and histories; upstream flags remain. Issue/record exclude
each other; interrupted operations require fresh work. Duplicate records retain
the first result and block. Finish writers before aggregation. Reissue archives
32 prior results in `slot/TAG-attempts.json`; model-selection/fallback/quota/preflight
failures block until new preparation. Summaries retain history. All `*.flag` files
block except the aggregator's own root `coverage-severe.flag`, which it rewrites from
current evidence; upstream flags are never exempt. `failure_codes` is canonical; `failures` aliases it.
The root `coverage-severe.flag` pathname is reserved exclusively for aggregation.
Collectors/executors must use distinct upstream flag names, never that reserved
path; their flags survive preparation and always block. This is a trusted-writer
contract, not a claim that an unkeyed hash authenticates filesystem writers.

Exit 2 means blocked. Aggregate exit 0: `deterministic` permits the report when no
blocking candidate/uncertainty exists (Minor/Info remain); `review` needs a chair.
Blocked input yields deterministic FAIL; the chair cannot waive coverage failures.

For a normally completed `aggregate` invocation:

| Exit / mode | Required artifacts and consumer action |
| --- | --- |
| 0 / `deterministic` | Current `role-summary.json`, `responded.txt`, `chair-mode.txt` and `deterministic-review.md`; only its validated final verdict may be published. |
| 0 / `review` | Current summary/responded/mode files; no deterministic report. Run the chair against this evidence. |
| 2 / `blocked` | Current summary/responded/mode files, `coverage-severe.flag` and a deterministic FAIL report; never waive this through a chair. |
| Abnormal exit, usage/I/O error or missing/mismatched artifacts | Execution failure; no output is guaranteed and stale reports cannot be credited. |

Exit 0 alone is not an approval signal. A fresh work directory is the start of a
new preparation; retries within it retain history, while a new preparation clears
owned history. Reissue of valid results is forbidden. Invalid nonterminal results
may be archived up to 32 times; overflow blocks instead of dropping older evidence.

Publish scrubbed reports/receipts/metadata only; never raw `roles/*.diff` or
`requests/*.input/.prompt`.

## Limits and checks

Limits: 95,000 diff bytes (UTF-8), 3,000 lines, 24,000 context bytes, <128 KiB
request; projects may lower them. Oversize blocks. No chunk coordinator or
combining partial PASS results; preserve custody/budgets.

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py'`.
Run `bash -n` separately for `run-specialists.sh`, `role-controls.sh` and `lib.sh`.
Offline CI: `.github/workflows/pr-review-roles-tests.yml`. Also retain
executor/adapter, limit and exact-HEAD publication tests; offline success proves
no live provider execution.

Sol replaces this repository's legacy Terra slot in this workflow; application
inference models remain unchanged.

Exclusions-only review requires both `--allow-exclusions-only --policy FILE`.
The trusted BASE collector supplies a schema-1 policy; its exact bytes must match
`input_policy_sha256`. The private `exclusions-policy.json` anchor is rechecked
during aggregation. Missing or mismatched opt-in blocks. The collector, not this
offline library, must establish complete Git scope and approved exclusions.

A valid result cannot be reissued to discard findings or uncertainty. Start a new
preparation for a new review; failed attempts retain their diagnostic history.

Codex/Claude rows use Bedrock Runtime IDs; Kiro rows use Kiro catalog aliases.
Local Codex on Mantle uses `openai.gpt-6-astra`; these namespaces are distinct.

Codex uses structured events and the CLI-designated final-message file. Progress
and tool output cannot substitute for a review; terminal diagnostics still block.
