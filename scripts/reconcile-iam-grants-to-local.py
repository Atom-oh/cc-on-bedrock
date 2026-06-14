#!/usr/bin/env python3
"""
ADR-026 T8 — reconcile existing EC2-only IAM grants onto Local Governance roles.

Before T5, approved grants were attached only to the EC2 task role
(cc-on-bedrock-task-{subdomain}). After T5 they go to BOTH the task role and the
Local role. ADR-031 (B′): the Local role is now cc-on-bedrock-local-user-{subdomain}
(was {sub}). This script finds inline grant
policies present on a task role but MISSING on the corresponding local role and
(optionally) copies them over, so pre-existing grants work in Local mode too.

Grant policies are inline policies named `Grant-*` or `PolicySet-*`.
Dry-run by DEFAULT — pass --apply to write.

Usage:
  python3 scripts/reconcile-iam-grants-to-local.py --self-test
  python3 scripts/reconcile-iam-grants-to-local.py --user-pool-name cc-on-bedrock-users
  python3 scripts/reconcile-iam-grants-to-local.py --user-pool-name ... --apply
"""
import argparse
import sys

GRANT_PREFIXES = ("Grant-", "PolicySet-")


def is_grant_policy(name: str) -> bool:
    return name.startswith(GRANT_PREFIXES)


def gaps(task_grants: dict, local_grants: dict, valid_subdomains) -> list:
    """Pure core: compute (local_role, policy_name) pairs to copy.

    ADR-031 (B′): both the task role and the Local role are named by subdomain
    (cc-on-bedrock-task-{subdomain} / cc-on-bedrock-local-user-{subdomain}), so the
    local role is keyed by subdomain directly — no sub indirection.

    task_grants:      {subdomain: set(policyName)}   grant policies on each task role
    local_grants:     {subdomain: set(policyName)}   grant policies on each local role
    valid_subdomains: set/dict of Cognito-known subdomains (orphan filter)
    Returns list of (local_role_name, policy_name, subdomain) needing copy.
    """
    out = []
    for subdomain, names in sorted(task_grants.items()):
        if subdomain not in valid_subdomains:
            continue  # no Cognito identity → skip (orphan/stale task role)
        have = local_grants.get(subdomain, set())
        for name in sorted(names):
            if is_grant_policy(name) and name not in have:
                out.append((f"cc-on-bedrock-local-user-{subdomain}", name, subdomain))
    return out


def _self_test() -> int:
    task = {"alice": {"Grant-r1", "PolicySet-s3", "BedrockInvokeInline"}, "bob": {"Grant-r2"}}
    local = {"alice": {"Grant-r1"}, "bob": set()}
    valid = {"alice", "bob"}
    res = gaps(task, local, valid)
    # alice: Grant-r1 already on local (skip), PolicySet-s3 missing → copy; BedrockInvokeInline not a grant → skip
    # bob: Grant-r2 missing → copy
    got = {(r, n) for r, n, _ in res}
    assert got == {("cc-on-bedrock-local-user-alice", "PolicySet-s3"), ("cc-on-bedrock-local-user-bob", "Grant-r2")}, got
    # unmapped subdomain is skipped
    assert gaps({"ghost": {"Grant-x"}}, {}, set()) == []
    print("[self-test] OK — grant-gap computation verified")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--region", default="ap-northeast-2")
    ap.add_argument("--user-pool-name", default="cc-on-bedrock-users")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return _self_test()

    import boto3

    iam = boto3.client("iam", region_name=args.region)
    cognito = boto3.client("cognito-idp", region_name=args.region)

    # subdomain -> sub from Cognito
    pool_id = None
    for page in cognito.get_paginator("list_user_pools").paginate(MaxResults=60):
        for p in page.get("UserPools", []):
            if p["Name"] == args.user_pool_name:
                pool_id = p["Id"]
    if not pool_id:
        raise SystemExit(f"[ERROR] user pool '{args.user_pool_name}' not found")
    # ADR-031 (B′): roles are keyed by subdomain; collect the set of Cognito-known
    # subdomains to filter orphan/stale task roles.
    valid_subdomains = set()
    for page in cognito.get_paginator("list_users").paginate(UserPoolId=pool_id):
        for u in page.get("Users", []):
            attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
            sd = attrs.get("custom:subdomain")
            if sd:
                valid_subdomains.add(sd)

    def inline_grants(role_name: str) -> set:
        try:
            names = []
            for page in iam.get_paginator("list_role_policies").paginate(RoleName=role_name):
                names += page.get("PolicyNames", [])
            return {n for n in names if is_grant_policy(n)}
        except iam.exceptions.NoSuchEntityException:
            return set()

    task_grants, local_grants = {}, {}
    for page in iam.get_paginator("list_roles").paginate(PathPrefix="/"):
        for r in page.get("Roles", []):
            rn = r["RoleName"]
            if rn.startswith("cc-on-bedrock-task-"):
                task_grants[rn[len("cc-on-bedrock-task-"):]] = inline_grants(rn)
            elif rn.startswith("cc-on-bedrock-local-user-"):
                local_grants[rn[len("cc-on-bedrock-local-user-"):]] = inline_grants(rn)

    todo = gaps(task_grants, local_grants, valid_subdomains)
    if not todo:
        print("[OK] no grant gaps — local roles already in sync")
        return 0
    for local_role, name, subdomain in todo:
        print(f"  [{'APPLY' if args.apply else 'DRY-RUN'}] copy {name} (from task-{subdomain}) → {local_role}")
        if args.apply:
            doc = iam.get_role_policy(RoleName=f"cc-on-bedrock-task-{subdomain}", PolicyName=name)["PolicyDocument"]
            import json as _json
            iam.put_role_policy(RoleName=local_role, PolicyName=name,
                                PolicyDocument=_json.dumps(doc) if not isinstance(doc, str) else doc)
    print(f"[{'APPLIED' if args.apply else 'DRY-RUN'}] {len(todo)} grant(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
