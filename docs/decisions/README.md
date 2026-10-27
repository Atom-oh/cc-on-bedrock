# Architecture Decision Records

[BASELINE.md](BASELINE.md) indexes current decisions, invariants and gated items.
[../architecture.md](../architecture.md) describes current implementation.
Archived ADRs and documents under `docs/history/` describe past decisions.

## Write or amend a decision

Create an ADR only for a real architectural decision or trade-off. Follow
[_TEMPLATE.md](_TEMPLATE.md), or use `project-init:add-adr`. Allocate the next
number after the current maximum; the next number is **016**. Do not reuse
retired numbers. Update the baseline in the same change as a new decision or
status/flag change.

New or substantially rewritten ADRs use English (ADR-013). Keep context,
decision, consequences and concrete implementation/verification references.
A correction of stale implementation evidence does not require a new decision.

## Verification status

ADR Compliance CI was removed on 2026-10-18 (ADR-013 amendment, baseline §2).
`adr-verify-pr.yml` and `adr-verify-main.yml` are absent. This ADR metadata does
not create a current merge-blocking check.

Frontmatter (`status`, `date`, `verification_required`) and `## Verification`
blocks remain as decision evidence. The local `.adr-verify/` toolkit can check
supported static claims when its dependencies/configuration are available;
semantic claims require independent source/runtime verification. Report checks
actually run. Historical pipeline descriptions live in the release changelog
and design history, not in current authoring requirements.

## Consolidation

ADRs 001–011 consolidated the legacy records; 012–015 are subsequent decisions.
[ADR-MAPPING.md](../history/ADR-MAPPING.md) maps retired numbers. The git tag
`adr-legacy-2026-06-23` preserves their bodies. Read the baseline before treating
an old number in a source comment as a current requirement.
