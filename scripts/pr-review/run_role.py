#!/usr/bin/env python3
"""Execute one prepared specialist review without changing its scope."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from role_review import diagnostic_failure


DIRECTORY = Path(__file__).resolve().parent
FAILURE = re.compile(
    r"Monthly request limit reached|MONTHLY_REQUEST_COUNT|UsageLimitReachedError|"
    r"ServiceQuotaExceededException|You have reached the limit for overages|"
    r"no agent with name|Falling back to user specified default|"
    r"Json supplied at .* is invalid|failed to set model|using tool:",
    re.IGNORECASE,
)
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
AGENT = {
    "name": "inline-review",
    "description": "Review inline data without tools, hooks or external resources.",
    "tools": [], "allowedTools": [], "mcpServers": {}, "resources": [],
    "hooks": {}, "useLegacyMcpJson": False,
}


def execute(command, cwd, environment, input_text, timeout):
    """Keep exit status and kill the whole process group on timeout."""
    try:
        process = subprocess.Popen(
            command, cwd=cwd, env=environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            encoding="utf-8", errors="replace", start_new_session=True,
        )
    except OSError:
        return 127, "", "Review CLI unavailable."
    try:
        output, error = process.communicate(input_text, timeout=timeout)
        return process.returncode, output, error
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        output, error = process.communicate()
        return 124, output, error + "\nReview CLI timed out."


def kiro_environment(cwd, source):
    environment = {
        key: source[key] for key in (
            "PATH", "LANG", "LC_ALL", "TMPDIR", "KIRO_API_KEY", "RUNNER_TRACKING_ID"
        )
        if key in source
    }
    environment["HOME"] = str(cwd)
    return environment


def install_agent(cwd):
    location = cwd / ".kiro" / "agents"
    location.mkdir(parents=True, exist_ok=True)
    (location / "inline-review.json").write_text(json.dumps(AGENT) + "\n")


def preflight(binary, model, cwd, environment, timeout):
    install_agent(cwd)
    (cwd / "preflight-canary.txt").write_text(secrets.token_hex(24) + "\n")
    prompt = (
        "Kiro startup safety check. Read ./preflight-canary.txt using a file-reading "
        "tool and return its exact contents. If no file-reading tools are available, "
        "reply with exactly NO_TOOLS. Do not run any other tools."
    )
    code, output, error = execute(
        [binary, "chat", prompt, "--model", model, "--agent", "inline-review",
         "--no-interactive", "--wrap", "never"],
        cwd, kiro_environment(cwd, environment), "", timeout,
    )
    reply = re.sub(r"(?m)^\s*> ?", "", ANSI.sub("", output)).strip()
    return code == 0 and reply == "NO_TOOLS" and not FAILURE.search(error), code, error


def bounded_setting(name, default, maximum):
    value = int(os.environ.get(name, default))
    if not 0 < value <= maximum:
        raise ValueError(f"{name} must be between 1 and {maximum}")
    return value


def scrub(text):
    """Reuse the repository's control and credential scrubbers before publication."""
    process = subprocess.run(
        ["bash", "-c", 'source "$1"; source "$2"; strip_ansi | scrub_secrets',
         "review-scrub", str(DIRECTORY / "lib.sh"), str(DIRECTORY / "role-controls.sh")],
        input=text, text=True, capture_output=True,
    )
    if process.returncode:
        raise RuntimeError("Review output scrubber failed")
    return process.stdout


def run(work, tag):
    plan = json.loads((work / "role-plan.json").read_text())
    role = plan["roles"][tag]
    if not plan["input_complete"]:
        print(f"{tag}: input incomplete; no provider call")
        return
    if not role["required"]:
        print(f"{tag}: NOT_APPLICABLE — {role['reason']}")
        return
    slot = work / "slot"
    slot.mkdir(exist_ok=True)
    runtime = work / "runtime"
    runtime.mkdir(exist_ok=True)
    attempts = bounded_setting("PANEL_RETRIES", 2, 3)
    timeout = bounded_setting("PANEL_TIMEOUT", 300, 900)
    preflight_timeout = bounded_setting("KIRO_PREFLIGHT_TIMEOUT", 60, 120)
    prompt = (work / "roles" / f"{tag}.txt").read_bytes().decode("utf-8")
    diff = (work / "roles" / f"{tag}.diff").read_bytes().decode("utf-8")
    start = time.monotonic()
    environment = dict(os.environ)
    # GitHub writes belong to the publisher. No review process needs this token.
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"):
        environment.pop(name, None)
    output = ""
    error = ""
    code = 1
    with tempfile.TemporaryDirectory(prefix=f"{tag}-", dir=runtime) as temporary:
        cwd = Path(temporary)
        if tag.startswith("kiro-"):
            binary = shutil.which("kiro-cli") or "kiro-cli"
            ok, code, error = preflight(
                binary, role["model"], cwd, environment, preflight_timeout
            )
            if not ok:
                (slot / f"kiro-preflight-{tag}.flag").write_text(
                    "Kiro startup safety check failed; PR input withheld.\n"
                )
                code = code or 1
            else:
                instruction = prompt + "\n\nUNTRUSTED DIFF DATA:\n" + diff
                if len(instruction.encode()) >= 131072:
                    code, error = 1, "Complete Kiro input exceeds argument limit."
                else:
                    command = [
                        binary, "chat", instruction, "--model", role["model"],
                        "--agent", "inline-review", "--no-interactive", "--wrap", "never",
                    ]
                    for _ in range(attempts):
                        code, output, error = execute(
                            command, cwd, kiro_environment(cwd, environment), "", timeout
                        )
                        if FAILURE.search(error):
                            code = code or 1
                            break
                        if code == 0 and output.strip():
                            break
        else:
            environment.pop("KIRO_API_KEY", None)
            if tag == "codex":
                command = [
                    "codex", "exec", "--model", role["model"],
                    "-s", "read-only", "--skip-git-repo-check", prompt,
                ]
                # Keep the trusted base checkout and its configured Bedrock provider.
                cwd = Path.cwd()
            elif tag == "claude-self":
                command = [
                    "claude", "-p", prompt, "--model", role["model"],
                    "--output-format", "text", "--strict-mcp-config", "--tools", "",
                ]
            else:
                raise ValueError("Unknown specialist")
            for _ in range(attempts):
                code, output, error = execute(command, cwd, environment, diff, timeout)
                if diagnostic_failure(error):
                    code = code or 1
                    break
                if code == 0 and output.strip():
                    break
    # Only scrubbed artifacts enter slot/. Runtime raw output is never uploaded.
    output_path = runtime / f"{tag}.txt"
    error_path = runtime / f"{tag}.err"
    output_path.write_text(scrub(output))
    error_path.write_text(scrub(error))
    result = subprocess.run([
        sys.executable, str(DIRECTORY / "role_review.py"), "record",
        "--work", str(work), "--tag", tag, "--output", str(output_path),
        "--stderr", str(error_path), "--exit-code", str(code),
    ])
    if result.returncode not in (0, 2):
        raise RuntimeError("Specialist result recording failed")
    (slot / f"{tag}-timing.json").write_text(json.dumps({
        "tag": tag, "elapsed_seconds": round(time.monotonic() - start, 3),
        "exit_code": code, "configured_model": role["model"],
    }, sort_keys=True) + "\n")
    print(f"{tag}: finished in {time.monotonic() - start:.1f}s (exit {code})")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    arguments = parser.parse_args()
    run(arguments.work.resolve(), arguments.tag)


if __name__ == "__main__":
    main()
