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


if __name__ == "__main__":
    unittest.main()
