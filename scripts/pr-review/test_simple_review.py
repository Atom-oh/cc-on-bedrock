"""Offline contract and CLI-stub tests for the active two-reviewer pipeline."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import simple_review


MODULE = Path(__file__).resolve().parent
ROOT = MODULE.parents[1]
PANEL = "\n".join(
    f"## {lens}\nChecked the changed paths and relevant contracts; no actionable regressions found."
    for lens in simple_review.LENSES
) + "\nLENS_COVERAGE: L2,L3,L4,L5\n"
CHAIR = (
    "## Summary\nBoth independent reviews cover the supplied changes with no confirmed "
    "blocking regressions in the inspected contracts.\n\nVERDICT: PASS\n"
)

STUB = r'''
import json, os, pathlib, sys, time
root = pathlib.Path(os.environ["STUB_ROOT"])
args = sys.argv[1:]
tag = pathlib.Path(sys.argv[0]).name
chair = tag == "claude" and any("You are the CHAIR" in arg for arg in args)
phase = "chair" if chair else tag
payload = sys.stdin.read()
with (root / (phase + ".jsonl")).open("a") as f:
    f.write(json.dumps({"args": args, "input": payload,
        "token_present": bool(os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")),
        "model": os.environ.get("ANTHROPIC_MODEL")}) + "\n")
case = os.environ.get("STUB_CASE", "")
text = (root / ("chair.txt" if chair else "panel.txt")).read_text()
if not chair and tag == "claude":
    if case == "empty": sys.exit(0)
    if case == "timeout": time.sleep(3)
    if case == "missing_lens": text = text.replace("## L3", "## Missing")
    if case == "oversize": text += "x" * 60001
    if case == "secret": text = text.replace("## L2", "ghp_" + "a" * 40 + "\n## L2")
if chair:
    if case == "double_verdict": text = "VERDICT: FAIL\n" + text
    if case == "verdict_only": text = "VERDICT: PASS\n"
    if case == "chair_error" or (
        case == "fallback" and os.environ.get("ANTHROPIC_MODEL") == "primary"
    ):
        print(text)
        sys.exit(1)
    if case == "finding": text = text.replace("VERDICT: PASS", "VERDICT: FAIL")
print(text)
if not chair and tag == "claude" and case == "nonzero":
    sys.exit(1)
'''


class SimpleReviewTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.work = self.root / "work"
        self.lenses = self.root / "lenses"
        self.lenses.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.diff = self.root / "diff.txt"
        self.diff.write_text("diff --git a/app.py b/app.py\n+CANARY_COMPLETE_DIFF\n")
        (self.root / "CLAUDE.md").write_text("BASE_CONTEXT_CANARY: preserve user data.")
        (self.root / "panel.txt").write_text(PANEL)
        (self.root / "chair.txt").write_text(CHAIR)
        for lens in ("COMMON", *simple_review.LENSES):
            (self.lenses / f"{lens}.txt").write_text(f"{lens}: inspect the applicable changes.")
        for tag in ("codex", "claude"):
            path = self.bin / tag
            path.write_text(f"#!{sys.executable}\n" + STUB)
            path.chmod(0o755)
        unexpected = self.bin / "kiro-cli"
        unexpected.write_text("#!/bin/sh\nexit 99\n")
        unexpected.chmod(0o755)
        self.env = {
            **os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
            "STUB_ROOT": str(self.root), "PANEL_TIMEOUT": "1", "PANEL_RETRIES": "1",
            "CHAIR_TIMEOUT": "2", "CHAIR_PRIMARY_MODEL": "primary",
            "CHAIR_FALLBACK_MODEL": "fallback",
            "GH_TOKEN": "do-not-inherit", "GITHUB_TOKEN": "do-not-inherit",
            "GITHUB_ENV": str(self.root / "github-env"),
            # Old environment configuration cannot route CI back to specialists.
            "ROLE_REVIEW": "1",
        }

    def run_script(self, name, *args):
        return subprocess.run(
            ["bash", str(MODULE / name), *map(str, args)], cwd=self.root,
            env=self.env, capture_output=True, text=True, timeout=20,
        )

    def panel(self):
        result = self.run_script("run-panel.sh", self.diff, self.lenses, self.work)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def synthesize(self):
        result = self.run_script(
            "synthesize.sh", self.diff, self.work, "42", "$(untrusted PR title)",
            self.work / "review.md",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        simple_review.validate(self.work / "review.md", "chair")
        return (self.work / "review.md").read_text()

    def calls(self, phase):
        path = self.root / f"{phase}.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_two_complete_calls_share_diff_context_and_all_checklists(self):
        self.panel()
        self.assertEqual((self.work / "responded.txt").read_text(), "codex\nclaude\n")
        for tag in ("codex", "claude"):
            self.assertEqual(len(self.calls(tag)), 1)
            call = self.calls(tag)[0]
            self.assertIn("CANARY_COMPLETE_DIFF", call["input"])
            self.assertIn("BASE_CONTEXT_CANARY", call["input"])
            self.assertFalse(call["token_present"])
            for lens in simple_review.LENSES:
                self.assertIn(f"{lens}: inspect", " ".join(call["args"]))
        codex_args = self.calls("codex")[0]["args"]
        self.assertIn("read-only", codex_args)
        self.assertIn("web_search=disabled", codex_args)
        claude_args = self.calls("claude")[0]["args"]
        self.assertEqual(claude_args[claude_args.index("--tools") + 1], "")
        self.assertIn("--strict-mcp-config", claude_args)
        self.assertEqual(claude_args[claude_args.index("--setting-sources") + 1], "")
        self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: PASS"))
        self.assertEqual(len(self.calls("chair")), 1)
        self.assertFalse(self.calls("chair")[0]["token_present"])

    def test_failed_or_incomplete_reviewer_blocks_without_chair_call(self):
        for case in ("empty", "nonzero", "missing_lens", "oversize", "timeout"):
            with self.subTest(case=case):
                self.env["STUB_CASE"] = case
                self.panel()
                self.assertTrue((self.work / "coverage-severe.flag").exists())
                self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: FAIL"))
                self.assertFalse(self.calls("chair"))

    def test_fresh_run_discards_stale_slots_and_flags(self):
        self.env["STUB_CASE"] = "empty"
        self.panel()
        self.env["STUB_CASE"] = ""
        self.panel()
        self.assertFalse((self.work / "coverage-severe.flag").exists())
        self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: PASS"))

    def test_retries_are_bounded(self):
        self.env.update(STUB_CASE="nonzero", PANEL_RETRIES="2")
        self.panel()
        self.assertEqual(len(self.calls("claude")), 2)
        self.assertEqual(len(self.calls("codex")), 1)

    def test_invalid_chair_output_or_nonzero_exit_cannot_pass(self):
        for case in ("double_verdict", "verdict_only", "chair_error"):
            with self.subTest(case=case):
                self.env["STUB_CASE"] = case
                self.panel()
                self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: FAIL"))
                self.assertTrue((self.work / "chair-failed.flag").exists())

    def test_chair_fallback_requires_successful_exit(self):
        self.env["STUB_CASE"] = "fallback"
        self.panel()
        self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: PASS"))
        self.assertEqual([call["model"] for call in self.calls("chair")], ["primary", "fallback"])

    def test_same_chair_model_is_not_called_twice(self):
        self.env.update(STUB_CASE="chair_error", CHAIR_FALLBACK_MODEL="primary")
        self.panel()
        self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: FAIL"))
        self.assertEqual(len(self.calls("chair")), 1)

    def test_confirmed_findings_keep_fail_verdict(self):
        self.env["STUB_CASE"] = "finding"
        self.panel()
        self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: FAIL"))
        self.assertFalse((self.work / "chair-failed.flag").exists())

    def test_changed_diff_is_not_synthesized_against_stale_reports(self):
        self.panel()
        self.diff.write_text("+DIFFERENT_DIFF\n")
        self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: FAIL"))
        self.assertFalse(self.calls("chair"))

    def test_successful_looking_report_needs_successful_exit_metadata(self):
        self.panel()
        (self.work / "slot/claude.md.rc").write_text("1\n")
        self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: FAIL"))
        self.assertFalse(self.calls("chair"))

    def test_missing_checklist_and_oversized_input_never_call_providers(self):
        (self.lenses / "L3.txt").unlink()
        self.panel()
        self.assertFalse(self.calls("codex"))
        (self.lenses / "L3.txt").write_text("Check security.")
        self.diff.write_text("+line\n" * 12_001)
        self.panel()
        self.assertFalse(self.calls("codex"))
        self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: FAIL"))
        self.diff.write_text("x" * (simple_review.DIFF_BYTES + 1))
        self.panel()
        self.assertFalse(self.calls("codex"))
        self.assertTrue(self.synthesize().rstrip().endswith("VERDICT: FAIL"))

    def test_symlink_workspace_does_not_delete_target_files(self):
        target = self.root / "target"
        (target / "slot").mkdir(parents=True)
        canary = target / "slot" / "keep.txt"
        canary.write_text("preserved")
        self.work.symlink_to(target, target_is_directory=True)
        result = self.run_script("run-panel.sh", self.diff, self.lenses, self.work)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(canary.read_text(), "preserved")

    def test_secrets_are_redacted_before_chair_receives_reports(self):
        self.env["STUB_CASE"] = "secret"
        self.panel()
        self.synthesize()
        payload = self.calls("chair")[0]["input"]
        self.assertNotIn("ghp_" + "a" * 40, payload)
        self.assertIn("[REDACTED-GH-TOKEN]", payload)

    def test_quoted_coverage_marker_and_empty_sections_do_not_count(self):
        path = self.root / "report.md"
        for text in (
            PANEL.replace("LENS_COVERAGE:", "> LENS_COVERAGE:"),
            "```\n" + PANEL + "\n```",
            "\n".join(f"## {lens}\nOK" for lens in simple_review.LENSES)
            + "\nLENS_COVERAGE: L2,L3,L4,L5\n",
        ):
            path.write_text(text)
            with self.assertRaises(ValueError):
                simple_review.validate(path, "panel")

    def test_ci_uses_trusted_base_and_has_no_kiro_or_specialist_switch(self):
        workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()
        for token in ("kiro", "ROLE_REVIEW", "run-specialists", "upload-artifact"):
            self.assertNotIn(token, workflow)
        self.assertIn("ref: ${{ github.event.pull_request.base.sha }}", workflow)
        self.assertIn('git diff --no-ext-diff --no-textconv "$MERGE_BASE_SHA" "$HEAD_SHA"', workflow)
        self.assertIn('[ "$CURRENT_HEAD" = "$HEAD_SHA" ]', workflow)
        for script in ("run-panel.sh", "synthesize.sh"):
            self.assertNotIn("ROLE_REVIEW", (MODULE / script).read_text())
            self.assertNotIn("kiro", (MODULE / script).read_text())


if __name__ == "__main__":
    unittest.main()
