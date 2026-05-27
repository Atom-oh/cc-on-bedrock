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
exists for explicit invalidation (tests or aggressive consistency); the
production code does NOT call it on the hot path.
"""
from __future__ import annotations

import boto3

LOCAL_ROLE_PREFIX = "cc-on-bedrock-local-user-"

_iam = boto3.client("iam")
_index: dict[str, list[str]] = {}
_built = False
# Per-username retry guard: if `username` is not in the freshly-built index,
# we rebuild once (in case a brand-new user landed after the cache was warmed)
# and remember we've tried — so we don't hammer iam:ListRoles for unknown keys.
_retried_for: set[str] = set()


def _build_index() -> None:
    """Scan `cc-on-bedrock-local-user-*` roles once and index by `username` tag.

    Sets the `_built` flag ONLY on a clean run. If `list_roles` raises
    (throttle / 5xx / permission revoked), `_built` stays False so the next
    `local_role_names_for()` call retries the scan — otherwise a single
    cold-start transient could leave the container permanently silent on
    every Deny attach.
    """
    global _index, _built
    if _built:
        return
    new_index: dict[str, list[str]] = {}
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
                    new_index.setdefault(uname, []).append(rname)
    except Exception as e:
        # Do NOT mark `_built`; the next call will retry. This is the difference
        # between a transient cold-start failure and permanent silent enforcement.
        print(f"[iam-lookup] list_roles failed (will retry next call): {e}")
        return
    _index = new_index
    _built = True


def local_role_names_for(username: str) -> list[str]:
    """Return real `cc-on-bedrock-local-user-*` role names whose `username` tag
    equals `username`. Returns an empty list when no role matches (caller must
    treat that as "Local Governance not provisioned for this user").

    On cache miss, retries once with a fresh index — covers the case where a
    user was provisioned after this container's cold-start scan. The retry is
    bounded per-username so unknown/malicious keys don't hammer `iam:ListRoles`.
    """
    _build_index()
    names = _index.get(username)
    if names:
        return list(names)
    # Cache miss — give it one second chance with a fresh scan in case the
    # user was provisioned after this container warmed up.
    if username in _retried_for:
        return []
    _retried_for.add(username)
    reset_cache(_keep_retry_guard=True)
    _build_index()
    return list(_index.get(username, []))


def reset_cache(_keep_retry_guard: bool = False) -> None:
    """Drop the in-process cache. Call from `handler` entry if you need a
    fresh index per invocation (e.g. tests or aggressive consistency).

    Internal: `local_role_names_for` calls this with `_keep_retry_guard=True`
    to force a single rescan without losing the per-username retry guard.
    """
    global _index, _built, _retried_for
    _index = {}
    _built = False
    if not _keep_retry_guard:
        _retried_for = set()
