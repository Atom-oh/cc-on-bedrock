# Sync Docs

Bring documentation back in line with the code; aim for accurate and concise, not more.

1. **Find drift** - Compare `CLAUDE.md`, module `CLAUDE.md` files (terraform/, lambda/, docker/, shared/nextjs-app/, scripts/, tools/, tests/, agent/), these steering docs, `docs/architecture.md` and `README.md` against the code and `git log --oneline -20`.
2. **Verify before keeping** - Confirm every command, path, count, model ID and ADR number against the code; fix or remove what no longer holds.
3. **Update what changed** - Keep each file's language and style. Use consolidated ADR numbers (`docs/history/ADR-MAPPING.md`).
4. **Decisions** - Point out undocumented architectural decisions and suggest an ADR; write one only if asked, and update `docs/decisions/BASELINE.md` in the same change.
5. **Report** - Files changed with a one-line reason each.
