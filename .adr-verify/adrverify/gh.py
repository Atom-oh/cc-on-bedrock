"""Minimal GitHub REST API helpers — sticky PR comment upsert.

Avoids pulling in PyGithub: we only need 'find marker, update or create'.
Uses GITHUB_TOKEN (default) from the workflow environment.
"""
from __future__ import annotations

import os
from typing import Any

import requests

API = "https://api.github.com"


def _headers() -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def upsert_pr_sticky_comment(
    repo: str,        # "owner/name"
    pr_number: int,
    marker: str,      # HTML comment marker, e.g. "<!-- adr-verify-comment -->"
    body: str,
) -> dict[str, Any]:
    """Find a previous comment by this bot (matched by marker) and update it,
    otherwise create a new one. Returns the comment object."""
    if marker not in body:
        body = f"{marker}\n{body}"

    list_url = f"{API}/repos/{repo}/issues/{pr_number}/comments"
    r = requests.get(list_url, headers=_headers(), params={"per_page": 100}, timeout=30)
    r.raise_for_status()
    for comment in r.json():
        if marker in (comment.get("body") or ""):
            patch_url = f"{API}/repos/{repo}/issues/comments/{comment['id']}"
            r2 = requests.patch(patch_url, headers=_headers(),
                                json={"body": body}, timeout=30)
            r2.raise_for_status()
            return r2.json()

    r = requests.post(list_url, headers=_headers(), json={"body": body}, timeout=30)
    r.raise_for_status()
    return r.json()
