"""Trusted context and immutable checkout regressions."""

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


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

    def prepare_locally(self, head, base, directory):
        run, calls = subprocess.run, []
        def local_run(args, **kwargs):
            if args[0] == "gh":
                return subprocess.CompletedProcess(args, 0, stdout=(base + "\n").encode())
            if args[:2] == ["git", "fetch"]:
                return subprocess.CompletedProcess(args, 0)
            if len(args) > 1 and args[1].endswith("role_review.py"):
                calls.append(args)
                return subprocess.CompletedProcess(args, 0)
            return run(args, **kwargs)
        with patch.object(prepare, "DIRECTORY", directory), \
                patch.object(prepare.subprocess, "run", side_effect=local_run), \
                patch.dict(os.environ, {"GH_REPO": "example/repo"}):
            prepare.prepare(head, base, self.root / "work")
        return calls

    def test_prefetched_merge_base_uses_local_objects_without_network(self):
        (self.root / "server.py").write_text("candidate change\n")
        self.git("add", ".")
        self.git("commit", "-qm", "candidate")
        head = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-q", "--detach", self.base)
        directory = self.root / "scripts/pr-review"
        directory.mkdir(parents=True)
        command, run = prepare.command, subprocess.run
        def offline_command(*args):
            self.assertNotEqual(args[0], "gh", "prefetched preparation must not call GitHub")
            return command(*args)
        def offline_run(args, **kwargs):
            self.assertNotEqual(args[:2], ["git", "fetch"], "objects were fetched by the trusted step")
            if len(args) > 1 and args[1].endswith("role_review.py"):
                return subprocess.CompletedProcess(args, 0)
            return run(args, **kwargs)
        with patch.dict(os.environ, {"GH_REPO": "example/repo", "MERGE_BASE_SHA": self.base}), \
                patch.object(prepare, "DIRECTORY", directory), \
                patch.object(prepare, "command", side_effect=offline_command), \
                patch.object(prepare.subprocess, "run", side_effect=offline_run):
            prepare.prepare(head, self.base, self.root / "work")
        source = json.loads((self.root / "work/role-source.json").read_text())
        self.assertEqual(source["merge_base_sha"], self.base)
        self.assertEqual(source["scope_paths"], ["server.py"])
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.base)

    def test_prefetched_merge_base_rejects_invalid_or_unavailable_objects(self):
        directory = self.root / "scripts/pr-review"
        directory.mkdir(parents=True)
        blob = self.git("rev-parse", self.base + ":AGENTS.md").strip()
        for value in ("", "main", "a" * 39, "f" * 40, blob, self.base + "\nOTHER=value"):
            with self.subTest(value=value), patch.dict(os.environ, {"MERGE_BASE_SHA": value}), \
                    self.assertRaisesRegex(ValueError, "merge base|commit"):
                self.prepare_locally(self.base, self.base, directory)

    def test_committed_context_hook_receives_selected_scope_and_lowers_cap(self):
        directory = self.root / "scripts/pr-review"
        directory.mkdir(parents=True)
        hook = directory / "prepare_context_roles.py"
        hook.write_text(
            "def prepare(head, base, paths, diff, cap):\n"
            "    return 'Scoped BASE rules.', {'paths': paths, 'diff': diff}, min(cap, 20000)\n"
        )
        (self.root / "server.py").write_text("old branch\n")
        self.git("add", ".")
        self.git("commit", "-qm", "trusted context hook")
        base = self.git("rev-parse", "HEAD").strip()
        (self.root / "server.py").write_text("new branch\n")
        self.git("add", ".")
        self.git("commit", "-qm", "candidate")
        head = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-q", "--detach", base)
        calls = self.prepare_locally(head, base, directory)
        work = self.root / "work"
        self.assertEqual((work / "project-context.md").read_text(), "Scoped BASE rules.")
        source = json.loads((work / "role-source.json").read_text())
        self.assertEqual(source["scoped_context"]["paths"], ["server.py"])
        self.assertEqual(source["scoped_context"]["diff"], (work / "role-diff.txt").read_text())
        self.assertEqual(calls[0][calls[0].index("--context-cap") + 1], "20000")
        hook.write_text("raise RuntimeError('must never execute replacement')\n")
        with self.assertRaisesRegex(ValueError, "trusted base"):
            self.prepare_locally(head, base, directory)
        hook.unlink()
        with self.assertRaisesRegex(ValueError, "trusted base"):
            self.prepare_locally(head, base, directory)

    def test_context_hook_absence_keeps_root_but_untracked_file_is_rejected(self):
        directory = self.root / "scripts/pr-review"
        directory.mkdir(parents=True)
        self.prepare_locally(self.base, self.base, directory)
        self.assertEqual((self.root / "work/project-context.md").read_text(),
                         "Trusted reviewer context.\n")
        hook = directory / "prepare_context_roles.py"
        hook.write_text("raise RuntimeError('must never execute untracked code')\n")
        with self.assertRaisesRegex(ValueError, "trusted base"):
            self.prepare_locally(self.base, self.base, directory)

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

    def test_directory_exclusions_do_not_exclude_same_named_source_files(self):
        policy = self.root / "scripts/pr-review/role-input-scope.json"
        policy.parent.mkdir(parents=True)
        policy.write_text(json.dumps({"schema_version": 1, "directories": ["build", "dist"]}))
        paths = ["scripts/build", "dist", "build/generated.js", "packages/dist/generated.js"]
        for name in paths:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("source\n")
        self.git("add", ".")
        self.git("commit", "-qm", "scope policy and source paths")
        kept, excluded, _ = prepare.selected_paths(self.git("rev-parse", "HEAD").strip(), paths)
        self.assertEqual(["scripts/build", "dist"], kept)
        self.assertEqual(["build/generated.js", "packages/dist/generated.js"], excluded)

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

    def test_exclusions_opt_in_passes_exact_base_policy_bytes_to_engine(self):
        policy = self.root / "scripts/pr-review/role-input-scope.json"
        policy.parent.mkdir(parents=True)
        (policy.parent / "role_review.py").write_bytes(MODULE.with_name("role_review.py").read_bytes())
        material = b'{"schema_version":1,"extensions":[".png"]}\r\n'
        policy.write_bytes(material)
        self.git("add", ".")
        self.git("commit", "-qm", "approved policy")
        base = self.git("rev-parse", "HEAD").strip()
        (self.root / "logo.png").write_text("candidate asset\n")
        self.git("add", "logo.png")
        self.git("commit", "-qm", "asset change")
        head = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-q", "--detach", base)
        policy.write_text('{"schema_version":1,"extensions":[".tf"]}\n')
        run, command = subprocess.run, prepare.command
        invoked = []

        def local_run(args, **kwargs):
            if args[:2] == ["git", "fetch"]:
                return subprocess.CompletedProcess(args, 0)
            if len(args) > 1 and args[1].endswith("role_review.py"):
                invoked.append(args)
                self.assertIn("--allow-exclusions-only", args)
                supplied = Path(args[args.index("--policy") + 1])
                self.assertEqual(supplied.read_bytes(), material)
            return run(args, **kwargs)

        def local_command(*args):
            return base + "\n" if args[:2] == ("gh", "api") else command(*args)

        work = self.root / "work"
        with patch.object(prepare, "command", side_effect=local_command), \
                patch.object(prepare.subprocess, "run", side_effect=local_run), \
                patch.object(prepare, "project_policy", return_value={}), \
                patch.object(prepare, "DIRECTORY", policy.parent), \
                patch.dict(os.environ, {"GH_REPO": "example/repo"}):
            prepare.prepare(head, base, work)
        self.assertEqual(len(invoked), 1)
        plan = json.loads((work / "role-plan.json").read_text())
        self.assertTrue(plan["input_complete"])
        self.assertFalse(any(role["required"] for role in plan["roles"].values()))
        self.assertEqual(plan["exclusions_policy_sha256"], hashlib.sha256(material).hexdigest())


if __name__ == "__main__":
    unittest.main()
