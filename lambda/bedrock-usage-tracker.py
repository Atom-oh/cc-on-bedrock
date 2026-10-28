"""
Bedrock Usage Tracker Lambda
Processes Bedrock Invocation Logging events from TWO sources:
  1. CloudWatch Logs Subscription (primary - has token counts + cost)
     textDataDeliveryEnabled=false: metadata only (token counts, model, identity)
     Full text is NOT logged to reduce CloudWatch Logs cost (~99% reduction)
  2. EventBridge CloudTrail events (fallback - request count only, no tokens)

DynamoDB Schema:
  PK: USER#{username}  SK: {date}#{model}
  GSI: PK starts_with DEPT# for department queries
"""
from __future__ import annotations  # PEP 563: lazy annotations (3.12 `X | None` parses on older runtimes/tests too)
import json
import os
import gzip
import base64
import re
import boto3
from botocore.exceptions import ClientError
from datetime import datetime
from decimal import Decimal

# Subdomain shape per Cognito naming: lowercase alphanumerics + hyphens, 3-32 chars total.
# Regex math: 1 boundary char + 1..30 middle chars + 1 boundary char = min 3, max 32.
# Used as a sanity guard before keying DynamoDB by the `username` tag.
_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")
# Tokens that must never be treated as a username (would happen if a future
# IAM role like cc-on-bedrock-task-execution is created accidentally).
_RESERVED_USERNAMES = {"execution", "boundary", "runner", "service", "system", "root"}

TABLE_NAME = os.environ.get("USAGE_TABLE_NAME", "cc-on-bedrock-usage")
ECS_CLUSTER = os.environ.get("ECS_CLUSTER_NAME", "cc-on-bedrock-devenv")
TASK_ROLE_PREFIX = "cc-on-bedrock-task-"
LOCAL_ROLE_PREFIX = "cc-on-bedrock-local-user-"  # Local Governance Mode (ADR-006 (legacy ADR-014))

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
ecs_client = boto3.client("ecs")
ec2_client = boto3.client("ec2")
cognito_client = boto3.client("cognito-idp")
USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", "")
# ADR-014 §9: region of the bedrock-mantle projects; empty = mantle estimate off.
MANTLE_REGION = os.environ.get("MANTLE_REGION", "")

# Bedrock pricing (USD per 1M tokens, Standard tier, Global cross-Region inference,
# short context). Sources (verified 2026-10-18): AWS Price List API
# (AmazonBedrockFoundationModels, regionCode=ap-northeast-2, *_global_standard
# usage types) for Claude + GPT-6 Astra; Bedrock model cards (Global CRIS row) for
# the other OpenAI GPT models. GPT-5.5 / GPT-5.4 cards list only In-Region rates
# (which carry a 10% premium) — their entries are the In-Region rate / 1.1.
#
# Each entry carries explicit cache rates because vendors differ: Anthropic
# cache read = 0.1x input, GPT-6.1 Sol = 0.05x, Claude Fable 5.1 = 0.025x, …
# An entry without cache rates falls back to CACHE_*_MULTIPLIER below.
#
# Exact per-version entries are matched longest-key-first (so "gpt-6.1-sol" wins
# over "gpt-6-sol"). Versions NOT listed fall back to FAMILY_PRICING (see
# get_model_pricing) — so a future claude-opus-6 is priced as Opus and a future
# gpt-7-sol as a GPT model, not silently as the Sonnet-level "default".
PRICING = {
    # Anthropic Claude (Claude Code)
    "claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_read": 0.20, "cache_write": 5.0},
    "claude-opus-5": {"input": 5.0, "output": 25.0, "cache_read": 0.50, "cache_write": 6.25},
    "claude-opus-4-8": {"input": 5.0, "output": 25.0, "cache_read": 0.50, "cache_write": 6.25},
    "claude-opus-4-7": {"input": 5.0, "output": 25.0, "cache_read": 0.50, "cache_write": 6.25},
    "claude-opus-4-6": {"input": 5.0, "output": 25.0, "cache_read": 0.50, "cache_write": 6.25},
    "claude-opus-4-5": {"input": 5.0, "output": 25.0, "cache_read": 0.50, "cache_write": 6.25},
    "claude-sonnet-5-5": {"input": 2.0, "output": 10.0, "cache_read": 0.10, "cache_write": 2.5},
    "claude-sonnet-5": {"input": 2.0, "output": 10.0, "cache_read": 0.20, "cache_write": 2.5},
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0, "cache_read": 0.30, "cache_write": 3.75},
    "claude-sonnet-4-5": {"input": 3.0, "output": 15.0, "cache_read": 0.30, "cache_write": 3.75},
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_read": 0.01, "cache_write": 0.125},
    "claude-haiku-4-5": {"input": 1.0, "output": 5.0, "cache_read": 0.10, "cache_write": 1.25},
    "claude-fable-5-1": {"input": 10.0, "output": 50.0, "cache_read": 0.25, "cache_write": 12.5},
    "claude-fable-5": {"input": 10.0, "output": 50.0, "cache_read": 1.0, "cache_write": 12.5},
    # OpenAI GPT (Codex CLI, ADR-014)
    "gpt-6.1-sol": {"input": 2.0, "output": 10.0, "cache_read": 0.10, "cache_write": 2.5},
    "gpt-6-astra": {"input": 10.0, "output": 50.0, "cache_read": 1.0, "cache_write": 12.5},
    "gpt-6-sol": {"input": 2.0, "output": 10.0, "cache_read": 0.20, "cache_write": 2.5},
    "gpt-6-luna": {"input": 0.10, "output": 0.50, "cache_read": 0.01, "cache_write": 0.125},
    "gpt-5.6-sol": {"input": 4.0, "output": 20.0, "cache_read": 0.40, "cache_write": 5.0},
    "gpt-5.6-terra": {"input": 2.0, "output": 12.0, "cache_read": 0.20, "cache_write": 2.5},
    "gpt-5.6-luna": {"input": 0.20, "output": 1.20, "cache_read": 0.02, "cache_write": 0.25},
    "gpt-5.5": {"input": 5.0, "output": 30.0, "cache_read": 0.50},  # card lists no cache-write rate → 1.25x fallback
    "gpt-5.4": {"input": 2.5, "output": 15.0, "cache_read": 0.25},
    "default": {"input": 3.0, "output": 15.0},
}

