"""Tier 2 semantic checks: invoke Claude on Bedrock to evaluate semantic[].

One Bedrock InvokeModel call per ADR. The model receives:
  - the full ADR markdown (so it has decision context)
  - each claim verbatim
  - every context_file content (under repo_root) inlined as fenced blocks

The model returns structured JSON; we validate the shape and merge into the
unified result schema. Bedrock auth is delegated to the default boto3 chain
(OIDC role via aws-actions/configure-aws-credentials on self-hosted runner).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import boto3

from .parse_adr import discover_adrs, parse_adr

DEFAULT_MODEL = "global.anthropic.claude-opus-4-7"
MAX_RETRIES = 3
RETRY_BACKOFF_BASE_SECONDS = 2.0


SYSTEM_PROMPT = """\
당신은 ADR(Architecture Decision Record) 준수성 검증자입니다.

각 ADR의 ## Verification 섹션에 있는 semantic[] 청구(claim)에 대해
첨부된 코드를 읽고 다음 verdict 중 하나로 판정합니다:

  - "pass"          : 코드가 청구를 충족함. evidence(file:line) 제시.
  - "fail"          : 코드가 청구와 불일치. 위치(file:line)와 이유 명시.
  - "unverifiable"  : 청구가 모호하거나 첨부된 코드만으로 판정 불가.

확실치 않은 "pass"가 가장 나쁜 결과입니다. 의심스러우면 "unverifiable".
출력은 오직 아래 JSON 스키마만 따르고 다른 설명/마크다운 없이.

응답 JSON 스키마:
{
  "adr_id": "ADR-NNN",
  "claims": [
    {
      "claim": "<원문 claim string 그대로>",
      "verdict": "pass" | "fail" | "unverifiable",
      "evidence": [{"file": "path/to/file", "line": 42, "snippet": "..."}],
      "reason": "<2~3 문장>"
    }
  ]
}
"""


def build_prompt(
    adr_id: str,
    adr_full_markdown: str,
    verification: dict[str, Any],
    repo_root: Path,
) -> tuple[str, str]:
    """Return (system_prompt, user_prompt)."""
    claims = verification.get("semantic") or []
    claims_block = "\n".join(
        f"- claim {i+1}: {json.dumps(c['claim'], ensure_ascii=False)}"
        for i, c in enumerate(claims)
    )

    context_blocks: list[str] = []
    seen: set[str] = set()
    for c in claims:
        for rel in c.get("context_files") or []:
            if rel in seen:
                continue
            seen.add(rel)
            p = repo_root / rel
            if not p.is_file():
                context_blocks.append(f"# {rel}\n(파일 누락)\n")
                continue
            try:
                content = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            lines = content.splitlines()
            if len(lines) > 800:
                content = "\n".join(lines[:800]) + f"\n# ... (truncated, {len(lines)-800} more lines)"
            fence = "```" + (p.suffix.lstrip(".") or "")
            context_blocks.append(f"# {rel}\n{fence}\n{content}\n```\n")

    user = (
        "# ADR 전문\n"
        "```markdown\n"
        f"{adr_full_markdown}\n"
        "```\n\n"
        "# 검증할 청구들\n"
        f"{claims_block}\n\n"
        "# 청구별 첨부 코드\n"
        + "\n".join(context_blocks)
    )
    return SYSTEM_PROMPT, user


@dataclass
class SemanticResult:
    status: str  # "pass" | "fail" | "skip" | "error"
    claims: list[dict[str, Any]] = field(default_factory=list)
    error: str = ""


def _invoke_with_retry(bedrock, model_id, system_prompt, user_prompt) -> str:
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 4096,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }
    last_exc: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = bedrock.invoke_model(
                modelId=model_id,
                body=json.dumps(body),
                contentType="application/json",
                accept="application/json",
            )
            raw = resp["body"].read().decode("utf-8")
            parsed = json.loads(raw)
            for block in parsed.get("content", []):
                if block.get("type") == "text":
                    return block["text"]
            raise ValueError("Bedrock response had no text block")
        except Exception as e:
            last_exc = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF_BASE_SECONDS * (2 ** attempt))
    assert last_exc is not None
    raise last_exc


def run_semantic_checks(
    adr_id: str,
    adr_full_markdown: str,
    verification: dict[str, Any],
    repo_root: Path,
    bedrock,
    model_id: str = DEFAULT_MODEL,
) -> SemanticResult:
    claims = verification.get("semantic") or []
    if not claims:
        return SemanticResult(status="skip")

    system, user = build_prompt(adr_id, adr_full_markdown, verification, repo_root)
    try:
        text = _invoke_with_retry(bedrock, model_id, system, user)
    except Exception as e:
        return SemanticResult(status="error", error=f"{type(e).__name__}: {e}")

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        try:
            text = _invoke_with_retry(bedrock, model_id, system, user)
            payload = json.loads(text)
        except Exception:
            return SemanticResult(
                status="fail",
                claims=[{
                    "claim": c["claim"],
                    "verdict": "unverifiable",
                    "evidence": [],
                    "reason": "LLM response was not valid JSON",
                } for c in claims],
                error="malformed LLM JSON",
            )

    parsed_claims: list[dict[str, Any]] = []
    for c in payload.get("claims", []):
        parsed_claims.append({
            "claim": c.get("claim", ""),
            "verdict": c.get("verdict", "unverifiable"),
            "evidence": c.get("evidence", []),
            "reason": c.get("reason", ""),
        })

    if not parsed_claims:
        return SemanticResult(status="error", error="LLM returned 0 claims")

    overall = "pass" if all(c["verdict"] == "pass" for c in parsed_claims) else "fail"
    return SemanticResult(status=overall, claims=parsed_claims)


def _main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", type=Path, default=Path.cwd())
    ap.add_argument("--decisions-dir", type=Path, default=Path("docs/decisions"))
    ap.add_argument("--model-id", default=DEFAULT_MODEL)
    ap.add_argument("--region", default="ap-northeast-2")
    ap.add_argument("--output", type=Path, default=Path("-"))
    args = ap.parse_args()

    bedrock = boto3.client("bedrock-runtime", region_name=args.region)
    decisions = args.repo_root / args.decisions_dir

    out: dict[str, Any] = {"adrs": []}
    for adr_path in discover_adrs(decisions):
        try:
            parsed = parse_adr(adr_path)
        except ValueError as e:
            out["adrs"].append({"adr_id": adr_path.stem, "tier2_semantic":
                {"status": "error", "claims": [], "error": str(e)}})
            continue
        if not parsed.has_verification_section:
            out["adrs"].append({
                "adr_id": parsed.adr_id,
                "tier2_semantic": {"status": "skip", "claims": []},
            })
            continue
        result = run_semantic_checks(
            parsed.adr_id, parsed.body, parsed.verification,
            repo_root=args.repo_root, bedrock=bedrock, model_id=args.model_id,
        )
        out["adrs"].append({"adr_id": parsed.adr_id,
                            "tier2_semantic": result.__dict__})

    text = json.dumps(out, indent=2, ensure_ascii=False, default=str)
    if str(args.output) == "-":
        print(text)
    else:
        args.output.write_text(text, encoding="utf-8")
    return 0  # Tier 2 is advisory — never fail the CI step


if __name__ == "__main__":
    sys.exit(_main())
