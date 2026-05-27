from pathlib import Path
import pytest
from adrverify.parse_adr import parse_adr, ParsedAdr


def test_parse_full_verification(sample_adr_with_full_verification: Path):
    p = parse_adr(sample_adr_with_full_verification)
    assert p.adr_id == "ADR-099"
    assert p.frontmatter["status"] == "Accepted"
    assert p.frontmatter["verification_required"] is True
    assert p.has_verification_section is True
    assert p.verification["files"][0]["path"] == "src/sample.py"
    assert p.verification["semantic"][0]["claim"] == "Sample claim about sample.py"


def test_parse_no_verification_section(sample_adr_no_verification: Path):
    p = parse_adr(sample_adr_no_verification)
    assert p.adr_id == "ADR-098"
    assert p.frontmatter["verification_required"] is False
    assert p.has_verification_section is False
    assert p.verification == {}


def test_parse_legacy_no_frontmatter(sample_adr_legacy: Path):
    p = parse_adr(sample_adr_legacy)
    assert p.adr_id == "ADR-001"
    assert p.frontmatter == {}
    assert p.has_verification_section is False


def test_parse_invalid_yaml_in_verification(tmp_path: Path):
    adr = tmp_path / "ADR-097.md"
    adr.write_text("""\
---
status: Accepted
---

# ADR-097: Invalid YAML

## Verification

```yaml
files:
  - path: src/x.py
    must_contain
      - "broken
```
""")
    with pytest.raises(ValueError, match="Verification YAML"):
        parse_adr(adr)


def test_parse_invalid_frontmatter(tmp_path: Path):
    adr = tmp_path / "ADR-096.md"
    adr.write_text("""\
---
status: Accepted
date: not: a: date
---

# ADR-096
""")
    with pytest.raises(ValueError, match="frontmatter"):
        parse_adr(adr)
