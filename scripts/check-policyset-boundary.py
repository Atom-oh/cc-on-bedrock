#!/usr/bin/env python3
"""
ADR-026 T6 — CI invariant: the task permission boundary MUST be a superset of the
services a developer may request (DEFAULT_SERVICE_ALLOWLIST). If a service is added
to the request allowlist but not permitted by the boundary, approved grants for it
would be silently nullified ("approved but doesn't work"). This check fails the build.

It compares at SERVICE-prefix granularity:
  - boundary services  := every Action's service prefix in the cc-on-bedrock-task-boundary
                          managed policy of the synthesized CloudFormation template.
  - allowlist services := DEFAULT_SERVICE_ALLOWLIST in iam-request-validation.ts.
NOTE: source regex is used ONLY to read the TS allowlist literal (a plain array).
The boundary side is read from the SYNTHESIZED template JSON (not TS source) so CDK
constructs/spreads are accounted for.

Usage:
  python3 scripts/check-policyset-boundary.py --self-test           # logic fixtures
  python3 scripts/check-policyset-boundary.py --template <cfn.json> # check a synth'd template
  python3 scripts/check-policyset-boundary.py                       # runs `npx cdk synth` then checks
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

BOUNDARY_NAME = "cc-on-bedrock-task-boundary"
ALLOWLIST_TS = "shared/nextjs-app/src/lib/iam-request-validation.ts"


def _services_from_actions(actions) -> set:
    if isinstance(actions, str):
        actions = [actions]
    out = set()
    for a in actions or []:
        if isinstance(a, str) and ":" in a:
            out.add(a.split(":")[0].lower())
    return out


def boundary_services(template: dict) -> set:
    """Collect Action service prefixes from the boundary managed policy."""
    svcs: set = set()
    for res in (template.get("Resources") or {}).values():
        if res.get("Type") != "AWS::IAM::ManagedPolicy":
            continue
        props = res.get("Properties", {})
        if props.get("ManagedPolicyName") != BOUNDARY_NAME:
            continue
        statements = (props.get("PolicyDocument") or {}).get("Statement") or []
        for st in statements:
            if st.get("Effect", "Allow") == "Allow":
                svcs |= _services_from_actions(st.get("Action"))
    return svcs


def allowlist_services(ts_path: Path) -> set:
    text = ts_path.read_text(encoding="utf-8")
    m = re.search(r"DEFAULT_SERVICE_ALLOWLIST\s*=\s*\[(.*?)\]", text, re.S)
    if not m:
        raise SystemExit(f"[ERROR] DEFAULT_SERVICE_ALLOWLIST not found in {ts_path}")
    return {s.lower() for s in re.findall(r'"([^"]+)"|\'([^\']+)\'', m.group(1)) for s in s if s}


def check(allowlist: set, boundary: set) -> set:
    """Return services in allowlist NOT covered by boundary (empty = OK)."""
    return allowlist - boundary


def boundary_actions(template: dict) -> set:
    """Collect ALL Allow action strings (lowercased) from the boundary policy."""
    acts: set = set()
    for res in (template.get("Resources") or {}).values():
        if res.get("Type") != "AWS::IAM::ManagedPolicy":
            continue
        if res.get("Properties", {}).get("ManagedPolicyName") != BOUNDARY_NAME:
            continue
        for st in (res["Properties"].get("PolicyDocument") or {}).get("Statement") or []:
            if st.get("Effect", "Allow") == "Allow":
                a = st.get("Action")
                for x in ([a] if isinstance(a, str) else (a or [])):
                    if isinstance(x, str):
                        acts.add(x.lower())
    return acts


def wildcard_ok_actions(ts_path: Path) -> set:
    text = ts_path.read_text(encoding="utf-8")
    m = re.search(r"DEFAULT_WILDCARD_OK_ACTIONS\s*=\s*\[(.*?)\]", text, re.S)
    if not m:
        raise SystemExit(f"[ERROR] DEFAULT_WILDCARD_OK_ACTIONS not found in {ts_path}")
    return {s.lower() for g in re.findall(r'"([^"]+)"|\'([^\']+)\'', m.group(1)) for s in g if s}


def _action_covered(boundary: set, pattern: str) -> bool:
    """Does some boundary action cover `pattern` (a possibly-wildcard request action)?
    A boundary wildcard 'svc:Pre*' covers pattern p iff p's prefix starts with 'svc:pre'."""
    p = pattern.lower()
    p_prefix = p[:-1] if p.endswith("*") else p
    for b in boundary:
        if b == p:
            return True
        if b.endswith("*") and p_prefix.startswith(b[:-1]):
            return True
    return False