# Family-level fallback (version-agnostic). Mirrors the family matching in
# token-limit-enforcer.py so cost pricing stays correct for future model
# versions without a code change. Rates = the current flagship of each family.
FAMILY_PRICING = {
    "opus": {"input": 5.0, "output": 25.0, "cache_read": 0.50, "cache_write": 6.25},
    "sonnet": {"input": 2.0, "output": 10.0, "cache_read": 0.20, "cache_write": 2.5},
    "haiku": {"input": 1.0, "output": 5.0, "cache_read": 0.10, "cache_write": 1.25},
    "fable": {"input": 10.0, "output": 50.0, "cache_read": 0.25, "cache_write": 12.5},
    # OpenAI tiers: astra (frontier) > sol (default) > terra > luna (small).
    "astra": {"input": 10.0, "output": 50.0, "cache_read": 1.0, "cache_write": 12.5},
    "luna": {"input": 0.20, "output": 1.20, "cache_read": 0.02, "cache_write": 0.25},
    "sol": {"input": 2.0, "output": 10.0, "cache_read": 0.20, "cache_write": 2.5},
    "terra": {"input": 2.0, "output": 12.0, "cache_read": 0.20, "cache_write": 2.5},
    # Unknown GPT tier → GPT-5.6 Sol rate (conservative: highest non-frontier tier).
    "gpt": {"input": 4.0, "output": 20.0, "cache_read": 0.40, "cache_write": 5.0},
    # Bedrock embeddings (Titan/Cohere) are input-only — no output tokens. Rate is a
    # conservative representative (~$0.02-0.10/1M across Titan v2/v1/Cohere); without
    # this, embeddings fall to the Sonnet $3/$15 default and over-count cost/budget.
    "embed": {"input": 0.10, "output": 0.0},
}

# Prompt-cache multipliers (relative to base input rate) — used only for an entry
# that has no explicit cache_read / cache_write rate (e.g. "default").
#   - cache read  : 0.1× input  (cache hit)
#   - cache write : 1.25× input (5-minute TTL cache create, default for Claude Code)
CACHE_READ_MULTIPLIER = 0.1
CACHE_WRITE_MULTIPLIER = 1.25

