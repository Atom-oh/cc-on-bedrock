#!/usr/bin/env bash
# Aggregated fast test gate (unit + invariants). Heavier integration tests live
# under tests/integration and tests/docker and are run separately.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Next.js dashboard: typecheck + vitest =="
( cd shared/nextjs-app && npx tsc --noEmit && npx vitest run )

echo "== Python unit tests (nginx config-gen, usage-tracker pricing, ADR-031 migration, …) =="
python3 -m pytest tests/unit/ scripts/__tests__/ -q

echo "== Lambda unit tests (usage/limits/rollup, incl. OTel productivity rollup) =="
python3 -m pytest lambda/__tests__ -q

echo "== Local CLI (cc-bedrock-local): syntax check =="
bash -n tools/cc-bedrock-local.sh

echo "== AMI build: ADR-032 cc-data-migrate unit (static safety checks) =="
bash tests/unit/test-build-ami-datavol.sh

echo "== ADR-030: boundary-X deny-floor + validator coherence invariant (self-test) =="
python3 scripts/check-policyset-boundary.py --self-test

# ADR-033: CDK removed — the boundary now lives in terraform/modules/security
# (aws_iam_policy.task_permission_boundary, ADR-030 deny-floor design). The --self-test
# above validates the coverage/coherence logic; the deployed boundary is verified by
# `terraform plan` drift + Phase-B live checks. (Former cdk synth template check retired.)

echo "ALL GREEN"
