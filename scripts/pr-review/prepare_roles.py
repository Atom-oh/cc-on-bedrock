#!/usr/bin/env python3
"""Prepare complete immutable diff data and trusted base context."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from role_review import Invalid, strict_json

DIRECTORY = Path(__file__).resolve().parent


def project_policy(directory=None):
    file = (directory or DIRECTORY) / "role-project.json"
    if not file.exists():
        return {}
    if file.is_symlink():
        raise ValueError("Project policy must be a regular trusted file")
    try:
        policy = strict_json(file.read_bytes().decode("utf-8"))
    except Invalid as error:
        raise ValueError("Invalid project policy") from error
    if (not isinstance(policy, dict) or policy.get("schema_version") != 1
            or policy.get("input_adapter") != "prepare_project_roles.py"
            or not isinstance(policy.get("chair"), dict)):
        raise ValueError("Invalid project policy or adapter")
    return policy


def command(*arguments):
    return subprocess.check_output(arguments).decode("utf-8")


def git_file(revision, path):
    result = subprocess.run(
        ["git", "show", f"{revision}:{path}"], capture_output=True,
    )
    return result.stdout.decode("utf-8") if result.returncode == 0 else None


def context_at(revision, cap):
    context = git_file(revision, "AGENTS.md")
    source = git_file(revision, "CLAUDE.md")
    if context is None:
        context = source
    if context is None or not context.strip() or len(context.encode()) > cap:
        raise ValueError("Base/candidate reviewer context is missing or oversized")
    if "generated-by: co-agent" in context:
        if source is None:
            raise ValueError("Generated context has no canonical source")
        digest = hashlib.sha256(source.encode()).hexdigest()[:12]
        if not re.search(rf"claude-md-sha:\s*{digest}\b", context):
            raise ValueError("Generated reviewer context is stale")
    return context


def prepare(head, base, work, supplied_diff=None):
    if not all(re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (head, base)):
        raise ValueError("Review requires immutable commit SHAs")
    if command("git", "rev-parse", "HEAD").strip() != base:
        raise ValueError("Review scripts must run from the pinned base checkout")
    repository = os.environ.get("GH_REPO") or os.environ["GITHUB_REPOSITORY"]
    merge_base = command(
        "gh", "api", f"repos/{repository}/compare/{base}...{head}",
        "--jq", ".merge_base_commit.sha",
    ).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", merge_base):
        raise ValueError("GitHub returned an invalid merge base")
    # Fetch objects as data. Never check out or run PR-head code or hooks.
    subprocess.run(
        ["git", "fetch", "--no-tags", "--depth=1", "origin", merge_base, head],
        check=True, stdout=subprocess.DEVNULL,
    )
    cap = int(os.environ.get("REVIEW_CONTEXT_CAP", "24000"))
    if not 0 < cap <= 24000:
        raise ValueError("REVIEW_CONTEXT_CAP must be between 1 and 24000 bytes")
    policy = project_policy()
    if policy:
        name = policy["input_adapter"]
        file = DIRECTORY / name
        # Load only the exact trusted-base adapter, never an untracked replacement.
        expected = git_file(base, f"scripts/pr-review/{name}")
        if file.is_symlink() or expected is None or file.read_bytes().decode("utf-8") != expected:
            raise ValueError("Project adapter differs from the trusted base")
        spec = importlib.util.spec_from_file_location("project_review_input", file)
        adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adapter)
        selected = adapter.prepare(head, base, merge_base, work, supplied_diff)
        diff = selected["diff"].decode("utf-8")
        context = selected["context"].decode("utf-8")
        paths = selected["paths"]
        provenance = dict(selected["provenance"], input_failures=selected["input_failures"])
        if set(provenance["context_sources"]) != set(policy["context_sources"]):
            raise ValueError("Project context sources differ from the policy")
        provenance["project_policy_sha256"] = hashlib.sha256(
            (DIRECTORY / "role-project.json").read_bytes()
        ).hexdigest()
    else:
        context = context_at(base, cap)
        context_at(head, cap)  # Candidate bytes never become instructions.
        options = [
            "git", "-c", "diff.noprefix=false", "diff", "--no-ext-diff",
            "--no-textconv", "--no-color", "--no-renames", merge_base, head,
        ]
        diff = command(*options, "--")
        paths = [path for path in command(*options, "--name-only", "-z", "--").split("\0") if path]
        provenance = {
            "head_sha": head, "base_sha": base, "merge_base_sha": merge_base,
            "diff_sha256": hashlib.sha256(diff.encode()).hexdigest(), "scope_paths": paths,
        }
    work.mkdir(parents=True, exist_ok=True)
    (work / "project-context.md").write_bytes(context.encode("utf-8"))
    (work / "role-diff.txt").write_bytes(diff.encode("utf-8"))
    (work / "role-paths.json").write_text(json.dumps(paths) + "\n")
    (work / "role-source.json").write_text(json.dumps(provenance, sort_keys=True) + "\n")
    result = subprocess.run([
        sys.executable, str(DIRECTORY / "role_review.py"), "prepare",
        "--head", head, "--base", base, "--work", str(work),
        "--context", str(work / "project-context.md"),
        "--diff", str(work / "role-diff.txt"),
        "--paths", str(work / "role-paths.json"),
        "--context-cap", str(cap),
        "--provenance", str(work / "role-source.json"),
    ])
    if result.returncode not in (0, 2):
        raise RuntimeError("Specialist preparation failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--prepared-diff", type=Path)
    arguments = parser.parse_args()
    prepare(os.environ["HEAD_SHA"], os.environ["BASE_SHA"], arguments.work.resolve(),
            arguments.prepared_diff)


if __name__ == "__main__":
    main()
