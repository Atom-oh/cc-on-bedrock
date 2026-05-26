"""One-shot migration: derive frontmatter from each legacy ADR's existing
status/date/links and prepend a YAML block. Idempotent — already-migrated
files are untouched.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import re
import sys
from pathlib import Path

import yaml

from .parse_adr import discover_adrs

STATUS_LINE_RE = re.compile(
    r"^##\s*Status\s*\n+([^\n]+)",
    re.MULTILINE,
)
BOLD_STATUS_RE = re.compile(r"^\*\*Status:\*\*\s+([A-Za-z]+)", re.MULTILINE)
BOLD_DATE_RE = re.compile(r"^\*\*Date:\*\*\s+(\d{4}-\d{2}-\d{2})", re.MULTILINE)
BOLD_BUILDS_ON_RE = re.compile(
    r"^\*\*Builds on:\*\*\s+\[(ADR-\d+)",
    re.MULTILINE,
)
# Inline-heading variants — "## Status: Accepted" / "## Date: 2026-04-03"
# (ADRs 004/005/006).
INLINE_STATUS_HEADING_RE = re.compile(
    r"^##\s*Status\s*:\s*(\S+)",
    re.MULTILINE,
)
INLINE_DATE_HEADING_RE = re.compile(
    r"^##\s*Date\s*:\s*(\d{4}-\d{2}-\d{2})",
    re.MULTILINE,
)
# Accept date followed by paren-close OR comma OR space
# (allows "(2026-04-03, retrospective ...)" patterns in ADRs 017-020).
DATE_IN_PAREN_RE = re.compile(r"\((\d{4}-\d{2}-\d{2})[\),\s]")
SUPERSEDED_RE = re.compile(
    r"Superseded by\s+\[(ADR-\d+)",
    re.IGNORECASE,
)


def _derive_frontmatter(content: str) -> dict:
    """Extract status / date / superseded_by / builds_on from the body."""
    # Legacy backfill default: false. Tasks 10-15 (and any future PR
    # that adds a ## Verification section) flip this to true.
    fm: dict = {"verification_required": False}

    bold_status = BOLD_STATUS_RE.search(content)
    bold_date = BOLD_DATE_RE.search(content)
    bold_builds = BOLD_BUILDS_ON_RE.search(content)

    status_match = STATUS_LINE_RE.search(content)
    if bold_status:
        fm["status"] = bold_status.group(1).strip()
        if bold_date:
            fm["date"] = _dt.date.fromisoformat(bold_date.group(1))
    elif status_match:
        line = status_match.group(1).strip()
        if line.lower().startswith("superseded"):
            fm["status"] = "Superseded"
            m = SUPERSEDED_RE.search(line)
            if m:
                fm["superseded_by"] = m.group(1).upper()
        elif line.lower().startswith("proposed"):
            fm["status"] = "Proposed"
        elif line.lower().startswith("deprecated"):
            fm["status"] = "Deprecated"
        else:
            fm["status"] = "Accepted"
        d = DATE_IN_PAREN_RE.search(line)
        if d:
            fm["date"] = _dt.date.fromisoformat(d.group(1))

    # Fallback: ## Status: ... heading form (ADRs 004-006)
    if "status" not in fm:
        m = INLINE_STATUS_HEADING_RE.search(content)
        if m:
            word = m.group(1).strip().lower()
            if word.startswith("accepted"):
                fm["status"] = "Accepted"
            elif word.startswith("proposed"):
                fm["status"] = "Proposed"
            elif word.startswith("superseded"):
                fm["status"] = "Superseded"
            elif word.startswith("deprecated"):
                fm["status"] = "Deprecated"

    if "date" not in fm:
        m = INLINE_DATE_HEADING_RE.search(content)
        if m:
            fm["date"] = _dt.date.fromisoformat(m.group(1))

    if bold_builds:
        fm["builds_on"] = bold_builds.group(1).upper()

    return fm


def backfill_one(path: Path) -> bool:
    """Add frontmatter if absent. Return True if file changed."""
    content = path.read_text(encoding="utf-8")
    if content.startswith("---\n"):
        return False

    fm = _derive_frontmatter(content)
    ordered: dict = {}
    for k in ("status", "date", "verification_required",
              "runtime_required", "related", "superseded_by", "builds_on"):
        if k in fm:
            ordered[k] = fm[k]

    block = "---\n" + yaml.safe_dump(ordered, sort_keys=False).rstrip() + "\n---\n\n"
    path.write_text(block + content, encoding="utf-8")
    return True


def _main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--decisions-dir", type=Path, default=Path("docs/decisions"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    changed = 0
    for adr_path in discover_adrs(args.decisions_dir):
        if args.dry_run:
            content = adr_path.read_text(encoding="utf-8")
            if not content.startswith("---\n"):
                print(f"would migrate: {adr_path.name}")
            continue
        if backfill_one(adr_path):
            changed += 1
            print(f"migrated: {adr_path.name}")
    print(f"\n{changed} ADR(s) migrated.")
    return 0


if __name__ == "__main__":
    sys.exit(_main())
