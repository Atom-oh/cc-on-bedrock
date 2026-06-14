"""S3-event rollup Lambda: OTLP metric batches -> DynamoDB (USER#{email}).

Triggered by S3 ObjectCreated on the `otel-metrics-raw` bucket (the ADOT collector's
awss3 exporter writes batched OTLP/JSON there). Aggregates Claude Code productivity
counters (via the pure `otel_rollup` module) and upserts daily, email-keyed rollups
into the existing usage table:

  PK = USER#{email}
    SK = PROD#{date}#{model}   ADD delta counters (loc/commits/prs/sessions/active/edits)
    SK = ACTIVE#{date}         presence (one per active day) -> DAU/WAU/MAU, with the
                               DAY#{date} GSI key for window counting
    SK = ATTR#{date}#{dim}     ADD approximate cost/token attribution (area 3)

Idempotency (per plan/Gemini review): each S3 object's writes ride in ONE
TransactWriteItems alongside an `OTELOBJ#{key}` marker guarded by attribute_not_exists.
A crash leaves nothing applied (no loss); a duplicate delivery cancels the transaction
and is skipped (no double-count).
"""
from __future__ import annotations

import json
import os

import boto3
from botocore.exceptions import ClientError

import otel_rollup

TABLE_NAME = os.environ.get("USAGE_TABLE_NAME", "cc-on-bedrock-usage")

s3 = boto3.client("s3")
ddb = boto3.client("dynamodb")

_PROD_FIELDS = ("loc_added", "loc_removed", "commits", "prs",
                "sessions", "active_seconds", "edit_accept", "edit_reject")


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


def _build_transact_items(s3key: str, agg: dict, presence: set, cost: dict) -> list:
    items = []
    for (email, date, model), row in agg.items():
        expr, vals = _add_expr({f: row[f] for f in _PROD_FIELDS})
        items.append({"Update": {
            "TableName": TABLE_NAME,
            "Key": {"PK": _s(f"USER#{email}"), "SK": _s(f"PROD#{date}#{model}")},
            "UpdateExpression": expr, "ExpressionAttributeValues": vals,
        }})
    for (email, date) in presence:
        items.append({"Put": {
            "TableName": TABLE_NAME,
            "Item": {"PK": _s(f"USER#{email}"), "SK": _s(f"ACTIVE#{date}"),
                     "gsi_day_pk": _s(f"DAY#{date}"), "gsi_day_sk": _s(f"USER#{email}")},
        }})
    for (email, date, dim), c in cost.items():
        expr, vals = _add_expr({"cost_usd_est": c["cost_usd"],
                                "tokens_in": c["tokens_in"], "tokens_out": c["tokens_out"]})
        items.append({"Update": {
            "TableName": TABLE_NAME,
            "Key": {"PK": _s(f"USER#{email}"), "SK": _s(f"ATTR#{date}#{dim}")},
            "UpdateExpression": expr, "ExpressionAttributeValues": vals,
        }})
    # Dedup marker — same transaction, only applied once.
    items.append({"Put": {
        "TableName": TABLE_NAME,
        "Item": {"PK": _s("OTELOBJ"), "SK": _s(f"OTELOBJ#{s3key}")},
        "ConditionExpression": "attribute_not_exists(PK)",
    }})
    return items


def _process_object(bucket: str, key: str) -> bool:
    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    records = otel_rollup.parse_otlp_metrics(json.loads(body))
    # Normalize identity to the ADR-029 email key; missing/invalid -> "unattributed".
    for r in records:
        r["attrs"]["enduser.id"] = otel_rollup.normalize_identity(r["attrs"]) or "unattributed"
    agg = otel_rollup.aggregate_daily(records)
    presence = otel_rollup.extract_presence(records)
    cost = otel_rollup.extract_cost_attribution(records)
    items = _build_transact_items(key, agg, presence, cost)
    if not items:
        return False
    if len(items) > 100:
        # TransactWriteItems hard limit; a single per-instance export should never hit
        # this. Surface loudly rather than silently dropping atomicity.
        raise RuntimeError(f"transaction too large ({len(items)} items) for {key}")
    try:
        ddb.transact_write_items(TransactItems=items)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("TransactionCanceledException", "ConditionalCheckFailedException"):
            return False  # already processed -> idempotent skip
        raise
    return True


def handler(event, context):
    processed = 0
    for rec in event.get("Records", []):
        bucket = rec["s3"]["bucket"]["name"]
        key = rec["s3"]["object"]["key"]
        if _process_object(bucket, key):
            processed += 1
    return {"processed": processed}
