"""Pure OTLP metric aggregation for Claude Code productivity rollups (Phase 1).

Parses the OTLP/JSON that the ADOT collector's awss3 exporter writes and aggregates
Claude Code productivity counters into daily, email-keyed rollups. Pure functions only
(no boto3 / AWS at import time) so they unit-test in isolation. The DynamoDB writer and
the email-key identity normalization live in the Lambda handler / `normalize_identity`.

Datapoint shape (from the Phase-0 spike): resource attributes carry the injected
`enduser.id` (email) and `department`; datapoint attributes carry `type` / `model` /
`decision` / `skill.name` / `agent.name`.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

# Conservative email shape for the ADR-029 canonical key. We only need to reject
# obvious non-emails (the anon user.id hash, empty strings); full RFC validation is
# unnecessary because the value is org-issued.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Metric names emitted by Claude Code (see monitoring spec).
M_LOC = "claude_code.lines_of_code.count"
M_COMMIT = "claude_code.commit.count"
M_PR = "claude_code.pull_request.count"
M_SESSION = "claude_code.session.count"
M_ACTIVE = "claude_code.active_time.total"
M_EDIT = "claude_code.code_edit_tool.decision"
M_COST = "claude_code.cost.usage"
M_TOKEN = "claude_code.token.usage"


def _attr_value(v: dict):
    """Unwrap an OTLP AnyValue."""
    if not isinstance(v, dict):
        return None
    if "stringValue" in v:
        return v["stringValue"]
    if "intValue" in v:
        return int(v["intValue"])
    if "doubleValue" in v:
        return float(v["doubleValue"])
    if "boolValue" in v:
        return v["boolValue"]
    return None


def _attrs_to_dict(attrs) -> dict:
    return {a["key"]: _attr_value(a.get("value", {})) for a in (attrs or []) if "key" in a}


def _dp_value(dp: dict):
    if "asInt" in dp:
        return int(dp["asInt"])
    if "asDouble" in dp:
        return float(dp["asDouble"])
    return 0


def _date_from_nano(nano):
    if not nano:
        return None
    return datetime.fromtimestamp(int(nano) / 1e9, tz=timezone.utc).strftime("%Y-%m-%d")


def parse_otlp_metrics(payload: dict) -> list:
    """Flatten an OTLP/JSON ExportMetricsServiceRequest into datapoint records.

    Each record: {metric, value, attrs (resource ∪ datapoint attrs), date}.
    """
    records = []
    for rm in payload.get("resourceMetrics", []):
        res = _attrs_to_dict(rm.get("resource", {}).get("attributes"))
        for sm in rm.get("scopeMetrics", []):
            for m in sm.get("metrics", []):
                name = m.get("name")
                data = m.get("sum") or m.get("gauge") or {}
                for dp in data.get("dataPoints", []):
                    merged = {**res, **_attrs_to_dict(dp.get("attributes"))}
                    records.append({
                        "metric": name,
                        "value": _dp_value(dp),
                        "attrs": merged,
                        "date": _date_from_nano(dp.get("timeUnixNano")),
                    })
    return records


def normalize_identity(attrs: dict):
    """Resolve the ADR-029 canonical key (lowercased email) from `enduser.id`.

    Returns None when absent/invalid; the handler buckets such datapoints as
    `unattributed` rather than dropping them silently.
    """
    raw = attrs.get("enduser.id")
    if not raw or not isinstance(raw, str):
        return None
    email = raw.strip().lower()
    return email if _EMAIL_RE.match(email) else None


def is_unverified(email: str, date: str, bedrock_seen) -> bool:
    """True when productivity exists for (email, date) but the Bedrock invocation logs
    show no usage — the cross-check that flags self-reported/tampered client identity
    (especially on local PCs). `bedrock_seen` is the set of (email, date) pairs observed
    in the authoritative Bedrock usage table.
    """
    return (email, date) not in (bedrock_seen or set())


def _blank_rollup() -> dict:
    return {
        "loc_added": 0, "loc_removed": 0, "commits": 0, "prs": 0,
        "sessions": 0, "active_seconds": 0, "edit_accept": 0, "edit_reject": 0,
    }


def aggregate_daily(records: list) -> dict:
    """Sum delta datapoints into rollups keyed by (email, date, model).

    `lines_of_code.count` carries a model attribute; the other counters do not and
    bucket under model="_". Email is taken raw here — `normalize_identity` (handler)
    lowercases/validates it before write.
    """
    out: dict = {}
    for r in records:
        a = r["attrs"]
        email = a.get("enduser.id")
        date = r["date"]
        if date is None:
            continue
        metric = r["metric"]
        val = r["value"]
        model = a.get("model") or "_"
        if metric == M_LOC:
            row = out.setdefault((email, date, model), _blank_rollup())
            if a.get("type") == "added":
                row["loc_added"] += val
            elif a.get("type") == "removed":
                row["loc_removed"] += val
        else:
            row = out.setdefault((email, date, "_"), _blank_rollup())
            if metric == M_COMMIT:
                row["commits"] += val
            elif metric == M_PR:
                row["prs"] += val
            elif metric == M_SESSION:
                row["sessions"] += val
            elif metric == M_ACTIVE:
                row["active_seconds"] += val
            elif metric == M_EDIT:
                if a.get("decision") == "accept":
                    row["edit_accept"] += val
                elif a.get("decision") == "reject":
                    row["edit_reject"] += val
    return out


def extract_presence(records: list) -> set:
    """Unique (email, date) pairs — the basis for DAU/WAU/MAU."""
    pres = set()
    for r in records:
        email = r["attrs"].get("enduser.id")
        if email and r["date"]:
            pres.add((email, r["date"]))
    return pres


def extract_cost_attribution(records: list) -> dict:
    """Per-(email, date, dimension) cost/token attribution from OTel (approximate).

    Dimension priority: skill.name > agent.name > model. This is the area-3 attribution
    the Bedrock invocation log cannot provide; it is labeled "Attributed" (estimate),
    never the authoritative "Billed" cost.
    """
    out: dict = {}
    for r in records:
        if r["metric"] not in (M_COST, M_TOKEN):
            continue
        a = r["attrs"]
        email = a.get("enduser.id")
        date = r["date"]
        if not (email and date):
            continue
        if a.get("skill.name"):
            dim = "skill:" + a["skill.name"]
        elif a.get("agent.name"):
            dim = "agent:" + a["agent.name"]
        else:
            dim = "model:" + (a.get("model") or "_")
        row = out.setdefault((email, date, dim), {"cost_usd": 0, "tokens_in": 0, "tokens_out": 0})
        if r["metric"] == M_COST:
            row["cost_usd"] += r["value"]
        elif r["metric"] == M_TOKEN:
            if a.get("type") == "input":
                row["tokens_in"] += r["value"]
            elif a.get("type") == "output":
                row["tokens_out"] += r["value"]
    return out
