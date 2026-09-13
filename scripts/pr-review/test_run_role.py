"""Behavioral tests for the subprocess boundary; no provider calls."""

import importlib.util
import json
import os
import stat
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import run_role
import role_review
import test_role_review as fixture


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
        self.final_file = self.root / "final.txt"
        self.final_file.write_text("{}\n")

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

    def test_preflight_rejects_quota_or_model_fallback_despite_no_tools_reply(self):
        for message in (
            "Monthly request limit reached",
            "[warn] failed to set model: Method not found",
            "Falling back to user specified default",
            "using \x1b[1mtool:\x1b[0m fs_read",
            "quota exceeded",
            "using \x1b]title\x07tool: fs_read",
            "using \x9b1mtool:\x9b0m fs_read",
            "Falling \x1b]title\x07back to user specified default",
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

    def test_codex_transport_requires_a_complete_unambiguous_event_stream(self):
        message = {"type": "item.completed", "item": {
            "id": "reply", "type": "agent_message", "text": '{"review":"exact"}',
        }}
        start = {"type": "turn.started"}
        done = {"type": "turn.completed", "usage": {
            "input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1,
        }}
        self.assertTrue(hasattr(self.runner, "codex_response"))
        for events in ([start, message], [start, done],
                       [start, message, {"type": "turn.failed", "error": {"message": "failed"}}],
                       [start, message, done, message],
                       [start, message, start, done], [start, message, done, "invalid"]):
            with self.subTest(events=events):
                raw = "\n".join(json.dumps(event) for event in events)
                output, error, valid = self.runner.codex_response(raw, self.final_file)
                self.assertFalse(valid)
                self.assertEqual(output, "")

    def test_codex_transport_uses_cli_final_file_without_concatenating_progress(self):
        self.assertTrue(hasattr(self.runner, "codex_response"))
        raw = "\n".join(json.dumps(event) for event in [
            {"type": "turn.started"},
            {"type": "item.completed", "item": {
                "id": "first", "type": "agent_message", "text": '{"first":true}\n'}},
            {"type": "item.completed", "item": {
                "id": "second", "type": "agent_message", "text": '{"second":true}\n'}},
            {"type": "turn.completed", "usage": {
                "input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1}},
        ])
        self.final_file.write_text('{"second":true}\n')
        output, error, valid = self.runner.codex_response(raw, self.final_file)
        self.assertTrue(valid, error)
        self.assertEqual(output, '{"second":true}\n')
        self.assertEqual(error, "")

    def test_codex_recovered_error_is_forwarded_without_invalidating_completed_turn(self):
        raw = "\n".join(json.dumps(event) for event in [
            {"type": "turn.started"},
            {"type": "error", "message": "Reconnecting... stream disconnected before completion"},
            {"type": "item.completed", "item": {
                "id": "reply", "type": "agent_message", "text": '{"review":"complete"}'}},
            {"type": "turn.completed", "usage": {
                "input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1}},
        ])
        self.final_file.write_text('{"review":"complete"}\n')
        output, error, valid = self.runner.codex_response(raw, self.final_file)
        self.assertTrue(valid, error)
        self.assertEqual(output, '{"review":"complete"}\n')
        self.assertIn("Reconnecting", error)


class RoleRecordingTests(unittest.TestCase):
    def setUp(self):
        self.harness = fixture.RoleReviewTests()
        self.harness.setUp()
        self.addCleanup(self.harness.tearDown)
        self.path = "fixtures/password=abcdefghijklmnop.txt"
        self.harness.prepare(fixture.patch(self.path))
        self.private_value = "synthetic_private_response_value"
        response = self.harness.response("codex", findings=[{
            "severity": "MINOR", "path": self.path, "condition": "On change",
            "evidence": f"password={self.private_value}",
        }])
        self.original = json.dumps(response) + "\n"
        self.raw_paths = []
        self.recorded_bytes = []
        self.recorded_modes = []

    def fake_codex(self, command, cwd, environment, input_text, timeout):
        self.assertEqual(command[:2], ["codex", "exec"])
        final = Path(command[command.index("--output-last-message") + 1])
        final.write_bytes(self.original.encode("utf-8"))
        events = [
            {"type": "turn.started"},
            {"type": "item.completed", "item": {
                "type": "agent_message", "text": self.original,
            }},
            {"type": "turn.completed"},
        ]
        return (0, "\n".join(json.dumps(event) for event in events),
                "Fixture diagnostic password=synthetic_diagnostic_value")

    def run_recording(self, record_error=None, record_code=None, tag="codex", execute=None):
        real_run = subprocess.run

        def observe_record(command, **kwargs):
            if (len(command) > 2 and command[2] == "record"
                    and Path(command[1]).name == "role_review.py"):
                raw = Path(command[command.index("--output") + 1])
                self.raw_paths.append(raw)
                self.recorded_bytes.append(raw.read_bytes())
                self.recorded_modes.append(stat.S_IMODE(raw.stat().st_mode))
                if record_error is not None:
                    raise record_error
                if record_code is not None:
                    return subprocess.CompletedProcess(command, record_code)
            return real_run(command, **kwargs)

        with patch.object(run_role, "execute", side_effect=execute or self.fake_codex), \
                patch.object(run_role.subprocess, "run", side_effect=observe_record):
            run_role.run(self.harness.work, tag)

    def assert_private_response_removed(self):
        self.assertEqual(len(self.raw_paths), 1)
        self.assertFalse(self.raw_paths[0].exists())
        self.assertFalse(self.raw_paths[0].is_relative_to(self.harness.work))
        self.assertEqual(self.recorded_modes, [0o600])

    def test_original_response_reaches_protocol_and_paths_are_preserved(self):
        self.run_recording()
        result = self.harness.read("slot/codex-result.json")
        self.assertTrue(result["valid"], result["failure_codes"])
        self.assertEqual(result["response"]["reviewed_paths"], [self.path])
        self.assertEqual(result["response"]["findings"][0]["path"], self.path)
        self.assertEqual(self.recorded_bytes, [self.original.encode("utf-8")])
        self.assertNotIn(self.private_value, json.dumps(result))
        error = (self.harness.work / "runtime/codex.err").read_text()
        self.assertNotIn("synthetic_diagnostic_value", error)
        self.assertIn("[REDACTED]", error)
        self.assertFalse((self.harness.work / "runtime/codex.txt").exists())
        self.assert_private_response_removed()

    def test_private_response_is_removed_when_recording_raises(self):
        with self.assertRaisesRegex(OSError, "synthetic recording failure"):
            self.run_recording(record_error=OSError("synthetic recording failure"))
        self.assert_private_response_removed()

    def test_private_response_is_removed_when_recorder_returns_an_error(self):
        with self.assertRaisesRegex(RuntimeError, "recording failed"):
            self.run_recording(record_code=7)
        self.assert_private_response_removed()


    def test_colored_kiro_response_records_without_scrubbing_valid_paths(self):
        self.path = "fixtures/이한-password=abcdefghijklmnop.txt"
        self.harness.prepare(fixture.patch(self.path))
        report = self.harness.response("kiro-sol", findings=[{
            "severity": "MINOR", "path": self.path, "condition": "On change",
            "evidence": f"password={self.private_value}",
        }], checks=[{"path": self.path, "evidence": "이한 escaped control \x1b"}])
        payload = json.dumps(report, ensure_ascii=False) + "\n"
        calls = []

        def kiro(command, cwd, environment, input_text, timeout):
            self.assertEqual(command[1], "chat")
            calls.append(command)
            if "preflight-canary.txt" in command[2]:
                return 0, "\x1b[32m> NO_TOOLS\x1b[0m\n", ""
            return 0, "\x1b[32m> \x1b[0m" + payload + "\x1b[0m", ""

        self.run_recording(tag="kiro-sol", execute=kiro)
        result = self.harness.read("slot/kiro-sol-result.json")
        self.assertEqual(len(calls), 2)
        self.assertTrue(result["valid"], result["failure_codes"])
        self.assertEqual(result["response"]["reviewed_paths"], [self.path])
        self.assertEqual(role_review.parse_response(self.recorded_bytes[0].decode()), report)
        self.assertNotIn(self.private_value, json.dumps(result))
        self.assert_private_response_removed()

    def test_claude_stdout_quota_blocks_retry(self):
        calls = []
        def execute(command, *arguments):
            calls.append(command)
            if len(calls) == 1:
                return 1, "Error: insufficient credits\n", ""
            return 0, json.dumps(self.harness.response("claude-self")), ""
        self.run_recording(tag="claude-self", execute=execute)
        result = self.harness.read("slot/claude-self-result.json")
        self.assertEqual(len(calls), 1)
        self.assertFalse(result["valid"])
        self.assertIn("quota_diagnostic", result["failure_codes"])
        self.assert_private_response_removed()

    def test_kiro_stdout_quota_is_retained(self):
        calls = []
        def execute(command, *arguments):
            calls.append(command)
            if "preflight-canary.txt" in command[2]:
                return 0, "NO_TOOLS\n", ""
            return 0, "\x1b[32m> UsageLimitReachedError\x1b[0m\n", ""
        self.run_recording(tag="kiro-sol", execute=execute)
        result = self.harness.read("slot/kiro-sol-result.json")
        self.assertEqual(len(calls), 2)
        self.assertFalse(result["valid"])
        self.assertIn("quota_diagnostic", result["failure_codes"])
        self.assert_private_response_removed()

    def test_json_quota_text_is_not_an_error(self):
        response = self.harness.response("claude-self", checks=[{
            "path": self.path, "evidence": "Checked MONTHLY_REQUEST_COUNT handling."
        }])
        self.run_recording(tag="claude-self", execute=lambda *args: (
            0, json.dumps(response), "",
        ))
        result = self.harness.read("slot/claude-self-result.json")
        self.assertTrue(result["valid"], result["failure_codes"])
        self.assert_private_response_removed()


if __name__ == "__main__":
    unittest.main()
