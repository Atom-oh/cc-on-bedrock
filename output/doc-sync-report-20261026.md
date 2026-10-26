# Documentation synchronization — 2026-10-26

This report records a source-based documentation update. It does not establish
deployed AWS state or implement the documented feature gaps.

## Result and preservation

Current deployment, authentication, routing, storage, telemetry and governance
documentation now follows the existing baseline and source contracts. README,
architecture, deployment and lifecycle guides, operational runbooks, relevant
ADR implementation notes, generated AI context and architecture artifacts were
synchronized. No new architectural decision was made or ADR allocated.

All 13 original uncommitted paths were accounted for. The two removed ADR
verification workflows were already absent on the current main branch. The
remaining 11 paths are included across the documentation and SVG changes.
Dated migration/PR reports retain their historical content. The original
destructive account-wipe procedure is preserved verbatim after a historical
header in `docs/history/runbooks/2026-06-19-full-account-wipe.md`; the current
teardown runbook explains Terraform ownership and persistent-data preservation.

The 512,000-byte/12,000-line PR review limit requires splitting the SVG replacement
from the documentation, Draw.io source and PNG changes. The SVG change is stacked
on the documentation branch, so each review sees its own bounded diff.

## Quality assessment

The independent checker used the same weighted rubric before and after:
commands 20, architecture 20, non-obvious patterns 15, conciseness 15,
currency 15 and actionability 15, with documented anti-pattern deductions.

| Existing instruction scope | Before | After |
|---|---:|---:|
| Root | 93 | 94 |
| Agent | 79 | 92 |
| Docker | 79 | 91 |
| Lambda | 90 | 90 |
| Scripts | 91 | 91 |
| PR review | 99 | 99 |
| Dashboard | 94 | 96 |
| Terraform | 97 | 97 |
| Tests | 93 | 95 |
| Local CLI | 98 | 98 |
| **Average** | **91.3** | **94.3** |

Ten meaningful missing scopes are now documented: eight Terraform modules,
`lambda/devenv-session-validator` and `agent/lambda`. Coverage improved from
0/10 to 10/10; their independent average is 92.0/100 and is excluded from
the comparable existing-scope averages.

## Implementation references: reported gaps

`docs/reference/` and its `INDEX.md` are absent. Reference Code Pointers,
AUTO-MANAGED index parity and TODO counts therefore remain unavailable.
The sync procedure reports these gaps and does not create layer reference files.
Detected topics can be authored separately with `/project-init:add-reference-doc`:

| Missing reference | Source evidence |
|---|---|
| `infrastructure.md` | Terraform root and eight module contracts |
| `dashboard.md` | Next.js application, authentication and API routes |
| `governance-lambdas.md` | Root usage, limits, IAM and provisioning handlers |
| `edge-routing.md` | Edge session validator and nginx routing |
| `devenv.md` | EC2/EBS lifecycle, AMI builder and Docker images |
| `local-cli.md` | Local wrapper, installer and credential issuance |
| `observability.md` | Native collector, scrubbed S3 signals and rollup |
| `ai-assistant.md` | AgentCore runtime transport and auxiliary tools |
| `review-testing.md` | PR review workflow, scripts and local quality gates |

The auxiliary `webpage/` documentation site remains a scoped-documentation
opportunity. A folder name alone is insufficient reason to add duplicate
runbooks or instruction files.

## Known implementation gaps retained

- Root EBS is retained by current launch code/template although ADR-002 intends
  root deletion. Persistent `/home/coder` retention remains required.
- The Cognito shim is wired, but the downstream UserRoleProvisioner,
  EventBridge rule and DLQ are absent from Terraform.
- Cognito account disable alone does not revoke an existing dashboard session
  or guarantee that credential issuance stops.
- AgentCore resources and legacy ECS/EFS tool assumptions remain outside the
  current Terraform ownership and EC2 model.
- Dashboard CloudFront sends the custom header, but its listener does not
  validate it; WAF currently associates only with the DevEnv distribution.
- Edge redirect/SSM paths and AMI helper subnet discovery still contain fixed
  assumptions. Fresh AMI builds require already-deployed prerequisites.
- Boundary source-floor parity does not replace Terraform plan/show validation
  against requested permissions or deployed-state verification.
- Legacy full Docker/E2E paths still reference removed LiteLLM functionality.

## Executed verification

- Independent documentation review: no open findings; 39 changed/new Markdown
  files' explicit links resolved, 55 shell blocks parsed and 38 command/test
  source references existed. The quality checker separately resolved 120 local
  pointers in its focused set.
- `terraform -chdir=terraform fmt -check -recursive`: passed.
- Focused offline Python tests covering IAM parity, edge packaging, collector
  configuration and local role/limit enforcement: **30 passed**.
- Agent and auxiliary script syntax compilation: passed without imports or AWS
  calls.
- Generated AGENTS context validation: current root SHA, size and secret checks
  passed. Kiro steering points to the same context.
- Draw.io XML validation and layout lint: passed, **100/100**; 17 service/actor
  icons and ten relationships. PNG was rendered locally; SVG retains complete
  native text and self-contained icon paths/images and was rendered with local
  librsvg/Cairo.
- Final independent diagram content review: **90/90**, normalized **100/100**,
  above the required raw 85 threshold; no open findings. All 42 source labels
  match the SVG text and minimum typography is 19 px.
- `git diff --check`: passed.

Terraform initialization/semantic validation, deployment, container builds and
live AWS checks were not run. The focused edge Vitest command was attempted but
could not run because dashboard Node dependencies are absent in this checkout.
No full dashboard/integration suite result is claimed.
