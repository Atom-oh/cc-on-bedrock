#!/usr/bin/env python3
"""
ADR-025 backfill: re-key usage/limits/user-budgets rows from subdomain → Cognito sub.

Rows historically keyed by PK=USER#{subdomain} are rewritten to PK=USER#{sub},
preserving SK and all attributes and adding a `subdomain` display attribute.
DEPT#* rows are left untouched (department is not changing).

SAFETY:
  * Dry-run by DEFAULT. Pass --apply to write.
  * Run against a NON-PROD table first (--usage-table / --limits-table overrides).
  * Idempotent: a row whose PK is already a known sub (no Cognito subdomain match)
    is skipped. Re-running after a partial run is safe.
  * Does NOT delete the old subdomain-keyed row unless --delete-old is set, so you
    can verify the sub-keyed copy before removing the original (recommended:
    --apply first, verify, then --apply --delete-old).

Usage:
  python3 migrate-adr025-usage-to-sub.py --user-pool-id ap-northeast-2_xxx            # dry-run
  python3 migrate-adr025-usage-to-sub.py --user-pool-id ... --apply                   # write sub rows
  python3 migrate-adr025-usage-to-sub.py --user-pool-id ... --apply --delete-old      # remove old rows
"""
import argparse
import sys

import boto3

REGION_DEFAULT = "ap-northeast-2"


def build_subdomain_to_sub(cognito, pool_id):
    """Return {subdomain: sub} for every user that has a custom:subdomain."""
    mapping = {}
    paginator = cognito.get_paginator("list_users")
    for page in paginator.paginate(UserPoolId=pool_id):
        for u in page.get("Users", []):
            attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
            sub = attrs.get("sub")
            sd = attrs.get("custom:subdomain")
            if sub and sd:
                if sd in mapping and mapping[sd] != sub:
                    print(f"  ! WARN subdomain {sd!r} maps to multiple subs "
                          f"({mapping[sd]} and {sub}) — skipping {sd}", file=sys.stderr)
                    mapping[sd] = None  # ambiguous → refuse to migrate
                else:
                    mapping.setdefault(sd, sub)
    return {k: v for k, v in mapping.items() if v}


def migrate_table(table, sd_to_sub, apply, delete_old, label):
    scanned = rekeyed = skipped = deleted = 0
    last_key = None
    while True:
        kwargs = {"ExclusiveStartKey": last_key} if last_key else {}
        resp = table.scan(**kwargs)
        for item in resp.get("Items", []):
            scanned += 1
            pk = item.get("PK", "")
            if not pk.startswith("USER#"):
                continue
            key = pk[len("USER#"):]
            # Already a sub (not in subdomain map) → assume migrated/native.
            if key not in sd_to_sub:
                skipped += 1
                continue
            sub = sd_to_sub[key]
            new_item = dict(item)
            new_item["PK"] = f"USER#{sub}"
            new_item["subdomain"] = key  # preserve human-readable subdomain
            print(f"  [{label}] {pk} | SK={item.get('SK')} → USER#{sub}")
            if apply:
                table.put_item(Item=new_item)
                if delete_old:
                    table.delete_item(Key={"PK": pk, "SK": item["SK"]})
                    deleted += 1
            rekeyed += 1
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
    print(f"[{label}] scanned={scanned} rekeyed={rekeyed} skipped={skipped} deleted={deleted}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default=REGION_DEFAULT)
    ap.add_argument("--user-pool-id", required=True)
    ap.add_argument("--usage-table", default="cc-on-bedrock-usage")
    ap.add_argument("--limits-table", default="cc-on-bedrock-limits")
    ap.add_argument("--user-budgets-table", default="cc-user-budgets")
    ap.add_argument("--apply", action="store_true", help="actually write (default: dry-run)")
    ap.add_argument("--delete-old", action="store_true", help="delete the old subdomain-keyed rows")
    args = ap.parse_args()

    boto3.setup_default_session(region_name=args.region)
    cognito = boto3.client("cognito-idp")
    ddb = boto3.resource("dynamodb")

    print(f"Building subdomain→sub map from {args.user_pool_id} ...")
    sd_to_sub = build_subdomain_to_sub(cognito, args.user_pool_id)
    print(f"  {len(sd_to_sub)} subdomain→sub mappings")
    if not args.apply:
        print("DRY-RUN (no writes). Pass --apply to execute.\n")

    # user-budgets uses key name `user_id`, not PK — handle separately.
    migrate_table(ddb.Table(args.usage_table), sd_to_sub, args.apply, args.delete_old, "usage")
    migrate_table(ddb.Table(args.limits_table), sd_to_sub, args.apply, args.delete_old, "limits")
    print("\nNOTE: cc-user-budgets uses key `user_id` (not PK#/SK) — migrate it with a "
          "dedicated pass if admin set per-user budgets by subdomain. See runbook.")


if __name__ == "__main__":
    main()
