"""
Session Insights Lambda (cc-on-bedrock-session-insights)

Once a day (EventBridge cron(0 0 * * ? *), 09:00 KST) analyzes the previous UTC
date's client-reported session buckets (sessions table, written by the usage
tracker's cc.session-report handler) and asks Claude Haiku (Bedrock Converse) for
a short cost analysis of the top users.

Privacy: only aggregate numbers are sent to the model. Users are pseudonymized as
U1..U10; the label -> email map is stored in the insight row and never sent.
No prompt text exists in the session data at all.

Event:
  {}                                  previous UTC date, skipped if an "ok" row exists
  {"date": "YYYY-MM-DD"}              that date
  {"force": true}                     regenerate even if a row exists

Output row (sessions table): PK=INSIGHT#daily, SK={date}
  date, generatedAt, model, status ("ok"|"error"), error?, stats (JSON),
  insight (JSON), labels (JSON {"U1": email}), ttl (now + 400 days)

The Converse call made here is NOT metered: the invocation-log subscription only
attributes task/local-user roles, and this Lambda's role is neither.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

SESSIONS_TABLE_NAME = os.environ.get("SESSIONS_TABLE_NAME", "cc-on-bedrock-sessions")
USAGE_TABLE_NAME = os.environ.get("USAGE_TABLE_NAME", "cc-on-bedrock-usage")
INSIGHTS_MODEL_ID = os.environ.get("INSIGHTS_MODEL_ID", "global.anthropic.claude-haiku-5-5")
INSIGHTS_LANGUAGE = os.environ.get("INSIGHTS_LANGUAGE", "ko")

INSIGHT_PK = "INSIGHT#daily"
DATE_INDEX = "date-index"
BASELINE_DAYS = 7
TOP_N = 10
MAX_FINDINGS = 8
INSIGHT_TTL_DAYS = 400
MAX_SCAN_PAGES = 200  # bounded usage scan, same approach as budget-check.py
SEVERITIES = ("info", "watch", "action")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_ddb = None
_bedrock = None


def _dynamodb():
    global _ddb
    if _ddb is None:
        _ddb = boto3.resource("dynamodb")
    return _ddb


def _bedrock_client():
    global _bedrock
    if _bedrock is None:
        _bedrock = boto3.client("bedrock-runtime")
    return _bedrock


def sessions_table():
    return _dynamodb().Table(SESSIONS_TABLE_NAME)


def usage_table():
    return _dynamodb().Table(USAGE_TABLE_NAME)


# ─── helpers ──────────────────────────────────────────────────────────────────

def _num(v) -> float:
    if isinstance(v, Decimal):
        return float(v)
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _ratio(a: float, b: float, digits: int = 6):
    return round(a / b, digits) if b else None


def target_date(event: dict, now: datetime) -> str:
    """The analyzed UTC date: event["date"] if valid, else the previous UTC date."""
    d = event.get("date") if isinstance(event, dict) else None
    if d:
        if not isinstance(d, str) or not _DATE_RE.match(d):
            raise ValueError(f"invalid date: {d!r}")
        datetime.strptime(d, "%Y-%m-%d")  # raises on 2026-13-45
        return d
    return (now.astimezone(timezone.utc).date() - timedelta(days=1)).isoformat()


def _dates_back(date: str, days: int) -> list:
    d = datetime.strptime(date, "%Y-%m-%d").date()
    return [(d - timedelta(days=i)).isoformat() for i in range(1, days + 1)]


# ─── reads ────────────────────────────────────────────────────────────────────

def query_session_rows(date: str) -> list:
    """All session bucket rows for one UTC date via the sparse date-index GSI."""
    t = sessions_table()
    items, kwargs = [], {"IndexName": DATE_INDEX, "KeyConditionExpression": Key("gsiDate").eq(date)}
    while True:
        r = t.query(**kwargs)
        items += r.get("Items", [])
        if not r.get("LastEvaluatedKey"):
            return items
        kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def metered_cost_by_user(date: str) -> dict:
    """{email: invocation-log cost} for one UTC date (USER# usage rows, SK {date}#model).

    Bounded scan like budget-check.py's usage scan; OTEL rollup rows under USER#
    (SK PROD#/SKILL#/…) and MANTLE# estimates never match the {date}# prefix.
    """
    t = usage_table()
    out: dict = {}
    kwargs = {
        "FilterExpression": "begins_with(PK, :p) AND begins_with(SK, :d)",
        "ExpressionAttributeValues": {":p": "USER#", ":d": f"{date}#"},
        "ProjectionExpression": "PK, estimatedCost",
    }
    for _ in range(MAX_SCAN_PAGES):
        r = t.scan(**kwargs)
        for it in r.get("Items", []):
            email = str(it.get("PK", ""))[5:].strip().lower()
            if email:
                out[email] = out.get(email, 0.0) + _num(it.get("estimatedCost"))
        if not r.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]
    else:
        print("[INSIGHTS] usage scan truncated at MAX_SCAN_PAGES — metered cost may be under-counted")
    return out


# ─── aggregation ──────────────────────────────────────────────────────────────

def _empty_acc() -> dict:
    return {"sessions": 0, "turns": 0, "requests": 0, "estimatedCost": 0.0,
            "inputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0,
            "maxSessionCost": 0.0, "maxSessionTurns": 0,
            "tools": {}, "models": {}}


def _add_row(acc: dict, row: dict) -> None:
    cost = _num(row.get("estimatedCost"))
    turns = int(_num(row.get("turns")))
    acc["sessions"] += 1
    acc["turns"] += turns
    acc["requests"] += int(_num(row.get("requests")))
    acc["estimatedCost"] += cost
    for f in ("inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"):
        acc[f] += int(_num(row.get(f)))
    acc["maxSessionCost"] = max(acc["maxSessionCost"], cost)
    acc["maxSessionTurns"] = max(acc["maxSessionTurns"], turns)
    tool = str(row.get("tool") or "other")
    t = acc["tools"].setdefault(tool, {"sessions": 0, "turns": 0, "estimatedCost": 0.0})
    t["sessions"] += 1
    t["turns"] += turns
    t["estimatedCost"] += cost
    try:
        models = json.loads(row.get("models") or "{}")
    except (TypeError, ValueError):
        models = {}
    if isinstance(models, dict):
        for model, m in models.items():
            if not isinstance(m, dict):
                continue
            e = acc["models"].setdefault(model, {"requests": 0, "estimatedCost": 0.0})
            e["requests"] += int(_num(m.get("requests")))
            e["estimatedCost"] += _num(m.get("estimatedCost"))


def _finish(acc: dict) -> dict:
    sessions, turns, cost = acc["sessions"], acc["turns"], acc["estimatedCost"]
    ctx = acc["inputTokens"] + acc["cacheReadTokens"] + acc["cacheWriteTokens"]
    return {
        "sessions": sessions,
        "turns": turns,
        "requests": acc["requests"],
        "estimatedCost": round(cost, 6),
        "costPerTurn": _ratio(cost, turns),
        "costPerSession": _ratio(cost, sessions),
        "avgTurnsPerSession": _ratio(turns, sessions, 2),
        "maxSessionCost": round(acc["maxSessionCost"], 6),
        "maxSessionTurns": acc["maxSessionTurns"],
        "cacheReadRatio": _ratio(acc["cacheReadTokens"], ctx, 4),
        "inputTokens": acc["inputTokens"],
        "outputTokens": acc["outputTokens"],
        "cacheReadTokens": acc["cacheReadTokens"],
        "cacheWriteTokens": acc["cacheWriteTokens"],
        "tools": {k: {"sessions": v["sessions"], "turns": v["turns"],
                      "estimatedCost": round(v["estimatedCost"], 6)}
                  for k, v in sorted(acc["tools"].items())},
        "models": {k: {"requests": v["requests"], "estimatedCost": round(v["estimatedCost"], 6)}
                   for k, v in sorted(acc["models"].items(), key=lambda kv: -kv[1]["estimatedCost"])},
    }


def _baseline(acc: dict | None) -> dict:
    if not acc:
        return {"sessions": 0, "costPerTurn": None, "costPerSession": None}
    return {"sessions": acc["sessions"],
            "costPerTurn": _ratio(acc["estimatedCost"], acc["turns"]),
            "costPerSession": _ratio(acc["estimatedCost"], acc["sessions"])}


def compute_stats(date: str, day_rows: list, baseline_rows: list, metered: dict) -> tuple:
    """(stats, labels). stats carries pseudonymized users only; labels maps U# -> email."""
    per_user, fleet = {}, _empty_acc()
    departments = {}
    for row in day_rows:
        email = str(row.get("email") or str(row.get("PK", ""))[5:]).strip().lower()
        if not email:
            continue
        departments[email] = row.get("department") or "default"
        _add_row(per_user.setdefault(email, _empty_acc()), row)
        _add_row(fleet, row)
    base_user, base_fleet = {}, _empty_acc()
    for row in baseline_rows:
        email = str(row.get("email") or str(row.get("PK", ""))[5:]).strip().lower()
        if not email:
            continue
        _add_row(base_user.setdefault(email, _empty_acc()), row)
        _add_row(base_fleet, row)

    ranked = sorted(per_user.items(), key=lambda kv: (-kv[1]["estimatedCost"], kv[0]))[:TOP_N]
    labels, users = {}, []
    for i, (email, acc) in enumerate(ranked, start=1):
        label = f"U{i}"
        labels[label] = email
        s = _finish(acc)
        m = metered.get(email)
        s.update({
            "user": label,
            "baseline7d": _baseline(base_user.get(email)),
            "meteredCost": round(m, 6) if m is not None else None,
            "coverage": _ratio(acc["estimatedCost"], m, 4) if m else None,
        })
        users.append(s)

    fleet_s = _finish(fleet)
    metered_total = sum(metered.values())
    fleet_s.update({
        "users": len(per_user),
        "baseline7d": _baseline(base_fleet if base_fleet["sessions"] else None),
        "meteredCost": round(metered_total, 6),
        "meteredUsers": len(metered),
        "coverage": _ratio(fleet["estimatedCost"], metered_total, 4) if metered_total else None,
    })
    stats = {"date": date, "baselineDays": BASELINE_DAYS, "fleet": fleet_s, "topUsers": users}
    return stats, labels


# ─── model call ───────────────────────────────────────────────────────────────

def system_prompt(language: str) -> str:
    return (
        "You are an analyst of AI coding-assistant cost (Claude Code and OpenAI Codex CLI on "
        "Amazon Bedrock). You receive one UTC day of aggregate session statistics for an "
        "organization: fleet totals and the top users by estimated cost, pseudonymized as "
        "U1..U10, each with a 7-day baseline (baseline7d) and invocation-log metered cost "
        "(coverage = reported / metered). Costs are USD. A turn is one user prompt; a "
        "request is one model call. cacheReadRatio = cache-read tokens / all input tokens.\n"
        "Flag: unusual cost per turn, very long sessions, low cache reuse, an expensive model "
        "choice for short sessions, and notable changes against the baseline. Give concrete, "
        "actionable suggestions. Refer to users only by their U label. Do not invent numbers.\n"
        f"Write all text values in this language: {language}.\n"
        "Output STRICT JSON only, no markdown, no code fence, exactly this shape:\n"
        '{"summary": "...", "findings": [{"user": "U1", "severity": "info|watch|action", '
        '"title": "...", "detail": "...", "suggestion": "..."}], "fleet": ["..."]}\n'
        f"At most {MAX_FINDINGS} findings. Use \"fleet\" as the user value for an "
        "organization-wide finding."
    )


def call_model(stats: dict) -> str:
    resp = _bedrock_client().converse(
        modelId=INSIGHTS_MODEL_ID,
        system=[{"text": system_prompt(INSIGHTS_LANGUAGE)}],
        messages=[{"role": "user", "content": [{"text": json.dumps(stats, ensure_ascii=False)}]}],
        inferenceConfig={"maxTokens": 2000, "temperature": 0.2},
    )
    parts = resp.get("output", {}).get("message", {}).get("content", [])
    return "".join(p.get("text", "") for p in parts if isinstance(p, dict))


def parse_insight(text: str, labels: dict) -> dict:
    """Validate the model output; raises ValueError when it is not the contract shape."""
    s = (text or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    start, end = s.find("{"), s.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in model output")
    try:
        obj = json.loads(s[start:end + 1])
    except ValueError as e:
        raise ValueError(f"model output is not JSON: {e}") from None
    if not isinstance(obj, dict) or not isinstance(obj.get("summary"), str):
        raise ValueError("model output lacks a summary string")
    findings = []
    for f in obj.get("findings") or []:
        if not isinstance(f, dict):
            continue
        user = str(f.get("user") or "fleet")
        if user not in labels and user != "fleet":
            user = "fleet"
        sev = str(f.get("severity") or "info").lower()
        findings.append({
            "user": user,
            "severity": sev if sev in SEVERITIES else "info",
            "title": str(f.get("title") or "")[:300],
            "detail": str(f.get("detail") or "")[:2000],
            "suggestion": str(f.get("suggestion") or "")[:2000],
        })
        if len(findings) >= MAX_FINDINGS:
            break
    fleet = [str(x)[:1000] for x in (obj.get("fleet") or []) if isinstance(x, (str, int, float))][:MAX_FINDINGS]
    return {"summary": obj["summary"][:4000], "findings": findings, "fleet": fleet}


# ─── handler ──────────────────────────────────────────────────────────────────

def _empty_insight() -> dict:
    return {"summary": "", "findings": [], "fleet": []}


def generate(date: str, force: bool = False, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    t = sessions_table()
    if not force:
        existing = t.get_item(Key={"PK": INSIGHT_PK, "SK": date}).get("Item")
        if existing and existing.get("status") == "ok":
            print(f"[INSIGHTS] {date}: insight exists, skipped (pass force to regenerate)")
            return {"date": date, "status": "ok", "skipped": True}

    day_rows = query_session_rows(date)
    baseline_rows = [r for d in _dates_back(date, BASELINE_DAYS) for r in query_session_rows(d)]
    metered = metered_cost_by_user(date)
    stats, labels = compute_stats(date, day_rows, baseline_rows, metered)

    status, error, insight = "ok", None, _empty_insight()
    if stats["fleet"]["sessions"]:
        try:
            insight = parse_insight(call_model(stats), labels)
        except Exception as e:  # Bedrock error or bad output: keep the numbers
            status, error = "error", f"{type(e).__name__}: {e}"[:1000]
            print(f"[INSIGHTS] {date}: {error}")

    item = {
        "PK": INSIGHT_PK,
        "SK": date,
        "date": date,
        "generatedAt": now.replace(tzinfo=None).isoformat() + "Z",
        "model": INSIGHTS_MODEL_ID,
        "status": status,
        "stats": json.dumps(stats, ensure_ascii=False, separators=(",", ":")),
        "insight": json.dumps(insight, ensure_ascii=False, separators=(",", ":")),
        "labels": json.dumps(labels, separators=(",", ":")),
        "ttl": int(now.timestamp()) + INSIGHT_TTL_DAYS * 86400,
    }
    if error:
        item["error"] = error
    t.put_item(Item=item)
    print(f"[INSIGHTS] {date}: status={status} sessions={stats['fleet']['sessions']} "
          f"users={stats['fleet']['users']}")
    return {"date": date, "status": status}


def handler(event, context):
    event = event if isinstance(event, dict) else {}
    now = datetime.now(timezone.utc)
    try:
        date = target_date(event, now)
    except ValueError as e:
        return {"date": event.get("date"), "status": "error", "error": str(e)}
    return generate(date, force=bool(event.get("force")), now=now)
