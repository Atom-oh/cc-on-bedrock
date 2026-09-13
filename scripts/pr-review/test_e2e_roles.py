"""Exercise immutable preparation, real subprocesses, aggregation and synthesis."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parent
FAKE = r'''#!/usr/bin/env python3
import json,pathlib,sys
root = pathlib.Path(ROOT)
argv = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
if name == "gh":
    print((root / "base-sha").read_text().strip())
    raise SystemExit(0)
stdin = sys.stdin.read()
with (root / "calls.jsonl").open("a") as stream:
    stream.write(json.dumps({"name": name, "args": argv, "stdin": stdin}) + "\n")
if name == "kiro-cli" and argv[1].startswith("Kiro startup safety check."):
    assert stdin == ""
    print("NO_TOOLS")
    raise SystemExit(0)
if name == "claude" and argv[1].startswith("You chair"):
    print("The supplied candidate remains a concrete regression.\nVERDICT: FAIL")
    raise SystemExit(0)
model = argv[argv.index("--model") + 1]
tag = {"global.openai.gpt-6-astra":"codex", "claude-opus-5":"kiro-fable",
       "gpt-5.6-sol":"kiro-sol", "global.anthropic.claude-fable-5-1":"claude-self"}[model]
plan = json.loads((root / "work/role-plan.json").read_text())
role = plan["roles"][tag]
paths = role["paths"]
response = {"head_sha":plan["head_sha"],"role":role["role"],"scope_complete":True,
            "reviewed_paths":paths,"checks":[{"path":paths[0],"evidence":"Checked changed behavior."}],
            "findings":[],"uncertainties":[]}
if (root / "major").exists() and tag == "codex":
    response["findings"] = [{"severity":"MAJOR","path":paths[0],"condition":"When the branch runs",
                            "evidence":"The changed return value loses state."}]
print(json.dumps(response))
if (root / "failure").exists() and tag == "codex":
    raise SystemExit(9)
'''


class EndToEndRoleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.work = self.root / "work"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("codex", "kiro-cli", "claude", "gh"):
            executable = self.bin / name
            executable.write_text(FAKE.replace("ROOT", repr(str(self.root))))
            executable.chmod(0o755)
        target = self.repo / "scripts/pr-review"
        target.mkdir(parents=True)
        for source in SOURCE.iterdir():
            if source.is_file() and source.suffix in (".py", ".sh"):
                shutil.copy2(source, target / source.name)
        self.assertTrue((target / "lib.sh").exists(), "Repository scrubbers must be available")
        (self.repo / "AGENTS.md").write_text("Trusted project context: preserve data and auth.\n")
        (self.repo / "CLAUDE.md").write_text("Project source instructions.\n")
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Review tests")
        self.git("config", "user.email", "tests@example.invalid")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip()
        (self.root / "base-sha").write_text(self.base)
        self.git("remote", "add", "origin", str(self.repo))
        self.environment = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.environment.update(
            BASE_SHA=self.base, GH_REPO="example/project", PANEL_RETRIES="1",
            PANEL_TIMEOUT="10", KIRO_PREFLIGHT_TIMEOUT="10",
        )
        self.environment.pop("GITHUB_ENV", None)
        self.environment.pop("ROLE_REVIEW", None)

    def git(self, *arguments):
        return subprocess.check_output(["git", *arguments], cwd=self.repo, text=True)

    def run_pipeline(self, path):
        changed = self.repo / path
        changed.parent.mkdir(parents=True, exist_ok=True)
        changed.write_text("export const result = 1;\n")
        self.git("add", ".")
        self.git("commit", "-qm", "change")
        self.environment["HEAD_SHA"] = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-q", "--detach", self.base)
        result = subprocess.run([
            "bash", "scripts/pr-review/run-specialists.sh", "unused", "unused", str(self.work),
        ], cwd=self.repo, env=self.environment, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        result = subprocess.run([
            "python3", "scripts/pr-review/synthesize_roles.py",
            "--work", str(self.work), "--output", str(self.work / "review.md"),
        ], cwd=self.repo, env=self.environment, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return [json.loads(line) for line in (self.root / "calls.jsonl").read_text().splitlines()]

    def test_frontend_uses_two_reviews_and_no_chair(self):
        calls = self.run_pipeline("frontend/components/Button.tsx")
        self.assertEqual(sorted(call["name"] for call in calls), ["claude", "codex"])
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_aws_change_uses_four_reviews_and_two_safety_checks(self):
        calls = self.run_pipeline("infra/network.tf")
        self.assertEqual(len(calls), 6)
        self.assertEqual(sum(call["name"] == "kiro-cli" for call in calls), 4)
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_nonzero_output_blocks_without_chair_override(self):
        (self.root / "failure").touch()
        calls = self.run_pipeline("frontend/components/Button.tsx")
        self.assertEqual(len(calls), 2)
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_major_candidate_adds_exactly_one_chair_call(self):
        (self.root / "major").touch()
        calls = self.run_pipeline("frontend/components/Button.tsx")
        self.assertEqual(len(calls), 3)
        self.assertTrue((self.work / "review.md").read_text().endswith("VERDICT: FAIL\n"))


if __name__ == "__main__":
    unittest.main()