def uncovered_wildcard_ok(boundary: set, wildcardok: set) -> set:
    """wildcard-ok request actions NOT covered by any boundary action (empty = OK)."""
    return {p for p in wildcardok if not _action_covered(boundary, p)}


def _self_test() -> int:
    ok_missing = check({"s3", "sqs"}, {"s3", "sqs", "sns", "bedrock"})
    bad_missing = check({"s3", "sqs", "kms"}, {"s3", "sqs"})
    assert ok_missing == set(), f"positive fixture should have no missing, got {ok_missing}"
    assert bad_missing == {"kms"}, f"negative fixture should flag kms, got {bad_missing}"
    # action-level (review MAJOR): boundary 'ec2:describe*' covers wildcard-ok 'ec2:describe*';
    # an enumerated-only boundary does NOT cover the wildcard pattern.
    assert uncovered_wildcard_ok({"ec2:describe*", "s3:listallmybuckets"}, {"ec2:describe*", "s3:listallmybuckets"}) == set()
    assert uncovered_wildcard_ok({"ec2:describeinstances"}, {"ec2:describe*"}) == {"ec2:describe*"}
    assert uncovered_wildcard_ok({"states:listexecutions"}, {"states:liststatemachines"}) == {"states:liststatemachines"}
    print("[self-test] OK — service-level + action-level coverage logic verified")
    return 0


def _load_template(args) -> dict:
    if args.template:
        return json.loads(Path(args.template).read_text(encoding="utf-8"))
    # CDK writes the JSON template to cdk.out/<Stack>.template.json (stdout is YAML).
    out = subprocess.run(
        ["npx", "cdk", "synth", "CcOnBedrock-Security"],
        cwd="cdk", capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise SystemExit(f"[ERROR] cdk synth failed:\n{out.stderr[-2000:]}")
    tpl = Path("cdk/cdk.out/CcOnBedrock-Security.template.json")
    if not tpl.exists():
        raise SystemExit(f"[ERROR] synthesized template not found: {tpl}")
    return json.loads(tpl.read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--template", help="path to a synthesized CFN template JSON")
    ap.add_argument("--allowlist-source", default=ALLOWLIST_TS)
    args = ap.parse_args()

    if args.self_test:
        return _self_test()

    template = _load_template(args)
    src = Path(args.allowlist_source)
    bsvcs = boundary_services(template)
    asvcs = allowlist_services(src)
    missing_svc = check(asvcs, bsvcs)
    print(f"allowlist services: {sorted(asvcs)}")
    print(f"boundary services : {sorted(bsvcs)}")

    # action-level: every wildcard-ok request action must be covered by a boundary action
    bacts = boundary_actions(template)
    wok = wildcard_ok_actions(src)
    missing_act = uncovered_wildcard_ok(bacts, wok)

    failed = False
    if missing_svc:
        print(f"[FAIL] services requestable but NOT in boundary (grants silently nullified): {sorted(missing_svc)}", file=sys.stderr)
        failed = True
    if missing_act:
        print(f"[FAIL] wildcard-ok actions NOT covered by boundary (Resource:* grants silently nullified): {sorted(missing_act)}", file=sys.stderr)
        failed = True
    if failed:
        return 1
    print("[OK] boundary ⊇ request service allowlist AND covers all wildcard-ok actions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
