"""Parse an ADR markdown file: frontmatter + ## Verification YAML block.

ADR filenames must match the pattern `ADR-NNN-<slug>.md` so the numeric id
can be derived from the path. Frontmatter is optional (legacy ADRs predate
it). The ## Verification section, if present, must contain a single fenced
YAML block.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ADR_ID_RE = re.compile(r"^(ADR-\d+)(?:[-.]|$)", re.IGNORECASE)
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
VERIFICATION_BLOCK_RE = re.compile(
    r"^## Verification\s*\n+```ya?ml\n(.*?)\n```",
    re.DOTALL | re.MULTILINE,
)


@dataclass
class ParsedAdr:
    """Result of parsing one ADR markdown file."""
    path: Path
    adr_id: str
    frontmatter: dict[str, Any] = field(default_factory=dict)
    body: str = ""
    verification: dict[str, Any] = field(default_factory=dict)

    @property
    def has_verification_section(self) -> bool:
        return bool(self.verification)

    @property
    def verification_required(self) -> bool:
        return bool(self.frontmatter.get("verification_required", False))


def parse_adr(path: Path) -> ParsedAdr:
    """Read and parse one ADR. Raise ValueError for malformed frontmatter or
    Verification YAML so the CI pipeline can surface the error to the author.
    """
    match = ADR_ID_RE.search(path.name)
    if not match:
        raise ValueError(f"path {path.name} does not match ADR-NNN-<slug>.md")
    adr_id = match.group(1).upper()

    content = path.read_text(encoding="utf-8")

    frontmatter: dict[str, Any] = {}
    body = content
    fm_match = FRONTMATTER_RE.match(content)
    if fm_match:
        try:
            frontmatter = yaml.safe_load(fm_match.group(1)) or {}
        except yaml.YAMLError as e:
            raise ValueError(f"{path.name}: invalid frontmatter — {e}") from e
        if not isinstance(frontmatter, dict):
            raise ValueError(f"{path.name}: frontmatter must be a YAML mapping")
        body = content[fm_match.end():]

    verification: dict[str, Any] = {}
    ver_match = VERIFICATION_BLOCK_RE.search(body)
    if ver_match:
        try:
            verification = yaml.safe_load(ver_match.group(1)) or {}
        except yaml.YAMLError as e:
            raise ValueError(f"{path.name}: invalid Verification YAML — {e}") from e
        if not isinstance(verification, dict):
            raise ValueError(f"{path.name}: Verification YAML must be a mapping")

    return ParsedAdr(
        path=path,
        adr_id=adr_id,
        frontmatter=frontmatter,
        body=body,
        verification=verification,
    )


def discover_adrs(decisions_dir: Path) -> list[Path]:
    """Return every ADR-NNN-*.md under decisions_dir, sorted by id."""
    paths = sorted(
        decisions_dir.glob("ADR-*.md"),
        key=lambda p: p.name,
    )
    return [p for p in paths if ADR_ID_RE.search(p.name)]
