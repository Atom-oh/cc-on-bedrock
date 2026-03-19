#!/bin/bash
# Detect documentation sync needs after file changes.
# Triggered by PostToolUse (Write|Edit) events.

FILE_PATH="${1:-}"
[ -z "$FILE_PATH" ] && exit 0

# Detect missing CLAUDE.md in source directories
for DIR_PREFIX in cdk/lib terraform/modules cloudformation docker shared/nextjs-app/src; do
    if [[ "$FILE_PATH" == ${DIR_PREFIX}/* ]]; then
        DIR=$(dirname "$FILE_PATH")
        if [ ! -f "$DIR/CLAUDE.md" ] && [ "$DIR" != "$DIR_PREFIX" ]; then
            echo "[doc-sync] $DIR/CLAUDE.md is missing. Consider creating module documentation."
        fi
    fi
done

# Alert if no ADRs exist when architecture files change
if [[ "$FILE_PATH" == cdk/* ]] || [[ "$FILE_PATH" == terraform/* ]] || [[ "$FILE_PATH" == cloudformation/* ]] || [[ "$FILE_PATH" == docs/architecture.md ]]; then
    ADR_COUNT=$(find docs/decisions -name 'ADR-*.md' 2>/dev/null | wc -l)
    if [ "$ADR_COUNT" -eq 0 ]; then
        echo "[doc-sync] No ADRs found. Record architectural decisions in docs/decisions/."
    fi
fi
