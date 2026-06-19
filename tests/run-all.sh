#!/usr/bin/env bash
# Aggregated fast test gate (unit + invariants). Heavier integration tests live
# under tests/integration and tests/docker and are run separately.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Next.js dashboard: typecheck + vitest =="
( cd shared/nextjs-app && npx tsc --noEmit && npx vitest run )

echo "== nginx config generator: code-server boot 502 interception (unit) =="
python3 -m pytest tests/unit/test_nginx_config_gen.py -q

echo "== Lambda unit tests (usage/limits/rollup, incl. OTel productivity rollup) =="
python3 -m pytest cdk/lib/lambda/__tests__ -q

echo "== Local CLI (cc-bedrock-local): syntax + credential_process unit tests =="
bash -n tools/cc-bedrock-local.sh
bash tests/unit/test-cc-bedrock-local.sh

echo "== AMI build: ADR-032 cc-data-migrate unit (static safety checks) =="
bash tests/unit/test-build-ami-datavol.sh

echo "== ADR-026: boundary ⊇ service-allowlist invariant (self-test) =="
python3 scripts/check-policyset-boundary.py --self-test

# Full invariant check when a synthesized Security template is available
# (CI synth step writes cdk/cdk.out/CcOnBedrock-Security.template.json).
TPL="cdk/cdk.out/CcOnBedrock-Security.template.json"
if [ -f "$TPL" ]; then
  echo "== ADR-026: boundary ⊇ service-allowlist (synthesized template) =="
  python3 scripts/check-policyset-boundary.py --template "$TPL"
else
  echo "(skip boundary template check — no synthesized template; run 'cd cdk && npx cdk synth CcOnBedrock-Security')"
fi

echo "ALL GREEN"
