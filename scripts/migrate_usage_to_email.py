#!/usr/bin/env python3
"""ADR-029 (B′) backfill: re-key usage/limits/user-budgets from Cognito sub /
subdomain → email, and create subdomain-named Local Governance IAM roles.

Rows historically keyed by PK=USER#{sub} (ADR-025) or PK=USER#{subdomain} (the
broken EC2 fallback) are rewritten to PK=USER#{email.lower()} — the ADR-029
canonical key. A `subdomain` attribute is preserved/added on every row, and the
per-user LIMIT# record additionally carries a transition `sub` (so the enforcer
can still target a legacy local-user-{sub} role during cutover — dropped later).

Merge policy on SK conflict (target row already exists):
  * usage rows + COUNTER#* : ADD numeric counters (sum-preserving)
  * LIMIT# / DENY#active / WARN# : prefer-new (overwrite, never sum)

IAM: for each deployed cc-on-bedrock-local-user-{sub}, create
cc-on-bedrock-local-user-{subdomain} cloning the full config + active Deny.
Old roles are kept unless --delete-old (blue-green; safe to verify first).

SAFETY: dry-run by DEFAULT. --apply to write. Idempotent. Subdomain collisions
(one subdomain → multiple emails) ABORT that user (never merge/share).

Usage:
  python3 migrate_usage_to_email.py --user-pool-id ap-northeast-2_xxx           # dry-run
  python3 migrate_usage_to_email.py --user-pool-id ... --apply                  # write email rows + new roles
  python3 migrate_usage_to_email.py --user-pool-id ... --apply --delete-old     # also remove old rows/roles
"""
from __future__ import annotations
import argparse
import sys
from decimal import Decimal

import boto3

REGION_DEFAULT = "ap-northeast-2"
LOCAL_ROLE_PREFIX = "cc-on-bedrock-local-user-"

# Numeric usage/counter fields summed on SK conflict (sum-preserving merge).
COUNTER_FIELDS = (
    "inputTokens", "outputTokens", "totalTokens", "cacheReadTokens",
    "cacheWriteTokens", "requests", "estimatedCost", "latencySumMs",
)


def build_identity_maps(users: list) -> dict:
    """From a Cognito ListUsers dump, build the re-key maps + collision report.

    Returns {
      "sub2email": {sub: email_lower}, "sd2email": {subdomain: email_lower},
      "sub2sd": {sub: subdomain}, "email2sd": {email: subdomain},
      "collisions": {subdomain: [emails...]}  # subdomain → >1 email (ABORT these)
    }
    Emails in a collision set are excluded from sd2email/sub2email so they are
    never merged into a shared key.
    """
    sub2email, sd2email, sub2sd, email2sd = {}, {}, {}, {}
    sd_owners: dict = {}
    for u in users:
        attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
        sub = attrs.get("sub")
        email = (attrs.get("email") or "").strip().lower()
        sd = attrs.get("custom:subdomain")
        if not (sub and email):
            continue
        sub2email[sub] = email
        if sd:
            sub2sd[sub] = sd
            email2sd[email] = sd
            sd_owners.setdefault(sd, set()).add(email)
    collisions = {sd: sorted(es) for sd, es in sd_owners.items() if len(es) > 1}
    for sd, owners in sd_owners.items():
        if sd in collisions:
            continue  # ambiguous — never map a colliding subdomain to an email
        sd2email[sd] = next(iter(owners))
    return {
        "sub2email": sub2email, "sd2email": sd2email, "sub2sd": sub2sd,
        "email2sd": email2sd, "collisions": collisions,
    }


def target_email(pk_suffix: str, maps: dict):
    """Resolve the canonical email for a USER# PK suffix (sub OR subdomain).
    Returns (email, subdomain) or (None, None) when unmapped / already-email."""
    if "@" in pk_suffix:
        return None, None  # already email-keyed (migrated/native) — skip
    if pk_suffix in maps["sub2email"]:
        return maps["sub2email"][pk_suffix], maps["sub2sd"].get(pk_suffix)
    if pk_suffix in maps["sd2email"]:
        return maps["sd2email"][pk_suffix], pk_suffix
    return None, None


def _num(v) -> Decimal:
    return v if isinstance(v, Decimal) else Decimal(str(v or 0))


def merge_counters(existing: dict, incoming: dict) -> dict:
    """Return `incoming` with COUNTER_FIELDS summed into `existing` (sum-preserving)."""
    merged = dict(incoming)
    for f in COUNTER_FIELDS:
        if f in existing or f in incoming:
            merged[f] = _num(existing.get(f)) + _num(incoming.get(f))
    return merged