# Client attribution (ADR-014): the invocation log carries no user agent, so the
# CLI is derived from the model vendor — Claude Code calls Anthropic models,
# Codex calls OpenAI models. Anything else (embeddings, other vendors) = "other".
TOOL_CLAUDE_CODE = "claude-code"
TOOL_CODEX = "codex"
TOOL_OTHER = "other"


def tool_for_model(model: str) -> str:
    m = (model or "").lower()
    if "claude" in m or "anthropic" in m:
        return TOOL_CLAUDE_CODE
    if "gpt" in m or "openai" in m:
        return TOOL_CODEX
    return TOOL_OTHER


# Cache: identity_arn → (email, subdomain, department)
_task_cache: dict = {}
# ADR-031: subdomain → email (from EC2 instance tag / Cognito) for the EC2 task-role path.
_email_cache: dict = {}
# Cache: subdomain → department (from EC2 instance tags)
_dept_cache: dict = {}


def _resolve_department(subdomain: str) -> str:
    """Resolve department for a user subdomain.
    Priority: 1) EC2 instance tag 2) Cognito custom:department 3) "default"
    """
    if subdomain in _dept_cache:
        return _dept_cache[subdomain]

    # Try EC2 instance tags first (fastest, works for running instances)
    try:
        resp = ec2_client.describe_instances(
            Filters=[
                {"Name": "tag:subdomain", "Values": [subdomain]},
                {"Name": "tag:managed_by", "Values": ["cc-on-bedrock"]},
            ],
            MaxResults=5,
        )
        for reservation in resp.get("Reservations", []):
            for inst in reservation.get("Instances", []):
                tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}
                dept = tags.get("department", "")
                if dept and dept != "default":
                    _dept_cache[subdomain] = dept
                    return dept
    except Exception as e:
        print(f"EC2 tag lookup failed for {subdomain}: {e}")

    # Fallback: Cognito custom:department (works even if instance is stopped)
    if USER_POOL_ID:
        try:
            resp = cognito_client.list_users(
                UserPoolId=USER_POOL_ID,
                Filter=f'username = "{subdomain}"',
                Limit=1,
            )
            for user in resp.get("Users", []):
                attrs = {a["Name"]: a["Value"] for a in user.get("Attributes", [])}
                dept = attrs.get("custom:department", "default")
                _dept_cache[subdomain] = dept
                return dept
        except Exception as e:
            print(f"Cognito lookup failed for {subdomain}: {e}")

    _dept_cache[subdomain] = "default"
    return "default"


def _resolve_email_from_subdomain(subdomain: str) -> str | None:
    """EC2 path: map a subdomain → user email (ADR-031 canonical key).

    The EC2 task role name carries only the subdomain. The canonical usage key
    is the email, obtained from the instance tag `cc:user`/`username` (set by the
    Dashboard on every per-user instance) or, as a fallback, the Cognito `email`
    attribute (username == subdomain). Returns None on miss (caller skips the
    record rather than writing a bad key).
    """
    if not _is_valid_username(subdomain):
        return None
    if subdomain in _email_cache:
        return _email_cache[subdomain]

    # EC2 instance tags first (cc:user / username == email)
    try:
        resp = ec2_client.describe_instances(
            Filters=[
                {"Name": "tag:subdomain", "Values": [subdomain]},
                {"Name": "tag:managed_by", "Values": ["cc-on-bedrock"]},
            ],
            MaxResults=5,
        )
        for reservation in resp.get("Reservations", []):
            for inst in reservation.get("Instances", []):
                tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}
                email = tags.get("cc:user") or tags.get("username")
                if email and "@" in email:
                    email = email.strip().lower()
                    _email_cache[subdomain] = email
                    return email
    except Exception as e:
        print(f"EC2 email tag lookup failed for {subdomain}: {e}")

    # Fallback: Cognito custom:subdomain → email map. The ListUsers *Filter* does
    # NOT support custom:subdomain (that was the original ADR-025 bug), and the
    # Username may be a UUID, so we cannot filter by username==subdomain either —
    # especially for provisioner-disambiguated subdomains (e.g. john-doe-2). Build
    # a full subdomain→email map once (reading the attribute in-memory) and cache.
    email = _subdomain_email_map().get(subdomain)
    if email:
        _email_cache[subdomain] = email
        return email
    return None


# subdomain → email, built lazily from a full Cognito ListUsers scan (custom:subdomain
# attribute read in-memory, since the API Filter does not support custom attributes).
_sd_email_map: dict | None = None


