# Sync Docs

Synchronize project documentation with current code state.

## Actions

### 1. Quality Assessment
Score each steering/doc file (0-100):
- Commands/workflows (20), Architecture clarity (20), Non-obvious patterns (15)
- Conciseness (15), Currency (15), Actionability (15)

### 2. AGENT.md Sync
Update Overview, Tech Stack, Conventions, Key Commands. Verify commands are copy-paste ready.

### 3. Architecture Doc Sync
Update `docs/architecture.md` to reflect current system structure.

### 4. Module Steering Audit
- Scan all directories under cdk/, terraform/, cloudformation/, docker/, shared/
- Create steering doc for modules missing one
- Update existing steering docs if out of date

### 5. ADR Audit
- Check recent commits (`git log --oneline -20`)
- Suggest new ADRs for undocumented architectural decisions
- ADR format: `docs/decisions/ADR-NNN-concise-title.md`

### 6. README.md Sync
Update project structure section to match actual directory layout.

### 7. Report
Output before/after quality scores and list of all changes.
