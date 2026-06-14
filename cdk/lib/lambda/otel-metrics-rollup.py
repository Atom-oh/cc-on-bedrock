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
from collections import defaultdict

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


def _user_transact_items(email: str, s3key: str, prod: dict, presence: set, cost: dict) -> list:
    """Build ONE TransactWriteItems list for a single user's rows in this S3 object,
    plus a per-(user, object) dedup marker. Keeping each user in their own transaction
    means we never approach the 100-item TransactWriteItems limit (a central collector
    object can mix many users), the marker lives under the user's own PK (no hot
    partition), and a mid-object crash leaves committed users intact while uncommitted
    ones are safely retried.
    """
    items = []
    for (date, model), row in prod.items():
        expr, vals = _add_expr({f: row[f] for f in _PROD_FIELDS})
        items.append({"Update": {
            "TableName": TABLE_NAME,
            "Key": {"PK": _s(f"USER#{email}"), "SK": _s(f"PROD#{date}#{model}")},
            "UpdateExpression": expr, "ExpressionAttributeValues": vals,
        }})
    for date in presence:
        items.append({"Put": {
            "TableName": TABLE_NAME,
            "Item": {"PK": _s(f"USER#{email}"), "SK": _s(f"ACTIVE#{date}"),
                     "gsi_day_pk": _s(f"DAY#{date}"), "gsi_day_sk": _s(f"USER#{email}")},
        }})
    for (date, dim), c in cost.items():
        expr, vals = _add_expr({"cost_usd_est": c["cost_usd"],
                                "tokens_in": c["tokens_in"], "tokens_out": c["tokens_out"]})
        items.append({"Update": {
            "TableName": TABLE_NAME,
            "Key": {"PK": _s(f"USER#{email}"), "SK": _s(f"ATTR#{date}#{dim}")},
            "UpdateExpression": expr, "ExpressionAttributeValues": vals,
        }})
    # Dedup marker under the user's own partition — only applied once per (user, object).
    items.append({"Put": {
        "TableName": TABLE_NAME,
        "Item": {"PK": _s(f"USER#{email}"), "SK": _s(f"OTELOBJ#{s3key}")},
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

    # Group everything by user so each user is written in an independent transaction.
    by_user: dict = defaultdict(lambda: {"prod": {}, "presence": set(), "cost": {}})
    for (email, date, model), row in agg.items():
        by_user[email]["prod"][(date, model)] = row
    for (email, date) in presence:
        by_user[email]["presence"].add(date)
    for (email, date, dim), c in cost.items():
        by_user[email]["cost"][(date, dim)] = c

    wrote_any = False
    for email, d in by_user.items():
        items = _user_transact_items(email, key, d["prod"], d["presence"], d["cost"])
        if len(items) > 100:
            # A single user in one export window cannot realistically exceed this.
            raise RuntimeError(f"per-user transaction too large ({len(items)}) for {email}/{key}")
        try:
            ddb.transact_write_items(TransactItems=items)
            wrote_any = True
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("TransactionCanceledException", "ConditionalCheckFailedException"):
                continue  # this user already processed for this object -> idempotent skip
            raise
    return wrote_any


def handler(event, context):
    processed = 0
    for rec in event.get("Records", []):
        bucket = rec["s3"]["bucket"]["name"]
        key = rec["s3"]["object"]["key"]
        if _process_object(bucket, key):
            processed += 1
    return {"processed": processed}
