"""Trusted context and immutable checkout regressions."""

import importlib.util
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


MODULE = Path(__file__).with_name("prepare_roles.py")
spec = importlib.util.spec_from_file_location("prepare_roles", MODULE)
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.previous = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.previous)
        self.git("init", "-q")
        self.git("config", "user.name", "Review test")
        self.git("config", "user.email", "review@example.invalid")
        (self.root / "CLAUDE.md").write_text("Canonical project instructions.\n")
        (self.root / "AGENTS.md").write_text("Trusted reviewer context.\n")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *arguments):
        return subprocess.check_output(["git", *arguments], text=True)

    def test_context_comes_from_git_object_not_dirty_working_file(self):
        (self.root / "AGENTS.md").write_text("UNTRUSTED changed instructions.\n")
        self.assertEqual(prepare.context_at(self.base, 24000), "Trusted reviewer context.\n")

    def test_stale_generated_context_is_rejected(self):
        (self.root / "AGENTS.md").write_text(
            "<!-- generated-by: co-agent · claude-md-sha: 000000000000 -->\n"
            "Context with a stale source hash.\n"
        )
        self.git("add", ".")
        self.git("commit", "-qm", "stale")
        with self.assertRaisesRegex(ValueError, "stale"):
            prepare.context_at(self.git("rev-parse", "HEAD").strip(), 24000)

    def test_wrong_base_checkout_is_rejected_before_network_or_provider_use(self):
        with self.assertRaisesRegex(ValueError, "pinned base"):
            prepare.prepare(self.base, "f" * 40, self.root / "work")

    def test_branch_name_cannot_replace_immutable_sha(self):
        with self.assertRaisesRegex(ValueError, "immutable"):
            prepare.prepare("main", self.base, self.root / "work")

    def test_candidate_context_size_limit_is_enforced(self):
        with self.assertRaisesRegex(ValueError, "oversized"):
            prepare.context_at(self.base, 3)

    def test_git_context_hash_preserves_committed_crlf_bytes(self):
        self.git("config", "core.autocrlf", "false")
        source = b"Canonical instructions.\r\nPreserve original bytes.\r\n"
        (self.root / "CLAUDE.md").write_bytes(source)
        sha = hashlib.sha256(source).hexdigest()[:12]
        context = f"<!-- generated-by: co-agent · claude-md-sha: {sha} -->\r\nContext.\r\n"
        (self.root / "AGENTS.md").write_bytes(context.encode())
        self.git("add", ".")
        self.git("commit", "-qm", "CRLF source")
        self.assertEqual(prepare.context_at(self.git("rev-parse", "HEAD").strip(), 24000), context)


if __name__ == "__main__":
    unittest.main()
