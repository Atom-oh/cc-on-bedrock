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

# Metric names emitted by tools/cc-otel-code-metrics.sh (#94, gauge datapoints).
M_COMMIT = "cc.git.commits"
M_LOC_ADDED = "cc.git.lines_added"
M_LOC_REMOVED = "cc.git.lines_deleted"
M_PUSH = "cc.git.pushes"
M_SESSION = "cc.claude.sessions.started"
M_ACTIVE_MIN = "cc.claude.active_minutes"


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
    return {"loc_added": 0, "loc_removed": 0, "commits": 0,
            "pushes": 0, "sessions": 0, "active_seconds": 0}


def aggregate_daily(records: list) -> dict:
    """Sum gauge/delta datapoints into rollups keyed by (email, date, "_").

    The cc.* event metrics carry no per-model attribute, so everything buckets
    under model="_". Email is taken raw here — `normalize_identity` (handler)
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
        row = out.setdefault((email, date, "_"), _blank_rollup())
        if metric == M_LOC_ADDED:
            row["loc_added"] += val
        elif metric == M_LOC_REMOVED:
            row["loc_removed"] += val
        elif metric == M_COMMIT:
            row["commits"] += val
        elif metric == M_PUSH:
            row["pushes"] += val
        elif metric == M_SESSION:
            row["sessions"] += val
        elif metric == M_ACTIVE_MIN:
            row["active_seconds"] += val * 60
    return out


def extract_presence(records: list) -> set:
    """Unique (email, date) pairs — the basis for DAU/WAU/MAU."""
    pres = set()
    for r in records:
        email = r["attrs"].get("enduser.id")
        if email and r["date"]:
            pres.add((email, r["date"]))
    return pres


# Cost/token attribution intentionally removed: OTel code-activity is productivity
# only. Authoritative cost stays in the ADR-005 invocation-log → DynamoDB pipeline.
