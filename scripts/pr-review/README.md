# Specialist review protocol

This change introduces the protocol library, `role_review.py`, and its offline
regression tests. The current `pr-review.yml` still runs the legacy panel. Provider
execution, project input adapters and activation follow in a separate reviewed
change; this library alone changes no live review or deployment behavior.

The approved target roles are Codex (`global.openai.gpt-6-astra`) for correctness,
Kiro Opus (`claude-opus-5`) for AWS, Kiro Sol (`gpt-5.6-sol`) for operations, and
Claude (`global.anthropic.claude-fable-5-1`) for auth/data/API/ADR requirements.
Kiro aliases differ from Bedrock profile IDs. A configured identity does not prove
provider routing. English is the language of this protocol and its review output.

`prepare --diff FILE --context FILE --head SHA --base SHA --work DIR` validates
complete input and writes role prompts and fingerprints. Optional `--paths FILE`
provides an authoritative JSON path manifest; `--provenance FILE` binds the
trusted collector's scope and exclusions. Limits are 95,000 UTF-8 diff bytes,
3,000 lines, at most 24,000 context bytes and a complete bounded request. Projects
may require smaller limits. Oversize input is blocked, never awarded prefix credit.

The executor must call `frame_request` with a fresh random 32-hex nonce for each
attempt. `record --work DIR --tag TAG --output FILE --stderr FILE --exit-code RC
--nonce NONCE` validates the response and binds that nonce into its request digest.
Missing, malformed, failed, stale or incomplete required responses block.
`aggregate --work DIR` writes `role-summary.json` and `chair-mode.txt`: complete
uncontroversial reports can use deterministic synthesis; substantive findings need
adjudication; coverage failure cannot be waived. `failure_codes` is the diagnostic
field; `failures` is a compatibility alias. These are scope attestations, not proof
that a model found every defect.

Before activation, preserve each project's approved input filtering, state/secret
custody, context, no-tools checks, invocation budgets and publishing safeguards.
Never feed a filtered-input workflow through a raw Git fallback. Project exceptions
need explicit provenance. Runtime and workflow changes use the trusted PR base;
head code and instructions remain untrusted review data.

Run `python3 -m unittest discover -s scripts/pr-review -p test_role_review.py -v`.
These tests use no provider credentials or model calls.
