"""Trusted project policies must retain their input and chair safeguards."""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare_roles
import synthesize_roles


POLICY = {
    "schema_version": 1, "input_adapter": "prepare_project_roles.py",
    "context_sources": ["CLAUDE.md", "scripts/pr-review/context.md"],
    "chair": {"timeout_seconds": 600, "max_turns": 8, "fallback_max_turns": 12,
              "allowed_tools": ["Read", "Grep", "Glob"],
              "disallowed_tools": ["Bash", "Write", "Edit", "NotebookEdit",
                                   "WebFetch", "WebSearch", "Task"]},
}


class ProjectPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_policy_is_optional_for_existing_generic_projects(self):
        self.assertEqual(prepare_roles.project_policy(self.root), {})

    def test_duplicate_policy_keys_cannot_replace_a_guard(self):
        (self.root / "role-project.json").write_text(
            '{"schema_version":1,"schema_version":2}'
        )
        with self.assertRaises(ValueError):
            prepare_roles.project_policy(self.root)

    def test_policy_rejects_an_adapter_outside_the_trusted_directory(self):
        data = dict(POLICY, input_adapter="../../outside.py")
        (self.root / "role-project.json").write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            prepare_roles.project_policy(self.root)

    def test_chair_policy_survives_legacy_script_removal(self):
        options = synthesize_roles.chair_options(POLICY)
        self.assertEqual(options["timeout"], 600)
        self.assertEqual(options["turns"], (8, 12))
        self.assertIn("Bash", options["deny"])
        self.assertIn("Task", options["deny"])

    def test_environment_cannot_disable_or_raise_mandatory_turn_caps(self):
        for value in ("0", "9"):
            with self.subTest(value=value), patch.dict(os.environ, {"CHAIR_MAX_TURNS": value}):
                with self.assertRaises(ValueError):
                    synthesize_roles.chair_options(POLICY)

    def test_project_policy_cannot_drop_the_required_deny_baseline(self):
        data = json.loads(json.dumps(POLICY))
        data["chair"]["disallowed_tools"] = ["Write"]
        with self.assertRaises(ValueError):
            synthesize_roles.chair_options(data)


if __name__ == "__main__":
    unittest.main()
