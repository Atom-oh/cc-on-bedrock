---
name: release
description: Prepare a tagged release of this repo - verify a clean, green tree, choose the semver bump, update CHANGELOG.md and create the tag.
---

# Release

Prepare a release. Pushing tags and deploying are the user's call; stop after creating the local tag and report the next steps.

## Steps

1. **Pre-checks.** The working tree is clean (`git status`) and the fast gate passes (`bash tests/run-all.sh`). If either fails, report it instead of continuing.
2. **Version.** Review changes since the last tag (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`; tags follow `vX.Y.Z`) and pick the bump: MAJOR for breaking changes, MINOR for backward-compatible features, PATCH for fixes only. Confirm the version with the user when the bump is not obvious.
3. **Changelog.** Turn the `## [Unreleased]` section of `CHANGELOG.md` into `## [X.Y.Z] - YYYY-MM-DD (<theme>)`, keeping its topic subsections and adding PR or commit references; start a fresh `[Unreleased]` above it. Verify each entry against the actual commit before writing it.
4. **Tag.** Update version fields only where the project keeps one in sync, commit, then `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
5. **Summary.** Report the version bump, key changes and next steps (push the tag, deploy).
