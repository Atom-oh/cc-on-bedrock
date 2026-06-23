#!/usr/bin/env bash
# Aggregated fast test gate (unit + invariants). Heavier integration tests live
# under tests/integration and tests/docker and are run separately.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Next.js dashboard: typecheck + vitest =="
( cd shared/nextjs-app && npx tsc --noEmit && npx vitest run )

echo "== Python unit tests (nginx config-gen, usage-tracker pricing, ADR-031 migration, …) =="
python3 -m pytest tests/unit/ scripts/__tests__/ -q

if [ -d lambda/__tests__ ]; then
  echo "== Lambda unit tests (usage/limits/rollup, incl. OTel productivity rollup) =="
  python3 -m pytest lambda/__tests__ -q
fi

echo "== Local CLI (cc-bedrock-local): syntax check =="
bash -n tools/cc-bedrock-local.sh

if [ -f tests/unit/test-build-ami-datavol.sh ]; then
  echo "== AMI build: ADR-032 cc-data-migrate unit (static safety checks) =="
  bash tests/unit/test-build-ami-datavol.sh
fi

echo "== ADR-030: boundary-X deny-floor + validator coherence invariant (self-test) =="
python3 scripts/check-policyset-boundary.py --self-test

echo "== Terraform formatting check =="
terraform -chdir=terraform fmt -check -recursive

echo "ALL GREEN"
