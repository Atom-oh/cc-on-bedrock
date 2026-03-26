# Sync Docs

Synchronize project documentation with current code state.

## Actions
1. **Quality Assessment** - Score each doc (0-100): commands(20), architecture(20), patterns(15), conciseness(15), currency(15), actionability(15)
2. **AGENT.md Sync** - Update Overview, Tech Stack, Conventions, Key Commands
3. **Architecture Doc Sync** - Update `docs/architecture.md`
4. **Module Steering Audit** - Scan cdk/, terraform/, cloudformation/, docker/, shared/, agent/; create/update steering docs
5. **ADR Audit** - Check `git log --oneline -20`, suggest ADRs. Format: `docs/decisions/ADR-NNN-title.md`
6. **README.md Sync** - Update project structure section
7. **Report** - Before/after scores, list of changes
