# Specialist review protocol

CI selects the specialist runtime with `ROLE_REVIEW=1`. `prepare_roles.py`
prepares trusted inputs, `run_role.py` invokes each applicable specialist,
`role_review.py` validates and aggregates results, and `synthesize_roles.py`
conditionally adjudicates findings. Legacy entrypoints remain compatibility
wrappers and regression fixtures; their old matrix is not the selected CI path.
See [the current project contract](../../docs/pr-review-specialists.md).

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

Preserve each project's approved input filtering, state/secret
custody, context, no-tools checks, invocation budgets and publishing safeguards.
Never feed a filtered-input workflow through a raw Git fallback. Project exceptions
need explicit provenance. Runtime and workflow changes use the trusted PR base;
head code and instructions remain untrusted review data.

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*role*.py' -v`.
These tests use no provider credentials or model calls.
