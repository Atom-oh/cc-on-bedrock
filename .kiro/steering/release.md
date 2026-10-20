# Release

1. **Pre-checks** - Clean working tree; `bash tests/run-all.sh` passes.
2. **Version** - Review changes since the last `vX.Y.Z` tag and apply semver (MAJOR/MINOR/PATCH).
3. **Changelog** - Turn `## [Unreleased]` in `CHANGELOG.md` into a dated `## [X.Y.Z]` section, verifying entries against commits.
4. **Tag** - Commit, then `git tag -a vX.Y.Z`. Pushing and deploying are left to the user.
5. **Summary** - Version bump, key changes, next steps.
