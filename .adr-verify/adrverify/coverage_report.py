"""Merge tier1+tier2 JSON outputs into a PR sticky comment markdown blob."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from . import gh

MARKER = "<!-- adr-verify-comment -->"


def _icon(status: str) -> str:
    return {"pass": "✅", "fail": "❌", "skip": "⚪", "error": "🛑"}.get(status, "❓")


def render_comment(tier1: dict[str, Any], tier2: dict[str, Any], total_adrs: int) -> str:
    t1_by_id = {a["adr_id"]: a for a in tier1.get("adrs", [])}
    t2_by_id = {a["adr_id"]: a for a in tier2.get("adrs", [])}
    all_ids = sorted(set(t1_by_id) | set(t2_by_id))

    verified = 0
    pass_count = 0
    fail_count = 0
    advisory_count = 0  # Tier 2 fails are advisory
    skipped = 0
    error_count = 0

    details: list[str] = []
    for adr_id in all_ids:
        t1 = t1_by_id.get(adr_id, {}).get("tier1_static", {"status": "skip"})
        t2 = t2_by_id.get(adr_id, {}).get("tier2_semantic", {"status": "skip"})

        if t1["status"] == "skip" and t2["status"] == "skip":
            skipped += 1
            continue

        verified += 1
        if t1["status"] == "fail":
            fail_count += 1
        elif t2["status"] == "fail":
            advisory_count += 1
        elif t1["status"] == "error" or t2["status"] == "error":
            error_count += 1
        else:
            pass_count += 1

        overall_icon = _icon(
            "fail" if t1["status"] == "fail"
            else "fail" if t2["status"] == "fail"
            else "error" if "error" in (t1["status"], t2["status"])
            else "pass"
        )

        block: list[str] = []
        block.append(f"<details><summary>{overall_icon} {adr_id}</summary>\n")

        if t1["status"] != "skip":
            t1_passes = sum(1 for c in t1.get("checks", []) if c["result"] == "pass")
            t1_total = len(t1.get("checks", []))
            block.append(f"**Static** ({t1_passes}/{t1_total})")
            for c in t1.get("checks", []):
                ic = _icon(c["result"])
                evidence = c.get("evidence") or ""
                block.append(f"- {ic} `{c['path']}` {c['rule']} `{c['value']}` — {evidence}")
            if t1.get("error"):
                block.append(f"- 🛑 {t1['error']}")

        if t2["status"] != "skip":
            t2_passes = sum(1 for c in t2.get("claims", []) if c["verdict"] == "pass")
            t2_total = len(t2.get("claims", []))
            block.append(f"\n**Semantic** ({t2_passes}/{t2_total})")
            for c in t2.get("claims", []):
                ic = _icon("pass" if c["verdict"] == "pass" else "fail")
                ev_line = ""
                if c.get("evidence"):
                    e0 = c["evidence"][0]
                    ev_line = f"  - `{e0['file']}:{e0['line']}` `{e0.get('snippet','')[:80]}`"
                block.append(f"- {ic} {c['claim']}")
                if ev_line:
                    block.append(ev_line)
                block.append(f"  - {c['reason']}")
            if t2.get("error"):
                block.append(f"- 🛑 {t2['error']}")

        block.append("\n</details>")
        details.append("\n".join(block))

    header = (
        "## 🧭 ADR Compliance — `cc-on-bedrock`\n\n"
        f"Coverage: {verified}/{total_adrs} ADRs verified "
        f"({skipped} skipped — no `## Verification` or `verification_required: false`)\n"
        f"Result: ✅ {pass_count} pass · ⚠️ {advisory_count} advisory · ❌ {fail_count} fail"
        + (f" · 🛑 {error_count} error" if error_count else "")
        + "\n\n"
    )

    body = MARKER + "\n" + header + "\n".join(details)
    return body


def _main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier1", type=Path, required=True)
    ap.add_argument("--tier2", type=Path, required=True)
    ap.add_argument("--total-adrs", type=int, default=24)
    ap.add_argument("--post-pr", type=int, default=0,
                    help="PR number to upsert sticky comment to (0 = stdout only)")
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""),
                    help="owner/name (defaults to GITHUB_REPOSITORY)")
    args = ap.parse_args()

    tier1 = json.loads(args.tier1.read_text(encoding="utf-8"))
    tier2 = json.loads(args.tier2.read_text(encoding="utf-8"))
    body = render_comment(tier1, tier2, total_adrs=args.total_adrs)

    if args.post_pr and args.repo:
        gh.upsert_pr_sticky_comment(args.repo, args.post_pr, MARKER, body)
    else:
        print(body)
    return 0


if __name__ == "__main__":
    sys.exit(_main())
