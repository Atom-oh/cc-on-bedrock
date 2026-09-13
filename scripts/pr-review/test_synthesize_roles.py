"""The deterministic path must never start a model."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


MODULE = Path(__file__).with_name("synthesize_roles.py")


class SynthesisTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(MODULE.exists(), "Conditional synthesis is not implemented")
        spec = importlib.util.spec_from_file_location("synthesize_roles", MODULE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_chair(self, replies):
        (self.root / "chair-mode.txt").write_text("review\n")
        (self.root / "role-summary.json").write_text('{"findings":[]}')
        (self.root / "project-context.md").write_text("Trusted base.")
        (self.root / "roles").mkdir(exist_ok=True)
        (self.root / "roles/codex.diff").write_text("Complete supplied diff.")
        with patch.dict(os.environ, {"CHAIR_TIMEOUT": "10",
                "CHAIR_PRIMARY_MODEL": "global.anthropic.claude-fable-5-1",
                "CHAIR_FALLBACK_MODEL": "global.anthropic.claude-opus-5"}), \
                patch.object(self.module, "record_status"), \
                patch.object(self.module, "execute", side_effect=replies) as invoke:
            self.module.synthesize(self.root, self.root / "review.md")
        return invoke.call_count, (self.root / "review.md").read_text()

    def test_transient_throttle_uses_configured_fallback(self):
        for kind in ("ThrottlingException", "TooManyRequestsException"):
            with self.subTest(kind=kind):
                calls, text = self.run_chair([
                    (1, "", f"An error occurred ({kind}) invoking the primary model"),
                    (0, "Fallback reviewed the evidence.\nVERDICT: PASS\n", ""),
                ])
                self.assertEqual(calls, 2)
                self.assertTrue(text.endswith("VERDICT: PASS\n"))

    def test_hard_account_limits_still_make_only_one_call(self):
        for error in ("ThrottlingException: MONTHLY_REQUEST_COUNT exhausted",
                      "Error: insufficient credits", "Error: You have reached the limit for overages"):
            with self.subTest(error=error):
                calls, text = self.run_chair([
                    (0, "Otherwise valid response.\nVERDICT: PASS\n", error),
                    (0, "Must not be used.\nVERDICT: PASS\n", ""),
                ])
                self.assertEqual(calls, 1)
                self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_markdown_examples_keep_verdict_and_credential_masking(self):
        for example in ("credentials=[]\nsecret={private-value}",
                        "-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY-----",
                        '{"name":"DATABASE_PASSWORD","value":"private-value"}'):
            with self.subTest(example=example):
                reply = (0, example + "\nReviewed behavior.\nVERDICT: PASS\n",
                         "")
                calls, text = self.run_chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertTrue(text.endswith("VERDICT: PASS\n"))
                self.assertNotIn("private-value", text)

    def test_stdout_account_errors_prevent_fallback_and_pass(self):
        for code in (0, 1):
            for message in (
                "UsageLimitReachedError",
                "Monthly request limit reached",
                "Error: insufficient credits",
                "You have reached the limit for overages",
            ):
                with self.subTest(code=code, message=message):
                    calls, text = self.run_chair([
                        (code, message + "\nVERDICT: PASS\n", ""),
                        (0, "Must not run.\nVERDICT: PASS\n", ""),
                    ])
                    self.assertEqual(calls, 1)
                    self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_quoted_account_diagnostics_are_review_evidence(self):
        report = (
            "Reviewed quota handling for UsageLimitReachedError.\n"
            '- The test covers "Monthly request limit reached".\n'
            "Example provider diagnostic:\n```\nUsageLimitReachedError\n```\n"
            "VERDICT: PASS\n"
        )
        calls, text = self.run_chair([(0, report, "")])
        self.assertEqual(calls, 1)
        self.assertTrue(text.endswith("VERDICT: PASS\n"))

    def test_complete_clean_review_does_not_call_chair(self):
        (self.root / "chair-mode.txt").write_text("deterministic\n")
        (self.root / "deterministic-review.md").write_text("Scope complete.\nVERDICT: PASS\n")
        with patch.object(self.module, "execute", side_effect=AssertionError("Unexpected call")):
            self.module.synthesize(self.root, self.root / "review.md")
        self.assertTrue((self.root / "review.md").read_text().endswith("VERDICT: PASS\n"))

    def test_incomplete_review_cannot_be_waived_by_chair(self):
        (self.root / "chair-mode.txt").write_text("blocked\n")
        (self.root / "deterministic-review.md").write_text("Missing required role.\nVERDICT: FAIL\n")
        with patch.object(self.module, "execute", side_effect=AssertionError("Unexpected call")):
            self.module.synthesize(self.root, self.root / "review.md")
        self.assertTrue((self.root / "review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_unique_final_verdict_and_body_are_required(self):
        self.assertTrue(self.module.valid("Evidence reviewed.\nVERDICT: PASS\n", 0))
        for output, status in [
            ("VERDICT: PASS", 0),
            ("Evidence reviewed.\nVERDICT: PASS", 2),
            ("Evidence reviewed.\nVERDICT: PASS\nVERDICT: PASS", 0),
            ("Evidence reviewed.\nVERDICT: PASS\nmore text", 0),
            ("Evidence reviewed.\n VERDICT: PASS", 0),
            ("Evidence reviewed.\nVERDICT: PASS ", 0),
            ("Evidence reviewed without a verdict.", 0),
        ]:
            self.assertFalse(self.module.valid(output, status))


    def test_generic_budget_overrides(self):
        limits = {"CHAIR_MAX_TURNS": "8", "CHAIR_FALLBACK_MAX_TURNS": "12",
                  "CHAIR_FAST_FAIL_S": "5"}
        with patch.dict(os.environ, limits):
            options = self.module.chair_options({})
        self.assertEqual(options["turns"], (8, 12))
        self.assertEqual(options["fast_fail"], 5)
        for name in limits:
            for value in ("0", "-1"):
                with self.subTest(name=name, value=value), \
                        patch.dict(os.environ, {name: value}), \
                        self.assertRaises(ValueError):
                    self.module.legacy_limit(name)


if __name__ == "__main__":
    unittest.main()
