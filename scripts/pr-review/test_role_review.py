"""Behavioral CLI tests; no network, credentials or model calls."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ENGINE = Path(__file__).with_name("role_review.py")
HEAD = "a" * 40
BASE = "b" * 40
FRONTEND = "dashboard/frontend/components/Button.tsx"
TAGS = ("codex", "kiro-fable", "kiro-sol", "claude-self")


def patch(path=FRONTEND, before="old label", after="new label"):
    return (
        f"diff --git a/{path} b/{path}\n"
        f"--- a/{path}\n+++ b/{path}\n"
        f"@@ -1 +1 @@\n-{before}\n+{after}\n"
    )


class RoleReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.diff = self.root / "raw.diff"
        self.context = self.root / "context.md"
        self.context.write_text("Trusted base: preserve accepted ADR scopes.\n")

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *args, expected=0):
        result = subprocess.run(
            [sys.executable, str(ENGINE), *map(str, args)],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(
            result.returncode, expected,
            f"command={args!r}\nstdout={result.stdout}\nstderr={result.stderr}",
        )
        return result

    def prepare(self, diff=None, expected=0, head=HEAD, extra=()):
        self.diff.write_text(patch() if diff is None else diff)
        self.cli(
            "prepare", "--diff", self.diff, "--context", self.context,
            "--head", head, "--base", BASE, "--work", self.work, *extra, expected=expected,
        )
        return self.read("role-plan.json")

    def read(self, name):
        return json.loads((self.work / name).read_text())

    def response(self, tag, **changes):
        plan = self.read("role-plan.json")
        paths = plan["roles"][tag]["paths"]
        result = {
            "head_sha": plan["head_sha"],
            "role": plan["roles"][tag]["role"],
            "scope_complete": True,
            "reviewed_paths": paths,
            "checks": [{"path": paths[0], "evidence": "Checked the changed branch and its caller."}],
            "findings": [],
            "uncertainties": [],
        }
        result.update(changes)
        return result

    def record(self, tag, response=None, raw=None, stderr="", rc=0, expected=0):
        output = self.root / f"{tag}-output.txt"
        diagnostic = self.root / f"{tag}-stderr.txt"
        output.write_text(raw if raw is not None else json.dumps(
            self.response(tag) if response is None else response
        ))
        diagnostic.write_text(stderr)
        self.cli(
            "record", "--work", self.work, "--tag", tag, "--output", output,
            "--stderr", diagnostic, "--exit-code", rc, expected=expected,
        )
        return self.read(f"slot/{tag}-result.json")

    def finish(self, overrides=None):
        for tag, role in self.read("role-plan.json")["roles"].items():
            if role["required"]:
                self.record(tag, response=(overrides or {}).get(tag))
        self.cli("aggregate", "--work", self.work)
        return self.read("role-summary.json")

    def assert_blocked(self):
        self.cli("aggregate", "--work", self.work, expected=2)
        self.assertEqual(self.read("role-summary.json")["mode"], "blocked")
        self.assertTrue((self.work / "coverage-severe.flag").exists())
        self.assertEqual((self.work / "chair-mode.txt").read_text(), "blocked\n")
        self.assertTrue((self.work / "deterministic-review.md").read_text().endswith("VERDICT: FAIL\n"))

    def test_frontend_routing_has_two_independent_full_scope_requests(self):
        raw = patch() + patch("dashboard/frontend/app/styles.css", "blue", "green")
        plan = self.prepare(raw)
        self.assertEqual(plan["schema_version"], 1)
        self.assertEqual(plan["head_sha"], HEAD)
        self.assertEqual(plan["base_sha"], BASE)
        self.assertEqual(set(plan["roles"]), set(TAGS))
        self.assertEqual(plan["roles"]["codex"]["role"], "implementation")
        self.assertEqual(
            {tag for tag, role in plan["roles"].items() if role["required"]},
            {"codex", "claude-self"},
        )
        self.assertNotEqual(plan["roles"]["codex"]["family"], plan["roles"]["claude-self"]["family"])
        for tag in ("codex", "claude-self"):
            role = plan["roles"][tag]
            self.assertEqual(set(role["paths"]), {FRONTEND, "dashboard/frontend/app/styles.css"})
            self.assertEqual((self.work / f"roles/{tag}.diff").read_text(), raw)
            prompt = (self.work / f"roles/{tag}.txt").read_text()
            self.assertIn("Trusted base: preserve accepted ADR scopes.", prompt)
            self.assertIn("untrusted", prompt.lower())
            self.assertIn("scope_complete", prompt)
            self.assertEqual(len(role["request_digest"]), 64)
        self.assertFalse((self.work / "roles/kiro-fable.txt").exists())
        self.assertEqual(self.finish()["mode"], "deterministic")
        self.assertEqual(set((self.work / "responded.txt").read_text().split()), {"codex", "claude-self"})

    def test_aws_docs_runbooks_and_adrs_activate_all_roles(self):
        for path in ("docs/aws.md", "docs/runbooks/ecs.md", "docs/decisions/ADR-999.md"):
            with self.subTest(path=path):
                plan = self.prepare(patch(path, "old policy", "ECS IAM role and recovery"))
                self.assertTrue(all(role["required"] for role in plan["roles"].values()))

    def test_aws_semantics_in_frontend_and_unknown_paths_are_conservative(self):
        for raw in (
            patch(after='import { S3Client } from "@aws-sdk/client-s3";'),
            patch("misc/unknown.xyz"),
        ):
            with self.subTest(raw=raw):
                plan = self.prepare(raw)
                self.assertTrue(all(role["required"] for role in plan["roles"].values()))

    def test_rename_scope_uses_destination_and_routes_from_full_raw_content(self):
        raw = (
            'diff --git "a/docs/old name.md" "b/docs/new name.md"\n'
            "similarity index 100%\nrename from docs/old name.md\nrename to docs/new name.md\n"
        )
        plan = self.prepare(raw)
        self.assertEqual(plan["roles"]["codex"]["paths"], ["docs/new name.md"])

    def test_unquoted_spaces_use_patch_metadata_not_shlex(self):
        path = "dashboard/frontend/components/A large Button.tsx"
        plan = self.prepare(patch(path))
        self.assertEqual(plan["roles"]["codex"]["paths"], [path])

    def test_authoritative_path_manifest_and_incomplete_manifest(self):
        manifest = self.root / "paths.json"
        manifest.write_text(json.dumps([FRONTEND]))
        self.prepare(extra=("--paths", manifest))
        manifest.write_text(json.dumps(["wrong.tsx"]))
        self.prepare(extra=("--paths", manifest), expected=2)
        self.assert_blocked()

    def test_context_default_supports_24000_bytes_and_lower_configured_cap(self):
        self.context.write_text("x" * 22892)
        self.prepare()
        self.prepare(extra=("--context-cap", "12288"), expected=2)
        self.assert_blocked()

    def test_revision_identifiers_must_be_full_hex_sha(self):
        self.prepare(head="HEAD", expected=2)
        self.assert_blocked()

    def test_decoded_credential_strings_are_scrubbed_before_public_json(self):
        self.prepare()
        secret = "ghp_" + "A" * 36
        response = self.response("codex", findings=[{
            "severity": "MINOR", "path": FRONTEND, "condition": "On submission",
            "evidence": "Credential " + secret,
        }])
        raw = json.dumps(response).replace("ghp_", "\\u0067hp_")
        result = self.record("codex", raw=raw)
        self.assertTrue(result["valid"])
        self.assertNotIn(secret, json.dumps(result))
        self.record("claude-self")
        self.cli("aggregate", "--work", self.work)
        self.assertNotIn(secret, (self.work / "deterministic-review.md").read_text())

    def test_decoded_multiline_and_control_split_credentials_are_scrubbed(self):
        cases = [
            ("-----BEGIN PRIVATE KEY-----\nPRIVATE_MATERIAL\n-----END PRIVATE KEY-----", "PRIVATE_MATERIAL"),
            ("ghp_" + "A" * 18 + "\x1b[31m" + "B" * 18, "B" * 18),
            ("ghp_" + "A" * 18 + "\u200b" + "B" * 18, "B" * 18),
            ("AWS_SECRET_ACCESS_KEY=PRIVATE_ACCESS_SECRET", "PRIVATE_ACCESS_SECRET"),
        ]
        for index, (credential, secret) in enumerate(cases):
            with self.subTest(index=index):
                self.work = self.root / f"secret-{index}"
                self.prepare()
                response = self.response("codex", checks=[{"path": FRONTEND, "evidence": credential}])
                result = self.record("codex", raw=json.dumps(response, ensure_ascii=True))
                self.assertNotIn(secret, json.dumps(result))

    def test_truncated_patch_or_bare_header_cannot_claim_complete_input(self):
        for raw in (
            f"diff --git a/{FRONTEND} b/{FRONTEND}\n",
            patch().rsplit("+new label", 1)[0],
        ):
            with self.subTest(raw=raw):
                self.prepare(raw, expected=2)
                self.assert_blocked()

    def test_mode_only_and_git_octal_quoted_paths(self):
        for raw, expected_path in (
            ("diff --git a/a file.sh b/a file.sh\nold mode 100644\nnew mode 100755\n", "a file.sh"),
            ('diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n'
             '--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n-a\n+b\n',
             "café.ts"),
        ):
            with self.subTest(raw=raw):
                plan = self.prepare(raw)
                self.assertEqual(plan["paths"], [expected_path])

    def test_duplicate_record_cannot_replace_a_failed_attempt_with_pass(self):
        self.prepare()
        self.record("codex", rc=1, expected=2)
        self.record("codex", expected=2)
        self.record("claude-self")
        self.assert_blocked()

    def test_deterministic_report_audits_role_routing_and_failure_codes(self):
        self.prepare()
        self.finish()
        report = (self.work / "deterministic-review.md").read_text()
        for value in ("codex", "kiro-fable", "kiro-sol", "claude-self", "implementation",
                      "clear_frontend_only", "inactive"):
            self.assertIn(value, report)
        self.work = self.root / "quota-report"
        self.prepare()
        self.record("codex", stderr="Error: quota exceeded for this account", expected=2)
        self.assert_blocked()
        report = (self.work / "deterministic-review.md").read_text()
        self.assertIn("quota", report)
        self.assertIn("missing_result:claude-self", report)

    def test_source_omission_flag_is_never_ignored(self):
        self.prepare()
        self.finish()
        (self.work / "source-omission.flag").touch()
        self.assert_blocked()

    def test_plan_and_request_digests_bind_head_context_and_full_diff(self):
        first = self.prepare()
        identical = self.prepare()
        self.assertEqual(first["plan_digest"], identical["plan_digest"])
        self.context.write_text("Changed trusted context.\n")
        second = self.prepare()
        self.assertNotEqual(first["plan_digest"], second["plan_digest"])
        self.assertNotEqual(
            first["roles"]["codex"]["request_digest"],
            second["roles"]["codex"]["request_digest"],
        )
        third = self.prepare(patch(after="different label"), head="c" * 40)
        self.assertNotEqual(second["plan_digest"], third["plan_digest"])

    def test_oversized_diff_blocks_without_truncating_role_input(self):
        prefix = patch()
        raw = prefix + "+" + "x" * (95001 - len(prefix) - 1)
        self.prepare(raw, expected=2)
        self.assertEqual((self.work / "roles/codex.diff").read_text(), raw)
        self.assert_blocked()

    def test_line_limit_and_empty_or_unparseable_inputs_block(self):
        for raw in (patch() + "+x\n" * 3001, "", "not a git diff\n"):
            with self.subTest(raw=raw[:30]):
                self.prepare(raw, expected=2)
                self.assert_blocked()

    def test_utf8_byte_limit_is_not_a_character_limit(self):
        self.prepare(patch(after="é" * 48000), expected=2)
        self.assert_blocked()

    def test_empty_context_blocks_preparation(self):
        self.context.write_text("")
        self.prepare(expected=2)
        self.assert_blocked()

    def test_minor_and_info_findings_allow_deterministic_summary(self):
        self.prepare()
        findings = [
            {"severity": severity, "path": FRONTEND, "condition": "When the label is empty",
             "evidence": "The changed fallback branch has no accessible name."}
            for severity in ("MINOR", "INFO")
        ]
        summary = self.finish({"codex": self.response("codex", findings=findings)})
        self.assertEqual(summary["mode"], "deterministic")
        rendered = (self.work / "deterministic-review.md").read_text()
        self.assertIn("MINOR", rendered)
        self.assertTrue(rendered.endswith("VERDICT: PASS\n"))

    def test_critical_major_or_uncertainties_require_chair_review(self):
        for severity in ("CRITICAL", "MAJOR", None):
            with self.subTest(severity=severity):
                self.work = self.root / f"work-{severity}"
                self.prepare()
                update = {"uncertainties": ["The caller contract is unavailable."]} if severity is None else {
                    "findings": [{"severity": severity, "path": FRONTEND,
                                  "condition": "On concurrent submissions",
                                  "evidence": "The changed code drops an in-flight update."}]
                }
                summary = self.finish({"codex": self.response("codex", **update)})
                self.assertEqual(summary["mode"], "review")
                self.assertFalse((self.work / "deterministic-review.md").exists())
                self.assertFalse((self.work / "coverage-severe.flag").exists())

    def test_single_json_fence_and_kiro_prefixes_are_supported(self):
        for wrapper in (
            lambda s: "```json\n" + s + "\n```",
            lambda s: "\n".join("> " + line for line in s.splitlines()),
            lambda s: "> ```json\n> " + s + "\n> ```",
        ):
            with self.subTest(wrapper=wrapper):
                self.work = self.root / str(id(wrapper))
                self.prepare()
                result = self.record("codex", raw=wrapper(json.dumps(self.response("codex"))))
                self.assertTrue(result["valid"])

    def test_blank_malformed_extra_text_and_duplicate_json_keys_reject(self):
        for raw in ("", "glob found no files", "{}", "[]", "```json\n{}\n```\nPASS",
                    '{"head_sha":"x","head_sha":"y"}'):
            with self.subTest(raw=raw):
                self.work = self.root / str(abs(hash(raw)))
                self.prepare()
                self.assertFalse(self.record("codex", raw=raw, expected=2)["valid"])
                self.assert_blocked()

    def test_missing_paths_false_scope_empty_checks_and_wrong_role_reject(self):
        changes = (
            {"reviewed_paths": []}, {"scope_complete": False}, {"scope_complete": "true"},
            {"checks": []}, {"checks": [{"path": FRONTEND, "evidence": " "}]},
            {"checks": [{"path": "not/changed.ts", "evidence": "claimed"}]},
            {"role": "claude-self"}, {"head_sha": "c" * 40},
        )
        for index, update in enumerate(changes):
            with self.subTest(update=update):
                self.work = self.root / f"scope-{index}"
                self.prepare()
                self.record("codex", self.response("codex", **update), expected=2)
                self.assert_blocked()

    def test_findings_need_known_severity_changed_path_condition_and_evidence(self):
        good = {"severity": "MAJOR", "path": FRONTEND, "condition": "When clicked",
                "evidence": "The changed handler raises."}
        for key, bad in (("severity", "PASS"), ("path", "other.py"), ("condition", ""), ("evidence", "")):
            with self.subTest(key=key):
                self.work = self.root / key
                self.prepare()
                finding = dict(good, **{key: bad})
                self.record("codex", self.response("codex", findings=[finding]), expected=2)
                self.assert_blocked()

    def test_nonzero_and_specific_stderr_failures_block_even_valid_json(self):
        for index, (rc, stderr) in enumerate((
            (1, ""), (0, "ERROR: INVALID_MODEL_ID secret=do-not-publish-this"),
            (0, "Warning: falling back to another model"),
            (0, "Error: quota exceeded for this account"),
            (0, "An error occurred (ThrottlingException) when invoking the model"),
        )):
            with self.subTest(rc=rc, stderr=stderr):
                self.work = self.root / f"diagnostic-{index}"
                self.prepare()
                self.record("codex", rc=rc, stderr=stderr, expected=2)
                self.assert_blocked()
                for file in self.work.rglob("*"):
                    if file.is_file():
                        self.assertNotIn("do-not-publish-this", file.read_text())

    def test_echoed_prompt_words_are_not_diagnostic_failures(self):
        self.prepare()
        result = self.record("codex", stderr=(
            "Review quota handling, fallback logic and model-selection tests.\n"
            "+ const note = 'quota exceeded';\n"
        ))
        self.assertTrue(result["valid"])

    def test_observed_kiro_diagnostics_reject_valid_json(self):
        diagnostics = (
            "[warn] failed to set model opus ... Method not found",
            "Monthly request limit reached",
            "Error: no agent with name inline-review found",
            "Falling back to user specified default",
        )
        for index, diagnostic in enumerate(diagnostics):
            with self.subTest(diagnostic=diagnostic):
                self.work = self.root / f"observed-kiro-{index}"
                self.prepare()
                self.record("codex", stderr=diagnostic, expected=2)
                self.assert_blocked()

    def test_echoed_diagnostic_examples_in_diff_are_not_runtime_failures(self):
        self.prepare()
        result = self.record("codex", stderr=(
            '+ "[warn] failed to set model opus ... Method not found"\n'
            "+ Monthly request limit reached\n"
            "+ Error: no agent with name X found\n"
            "+ Falling back to user specified default\n"
        ))
        self.assertTrue(result["valid"])

    def test_missing_result_is_blocked_even_when_other_role_found_major(self):
        self.prepare()
        finding = {"severity": "MAJOR", "path": FRONTEND, "condition": "When clicked", "evidence": "Fails."}
        self.record("codex", self.response("codex", findings=[finding]))
        self.assert_blocked()

    def test_stale_plan_request_and_result_tag_fingerprints_block(self):
        for key in ("plan_digest", "request_digest", "head_sha", "tag"):
            with self.subTest(key=key):
                self.work = self.root / f"stale-{key}"
                self.prepare()
                for tag in ("codex", "claude-self"):
                    self.record(tag)
                p = self.work / "slot/codex-result.json"
                data = json.loads(p.read_text())
                data[key] = "wrong"
                p.write_text(json.dumps(data))
                self.assert_blocked()

    def test_offroster_and_inactive_results_cannot_supply_coverage(self):
        for name in ("intruder", "kiro-fable"):
            with self.subTest(name=name):
                self.work = self.root / name
                self.prepare()
                for tag in ("codex", "claude-self"):
                    self.record(tag)
                shutil_source = self.work / "slot/codex-result.json"
                (self.work / f"slot/{name}-result.json").write_bytes(shutil_source.read_bytes())
                self.assert_blocked()

    def test_corrupt_slot_and_plan_metadata_fail_closed(self):
        self.prepare()
        for tag in ("codex", "claude-self"):
            self.record(tag)
        (self.work / "slot/codex-result.json").write_text("{bad")
        self.assert_blocked()
        plan = self.read("role-plan.json")
        plan["roles"]["claude-self"]["required"] = False
        (self.work / "role-plan.json").write_text(json.dumps(plan))
        self.assert_blocked()

    def test_failure_flags_override_valid_responses_and_remove_stale_pass(self):
        for name in ("kiro-preflight-failed.flag", "kiro-fallback.flag", "kiro-quota.flag",
                     "slot/kiro-diff-truncated.flag", "diff-truncated.flag"):
            with self.subTest(name=name):
                self.work = self.root / name.replace("/", "-")
                self.prepare()
                self.finish()
                (self.work / name).touch()
                self.assert_blocked()

    def test_aggregate_revalidates_payload_and_does_not_trust_valid_boolean(self):
        self.prepare()
        for tag in ("codex", "claude-self"):
            self.record(tag)
        file = self.work / "slot/codex-result.json"
        result = self.read("slot/codex-result.json")
        result["response"]["scope_complete"] = False
        file.write_text(json.dumps(result))
        self.assert_blocked()


if __name__ == "__main__":
    unittest.main()
