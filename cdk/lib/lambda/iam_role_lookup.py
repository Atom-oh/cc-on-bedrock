"""
Shared IAM-role lookup for ADR-014 Local Governance roles.

`cc-on-bedrock-local-user-{cognito_sub}` is the canonical role name, but the
usage-tracking pipeline keys rows by Cognito *username* (`USER#atomoh`), not
the sub UUID. That asymmetry means token-limit-enforcer (Stream consumer) and
budget-check (5-min cron backup path) cannot naively build the role name from
the PK suffix — `cc-on-bedrock-local-user-atomoh` does not exist; the real role
is `cc-on-bedrock-local-user-{sub}`.

This module bridges the gap by reverse-indexing the IAM `username` tag once per
Lambda container lifetime. Both callers should resolve role names through
`local_role_names_for(username)` instead of string-formatting the prefix.

Lambda container reuse persists the cache, so subsequent invocations within the
same warm container avoid the `iam:ListRoles` round-trip. `reset_cache()`
exists for explicit invalidation (e.g. handler-entry reset like budget-check
already does for its dept-deny index).
"""
from __future__ import annotations

import boto3

LOCAL_ROLE_PREFIX = "cc-on-bedrock-local-user-"

_iam = boto3.client("iam")
_index: dict[str, list[str]] = {}
_built = False


def _build_index() -> None:
    """Scan `cc-on-bedrock-local-user-*` roles once and index by `username` tag.

    Idempotent within a single Lambda container. The `built` flag is set in
    `finally` so a partial index from a mid-scan failure still prevents
    redundant re-scans on every lookup in the same invocation.
    """
    global _index, _built
    if _built:
        return
    _index = {}
    try:
        paginator = _iam.get_paginator("list_roles")
        for page in paginator.paginate(PathPrefix="/"):
            for role in page.get("Roles", []):
                rname = role.get("RoleName", "")
                if not rname.startswith(LOCAL_ROLE_PREFIX):
                    continue
                try:
                    tags = _iam.list_role_tags(RoleName=rname)
                    uname = next(
                        (t["Value"] for t in tags.get("Tags", []) if t["Key"] == "username"),
                        None,
                    )
                except Exception as e:
                    print(f"[iam-lookup] list_role_tags failed for {rname}: {e}")
                    uname = None
                if uname:
                    _index.setdefault(uname, []).append(rname)
    except Exception as e:
        print(f"[iam-lookup] list_roles failed: {e}")
    finally:
        _built = True


def local_role_names_for(username: str) -> list[str]:
    """Return real `cc-on-bedrock-local-user-*` role names whose `username` tag
    equals `username`. Returns an empty list when no role matches (caller
    should treat that as "Local Governance not provisioned for this user").
    """
    _build_index()
    return list(_index.get(username, []))


def reset_cache() -> None:
    """Drop the in-process cache. Call from `handler` entry if you need a
    fresh index per invocation (e.g. tests or aggressive consistency)."""
    global _index, _built
    _index = {}
    _built = False
