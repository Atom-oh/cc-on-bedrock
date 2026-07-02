"""Guard against model-ID drift.

terraform/variables.tf (opus_model_id / sonnet_model_id) is the single source of
truth for the shipped default model. Every place that hardcodes the *default*
Bedrock model for a real session must match it — otherwise a version bump (e.g.
Sonnet 4.6 -> 5) silently misses a consumer and users get the wrong model with
no error. Bumping the default? Update terraform/variables.tf, then re-run this
test: whatever file it flags is what you still need to touch.

Deliberately out of scope: historical/legacy pricing entries (multiple versions
kept on purpose, see lambda/bedrock-usage-tracker.py PRICING dict) and
prose/marketing docs (drift there is a UX issue, not a wrong-model-billed one).
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# Files that ship the runtime default straight to a real devenv/local session.
CONSUMERS = [
    "docker/devenv/scripts/entrypoint.sh",
    "shared/nextjs-app/src/lib/ec2-clients.ts",
    "shared/nextjs-app/src/app/api/install/route.ts",
    "tools/cc-bedrock-local.sh",
    "terraform/terraform.tfvars.example",
]


def _tf_default(var_name: str) -> str:
    tf = (REPO / "terraform/variables.tf").read_text()
    m = re.search(r'variable\s+"%s"\s*{.*?default\s*=\s*"([^"]+)"' % var_name, tf, re.DOTALL)
    assert m, f"couldn't find a default for variable {var_name!r} in terraform/variables.tf"
    return m.group(1)


def test_consumers_match_terraform_default():
    sonnet = _tf_default("sonnet_model_id")
    opus = _tf_default("opus_model_id")
    missing = []
    for rel in CONSUMERS:
        text = (REPO / rel).read_text()
        if sonnet not in text:
            missing.append(f"{rel}: missing sonnet default {sonnet!r}")
        if opus not in text:
            missing.append(f"{rel}: missing opus default {opus!r}")
    assert not missing, "Model ID drifted from terraform/variables.tf:\n" + "\n".join(missing)
