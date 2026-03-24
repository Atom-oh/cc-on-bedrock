# Release

Automate the release process with validation checks.

## Procedure
1. **Pre-release** - Clean working tree, all tests pass, no uncommitted changes
2. **Version** - Review changes since last tag, apply semver (MAJOR/MINOR/PATCH)
3. **Changelog** - Group by type (Added, Changed, Fixed, Removed), include commit refs
4. **Release** - Update version files, create git tag `vX.Y.Z`, generate release notes
5. **Summary** - Display version bump, key changes, next steps
