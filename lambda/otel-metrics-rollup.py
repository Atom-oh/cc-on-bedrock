"""S3-event rollup Lambda: OTLP metric batches -> DynamoDB (USER#{email}).

Triggered by S3 ObjectCreated on the `otel-metrics-raw` bucket (the ADOT collector's
awss3 exporter writes batched OTLP/JSON there). Aggregates Claude Code productivity
counters (via the pure `otel_rollup` module) and upserts daily, email-keyed rollups
into the existing usage table:

  PK = USER#{email}
    SK = PROD#{date}#{model}   ADD productivity counters from native claude_code.* metrics
                               (loc_added/removed, commits, prs, sessions, active_seconds,
                               edit_accept/reject)
    SK = SKILL#{date}#{name}   ADD count from tool_result events (Skill tool)
    SK = AGENT#{date}#{type}   ADD count from tool_result events (Agent/Task tool)
    SK = TOOL#{date}#{name}    ADD count/accept/reject from tool_result/tool_decision events
    SK = ACTIVE#{date}         presence (one per active day) -> DAU/WAU/MAU, with the
                               DAY#{date} GSI key for window counting
    SK = OTELOBJ#{key}#{i}     per-(user, object, chunk) dedup marker (TTL'd)

Idempotency (per plan/Gemini review): each S3 object's writes ride in ONE
TransactWriteItems alongside an `OTELOBJ#{key}` marker guarded by attribute_not_exists.
A crash leaves nothing applied (no loss); a duplicate delivery cancels the transaction
and is skipped (no double-count).
"""
from __future__ import annotations

import json
import os
import time
import urllib.parse
from collections import defaultdict

import boto3
from botocore.exceptions import ClientError

import otel_rollup

TABLE_NAME = os.environ.get("USAGE_TABLE_NAME", "cc-on-bedrock-usage")
OTELOBJ_TTL_SECONDS = 604800  # 7 days — bound dedup-marker storage growth

s3 = boto3.client("s3")
ddb = boto3.client("dynamodb")

_PROD_FIELDS = ("loc_added", "loc_removed", "commits", "prs",
                "sessions", "active_seconds", "edit_accept", "edit_reject")
_USAGE_SK = {"skill": "SKILL", "agent": "AGENT", "tool": "TOOL"}
_MAX_TX = 100  # DynamoDB TransactWriteItems hard limit


def _n(v):
    return {"N": str(v)}


def _s(v):
    return {"S": str(v)}


def _add_expr(fields: dict):
    """Build an ADD UpdateExpression + values for the given numeric fields."""
    parts, vals = [], {}
    for i, (name, val) in enumerate(fields.items()):
        ph = f":v{i}"
        parts.append(f"{name} {ph}")
        vals[ph] = _n(val)
    return "ADD " + ", ".join(parts), vals


def _user_data_items(email: str, prod: dict, presence: set, usage: dict) -> list:
    """All non-marker write items for one user: PROD# productivity counters,
    SKILL#/AGENT#/TOOL# usage counts, and ACTIVE# presence rows."""
    items = []
    for (date, model), row in prod.items():
        expr, vals = _add_expr({f: row[f] for f in _PROD_FIELDS})
        items.append({"Update": {
            "TableName": TABLE_NAME,
            "Key": {"PK": _s(f"USER#{email}"), "SK": _s(f"PROD#{date}#{model}")},
            "UpdateExpression": expr, "ExpressionAttributeValues": vals,
        }})
    for (date, kind, name) in sorted(usage):
        c = usage[(date, kind, name)]
        expr, vals = _add_expr({"count": c["count"], "accept": c["accept"], "reject": c["reject"]})
        items.append({"Update": {
            "TableName": TABLE_NAME,
            "Key": {"PK": _s(f"USER#{email}"), "SK": _s(f"{_USAGE_SK[kind]}#{date}#{name}")},
            "UpdateExpression": expr, "ExpressionAttributeValues": vals,
        }})
    for date in sorted(presence):
        items.append({"Put": {
            "TableName": TABLE_NAME,
            "Item": {"PK": _s(f"USER#{email}"), "SK": _s(f"ACTIVE#{date}"),
                     "gsi_day_pk": _s(f"DAY#{date}"), "gsi_day_sk": _s(f"USER#{email}")},
        }})
    return items


def _user_transact_chunks(email, s3key, prod, presence, usage, marker_ttl):
    """Yield TransactWriteItems lists (<= _MAX_TX), each ending with its own TTL'd dedup
    marker OTELOBJ#{key}#{i} guarded by attribute_not_exists. Per-chunk markers keep each
    chunk independently idempotent (a duplicate delivery cancels the chunk; ADD counters
    are never double-applied) while staying under the 100-item transaction limit.
    """
    data = _user_data_items(email, prod, presence, usage)
    cap = _MAX_TX - 1  # leave room for the marker
    chunks = [data[i:i + cap] for i in range(0, len(data), cap)] or [[]]
    for i, chunk in enumerate(chunks):
        marker = {"Put": {
            "TableName": TABLE_NAME,
            "Item": {"PK": _s(f"USER#{email}"), "SK": _s(f"OTELOBJ#{s3key}#{i}"), "ttl": _n(marker_ttl)},
            "ConditionExpression": "attribute_not_exists(PK)",
        }}
        yield chunk + [marker]


def _normalize(records):
    """Normalize identity to the ADR-029 email key; missing/invalid -> 'unattributed'."""
    for r in records:
        r["attrs"]["enduser.id"] = otel_rollup.normalize_identity(r["attrs"]) or "unattributed"


def _process_object(bucket: str, key: str) -> bool:
    payload = json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
    by_user: dict = defaultdict(lambda: {"prod": {}, "presence": set(), "usage": {}})

    if "resourceMetrics" in payload:  # native claude_code.* productivity metrics
        recs = otel_rollup.parse_otlp_metrics(payload)
        _normalize(recs)
        for (email, date, model), row in otel_rollup.aggregate_daily(recs).items():
            by_user[email]["prod"][(date, model)] = row
        for (email, date) in otel_rollup.extract_presence(recs):
            by_user[email]["presence"].add(date)
    if "resourceLogs" in payload:  # scrubbed tool_result/tool_decision events
        recs = otel_rollup.parse_otlp_logs(payload)
        _normalize(recs)
        for (email, date, kind, name), c in otel_rollup.aggregate_tool_events(recs).items():
            by_user[email]["usage"][(date, kind, name)] = c
        for (email, date) in otel_rollup.extract_presence(recs):
            by_user[email]["presence"].add(date)

    marker_ttl = int(time.time()) + OTELOBJ_TTL_SECONDS
    wrote_any = False
    for email, d in by_user.items():
        for items in _user_transact_chunks(email, key, d["prod"], d["presence"], d["usage"], marker_ttl):
            try:
                ddb.transact_write_items(TransactItems=items)
                wrote_any = True
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code", "")
                if code in ("TransactionCanceledException", "ConditionalCheckFailedException"):
                    continue  # this chunk already processed for this object -> idempotent skip
                raise
    return wrote_any


def handler(event, context):
    processed = 0
    for rec in event.get("Records", []):
        bucket = rec["s3"]["bucket"]["name"]
        # S3 event notifications URL-encode the object key (the collector writes Hive-style
        # keys like year=2026/month=06/..., whose '=' arrives as %3D); decode before GetObject.
        key = urllib.parse.unquote_plus(rec["s3"]["object"]["key"])
        if _process_object(bucket, key):
            processed += 1
    return {"processed": processed}
