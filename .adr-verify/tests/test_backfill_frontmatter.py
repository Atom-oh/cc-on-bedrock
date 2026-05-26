from pathlib import Path
from adrverify.backfill_frontmatter import backfill_one


def test_backfill_standard_status_line(tmp_path: Path):
    adr = tmp_path / "ADR-021-sample.md"
    adr.write_text("""\
# ADR-021: Sample

## Status
Accepted (2026-05-13)

## Context
text
""")
    backfill_one(adr)
    out = adr.read_text()
    assert out.startswith("---\n")
    assert "status: Accepted" in out
    assert "date: 2026-05-13" in out
    assert "verification_required: true" in out
    assert "## Status" in out


def test_backfill_superseded(tmp_path: Path):
    adr = tmp_path / "ADR-001-old.md"
    adr.write_text("""\
# ADR-001: Old

## Status
Superseded by [ADR-004](ADR-004-foo.md) (2026-04-03)
""")
    backfill_one(adr)
    out = adr.read_text()
    assert "status: Superseded" in out
    assert "date: 2026-04-03" in out
    assert "superseded_by: ADR-004" in out


def test_backfill_bold_status_variant(tmp_path: Path):
    adr = tmp_path / "ADR-024-variant.md"
    adr.write_text("""\
# ADR-024: Variant

**Status:** Accepted
**Date:** 2026-05-15
**Builds on:** [ADR-022 foo](ADR-022-foo.md)

## Context
""")
    backfill_one(adr)
    out = adr.read_text()
    assert "status: Accepted" in out
    assert "date: 2026-05-15" in out
    assert "builds_on: ADR-022" in out


def test_backfill_idempotent(tmp_path: Path):
    adr = tmp_path / "ADR-021-sample.md"
    adr.write_text("""\
---
status: Accepted
date: 2026-05-13
verification_required: true
---

# ADR-021: Sample
""")
    before = adr.read_text()
    backfill_one(adr)
    after = adr.read_text()
    assert before == after, "already-migrated file must be unchanged"
