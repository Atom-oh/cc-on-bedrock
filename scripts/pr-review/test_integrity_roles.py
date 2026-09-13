"""Regressions from independent review of failure and byte-provenance handling."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_role
import synthesize_roles


class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.raw = (
            "diff --git a/backend/worker.ts b/backend/worker.ts\n"
            "--- a/backend/worker.ts\n+++ b/backend/worker.ts\n"
            "@@ -1 +1 @@\n-return 1;\r\n+return 1;\n"
        )
        (self.root / "diff").write_bytes(self.raw.encode())
        (self.root / "context").write_text("Trusted context.\n")
        subprocess.run([
            sys.executable, str(Path(run_role.__file__).with_name("role_review.py")),
            "prepare", "--head", "a" * 40, "--base", "b" * 40,
            "--diff", str(self.root / "diff"), "--context", str(self.root / "context"),
            "--work", str(self.work),
        ], check=True, capture_output=True)
        self.plan = json.loads((self.work / "role-plan.json").read_text())
        self.environment = patch.dict(os.environ, {
            "PANEL_RETRIES": "2", "PANEL_TIMEOUT": "10", "KIRO_PREFLIGHT_TIMEOUT": "10",
            "CHAIR_TIMEOUT": "10",
            "CHAIR_PRIMARY_MODEL": "global.anthropic.claude-fable-5-1",
            "CHAIR_FALLBACK_MODEL": "global.anthropic.claude-opus-5",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def response(self, tag):
        return json.dumps({
            "head_sha": self.plan["head_sha"], "role": self.plan["roles"][tag]["role"],
            "scope_complete": True, "reviewed_paths": ["backend/worker.ts"],
            "checks": [{"path": "backend/worker.ts", "evidence": "Checked changed return bytes."}],
            "findings": [], "uncertainties": [],
        })

    def codex_events(self, response=None, tool_output="", error=""):
        events = [{"type": "turn.started"}]
        if tool_output:
            events.append({"type": "item.completed", "item": {
                "id": "tool", "type": "command_execution", "command": "cat README.md",
                "aggregated_output": tool_output, "exit_code": 0, "status": "completed",
            }})
        if error:
            events.append({"type": "error", "message": error})
        if response is not None:
            events.append({"type": "item.completed", "item": {
                "id": "reply", "type": "agent_message", "text": response,
            }})
        events.append({"type": "turn.completed", "usage": {
            "input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1,
        }})
        return "\n".join(json.dumps(event) for event in events) + "\n"

    def codex_execute(self, replies):
        """Mock only the CLI, including its designated final-output file."""
        index = 0
        self.final_paths = []
        def invoke(command, *arguments):
            nonlocal index
            code, events, error, final = replies[min(index, len(replies) - 1)]
            index += 1
            if "--output-last-message" in command:
                path = Path(command[command.index("--output-last-message") + 1])
                self.final_paths.append(path)
                self.assertEqual(path.parent.stat().st_mode & 0o077, 0)
                if final is not None:
                    path.write_bytes(final.encode("utf-8"))
            return code, events, error
        return invoke

    def chair(self, responses):
        (self.work / "chair-mode.txt").write_text("review\n")
        (self.work / "role-summary.json").write_text('{"findings":[]}\n')
        (self.work / "project-context.md").write_text("Trusted context.\n")
        with patch.object(synthesize_roles, "execute", side_effect=responses) as execute:
            with patch.object(synthesize_roles, "scrub", side_effect=lambda value: value):
                synthesize_roles.synthesize(self.work, self.work / "review.md")
        return execute, (self.work / "review.md").read_text()

    def test_terminal_failure_cannot_disappear_in_a_later_retry(self):
        for tag in ("codex", "claude-self"):
            with self.subTest(tag=tag):
                with patch.object(run_role, "execute", side_effect=[
                    (1, "", "Monthly request limit reached"),
                    (0, self.response(tag), ""),
                ]) as execute:
                    run_role.run(self.work, tag)
                self.assertEqual(execute.call_count, 1)
                result = json.loads((self.work / "slot" / f"{tag}-result.json").read_text())
                self.assertFalse(result["valid"])
                self.assertIn("quota_diagnostic", result["failure_codes"])

    def test_chair_rejects_model_selection_failure_even_with_pass_footer(self):
        reply = (0, "Reviewed candidates.\nVERDICT: PASS\n",
                 "[warn] failed to set model: Method not found")
        execute, text = self.chair([reply, reply])
        self.assertEqual(execute.call_count, 2)
        self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_chair_quota_failure_does_not_consume_fallback(self):
        reply = (0, "Reviewed candidates.\nVERDICT: PASS\n", "Monthly request limit reached")
        execute, text = self.chair([reply, reply])
        self.assertEqual(execute.call_count, 1)
        self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_explicit_clean_fallback_can_resolve_selection_failure(self):
        execute, text = self.chair([
            (0, "Reviewed candidates.\nVERDICT: PASS\n", "[warn] failed to set model"),
            (0, "Reviewed candidates with the configured fallback.\nVERDICT: PASS\n", ""),
        ])
        self.assertEqual(execute.call_count, 2)
        self.assertTrue(text.endswith("VERDICT: PASS\n"))

    def test_stored_and_delivered_specialist_diff_bytes_match(self):
        for tag in ("codex", "kiro-fable"):
            with self.subTest(tag=tag):
                with patch.object(run_role, "preflight", return_value=(True, 0, "")):
                    response = self.response(tag)
                    invoke = (self.codex_execute([(0, self.codex_events(response), "", response)])
                              if tag == "codex" else lambda *args: (0, response, ""))
                    with patch.object(run_role, "execute", side_effect=invoke) as execute:
                        run_role.run(self.work, tag)
                delivered = execute.call_args.args[3] if tag == "codex" else execute.call_args.args[0][2]
                self.assertIn(self.raw.encode(), delivered.encode())
                self.assertIn("BEGIN DIFF ", delivered)
                self.assertIn("END DIFF ", delivered)
                self.assertEqual((self.work / "roles" / f"{tag}.diff").read_bytes(), self.raw.encode())
                result = json.loads((self.work / "slot" / f"{tag}-result.json").read_text())
                self.assertTrue(result["valid"], result)
                self.assertEqual(len(result["invocation_nonce"]), 32)
                self.assertNotEqual(result["request_digest"], self.plan["roles"][tag]["request_digest"])
                if tag == "codex":
                    self.assertEqual(execute.call_args.args[0][-1], "-")
                    self.assertIn("Review tag: codex", delivered)

    def test_codex_tool_data_is_not_a_diagnostic_or_review(self):
        tool = ('Monthly request limit reached\n'
                '[warn] failed to set model: Method not found\n'
                '{"type":"error","message":"insufficient credits"}\n'
                + self.response("codex"))
        with patch.dict(os.environ, {"AWS_REGION": "ap-northeast-2",
                                    "AWS_PROFILE": "existing-bedrock",
                                    "GH_TOKEN": "fixture-only"}):
            with patch.object(run_role, "execute", side_effect=self.codex_execute([(
                    0, self.codex_events(self.response("codex"), tool_output=tool), "",
                    self.response("codex"),
            )])) as execute:
                run_role.run(self.work, "codex")
        self.assertEqual(execute.call_count, 1)
        command, cwd, environment, delivered, timeout = execute.call_args.args
        self.assertIn("--json", command)
        self.assertIn("--output-last-message", command)
        self.assertEqual(command[command.index("--model") + 1], "global.openai.gpt-6-astra")
        self.assertEqual(command[-1], "-")
        self.assertEqual(cwd, Path.cwd())
        self.assertEqual(environment["AWS_PROFILE"], "existing-bedrock")
        self.assertEqual(environment["AWS_REGION"], "ap-northeast-2")
        self.assertNotIn("GH_TOKEN", environment)
        self.assertEqual(timeout, 10)
        self.assertIn(self.raw, delivered)
        result = json.loads((self.work / "slot/codex-result.json").read_text())
        self.assertTrue(result["valid"], result)

    def test_codex_terminal_error_event_cannot_be_overwritten_by_retry(self):
        with patch.object(run_role, "execute", side_effect=self.codex_execute([
            (0, self.codex_events(self.response("codex"),
                                 error="[warn] failed to set model: Method not found"), "",
             self.response("codex")),
            (0, self.codex_events(self.response("codex")), "", self.response("codex")),
        ])) as execute:
            run_role.run(self.work, "codex")
        self.assertEqual(execute.call_count, 1)
        result = json.loads((self.work / "slot/codex-result.json").read_text())
        self.assertFalse(result["valid"])
        self.assertIn("model_selection_diagnostic", result["failure_codes"])

    def test_codex_recovered_error_does_not_consume_another_attempt(self):
        with patch.object(run_role, "execute", side_effect=self.codex_execute([
            (0, self.codex_events(self.response("codex"),
                                 error="Reconnecting... stream disconnected before completion"), "",
             self.response("codex")),
            (0, self.codex_events(self.response("codex")), "", self.response("codex")),
        ])) as execute:
            run_role.run(self.work, "codex")
        self.assertEqual(execute.call_count, 1)
        result = json.loads((self.work / "slot/codex-result.json").read_text())
        self.assertTrue(result["valid"], result)

    def test_codex_tool_only_stream_cannot_supply_inner_review_json(self):
        with patch.object(run_role, "execute", side_effect=self.codex_execute([(
                0, self.codex_events(tool_output=self.response("codex")), "", None,
        )])):
            run_role.run(self.work, "codex")
        result = json.loads((self.work / "slot/codex-result.json").read_text())
        self.assertFalse(result["valid"])
        self.assertFalse((self.work / "runtime/codex.txt").exists())

    def test_codex_transport_does_not_extract_json_from_invalid_agent_text(self):
        final = "Unrequested prose\n" + self.response("codex")
        with patch.object(run_role, "execute", side_effect=self.codex_execute([(
                0, self.codex_events(final), "", final,
        )])):
            run_role.run(self.work, "codex")
        result = json.loads((self.work / "slot/codex-result.json").read_text())
        self.assertFalse(result["valid"])
        self.assertFalse((self.work / "runtime/codex.txt").exists())

    def test_codex_progress_is_ignored_but_cli_final_reply_is_strictly_validated(self):
        final = self.response("codex")
        events = self.codex_events(final).splitlines()
        events.insert(1, json.dumps({"type": "item.completed", "item": {
            "id": "progress", "type": "agent_message", "text": "I am checking the changed code."}}))
        with patch.object(run_role, "execute", side_effect=self.codex_execute([(
                0, "\n".join(events), "", final,
        )])) as execute:
            run_role.run(self.work, "codex")
        self.assertEqual(execute.call_count, 1)
        result = json.loads((self.work / "slot/codex-result.json").read_text())
        self.assertTrue(result["valid"], result)

    def test_codex_missing_final_file_cannot_reuse_a_failed_attempts_output(self):
        final = self.response("codex")
        with patch.object(run_role, "execute", side_effect=self.codex_execute([
            (9, self.codex_events(final), "", final),
            (0, self.codex_events(final), "", None),
        ])) as execute:
            run_role.run(self.work, "codex")
        self.assertEqual(execute.call_count, 2)
        self.assertEqual(len(set(self.final_paths)), 2)
        result = json.loads((self.work / "slot/codex-result.json").read_text())
        self.assertFalse(result["valid"])

    def test_codex_native_error_item_cannot_be_hidden_by_valid_final_file(self):
        final = self.response("codex")
        events = self.codex_events(final).splitlines()
        events.insert(1, json.dumps({"type": "item.completed", "item": {
            "id": "native-error", "type": "error",
            "message": "model rerouted: requested -> fallback (unavailable)"}}))
        with patch.object(run_role, "execute", side_effect=self.codex_execute([(
                0, "\n".join(events), "", final,
        )])) as execute:
            run_role.run(self.work, "codex")
        self.assertEqual(execute.call_count, 1)
        result = json.loads((self.work / "slot/codex-result.json").read_text())
        self.assertFalse(result["valid"])
        self.assertIn("model_fallback_diagnostic", result["failure_codes"])

    def assert_kiro_terminal_stops_retry(self, error, failure_code):
        tag = "kiro-fable"
        with patch.object(run_role, "preflight", return_value=(True, 0, "")):
            with patch.object(run_role, "execute", side_effect=[
                (1, "", error), (0, self.response(tag), ""),
            ]) as execute:
                run_role.run(self.work, tag)
        self.assertEqual(execute.call_count, 1)
        result = json.loads((self.work / "slot" / f"{tag}-result.json").read_text())
        self.assertFalse(result["valid"])
        self.assertIn(failure_code, result["failure_codes"])

    def test_kiro_generic_quota_failure_cannot_disappear_in_retry(self):
        self.assert_kiro_terminal_stops_retry(
            "Error: insufficient credits for this request", "quota_diagnostic")

    def test_kiro_model_fallback_cannot_disappear_in_retry(self):
        self.assert_kiro_terminal_stops_retry(
            "[warn] Falling back to default model", "model_fallback_diagnostic")

    def test_chair_receives_the_same_raw_diff_bytes(self):
        execute, _ = self.chair([(0, "Evidence checked.\nVERDICT: FAIL\n", "")])
        self.assertIn(self.raw, execute.call_args.args[3])


if __name__ == "__main__":
    unittest.main()
