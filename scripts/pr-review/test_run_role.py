"""Behavioral tests for the subprocess boundary; no provider calls."""

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


MODULE = Path(__file__).with_name("run_role.py")


class RoleExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not MODULE.exists():
            return
        spec = importlib.util.spec_from_file_location("run_role", MODULE)
        cls.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.runner)

    def setUp(self):
        self.assertTrue(MODULE.exists(), "The single-role executor is not implemented")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def executable(self, text):
        path = self.root / "fake-cli"
        path.write_text("#!/usr/bin/env python3\n" + text)
        path.chmod(0o755)
        return str(path)

    def test_process_status_is_not_inferred_from_nonempty_stdout(self):
        cli = self.executable("print('a plausible review'); raise SystemExit(7)\n")
        code, output, error = self.runner.execute([cli], self.root, os.environ.copy(), "", 2)
        self.assertEqual(code, 7)
        self.assertEqual(output.strip(), "a plausible review")

    def test_timeout_kills_a_child_that_ignores_termination(self):
        cli = self.executable(
            "import signal,time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "print('partial output', flush=True)\ntime.sleep(30)\n"
        )
        code, output, error = self.runner.execute([cli], self.root, os.environ.copy(), "", 0.1)
        self.assertEqual(code, 124)
        self.assertIn("partial output", output)

    def test_kiro_environment_contains_no_cloud_or_repository_credentials(self):
        source = {
            "PATH": "/usr/bin", "KIRO_API_KEY": "test-key",
            "AWS_SECRET_ACCESS_KEY": "private", "GH_TOKEN": "private",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI": "private",
        }
        result = self.runner.kiro_environment(self.root, source)
        self.assertEqual(result["KIRO_API_KEY"], "test-key")
        self.assertEqual(result["HOME"], str(self.root))
        self.assertFalse(any(k.startswith("AWS_") or k == "GH_TOKEN" for k in result))

    def test_preflight_rejects_quota_or_model_fallback_despite_no_tools_reply(self):
        for message in (
            "Monthly request limit reached",
            "[warn] failed to set model: Method not found",
            "Falling back to user specified default",
        ):
            with self.subTest(message=message):
                cli = self.executable(
                    "import sys\nprint('NO_TOOLS')\n"
                    f"print({message!r}, file=sys.stderr)\n"
                )
                ok, code, error = self.runner.preflight(
                    cli, "claude-opus-5", self.root, os.environ.copy(), 2
                )
                self.assertFalse(ok)

    def test_preflight_uses_empty_catalog_and_never_receives_pr_input(self):
        cli = self.executable(
            "import json,pathlib,sys\n"
            "agent=json.loads(pathlib.Path('.kiro/agents/inline-review.json').read_text())\n"
            "assert agent['tools']==[] and agent['allowedTools']==[]\n"
            "assert sys.stdin.read()==''\n"
            "assert '--agent' in sys.argv and '--v3' not in sys.argv\n"
            "assert 'preflight-canary.txt' in sys.argv[2]\n"
            "print('> NO_TOOLS')\n"
        )
        ok, code, error = self.runner.preflight(
            cli, "claude-opus-5", self.root, os.environ.copy(), 2
        )
        self.assertTrue(ok, error)
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
