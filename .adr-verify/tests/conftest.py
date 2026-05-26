from pathlib import Path
import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES_DIR


@pytest.fixture
def sample_adr_with_full_verification(tmp_path: Path) -> Path:
    """ADR with frontmatter + ## Verification YAML (Tier 1+2)."""
    adr = tmp_path / "ADR-099-sample.md"
    adr.write_text("""\
---
status: Accepted
date: 2026-05-26
verification_required: true
---

# ADR-099: Sample ADR

## Context
Test fixture.

## Decision
Test fixture.

## Verification

```yaml
files:
  - path: src/sample.py
    must_contain:
      - "expected_string"
  - path: src/**/*.py
    must_not_contain:
      - "forbidden_pattern"
semantic:
  - claim: "Sample claim about sample.py"
    context_files:
      - src/sample.py
```
""")
    return adr


@pytest.fixture
def sample_adr_no_verification(tmp_path: Path) -> Path:
    """ADR with frontmatter but no ## Verification — skip+warn case."""
    adr = tmp_path / "ADR-098-no-verify.md"
    adr.write_text("""\
---
status: Accepted
date: 2026-05-26
verification_required: false
---

# ADR-098: No Verification Sample

## Context
Procedural ADR with no testable claims.
""")
    return adr


@pytest.fixture
def sample_adr_legacy(tmp_path: Path) -> Path:
    """Pre-frontmatter ADR (one of the existing 24)."""
    adr = tmp_path / "ADR-001-legacy.md"
    adr.write_text("""\
# ADR-001: Legacy Sample

## Status
Accepted (2026-04-01)

## Context
No frontmatter.
""")
    return adr