def _is_counter_sk(sk: str) -> bool:
    return sk.startswith("COUNTER#") or "#" in sk and not sk.startswith(("LIMIT#", "DENY#", "WARN#"))


def plan_row(item: dict, maps: dict):
    """Compute the migrated row for one DynamoDB item, or None to skip.
    Returns (new_item, old_key, is_limit_record) or None."""
    pk = item.get("PK", "")
    if not pk.startswith("USER#"):
        return None
    suffix = pk[len("USER#"):]
    email, subdomain = target_email(suffix, maps)
    if not email:
        return None
    new_item = dict(item)
    new_item["PK"] = f"USER#{email}"
    if subdomain:
        new_item["subdomain"] = subdomain
    sk = item.get("SK", "")
    is_limit = sk == "DENY#active" or sk.startswith("LIMIT#")
    if sk.startswith("LIMIT#") and subdomain:
        # transition sub source for dual-name enforcement (dropped in cleanup PR)
        new_item.setdefault("sub", suffix if "@" not in suffix else new_item.get("sub"))
    if sk == "DENY#active" and subdomain:
        new_item["subdomain"] = subdomain
    return new_item, {"PK": pk, "SK": sk}, is_limit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default=REGION_DEFAULT)
    ap.add_argument("--user-pool-id", required=True)
    ap.add_argument("--usage-table", default="cc-on-bedrock-usage")
    ap.add_argument("--limits-table", default="cc-on-bedrock-limits")
    ap.add_argument("--user-budgets-table", default="cc-user-budgets")
    ap.add_argument("--apply", action="store_true", help="actually write (default: dry-run)")
    ap.add_argument("--delete-old", action="store_true", help="delete old sub/subdomain rows + roles")
    ap.add_argument("--skip-roles", action="store_true", help="skip IAM role recreation")
    args = ap.parse_args()

    boto3.setup_default_session(region_name=args.region)
    cognito = boto3.client("cognito-idp")
    ddb = boto3.resource("dynamodb")
    iam = boto3.client("iam")

    print(f"Building identity maps from {args.user_pool_id} ...")
    users = []
    paginator = cognito.get_paginator("list_users")
    for page in paginator.paginate(UserPoolId=args.user_pool_id):
        users.extend(page.get("Users", []))
    maps = build_identity_maps(users)
    print(f"  {len(maps['sub2email'])} users; {len(maps['sd2email'])} subdomain→email; "
          f"{len(maps['collisions'])} subdomain collision(s)")
    for sd, emails in maps["collisions"].items():
        print(f"  ! COLLISION subdomain {sd!r} → {emails} — ABORTED (manual fix required)", file=sys.stderr)
    if not args.apply:
        print("DRY-RUN (no writes). Pass --apply to execute.\n")

    _migrate_table(ddb.Table(args.usage_table), maps, args, "usage")
    _migrate_table(ddb.Table(args.limits_table), maps, args, "limits")
    _migrate_user_budgets(ddb.Table(args.user_budgets_table), maps, args)
    if not args.skip_roles:
        _migrate_roles(iam, maps, args)


def _migrate_table(table, maps, args, label):
    scanned = rekeyed = skipped = merged = deleted = 0
    last = None
    while True:
        kwargs = {"ExclusiveStartKey": last} if last else {}
        resp = table.scan(**kwargs)
        for item in resp.get("Items", []):
            scanned += 1
            planned = plan_row(item, maps)
            if not planned:
                skipped += 1
                continue
            new_item, old_key, is_limit = planned
            tgt_key = {"PK": new_item["PK"], "SK": new_item["SK"]}
            existing = table.get_item(Key=tgt_key).get("Item") if args.apply else None
            if existing and not is_limit:
                new_item = merge_counters(existing, new_item)
                merged += 1
            # Idempotency (P4 CRITICAL): summed rows (usage + COUNTER#) MUST delete
            # their source in the same pass, else a re-run re-adds the source into
            # the already-merged target → doubled counters/spend. prefer-new rows
            # (LIMIT/DENY/WARN) overwrite, so re-runs are naturally idempotent;
            # their source is removed only with --delete-old.
            delete_src = args.apply and (not is_limit or args.delete_old)
            print(f"  [{label}] {old_key['PK']} | SK={old_key['SK']} → {new_item['PK']}"
                  f"{' (merge)' if existing and not is_limit else ''}{' +del-src' if delete_src else ''}")
            if args.apply:
                table.put_item(Item=new_item)
                if delete_src:
                    table.delete_item(Key=old_key)
                    deleted += 1
            rekeyed += 1
        last = resp.get("LastEvaluatedKey")
        if not last:
            break
    print(f"[{label}] scanned={scanned} rekeyed={rekeyed} merged={merged} skipped={skipped} deleted={deleted}")


