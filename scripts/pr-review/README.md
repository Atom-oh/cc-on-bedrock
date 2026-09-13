# Specialist review protocol

CI activates this protocol with `ROLE_REVIEW=1`. The trusted preparer selects
complete project-approved input; executors send issued nonce-framed requests;
aggregation verifies receipts and responses; synthesis adjudicates only when
needed. See [the project contract](../../docs/pr-review-specialists.md).

Target responsibilities: Codex `global.openai.gpt-6-astra` checks correctness;
Kiro `claude-opus-5` checks AWS; Kiro `gpt-5.6-sol` checks operations; Claude
`global.anthropic.claude-fable-5-1` checks auth/data/API/ADR requirements. Sol is an
intentional replacement for the legacy Terra slot in the active workflow. Kiro
aliases and Bedrock profile IDs are separate namespaces. The `kiro-fable` tag is
the compatibility name of the Opus slot. Review artifacts are English-only.

## API and files

Run `python3 scripts/pr-review/role_review.py COMMAND --help` for exact flags.

| Command | Contract |
| --- | --- |
| `prepare` | Accept approved diff/context files, HEAD/base SHAs and work directory; optional authoritative paths/provenance. Write `role-plan.json` and `roles/TAG.txt/.diff`. Invalidate old result, request and timing records. |
| `issue` | Given work directory and required tag, generate a fresh nonce and persist exact `requests/TAG.prompt/.input` plus `slot/TAG-request.json`. Call before every provider attempt. |
| `record` | Given tag, output/stderr files, exit code and issued `--nonce`, require the matching issued receipt and validate/scrub the response. Write `slot/TAG-result.json`. |
| `aggregate` | Require matching receipts and valid complete results. Write `role-summary.json`, `responded.txt`, `chair-mode.txt`, and applicable `coverage-severe.flag`/`deterministic-review.md`. |

The executor sends the issued framed bytes and retains their receipt with the
result. A result cannot nominate a different nonce. Hashes bind prepared inputs,
provenance, issued frames and results; they are not provider signatures or proof
of a model's identity, honesty or transport. The trusted executor and upstream
collector remain responsible for actual execution and complete source selection.

Start each job with a fresh work directory before collecting current inputs.
`prepare` removes prior `*-result.json`, `*-request.json` and timing files from
`slot/`; current upstream failure flags remain. Aggregation treats upstream
`*.flag` files under the work tree as failures, except its own root
`coverage-severe.flag`. Upload issued receipts alongside results and safe source
metadata. `failure_codes` is canonical; `failures` is a compatibility alias.

## Coverage and limits

Trusted code routes untrusted path/content data conservatively. Codex and Claude
remain required across families; only clearly irrelevant Kiro roles are inactive.
Missing/failed/invalid required output is never NOT_APPLICABLE. Structural checks
reject incomplete hunks and incomplete new/deleted-file records; approved
metadata-only deletions must be explicitly identified by trusted provenance.

Bounds: 95,000 UTF-8 diff bytes, 3,000 lines, up to 24,000 context bytes and a
complete request below 128 KiB. Projects may impose smaller limits. The caller
must retain its own source exclusions, state/secret custody and budget controls.
Never replace a required project collector with raw Git input. There is no chunk
coordinator: oversized input blocks; independent PASS results cannot be combined
to claim coverage of a larger change.

Exit 2 means blocked. After aggregate exit 0, read `chair-mode.txt`: `deterministic`
permits the prepared clean summary, while `review` requires substantive
adjudication. Coverage failure produces FAIL and cannot be waived by the chair.
Scope assertions do not prove that every defect was found.

## Verification

`python3 -m unittest discover -s scripts/pr-review -p test_role_review.py -v`
uses no provider credentials or model calls. Also verify
executors, project input preparation, invocation limits and exact-head publishing.

## Collector input schema

`--paths` names a UTF-8 JSON array of unique repository-relative changed paths,
for example `["src/api.ts", "docs/architecture.md"]`. It must cover the prepared
patch exactly. Paths cannot escape the repository. Omit this flag only when the
patch itself is authoritative and its paths are unambiguous.

`--provenance` names a JSON object with these required fields:

| Field | Value |
| --- | --- |
| `head_sha` | The same 40-character lowercase Git SHA as `--head`. |
| `base_sha` | The same 40-character lowercase Git SHA as `--base`. |
| `diff_sha256` | SHA-256 of the exact raw `--diff` bytes before framing or scrubbing. |

Optional `input_failures` is an array of static failure codes; any entry blocks
coverage. Optional `path_only` is an array of collector-approved metadata-only
deletions. The trusted collector must verify deletion scope before withholding
bodies; this does not permit omitting arbitrary source changes. MRA uses this
hook for its existing state-file deletion custody policy.

Minimal provenance (replace all values with the actual supplied revisions/hash):

```json
{"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","base_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","diff_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
```

A configured exclusions-only input additionally requires
`scope_exception: "configured_exclusions_only"`, a 64-character
`input_policy_sha256`, and matching nonempty `scope_paths` / `excluded_paths`
arrays of safe unique paths. Its prepared diff and `--paths` must both be empty.
The upstream collector verifies the approved policy against the base revision.
A missing or accidentally empty patch never qualifies as this exception.


Each reissue archives prior results in `slot/TAG-attempts.json`. Model-selection,
fallback, quota and agent-preflight failures stay blocking until a new preparation.
Summaries retain attempt history; retries cannot erase terminal diagnostics.
