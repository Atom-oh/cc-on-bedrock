# Specialist PR review

CI assigns distinct responsibilities instead of asking every model to repeat
every review lens. The trusted workflow enables this protocol with
`ROLE_REVIEW=1`; legacy matrix entrypoints remain for regression fixtures.

| Slot | Configured model | Responsibility |
| --- | --- | --- |
| `codex` | `global.openai.gpt-6-astra` | Implementation, concurrency, errors and tests |
| `kiro-fable` | `claude-opus-5` | AWS architecture, IAM, networking and service constraints |
| `kiro-sol` | `gpt-5.6-sol` | Deployment order, component contracts, lifecycle and recovery |
| `claude-self` | `global.anthropic.claude-fable-5-1` | Authentication, data boundaries, requirements, API and ADR consistency |

The shared `kiro-fable` tag identifies the Opus slot. Kiro catalog aliases differ
from Bedrock inference-profile IDs. These are configured model identities, not
attestation of the provider's internal routing or weights.

## Routing and evidence

Trusted code determines which roles apply. Codex and Claude review the full change
boundary, retaining independent OpenAI/Anthropic checks for sensitive changes.
Kiro roles run for applicable AWS and operational changes, including relevant
documentation. Unfamiliar paths route conservatively. Only deterministic routing
may record NOT_APPLICABLE; provider failures never do.

`prepare_roles.py` verifies the pinned base checkout, resolves the immutable merge
base, fetches Git objects and generates a complete diff without executing head
code. It reads reviewer instructions from the base Git object. Candidate context
is checked for availability, size and generated-source freshness, then discarded.
The shared context ceiling is 24,000 bytes; repositories may enforce a smaller one.

Every result confirms its role, HEAD and reviewed paths. Host metadata binds it
to the prepared request and records the process status. Nonzero exits, malformed
or empty reports, missing paths, invalid fingerprints, model selection errors,
quota exhaustion and failed required roles block coverage. A JSON shape is
evidence of protocol completion, not proof that the model found every defect.

The common protocol accepts a complete diff within 3,000 lines and 95,000 UTF-8
bytes. It blocks oversized input without awarding credit for a prefix. Existing
repository-specific chunking is governed by its own implementation and budget;
do not remove chunk attestations or raise limits to obtain a pass.

## Execution and synthesis

Each applicable model receives one specialist request. Both Kiro roles use fresh
HOME/cwd directories and an explicit empty tool catalog with no MCP resources or
hooks. Each active Kiro job first receives a fixed canary check without PR data;
only an exact successful no-tools response permits the actual review. Its child
environment excludes AWS and GitHub credentials. Errors remain visible; no
automatic quota or billing changes are made.

Codex retains its read-only sandbox and configured Bedrock provider. Claude's
specialist has no tools. The chair has bounded local read tools and no GitHub
token. Review output is scrubbed before becoming a public artifact.

Complete, valid results with no Critical/Major candidate or uncertainty receive
a deterministic summary. Other valid results require chair adjudication. A
coverage failure receives a deterministic failure; a chair cannot waive it.
Minor/Info findings remain in the report.

With all four roles active, the ordinary path uses four review calls and two
Kiro startup checks. Adjudication adds one chair call; retries and fallback add
calls only when needed. This reduces duplicate requests, but is not a measured
wall-clock speedup. Per-role timing artifacts support before/after measurement.

## Maintenance and release

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*role*.py' -v`
and the repository's existing review tests. Offline fake CLIs validate routing,
scope, subprocess status and safety boundaries without spending model credits.
They do not establish successful live model execution.

Native `pull_request_target` uses base scripts, so a workflow-changing PR must
also have offline checks for the candidate implementation. Review the latest HEAD,
resolve real Critical/Major findings, satisfy required CI and branch rules, and
verify the integration path before merge. Missing review or quota failure is not
a clean result. Model limits and required gates remain in force.

## Approved source scope

`role-input-scope.json` preserves this repository's existing lockfile/generated-
asset exclusions. The trusted base copy classifies immutable Git paths before
requests are prepared. Provenance records every excluded path and both raw and
approved diff hashes. Renames are expanded into deletion/addition records so a
source path cannot disappear through an artifact rename. A verified exclusions-
only change is explicitly NOT_APPLICABLE and invokes no model; missing inputs,
unknown exclusions and truncated required source remain blocked. The policy does
not authorize excluding additional source merely to obtain a pass.

Approved exclusions-only input explicitly supplies `--allow-exclusions-only` and
a private `--policy` file copied from Git BASE. The engine checks its byte hash
and retains an anchor through aggregation; arbitrary provenance cannot opt in.
