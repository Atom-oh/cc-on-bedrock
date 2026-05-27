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


def _next_link(link_header: str) -> str | None:
    """Parse a GitHub `Link` header and return the URL with rel="next", or None.

    Example header value:
      <https://api.github.com/repos/x/y/issues/1/comments?page=2>; rel="next", ...
    """
    if not link_header:
        return None
    for part in link_header.split(","):
        segments = [s.strip() for s in part.split(";")]
        if not segments:
            continue
        url_seg = segments[0]
        if not (url_seg.startswith("<") and url_seg.endswith(">")):
            continue
        for rel in segments[1:]:
            if rel.replace('"', "") == "rel=next":
                return url_seg[1:-1]
    return None


def upsert_pr_sticky_comment(
    repo: str,        # "owner/name"
    pr_number: int,
    marker: str,      # HTML comment marker, e.g. "<!-- adr-verify-comment -->"
    body: str,
) -> dict[str, Any]:
    """Find a previous comment by this bot (matched by marker) and update it,
    otherwise create a new one. Returns the comment object.

    Follows GitHub's `Link: rel="next"` header so that on long-lived PRs with
    >100 comments the sticky marker is still found instead of duplicate
    comments piling up. Stops as soon as the marker is located.
    """
    if marker not in body:
        body = f"{marker}\n{body}"

    list_url = f"{API}/repos/{repo}/issues/{pr_number}/comments"
    next_url: str | None = list_url
    params: dict[str, Any] | None = {"per_page": 100}
    while next_url:
        r = requests.get(next_url, headers=_headers(), params=params, timeout=30)
        r.raise_for_status()
        for comment in r.json():
            if marker in (comment.get("body") or ""):
                patch_url = f"{API}/repos/{repo}/issues/comments/{comment['id']}"
                r2 = requests.patch(patch_url, headers=_headers(),
                                    json={"body": body}, timeout=30)
                r2.raise_for_status()
                return r2.json()
        next_url = _next_link(r.headers.get("Link", ""))
        params = None  # subsequent next URLs already include the page query

    r = requests.post(list_url, headers=_headers(), json={"body": body}, timeout=30)
    r.raise_for_status()
    return r.json()