def _subdomain_email_map() -> dict:
    global _sd_email_map
    if _sd_email_map is not None:
        return _sd_email_map
    mapping: dict = {}
    if USER_POOL_ID:
        try:
            paginator = cognito_client.get_paginator("list_users")
            for page in paginator.paginate(UserPoolId=USER_POOL_ID):
                for user in page.get("Users", []):
                    attrs = {a["Name"]: a["Value"] for a in user.get("Attributes", [])}
                    sd = attrs.get("custom:subdomain")
                    email = (attrs.get("email") or "").strip().lower()
                    if sd and email and "@" in email:
                        mapping[sd] = email
        except Exception as e:
            print(f"Cognito subdomain→email map build failed: {e}")
            return {}  # transient: don't cache an empty map
    _sd_email_map = mapping
    return mapping


def resolve_user_from_arn(identity_arn: str, source_ip: str = "") -> tuple:
    """Resolve (email, subdomain, department) from an IAM role ARN.

    ADR-031 (B′): the canonical user key is the lowercased email. `subdomain` is
    returned for display + IAM role-name construction downstream. Cognito sub is
    not used. Returns (None, ...) when the email cannot be resolved so the caller
    skips the record rather than writing a non-canonical key.

    Identity ARN format:
      arn:aws:sts::ACCOUNT:assumed-role/cc-on-bedrock-task-{subdomain}/SESSION
      arn:aws:sts::ACCOUNT:assumed-role/cc-on-bedrock-local-user-{subdomain}/SESSION
    """
    if not identity_arn:
        return None, None, None

    cache_key = identity_arn
    if cache_key in _task_cache:
        return _task_cache[cache_key]

    parts = identity_arn.split("/")
    role_name = parts[1] if len(parts) >= 2 else ""

    # EC2 per-user mode: role name is cc-on-bedrock-task-{subdomain}
    if role_name.startswith(TASK_ROLE_PREFIX):
        subdomain = role_name[len(TASK_ROLE_PREFIX):]
        if not _is_valid_username(subdomain):
            print(f"Skipping non-user task role: {role_name} (subdomain={subdomain!r})")
            return None, None, None
        dept = _resolve_department(subdomain)
        email = _resolve_email_from_subdomain(subdomain)
        if email is None:
            # No email resolvable — skip rather than write a bad key (ADR-031).
            print(f"[ADR-031] email unresolved for {role_name}; skipping record")
            return None, subdomain, dept
        _task_cache[cache_key] = (email, subdomain, dept)
        print(f"Resolved {role_name} → email={email} subdomain={subdomain}({dept})")
        return email, subdomain, dept

    # Local Governance Mode (ADR-006 (legacy ADR-014)): role name is cc-on-bedrock-local-user-{subdomain}.
    # email/subdomain/department come from role tags set by sts-issuer.py.
    if role_name.startswith(LOCAL_ROLE_PREFIX):
        (email_tag, sub_tag, dept_tag), cacheable = _resolve_user_dept_from_role_tags(role_name)
        email = email_tag.strip().lower() if email_tag and "@" in email_tag else None
        subdomain = sub_tag if _is_valid_username(sub_tag) else None
        dept = dept_tag or (_resolve_department(subdomain) if subdomain else "default") or "default"
        if email is None:
            print(f"[ADR-031] email unresolved for {role_name}; skipping record")
            return None, subdomain, dept
        if cacheable:
            _task_cache[cache_key] = (email, subdomain, dept)
        print(f"Resolved {role_name} → email={email} subdomain={subdomain}({dept}) [local{'' if cacheable else ', uncached'}]")
        return email, subdomain, dept

    # Not a cc-on-bedrock per-user role — skip tracking
    print(f"Skipping non-user role: {role_name}")
    return None, None, None


def _is_valid_username(candidate: str) -> bool:
    """Sanity guard: must match Cognito subdomain shape and not collide with reserved tokens."""
    if not candidate or candidate in _RESERVED_USERNAMES:
        return False
    return bool(_USERNAME_RE.match(candidate))


