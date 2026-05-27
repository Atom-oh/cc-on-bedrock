# ADR Compliance Pipeline (`adrverify`)

Local scripts and GitHub Actions runners for verifying that code implements
each ADR's `## Verification` section. See
`docs/superpowers/specs/2026-05-26-adr-compliance-pipeline-design.md` for
the full design.

## Quick start (local)

```bash
cd .adr-verify
python3 -m venv .venv && source .venv/bin/activate
pip install -e .[dev]
pytest                            # run unit tests

# run tier 1 against current working tree
python -m adrverify.tier1_static --repo-root ../

# run tier 2 (requires AWS creds + Bedrock access)
AWS_REGION=ap-northeast-2 python -m adrverify.tier2_semantic --repo-root ../
```

## Scripts

| Module | CLI | Purpose |
|--------|-----|---------|
| `parse_adr.py` | — | Library — extract frontmatter + Verification YAML |
| `tier1_static.py` | `python -m adrverify.tier1_static` | Deterministic file checks |
| `tier2_semantic.py` | `python -m adrverify.tier2_semantic` | Bedrock-backed LLM checks |
| `coverage_report.py` | `python -m adrverify.coverage_report` | Build PR sticky comment |
| `backfill_frontmatter.py` | `python -m adrverify.backfill_frontmatter` | One-shot 24-ADR migration |
| `gh.py` | — | Library — GitHub API helpers |
