#!/usr/bin/env python3
"""Delete stale non-Cognito identities from the budget/usage tables.

The Bedrock usage tracker historically keyed usage rows by the raw IAM principal
(e.g. ``awsops-ec2-role``) before the ``cc-on-bedrock-task-`` /
``cc-on-bedrock-local-user-`` role filter was added (commit f574355). Those
stale rows leak into ``cc-user-budgets`` via budget-check.py and surface in
``/admin/budgets`` as fake users.

This script builds the authoritative set of Cognito identities (sub /
custom:subdomain / email / username) and deletes any budget/usage row whose
identity is NOT in that set.

Dry-run by default — prints what it WOULD delete. Pass ``--apply`` to delete.

Usage:
  python3 scripts/cleanup-stale-budget-users.py                 # dry-run
  python3 scripts/cleanup-stale-budget-users.py --apply         # delete
  python3 scripts/cleanup-stale-budget-users.py \
      --region ap-northeast-2 --user-pool-name cc-on-bedrock-users \
      --user-budgets-table cc-user-budgets --usage-table cc-on-bedrock-usage
"""
import argparse
import sys

import boto3


def resolve_pool_id(cognito, name: str) -> str:
    paginator = cognito.get_paginator("list_user_pools")
    for page in paginator.paginate(MaxResults=60):
        for pool in page.get("UserPools", []):
            if pool["Name"] == name:
                return pool["Id"]
    raise SystemExit(f"[ERROR] Cognito user pool '{name}' not found")


def load_valid_keys(cognito, pool_id: str) -> set:
    keys: set = set()
    pagination_token = None
    while True:
        params = {"UserPoolId": pool_id, "Limit": 60}
        if pagination_token:
            params["PaginationToken"] = pagination_token
        result = cognito.list_users(**params)
        for u in result.get("Users", []):
            # ADR-029 (B′): canonical key is email (lowercased). Lowercase every
            # identity key so an email-keyed USER# row is recognised as valid and
            # never deleted as "stale". sub/subdomain kept for back-compat.
            if u.get("Username"):
                keys.add(u["Username"].strip().lower())
            for attr in u.get("Attributes", []):
                if attr["Name"] in ("sub", "custom:subdomain", "email") and attr.get("Value"):
                    keys.add(attr["Value"].strip().lower())
        pagination_token = result.get("PaginationToken")
        if not pagination_token:
            break
    return keys


def scan_all(table, **kwargs):
    last_key = None
    while True:
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        result = table.scan(**kwargs)
        for item in result.get("Items", []):
            yield item
        last_key = result.get("LastEvaluatedKey")
        if not last_key:
            break


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", default="ap-northeast-2")
    ap.add_argument("--user-pool-name", default="cc-on-bedrock-users")
    ap.add_argument("--user-pool-id", default=None, help="overrides --user-pool-name")
    ap.add_argument("--user-budgets-table", default="cc-user-budgets")
    ap.add_argument("--usage-table", default="cc-on-bedrock-usage")
    ap.add_argument("--apply", action="store_true", help="actually delete (default: dry-run)")
    args = ap.parse_args()

    cognito = boto3.client("cognito-idp", region_name=args.region)
    ddb = boto3.resource("dynamodb", region_name=args.region)

    pool_id = args.user_pool_id or resolve_pool_id(cognito, args.user_pool_name)
    valid = load_valid_keys(cognito, pool_id)
    if not valid:
        raise SystemExit(
            "[ABORT] Loaded 0 Cognito identities — refusing to delete "
            "everything. Check the pool name/id and credentials."
        )
    print(f"[INFO] pool={pool_id} valid Cognito identity keys={len(valid)}")
    mode = "APPLY (deleting)" if args.apply else "DRY-RUN (no deletes)"
    print(f"[INFO] mode={mode}\n")

    # ── cc-user-budgets: key = user_id ──────────────────────────────────────
    budgets_table = ddb.Table(args.user_budgets_table)
    stale_budgets = [
        item for item in scan_all(budgets_table)
        if str(item.get("user_id", "")).strip().lower() not in valid
    ]
    print(f"[{args.user_budgets_table}] stale rows: {len(stale_budgets)}")
    for item in stale_budgets:
        print(f"    user_id={item.get('user_id')!r} dept={item.get('department')} "
              f"spend={item.get('currentSpend')}")
    if args.apply and stale_budgets:
        with budgets_table.batch_writer() as bw:
            for item in stale_budgets:
                bw.delete_item(Key={"user_id": item["user_id"]})
        print(f"    -> deleted {len(stale_budgets)} rows")

    # ── cc-on-bedrock-usage: key = PK + SK, only USER# rows ─────────────────
    usage_table = ddb.Table(args.usage_table)
    stale_usage = [
        item for item in scan_all(
            usage_table,
            FilterExpression="begins_with(PK, :p)",
            ExpressionAttributeValues={":p": "USER#"},
        )
        if str(item["PK"]).replace("USER#", "").strip().lower() not in valid
    ]
    # Distinct identities for a readable summary
    ids = sorted({str(i["PK"]).replace("USER#", "") for i in stale_usage})
    print(f"\n[{args.usage_table}] stale USER# rows: {len(stale_usage)} "
          f"across {len(ids)} identities")
    for ident in ids:
        n = sum(1 for i in stale_usage if str(i["PK"]).replace("USER#", "") == ident)
        print(f"    {ident!r}: {n} rows")
    if args.apply and stale_usage:
        with usage_table.batch_writer() as bw:
            for item in stale_usage:
                bw.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
        print(f"    -> deleted {len(stale_usage)} rows")

    if not args.apply:
        print("\n[DRY-RUN] Re-run with --apply to delete the rows listed above.")


if __name__ == "__main__":
    main()
