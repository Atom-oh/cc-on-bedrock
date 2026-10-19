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

from role_review import diagnostic_failure, issue_request, MAX_REQUEST_BYTES


DIRECTORY = Path(__file__).resolve().parent
FAILURE = re.compile(
    r"Monthly request limit reached|MONTHLY_REQUEST_COUNT|UsageLimitReachedError|"
    r"ServiceQuotaExceededException|You have reached the limit for overages|"
    r"no agent with name|Falling back to user specified default|"
    r"Json supplied at .* is invalid|failed to set model|using tool:",
    re.IGNORECASE,
)
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


def codex_response(raw, final_path):
    """Validate all events, then read the CLI-designated final reply unchanged."""
    started = completed = failed = False
    has_message = False
    diagnostics = []
    def diagnostic(text):
        line = " ".join(text.splitlines())
        if line.lower().startswith("model rerouted:"):
            line = "Falling back to another model: " + line
        diagnostics.append(line)

    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            failed = True
            continue
        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
            failed = True
            continue
        kind = event["type"]
        if completed:
            failed = True
        if kind in ("error", "turn.failed"):
            # Native "error" includes in-turn reconnect notices. A completed
            # turn may recover; the caller still rejects terminal diagnostics.
            if kind == "turn.failed":
                failed = True
            error = event.get("error", event)
            text = error.get("message") if isinstance(error, dict) else None
            if isinstance(text, str):
                diagnostic(text)
            else:
                failed = True
            continue
        if kind == "turn.started":
            if started:
                failed = True
            started = True
        elif kind == "turn.completed":
            if not started:
                failed = True
            completed = True
        elif kind == "item.completed":
            item = event.get("item")
            if not started or not isinstance(item, dict):
                failed = True
            elif item.get("type") == "error":
                text = item.get("message")
                if isinstance(text, str):
                    diagnostic(text)
                else:
                    failed = True
            elif item.get("type") == "agent_message":
                text = item.get("text")
                if not isinstance(text, str):
                    failed = True
                else:
                    # Progress items are not the final response. Codex owns
                    # final-message selection; never search for parsable JSON.
                    has_message = True
    if failed or not completed or not has_message:
        diagnostics.append("Codex event stream did not complete with agent output.")
        return "", "\n".join(diagnostics), False
    try:
        if final_path.is_symlink() or not final_path.is_file():
            raise OSError("Final reply is not a regular file")
        output = final_path.read_bytes().decode("utf-8")
    except (OSError, UnicodeError):
        diagnostics.append("Codex final reply file is missing or invalid.")
        return "", "\n".join(diagnostics), False
    return output, "\n".join(diagnostics), True


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


def controls(text):
    """Use the existing CSI/OSC/C1 contract without redacting diagnostic text."""
    process = subprocess.run(
        ["bash", "-c", 'set -e; source "$1"; strip_ansi',
         "review-controls", str(DIRECTORY / "role-controls.sh")],
        input=text, text=True, encoding="utf-8", capture_output=True,
    )
    if process.returncode:
        raise RuntimeError("Review control-byte normalizer failed")
    return process.stdout


def preflight(binary, model, cwd, environment, timeout):
    # Keep model selection and the empty-agent guard on the validated Kiro v1 path.
    install_agent(cwd)
    (cwd / "preflight-canary.txt").write_text(secrets.token_hex(24) + "\n")
    prompt = (
        "Kiro startup safety check. Read ./preflight-canary.txt using a file-reading "
        "tool and return its exact contents. If no file-reading tools are available, "
        "reply with exactly NO_TOOLS. Do not run any other tools."
    )
    code, output, error = execute(
        [binary, "chat", prompt, "--model", model, "--agent", "inline-review",
         "--no-interactive", "--wrap", "never", "--legacy-ui", "--agent-engine", "v1"],
        cwd, kiro_environment(cwd, environment), "", timeout,
    )
    reply = re.sub(r"(?m)^\s*> ?", "", controls(output)).strip()
    diagnostic = controls(error)
    return (code == 0 and reply == "NO_TOOLS" and not FAILURE.search(diagnostic)
            and not diagnostic_failure(diagnostic)), code, error



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


def preserve_stdout_error(output, error):
    lines = controls(output).lstrip().splitlines()
    first = re.sub(r"^> ?", "", lines[0]) if lines else ""
    # JSON review evidence and JSONL events are not text-mode CLI diagnostics.
    if first.startswith(("{", "```")):
        return error
    if re.match(r"(?:Error:\s*)?(?:You have reached the )?limit for overages\b", first, re.I):
        first = "UsageLimitReachedError: overage limit reported on stdout"
    return error + "\n" + first if diagnostic_failure(first) else error


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
    nonce, framed_prompt, payload = issue_request(work, tag)
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
                instruction = framed_prompt + "\n" + payload
                if len(instruction.encode()) >= MAX_REQUEST_BYTES:
                    code, error = 1, "Complete Kiro input exceeds argument limit."
                else:
                    command = [
                        binary, "chat", instruction, "--model", role["model"],
                        "--agent", "inline-review", "--no-interactive", "--wrap", "never",
                        "--legacy-ui", "--agent-engine", "v1",
                    ]
                    for _ in range(attempts):
                        nonce, framed_prompt, payload = issue_request(work, tag)
                        command[2] = framed_prompt + "\n" + payload
                        code, output, error = execute(
                            command, cwd, kiro_environment(cwd, environment), "", timeout
                        )
                        error = controls(error)
                        error = preserve_stdout_error(output, error)
                        if FAILURE.search(error) or diagnostic_failure(error):
                            code = code or 1
                            break
                        if code == 0 and output.strip():
                            break
        else:
            environment.pop("KIRO_API_KEY", None)
            if tag == "codex":
                command = [
                    "codex", "exec", "--model", role["model"],
                    "-s", "read-only", "--skip-git-repo-check", "--json",
                    "--output-last-message", "", prompt,
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
                nonce, framed_prompt, payload = issue_request(work, tag)
                if tag == "codex":
                    # The role's mode-0700 temporary directory is independent
                    # of the trusted base cwd. Each attempt gets a fresh file.
                    final_output = Path(temporary) / f"codex-final-{nonce}.txt"
                    final_output.unlink(missing_ok=True)
                    command[-2] = str(final_output)
                    command[-1] = "-"
                    delivered = framed_prompt + "\n" + payload
                else:
                    command[2] = framed_prompt
                    delivered = payload
                code, output, error = execute(command, cwd, environment, delivered, timeout)
                if tag == "codex":
                    output, event_error, complete = codex_response(output, final_output)
                    if event_error:
                        error = error + ("\n" if error else "") + event_error
                    if not complete:
                        code = code or 1
                error = controls(error)
                error = preserve_stdout_error(output, error)
                if diagnostic_failure(error):
                    code = code or 1
                    break
                if code == 0 and output.strip():
                    break
    # Diagnostics remain scrubbed. Record must see the original JSON so it can
    # validate and preserve source paths before scrubbing decoded evidence.
    error_path = runtime / f"{tag}.err"
    error_path.write_text(scrub(error))
    # NamedTemporaryFile is mode 0600 and is removed even if recording raises.
    # Keep it outside the review workspace and its publishable artifact paths.
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", prefix=f"{tag}-response-", dir=work.parent,
    ) as response:
        response.write(controls(output))
        response.flush()
        result = subprocess.run([
            sys.executable, str(DIRECTORY / "role_review.py"), "record",
            "--work", str(work), "--tag", tag, "--output", response.name,
            "--stderr", str(error_path), "--exit-code", str(code),
            "--nonce", nonce,
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