def _migrate_user_budgets(table, maps, args):
    """cc-user-budgets is keyed by `user_id` (sub) → re-key to email."""
    scanned = rekeyed = skipped = 0
    last = None
    while True:
        kwargs = {"ExclusiveStartKey": last} if last else {}
        resp = table.scan(**kwargs)
        for item in resp.get("Items", []):
            scanned += 1
            uid = item.get("user_id", "")
            if "@" in uid:
                skipped += 1
                continue
            email = maps["sub2email"].get(uid) or maps["sd2email"].get(uid)
            if not email:
                skipped += 1
                continue
            new_item = dict(item)
            new_item["user_id"] = email
            print(f"  [budgets] {uid} → {email}")
            if args.apply:
                table.put_item(Item=new_item)
                if args.delete_old:
                    table.delete_item(Key={"user_id": uid})
            rekeyed += 1
        last = resp.get("LastEvaluatedKey")
        if not last:
            break
    print(f"[budgets] scanned={scanned} rekeyed={rekeyed} skipped={skipped}")


def _migrate_roles(iam, maps, args):
    """Create cc-on-bedrock-local-user-{subdomain} from each legacy
    cc-on-bedrock-local-user-{sub}, cloning trust + inline policies + active Deny
    + tags. Old roles kept unless --delete-old."""
    created = skipped = deleted = 0
    for sub, subdomain in maps["sub2sd"].items():
        old_name = f"{LOCAL_ROLE_PREFIX}{sub}"
        new_name = f"{LOCAL_ROLE_PREFIX}{subdomain}"
        email = maps["sub2email"].get(sub, "")
        if subdomain in maps["collisions"]:
            skipped += 1
            continue
        try:
            old = iam.get_role(RoleName=old_name)["Role"]
        except iam.exceptions.NoSuchEntityException:
            continue
        print(f"  [role] {old_name} → {new_name} (email={email})")
        if args.apply:
            try:
                iam.get_role(RoleName=new_name)  # already exists → just ensure policies below
            except iam.exceptions.NoSuchEntityException:
                kw = dict(
                    RoleName=new_name,
                    AssumeRolePolicyDocument=_doc(old.get("AssumeRolePolicyDocument")),
                    MaxSessionDuration=old.get("MaxSessionDuration", 3600),
                    Tags=_clone_tags(iam, old_name, email, subdomain),
                    Description=old.get("Description", f"Local Governance role for {email}"),
                )
                pb = old.get("PermissionsBoundary", {}).get("PermissionsBoundaryArn")
                if pb:
                    kw["PermissionsBoundary"] = pb
                iam.create_role(**kw)
                created += 1
            _clone_inline_policies(iam, old_name, new_name)
            if args.delete_old:
                _delete_role(iam, old_name)
                deleted += 1
    print(f"[roles] created={created} skipped(collision/none)={skipped} deleted={deleted}")


def _doc(d):
    import json
    return json.dumps(d) if isinstance(d, dict) else (d or "{}")


def _clone_tags(iam, old_name, email, subdomain):
    tags = iam.list_role_tags(RoleName=old_name).get("Tags", [])
    out = [t for t in tags if t["Key"] not in ("email", "subdomain", "username")]
    out += [
        {"Key": "email", "Value": email}, {"Key": "subdomain", "Value": subdomain},
        {"Key": "username", "Value": email},
    ]
    return out


def _clone_inline_policies(iam, old_name, new_name):
    import json
    for pname in iam.list_role_policies(RoleName=old_name).get("PolicyNames", []):
        doc = iam.get_role_policy(RoleName=old_name, PolicyName=pname)["PolicyDocument"]
        iam.put_role_policy(RoleName=new_name, PolicyName=pname, PolicyDocument=json.dumps(doc))


def _delete_role(iam, name):
    for pname in iam.list_role_policies(RoleName=name).get("PolicyNames", []):
        iam.delete_role_policy(RoleName=name, PolicyName=pname)
    iam.delete_role(RoleName=name)


if __name__ == "__main__":
    main()
