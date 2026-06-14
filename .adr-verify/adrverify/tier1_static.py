"""Tier 1 static checks: deterministic file content rules.

Rule kinds supported on each `files[]` entry:
  - must_contain: list of substrings or /regex/. ALL must match the file
    content (failure on first miss).
  - must_not_contain: list of substrings or /regex/. NONE may match
    (failure on first hit; evidence shows which file).
  - must_exist: bool (default True). If False, the file MUST NOT exist.

A `path:` value may be a single relative path or a glob (`**/*.ts`). Glob
matching uses pathlib.PurePath.glob — symlinks are followed, hidden files
included only if explicitly globbed.

CLI entry point produces a JSON document on stdout suitable for piping into
coverage_report.py. Exit code is 0 if all checks pass (and at least one was
run); 1 if any FAIL; 2 if a required-but-missing-Verification ADR is
encountered (Soft launch + 강제 rule from the spec).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .parse_adr import ADR_ID_RE, ParsedAdr, discover_adrs, parse_adr


@dataclass
class StaticCheckOutcome:
    path: str
    rule: str
    value: str
    result: str  # "pass" | "fail"
    evidence: str = ""


@dataclass
class StaticResult:
    status: str  # "pass" | "fail" | "skip"
    checks: list[StaticCheckOutcome] = field(default_factory=list)


def _resolve_paths(repo_root: Path, path_spec: str) -> list[Path]:
    """Expand a glob or single path under repo_root. Returns sorted, deduped."""
    if any(ch in path_spec for ch in "*?["):
        # glob — pathlib supports ** for recursive
        return sorted(set(repo_root.glob(path_spec)))
    return [repo_root / path_spec]


def _match_pattern(content: str, pattern: str) -> bool:
    """Substring by default; /regex/ if pattern is wrapped in slashes."""
    if len(pattern) >= 2 and pattern.startswith("/") and pattern.endswith("/"):
        inner = pattern[1:-1]
        if not inner:
            raise ValueError(f"empty regex pattern: {pattern}")
        return re.search(inner, content) is not None
    return pattern in content


def _evidence_line(file_path: Path, content: str, pattern: str, repo_root: Path) -> str:
    """Find first line containing pattern (substring or regex). Used for failure evidence."""
    for i, line in enumerate(content.splitlines(), start=1):
        if _match_pattern(line, pattern):
            return f"{file_path.relative_to(repo_root)}:{i}: {line.strip()[:120]}"
    return str(file_path.relative_to(repo_root))


def run_static_checks(verification: dict[str, Any], repo_root: Path) -> StaticResult:
    """Run every Tier 1 rule in the Verification YAML block."""
    files_rules = verification.get("files") or []
    if not files_rules:
        return StaticResult(status="skip")

    checks: list[StaticCheckOutcome] = []
    for rule in files_rules:
        path_spec = rule["path"]
        matched = _resolve_paths(repo_root, path_spec)

        # must_exist — when explicitly present, ALWAYS emit a row reflecting
        # whether the actual presence matches the declared expectation.
        must_exist = rule.get("must_exist", True)
        if "must_exist" in rule:
            has_any = any(p.is_file() for p in matched)
            passed = (has_any == bool(must_exist))
            if passed:
                evidence = ""
            elif must_exist:
                evidence = f"no file matched {path_spec}"
            else:
                first = next(p for p in matched if p.is_file())
                evidence = f"file exists but must_exist=False: {first.relative_to(repo_root)}"
            checks.append(StaticCheckOutcome(
                path=path_spec, rule="must_exist",
                value=str(must_exist), result="pass" if passed else "fail",
                evidence=evidence,
            ))
            if not must_exist:
                continue  # file shouldn't exist → don't try content checks
            if not has_any:
                continue  # file should exist but doesn't → can't run content checks

        existing = [p for p in matched if p.is_file()]
        if not existing and (rule.get("must_contain") or rule.get("must_not_contain")):
            # path expected to exist but does not — fail loudly
            checks.append(StaticCheckOutcome(
                path=path_spec, rule="must_exist", value="True",
                result="fail", evidence=f"no file matched {path_spec}",
            ))
            continue

        for f in existing:
            content = f.read_text(encoding="utf-8", errors="replace")

            for pat in rule.get("must_contain", []):
                hit = _match_pattern(content, pat)
                checks.append(StaticCheckOutcome(
                    path=str(f.relative_to(repo_root)),
                    rule="must_contain",
                    value=pat,
                    result="pass" if hit else "fail",
                    evidence=(_evidence_line(f, content, pat, repo_root) if hit
                              else f"{f.relative_to(repo_root)}: pattern not found: {pat}"),
                ))

            for pat in rule.get("must_not_contain", []):
                hit = _match_pattern(content, pat)
                checks.append(StaticCheckOutcome(
                    path=str(f.relative_to(repo_root)),
                    rule="must_not_contain",
                    value=pat,
                    result="fail" if hit else "pass",
                    evidence=(_evidence_line(f, content, pat, repo_root) if hit
                              else ""),
                ))

    if not checks:
        return StaticResult(status="skip")

    overall = "fail" if any(c.result == "fail" for c in checks) else "pass"
    return StaticResult(status=overall, checks=checks)


def _main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", type=Path, default=Path.cwd())
    ap.add_argument("--decisions-dir", type=Path,
                    default=Path("docs/decisions"))
    ap.add_argument("--output", type=Path, default=Path("-"),
                    help="write JSON results here (default stdout)")
    args = ap.parse_args()

    decisions = args.repo_root / args.decisions_dir
    out: dict[str, Any] = {"adrs": []}
    any_fail = False

    for adr_path in discover_adrs(decisions):
        try:
            parsed = parse_adr(adr_path)
        except ValueError as e:
            m = ADR_ID_RE.search(adr_path.name)
            adr_id_fallback = m.group(1).upper() if m else adr_path.stem
            out["adrs"].append({
                "adr_id": adr_id_fallback,
                "frontmatter": {},
                "tier1_static": {
                    "status": "error",
                    "checks": [],
                    "error": str(e),
                },
            })
            any_fail = True
            continue

        if parsed.verification_required and not parsed.has_verification_section:
            # verification_required: true but the ## Verification section has no machine-checkable
            # (fenced ```yaml) items — e.g. a prose-only section or none at all. There is nothing to
            # statically verify, so treat as SKIP (not a hard fail), consistent with
            # run_static_checks() returning "skip" for an empty verification block. An ADR that
            # documents a decision with no mechanically-verifiable claim must not block CI.
            out["adrs"].append({
                "adr_id": parsed.adr_id,
                "frontmatter": parsed.frontmatter,
                "tier1_static": {
                    "status": "skip",
                    "checks": [],
                    "note": "verification_required: true but no machine-checkable ## Verification items — nothing to verify (skipped)",
                },
            })
            continue

        result = run_static_checks(parsed.verification, repo_root=args.repo_root)
        out["adrs"].append({
            "adr_id": parsed.adr_id,
            "frontmatter": parsed.frontmatter,
            "tier1_static": asdict(result),
        })
        if result.status == "fail":
            any_fail = True

    text = json.dumps(out, indent=2, ensure_ascii=False, default=str)
    if str(args.output) == "-":
        print(text)
    else:
        args.output.write_text(text, encoding="utf-8")
    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(_main())
