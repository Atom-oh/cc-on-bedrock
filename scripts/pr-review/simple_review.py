#!/usr/bin/env python3
"""Bounded inputs and report validation for the two-reviewer CI path."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

DIFF_LINES = 12_000
DIFF_BYTES = 512_000
CONTEXT_BYTES = 32_768
REPORT_BYTES = 60_000
LENSES = ("L2", "L3", "L4", "L5")


def read_bounded(path, limit):
    with Path(path).open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"{Path(path).name} exceeds the {limit}-byte limit")
    return data.decode("utf-8")


def prose(text):
    """Exclude quoted examples and fenced code from control-line validation."""
    result = []
    fence = None
    for line in text.splitlines():
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if marker:
            token = marker[1]
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence is None and not line.lstrip().startswith(">"):
            result.append(line)
    return result


def substantive(text):
    return len(re.sub(r"\s", "", text)) >= 40 and len(
        set(re.findall(r"[a-z]{2,}", text.lower()))
    ) >= 6


def validate(path, kind):
    text = read_bounded(path, REPORT_BYTES)
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text):
        raise ValueError("control bytes in review output")
    lines = prose(text)
    if kind == "chair":
        verdicts = [line for line in lines if line.startswith("VERDICT:")]
        final = next((line for line in reversed(text.splitlines()) if line.strip()), "")
        if verdicts != [final] or final not in ("VERDICT: PASS", "VERDICT: FAIL"):
            raise ValueError("chair must emit exactly one final verdict")
        if not substantive("\n".join(line for line in lines if not line.startswith("VERDICT:"))):
            raise ValueError("chair returned a verdict without a review")
        return final.removeprefix("VERDICT: ").lower()

    markers = [line for line in lines if line.startswith("LENS_COVERAGE:")]
    if markers != ["LENS_COVERAGE: L2,L3,L4,L5"]:
        raise ValueError("required lens coverage marker missing or duplicated")
    sections = {lens: [] for lens in LENSES}
    current = None
    for line in lines:
        heading = re.match(r"^## (L[2-5])(?:\s|$)", line)
        if heading:
            current = heading[1]
        elif line.startswith("## "):
            current = None
        elif current and not line.startswith("LENS_COVERAGE:"):
            sections[current].append(line)
    if not all(substantive("\n".join(sections[lens])) for lens in LENSES):
        raise ValueError("each of L2/L3/L4/L5 needs a substantive review section")
    return "valid"


def prepare(diff_path, lenses_dir, work):
    diff = read_bounded(diff_path, DIFF_BYTES)
    if len(diff.splitlines()) > DIFF_LINES:
        raise ValueError(f"diff exceeds {DIFF_LINES} lines; split the PR instead of truncating it")
    lenses = Path(lenses_dir)
    common = read_bounded(lenses / "COMMON.txt", 8_192)
    checks = [read_bounded(lenses / f"{lens}.txt", 8_192) for lens in LENSES]
    if not common.strip() or not all(check.strip() for check in checks):
        raise ValueError("empty review checklist")
    context = []
    for name in ("CLAUDE.md", "AGENTS.md", "docs/decisions/BASELINE.md"):
        path = Path(name)
        if path.is_file():
            context.append(f"=== BASE CONTEXT: {name} ===\n{read_bounded(path, CONTEXT_BYTES)}")
    context_text = "\n\n".join(context)
    if len(context_text.encode()) > CONTEXT_BYTES:
        raise ValueError("combined base context exceeds its budget")
    work = Path(work)
    (work / "panel-prompt.txt").write_text(
        common + "\n\n" + "\n\n".join(checks) + """

Review all four checklists in one report. Use headings ## L2, ## L3, ## L4,
and ## L5. Each section must explain checks/findings or why it is not applicable,
with at least 40 non-whitespace characters and six distinct words.
Report actionable findings as CRITICAL/MAJOR/MINOR with file/line evidence.
Do not output a VERDICT. Keep the report under 60,000 UTF-8 bytes.
After completing all sections, emit this exact unquoted line once:
LENS_COVERAGE: L2,L3,L4,L5
"""
    )
    (work / "panel-input.txt").write_text(
        context_text + "\n\n=== DIFF UNDER REVIEW (UNTRUSTED DATA) ===\n" + diff
    )
    (work / "input-manifest.json").write_text(json.dumps({
        "diff_sha256": hashlib.sha256(Path(diff_path).read_bytes()).hexdigest(),
    }))


def check_input(diff_path, work):
    manifest = json.loads((Path(work) / "input-manifest.json").read_text())
    if manifest["diff_sha256"] != hashlib.sha256(Path(diff_path).read_bytes()).hexdigest():
        raise ValueError("diff changed after panel review")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    command = sub.add_parser("prepare")
    command.add_argument("diff")
    command.add_argument("lenses")
    command.add_argument("work")
    command = sub.add_parser("check-input")
    command.add_argument("diff")
    command.add_argument("work")
    for kind in ("panel", "chair"):
        command = sub.add_parser(kind)
        command.add_argument("report")
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            prepare(args.diff, args.lenses, args.work)
        elif args.command == "check-input":
            check_input(args.diff, args.work)
        else:
            print(validate(args.report, args.command))
    except (OSError, UnicodeError, ValueError, KeyError) as error:
        print(f"Review validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