def _resolve_user_dept_from_role_tags(role_name: str) -> tuple:
    """Read email + subdomain + department tags from a Local Governance IAM role.
    Returns ((email, subdomain, department), cacheable). cacheable=False on transient
    errors so the caller skips caching and retries on the next event. (ADR-031: the
    canonical key is email; `subdomain`/`username` tag drives the role name.)
    """
    try:
        resp = boto3.client("iam").get_role(RoleName=role_name)
        tags = {t["Key"]: t["Value"] for t in resp.get("Role", {}).get("Tags", [])}
        subdomain = tags.get("subdomain") or tags.get("username", "")
        return (tags.get("email", ""), subdomain, tags.get("department", "")), True
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        # NoSuchEntity is terminal — role truly doesn't exist.
        if code == "NoSuchEntity":
            print(f"IAM role not found: {role_name}")
            return ("", "", ""), True
        # Throttling/AccessDenied/InternalFailure → transient; do NOT cache.
        print(f"IAM GetRole transient error for {role_name}: {code}")
        return ("", "", ""), False
    except Exception as e:
        print(f"IAM role tag lookup failed for {role_name}: {e}")
        return ("", "", ""), False


def get_model_pricing(model_id: str) -> dict:
    """Get pricing for a model ID.

    Resolution order:
      1) exact per-version match in PRICING (lets a version override its family),
      2) family fallback (opus/sonnet/haiku/fable, astra/luna/terra/gpt) —
         version-agnostic, so new versions are priced by family instead of the
         generic default,
      3) generic default (Sonnet-level) for anything unrecognized.
    """
    model_lower = model_id.lower()
    # 1) exact version match (skip the generic "default" sentinel). Longest key
    #    first so "gpt-6.1-sol" is not swallowed by "gpt-6-sol"-style prefixes and
    #    "claude-opus-5-5" wins over "claude-opus-5".
    for key in sorted(PRICING, key=len, reverse=True):
        if key != "default" and key in model_lower:
            return PRICING[key]
    # 2) family fallback
    for family, price in FAMILY_PRICING.items():
        if family in model_lower:
            return price
    # 3) generic default
    return PRICING["default"]


def normalize_model(model_id: str) -> str:
    """Normalize model ID to short form.

    Handles:
      - ARN: arn:aws:bedrock:region:account:inference-profile/global.anthropic.claude-sonnet-5
      - Prefixed: global.anthropic.claude-sonnet-5
      - Plain: claude-sonnet-5
      - OpenAI (Codex, ADR-014): inference-profile/global.openai.gpt-6.1-sol → gpt-6.1-sol
    """
    if not model_id or model_id == "unknown":
        return "unknown"
    # Extract model name from ARN (split on "/" first, handles both foundation-model and inference-profile)
    if "/" in model_id:
        model_id = model_id.split("/")[-1]
    # If still looks like an ARN (starts with "arn:"), try splitting on ":" to find the model part
    if model_id.startswith("arn:"):
        # arn:aws:bedrock:region:account:resource-type:model-name
        arn_parts = model_id.split(":")
        model_id = arn_parts[-1] if len(arn_parts) > 5 else "unknown"
    # Remove region/vendor prefixes
    for prefix in [
        "global.anthropic.", "apac.anthropic.", "us.anthropic.", "eu.anthropic.", "anthropic.",
        "global.openai.", "apac.openai.", "us.openai.", "eu.openai.", "openai.",
    ]:
        model_id = model_id.replace(prefix, "")
    # Remove colon suffix (e.g., ":0")
    model_id = model_id.split(":")[0]
    # Remove version suffixes
    if model_id.endswith("[1m]"):
        model_id = model_id[:-4]
    for suffix in ["-v1", "-v2"]:
        if model_id.endswith(suffix):
            model_id = model_id[:-len(suffix)]
            break
    # Strip date suffixes (e.g., claude-haiku-4-5-20251001 → claude-haiku-4-5)
    model_id = re.sub(r"-\d{8}$", "", model_id)
    return model_id or "unknown"


