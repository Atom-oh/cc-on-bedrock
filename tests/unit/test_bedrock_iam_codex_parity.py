"""ADR-014 guard: every per-user Bedrock allow-list (and the permission boundary
that caps them) must grant the OpenAI GPT models + the default Responses project
that Codex needs. Missing any one copy = AccessDenied for Codex users on that
path (boundary = all paths) with no other symptom.

The dashboard's own role (security/main.tf BedrockAccess) is deliberately
excluded — it only calls Claude for in-dashboard AI features.
"""
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# (file, occurrences expected) — security/main.tf: shared bedrock doc + boundary.
COPIES = [
    ("terraform/modules/security/main.tf", 2),
    ("terraform/modules/ec2-devenv/main.tf", 1),
    ("lambda/role_factory.py", 1),
    ("lambda/user-role-provisioner.py", 1),
    ("shared/nextjs-app/src/lib/ec2-clients.ts", 1),
]
REQUIRED = [
    "foundation-model/*openai.gpt-*",
    "inference-profile/*openai.gpt-*",
    ":project/*",
    # Claude must still be there — Codex is additive.
    "foundation-model/*anthropic.claude-*",
]


def test_all_bedrock_allow_lists_cover_codex():
    problems = []
    for rel, n in COPIES:
        text = (REPO / rel).read_text()
        for needle in REQUIRED:
            got = text.count(needle)
            if got < n:
                problems.append(f"{rel}: {needle!r} found {got}x, expected >= {n}")
    assert not problems, "Bedrock IAM allow-list drift (ADR-014):\n" + "\n".join(problems)


def test_dashboard_role_stays_claude_only():
    tf = (REPO / "terraform/modules/security/main.tf").read_text()
    i = tf.index('"BedrockAccess"')
    block = tf[i:tf.index("statement", i)]
    assert "openai.gpt" not in block