def estimate_cost(
    model_id: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> float:
    """Estimate cost in USD, including prompt-cache tokens when present."""
    pricing = get_model_pricing(model_id)
    cache_read_rate = pricing.get("cache_read", pricing["input"] * CACHE_READ_MULTIPLIER)
    cache_write_rate = pricing.get("cache_write", pricing["input"] * CACHE_WRITE_MULTIPLIER)
    return (
        input_tokens * pricing["input"]
        + output_tokens * pricing["output"]
        + cache_read_tokens * cache_read_rate
        + cache_write_tokens * cache_write_rate
    ) / 1_000_000


def upsert_usage(email: str, subdomain: str | None, department: str, date_str: str, model: str,
                 input_tokens: int, output_tokens: int, cost: float, latency_ms: int = 0,
                 cache_read_tokens: int = 0, cache_write_tokens: int = 0):
    """Atomic upsert to DynamoDB.

    ADR-031 (B′): rows are keyed by the lowercased email (PK=USER#{email}).
    `subdomain` is stored as a row attribute — it drives the IAM role names
    (`task-{subdomain}`, `local-user-{subdomain}`) used by the enforcer. No sub.
    """
    email = (email or "").strip().lower()
    try:
        set_clause = (
            "SET department = :dept, model = :model, #tool = :tool, #dt = :date, updatedAt = :now"
        )
        names = {"#dt": "date", "#tool": "tool"}
        values = {
            ":dept": department,
            ":model": model,
            ":tool": tool_for_model(model),
            ":date": date_str,
            ":now": datetime.utcnow().isoformat(),
            ":inp": input_tokens,
            ":out": output_tokens,
            ":total": input_tokens + output_tokens + cache_read_tokens + cache_write_tokens,
            ":cr": cache_read_tokens,
            ":cw": cache_write_tokens,
            ":one": 1,
            ":cost": Decimal(str(round(cost, 6))),
            ":lat": latency_ms,
        }
        if subdomain:
            set_clause += ", subdomain = :subdomain"
            values[":subdomain"] = subdomain
        table.update_item(
            Key={"PK": f"USER#{email}", "SK": f"{date_str}#{model}"},
            UpdateExpression=(
                set_clause + " "
                "ADD inputTokens :inp, outputTokens :out, totalTokens :total, "
                "cacheReadTokens :cr, cacheWriteTokens :cw, "
                "requests :one, estimatedCost :cost, latencySumMs :lat"
            ),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
        # Department aggregate
        table.update_item(
            Key={"PK": f"DEPT#{department}", "SK": date_str},
            UpdateExpression=(
                "SET updatedAt = :now "
                "ADD inputTokens :inp, outputTokens :out, totalTokens :total, "
                "cacheReadTokens :cr, cacheWriteTokens :cw, "
                "requests :one, estimatedCost :cost, latencySumMs :lat"
            ),
            ExpressionAttributeValues={
                ":now": datetime.utcnow().isoformat(),
                ":inp": input_tokens,
                ":out": output_tokens,
                ":total": input_tokens + output_tokens + cache_read_tokens + cache_write_tokens,
                ":cr": cache_read_tokens,
                ":cw": cache_write_tokens,
                ":one": 1,
                ":cost": Decimal(str(round(cost, 6))),
                ":lat": latency_ms,
            },
        )
        lat_str = f" {latency_ms}ms" if latency_ms > 0 else ""
        cache_str = ""
        if cache_read_tokens or cache_write_tokens:
            cache_str = f" cacheR:{cache_read_tokens} cacheW:{cache_write_tokens}"
        print(f"Tracked: email={email} subdomain={subdomain}({department}) {model} in:{input_tokens} out:{output_tokens}{cache_str} ${cost:.6f}{lat_str}")
    except Exception as e:
        print(f"DynamoDB error: {e}")


def process_invocation_log(log_event: dict):
    """Process a Bedrock Invocation Log entry from CloudWatch Logs."""
    message = log_event.get("message", "")
    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        return

    # Extract fields from Bedrock Invocation Log format
    model_id = data.get("modelId", "unknown")
    identity = data.get("identity", {})
    identity_arn = identity.get("arn", "")
    source_ip = data.get("sourceIPAddress", "")

    # Token counts from invocation log
    input_data = data.get("input", {})
    output_data = data.get("output", {})
    input_tokens = input_data.get("inputTokenCount", 0) or data.get("inputTokenCount", 0)
    output_tokens = output_data.get("outputTokenCount", 0) or data.get("outputTokenCount", 0)
    # Bedrock Invocation Log surfaces prompt-cache counts under input.* (AgentCore
    # stable schema). Fall back to top-level keys if the nested envelope is absent.
    cache_read_tokens = (
        input_data.get("cacheReadInputTokenCount", 0)
        or data.get("cacheReadInputTokenCount", 0)
        or 0
    )
    cache_write_tokens = (
        input_data.get("cacheWriteInputTokenCount", 0)
        or data.get("cacheWriteInputTokenCount", 0)
        or 0
    )

    # Latency from output metrics (only available when textDataDeliveryEnabled=true)
    latency_ms = data.get("latencyMs", 0) or 0
    if not latency_ms:
        output_body = output_data.get("outputBodyJson", {})
        if isinstance(output_body, dict):
            metrics = output_body.get("metrics", {})
            latency_ms = metrics.get("latencyMs", 0) or 0

    # Timestamp
    timestamp = data.get("timestamp", datetime.utcnow().isoformat())
    date_str = timestamp[:10]

    # Resolve user — skip if not a cc-on-bedrock role or email unresolved
    email, subdomain, department = resolve_user_from_arn(identity_arn, source_ip)
    if email is None:
        return

    model = normalize_model(model_id)
    cost = estimate_cost(model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)

    upsert_usage(
        email, subdomain, department, date_str, model,
        input_tokens, output_tokens, cost, latency_ms,
        cache_read_tokens=cache_read_tokens,
        cache_write_tokens=cache_write_tokens,
    )


def process_cloudtrail_event(detail: dict):
    """Process a CloudTrail Bedrock event from EventBridge (fallback, no token counts)."""
    if not detail or not isinstance(detail, dict):
        print("Skipping: empty or invalid CloudTrail detail")
        return

    event_name = detail.get("eventName", "")
    if event_name not in ("InvokeModel", "InvokeModelWithResponseStream", "Converse", "ConverseStream"):
        return

    # Check for error events (requestParameters is null on errors)
    request_params = detail.get("requestParameters")
    if not request_params or not isinstance(request_params, dict):
        print(f"Skipping: no requestParameters in {event_name}")
        return

    source_ip = detail.get("sourceIPAddress", "")
    identity_arn = (detail.get("userIdentity") or {}).get("arn", "")
    event_time = detail.get("eventTime", datetime.utcnow().isoformat())
    date_str = event_time[:10]
    model_id = request_params.get("modelId", "unknown")

    email, subdomain, department = resolve_user_from_arn(identity_arn, source_ip)
    if email is None:
        return

    model = normalize_model(model_id)

    # CloudTrail doesn't have token counts — track request count only
    upsert_usage(email, subdomain, department, date_str, model, 0, 0, 0)


# ─── bedrock-mantle cost ESTIMATE (ADR-014 §9 stage 1) ──────────────────────
# Mantle writes no invocation log, so its per-user cost is estimated from the
# AWS/BedrockMantle InputTokens/OutputTokens metrics of each user's own project
# (budget-check creates one per user, owner in the `cc-on-bedrock:user` tag) × the
# PRICING table above. Rows live under MANTLE#{YYYY-MM} (SK {email}#{date}#{model}),
# a prefix no budget or usage reader touches (they all use USER#/DEPT#), so the
# estimate is never enforced.
# Known error sources (documented in ADR-014 §9): runtime Global-CRIS rates, not
# mantle in-region rates; cached input billed at the full input rate; no
# EDP/private pricing; web-search query charges not included; metric lag.

def _list_mantle_projects() -> list:
    """Active mantle projects as [{id, name, tags}] (SigV4; no boto3 client exists)."""
    import urllib.request
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    creds = boto3.Session().get_credentials().get_frozen_credentials()
    out, after = [], None
    for _ in range(20):
        url = (f"https://bedrock-mantle.{MANTLE_REGION}.api.aws/v1/organization/projects?limit=100"
               + (f"&after={after}" if after else ""))
        req = AWSRequest(method="GET", url=url)
        SigV4Auth(creds, "bedrock-mantle", MANTLE_REGION).add_auth(req)
        with urllib.request.urlopen(urllib.request.Request(url, headers=dict(req.headers)), timeout=10) as r:
            page = json.loads(r.read() or b"{}")
        out += [{"id": p["id"], "name": p.get("name", ""), "tags": p.get("tags") or {}}
                for p in page.get("data", []) if p.get("status", "active") == "active"]
        if not page.get("has_more"):
            break
        after = page.get("last_id")
    return out


def _cw_mantle():
    return boto3.client("cloudwatch", region_name=MANTLE_REGION)


def meter_mantle(now: datetime | None = None) -> dict:
    """Write today's and yesterday's (UTC) estimated mantle cost per user and model.

    Totals are SET, not ADDed, so every run (and a re-run) converges on the metric
    values instead of double counting."""
    if not MANTLE_REGION:
        return {"skipped": "mantle disabled"}
    from datetime import timedelta, timezone

    now = now or datetime.now(timezone.utc)
    owners = {p["id"]: str(p["tags"].get("cc-on-bedrock:user", "")).strip().lower()
              for p in _list_mantle_projects()
              if p["tags"].get("cc-on-bedrock:managed") == "true" and p["tags"].get("cc-on-bedrock:user")}
    cw = _cw_mantle()
    metrics = []
    for name in ("InputTokens", "OutputTokens"):
        for page in cw.get_paginator("list_metrics").paginate(Namespace="AWS/BedrockMantle", MetricName=name):
            for m in page.get("Metrics", []):
                dims = {d["Name"]: d["Value"] for d in m.get("Dimensions", [])}
                if set(dims) == {"Project", "Model"} and dims["Project"] in owners:
                    metrics.append((name, dims["Project"], dims["Model"]))
    start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc) - timedelta(days=1)
    totals: dict = {}  # (email, date, model) -> {"InputTokens": n, "OutputTokens": n, "project": id}
    for i in range(0, len(metrics), 500):
        batch = metrics[i:i + 500]
        queries = [{"Id": f"m{j}", "ReturnData": True, "MetricStat": {
            "Metric": {"Namespace": "AWS/BedrockMantle", "MetricName": name,
                       "Dimensions": [{"Name": "Project", "Value": proj}, {"Name": "Model", "Value": model}]},
            "Period": 86400, "Stat": "Sum"}} for j, (name, proj, model) in enumerate(batch)]
        token = None
        while True:
            kw = {"MetricDataQueries": queries, "StartTime": start, "EndTime": now}
            if token:
                kw["NextToken"] = token
            resp = cw.get_metric_data(**kw)
            for res in resp.get("MetricDataResults", []):
                name, proj, model = batch[int(res["Id"][1:])]
                for ts, value in zip(res.get("Timestamps", []), res.get("Values", [])):
                    row = totals.setdefault((owners[proj], ts.strftime("%Y-%m-%d"), normalize_model(model)),
                                            {"InputTokens": 0, "OutputTokens": 0, "project": proj})
                    row[name] += int(value)
            token = resp.get("NextToken")
            if not token:
                break
    for (email, day, model), row in totals.items():
        cost = estimate_cost(model, row["InputTokens"], row["OutputTokens"])
        table.update_item(
            Key={"PK": f"MANTLE#{day[:7]}", "SK": f"{email}#{day}#{model}"},
            UpdateExpression=("SET email = :email, inputTokens = :inp, outputTokens = :out, estimatedCost = :cost, "
                              "projectId = :proj, mantleRegion = :region, metered = :f, updatedAt = :now"),
            ExpressionAttributeValues={
                ":email": email, ":inp": row["InputTokens"], ":out": row["OutputTokens"],
                ":cost": Decimal(str(round(cost, 6))), ":proj": row["project"],
                ":region": MANTLE_REGION, ":f": False, ":now": now.replace(tzinfo=None).isoformat(),
            },
        )
    print(f"[MANTLE] estimate rows written: {len(totals)} ({len(owners)} managed projects)")
    return {"rows": len(totals)}


def handler(event, context):
    """Handle events from CloudWatch Logs Subscription or EventBridge."""
    if event.get("source") == "cc.mantle-meter":  # scheduled (usage-tracking mantle-audit.tf)
        return meter_mantle()
    processed = 0

    # Source 1: CloudWatch Logs Subscription (Bedrock Invocation Logging — primary, has tokens)
    if "awslogs" in event:
        compressed = base64.b64decode(event["awslogs"]["data"])
        log_data = json.loads(gzip.decompress(compressed))
        log_events = log_data.get("logEvents", [])
        print(f"Processing {len(log_events)} invocation log events")
        for log_event in log_events:
            try:
                process_invocation_log(log_event)
                processed += 1
            except Exception as e:
                print(f"Error processing invocation log: {e}")

    # Source 2: EventBridge CloudTrail (fallback — request count only, no tokens)
    elif "detail" in event:
        try:
            process_cloudtrail_event(event.get("detail"))
            processed = 1
        except Exception as e:
            print(f"Error processing CloudTrail event: {e}")

    else:
        print(f"Unknown event format: {json.dumps(event)[:200]}")

    return {"processed": processed}
