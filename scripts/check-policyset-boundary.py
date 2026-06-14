#!/usr/bin/env python3
"""
ADR-030 T6 — CI invariant for the per-user task permission boundary (boundary X).

Boundary X (ADR-030) replaced the ADR-026 per-service `GrantCeiling*` allowlist ceiling
with: AllowInAccount (Action:"*" + Condition aws:ResourceAccount=<account>) + a DenyEscalation
floor. Because the boundary now allows every action *in account*, the old "boundary ⊇ request
service allowlist" superset check is trivially true and no longer meaningful. The thing that now
matters — and that this check enforces — is the **Deny floor**: the escalation / resource-policy /
control-plane actions that must NEVER be reachable by a task role, no matter what an admin grants.

Invariants enforced against the SYNTHESIZED CloudFormation template (so CDK constructs/spreads
are accounted for):
  (a) Deny-floor coverage   — every action in CANONICAL_DENY_FLOOR is denied by the boundary's
                              Deny statements (wildcard-aware: boundary `iam:*` covers `iam:PassRole`).
  (b) validator coherence   — every CANONICAL_DENY_FLOOR action is ALSO flagged dangerous by the
                              request validator's DEFAULT_DANGEROUS patterns. This keeps request-time
                              rejection and runtime Deny aligned (defense-in-depth) for the
                              IAM-expressible escalation actions.
  (c) account confinement   — an Allow statement with Action "*" exists AND carries a
                              StringEquals aws:ResourceAccount condition (cross-account fail-closed).

NOTE on scope of (b): the validator's DEFAULT_DANGEROUS is regex / cross-service (e.g.
`/:put[a-z]*policy$/` matches put*policy on ANY service). IAM Deny cannot express a service-partial
wildcard across all services (`*:Put*Policy` is invalid) — that is the same ADR-030 finding that
motivated boundary X. So literal "validator-dangerous ⊆ boundary-Deny" is INFEASIBLE. We instead
pin a CANONICAL_DENY_FLOOR (the IAM-expressible escalation actions that matter) and assert it is a
subset of BOTH the boundary Deny and the validator-dangerous set. ADR-030 T4 reviews completeness.

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

# The hard floor: escalation / resource-policy-exposure / control-plane actions that the boundary
# MUST deny for a per-user task role regardless of any admin-approved grant. Each entry is a
# concrete action; the boundary may cover it via an exact match OR a wildcard (e.g. `iam:*`).
# This is intentionally the IAM-EXPRESSIBLE representative set (see module docstring (b) note);
# ADR-030 T4 is the place to grow it. Keep entries lowercase.
CANONICAL_DENY_FLOOR = [
    # privilege delegation / role escalation
    "iam:passrole", "iam:createrole", "iam:attachrolepolicy", "iam:putrolepolicy",
    "iam:createpolicyversion", "iam:updateassumerolepolicy",
    "sts:assumerole", "sts:getfederationtoken", "sts:getsessiontoken",
    # account-access control planes outside iam:* — ADR-030 T4
    "sso:createaccountassignment", "identitystore:creategroupmembership",
    "lakeformation:grantpermissions",
    # cross-account resource sharing (defeats aws:ResourceAccount) — ADR-030 T4
    "ram:createresourceshare", "ram:associateresourceshare",
    # cross-account resource-policy / public exposure on non-requestable services — ADR-030 T4
    "backup:putbackupvaultaccesspolicy", "codebuild:updateprojectvisibility",
    "ecr:putregistrypolicy", "logs:putresourcepolicy", "kinesis:putresourcepolicy",
    # escalation/exposure on REQUESTABLE services (validator MUST also flag — invariant b) — ADR-030 T4
    "eks:createaccessentry", "eks:associateaccesspolicy",
    "ec2:modifysnapshotattribute", "ec2:modifyimageattribute",
    "dynamodb:putresourcepolicy", "dynamodb:deleteresourcepolicy",
    # KMS key destruction / policy
    "kms:putkeypolicy", "kms:schedulekeydeletion", "kms:disablekey", "kms:creategrant",
    # resource-policy / public exposure (cross-account)
    "s3:putbucketpolicy", "s3:putbucketacl", "s3:putaccountpublicaccessblock", "s3:deletebucketpolicy",
    "lambda:addpermission", "lambda:addlayerversionpermission", "lambda:putfunctionconcurrency",
    "sns:addpermission", "sqs:addpermission",
    "secretsmanager:putresourcepolicy", "secretsmanager:deleteresourcepolicy",
    "ecr:setrepositorypolicy", "events:putpermission", "glue:putresourcepolicy",
    # network exposure
    "ec2:authorizesecuritygroupingress", "ec2:authorizesecuritygroupegress",
    "ec2:modifysecuritygrouprules",
]


# ----------------------------------------------------------------------------- template parsing
def _boundary_policy(template: dict) -> dict:
    for res in (template.get("Resources") or {}).values():
        if res.get("Type") != "AWS::IAM::ManagedPolicy":
            continue
        if res.get("Properties", {}).get("ManagedPolicyName") != BOUNDARY_NAME:
            continue
        return (res["Properties"].get("PolicyDocument") or {})
    raise SystemExit(f"[ERROR] boundary managed policy '{BOUNDARY_NAME}' not found in template")


def _as_list(x) -> list:
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def deny_actions(doc: dict) -> set:
    """All actions (lowercased) carried by Deny statements in the boundary."""
    acts: set = set()
    for st in _as_list(doc.get("Statement")):
        if st.get("Effect") == "Deny":
            acts |= {a.lower() for a in _as_list(st.get("Action")) if isinstance(a, str)}
    return acts


def account_confinement(doc: dict) -> bool:
    """True iff some Allow Action:'*' statement carries a StringEquals aws:ResourceAccount cond."""
    for st in _as_list(doc.get("Statement")):
        if st.get("Effect", "Allow") != "Allow":
            continue
        if "*" not in _as_list(st.get("Action")):
            continue
        se = (st.get("Condition") or {}).get("StringEquals") or {}
        if any(k.lower() == "aws:resourceaccount" for k in se):
            return True
    return False


# ----------------------------------------------------------------------------- coverage logic
def action_denied(deny: set, action: str) -> bool:
    """Does some boundary Deny action cover `action`? Wildcard-aware: a deny entry
    `svc:*` (or any `prefix*`) covers `action` iff action starts with the prefix."""
    a = action.lower()
    for d in deny:
        if d == a:
            return True
        if d.endswith("*") and a.startswith(d[:-1]):
            return True
    return False


def uncovered_floor(deny: set) -> list:
    """Floor actions NOT denied by the boundary (empty = OK)."""
    return [a for a in CANONICAL_DENY_FLOOR if not action_denied(deny, a)]


# ----------------------------------------------------------------------------- validator coherence
def validator_dangerous_patterns(ts_path: Path) -> list:
    """Extract DEFAULT_DANGEROUS regex SOURCES from the TS validator and compile them.
    The literals are simple, POSIX-compatible bodies between `/.../i` — usable as-is in Python."""
    text = ts_path.read_text(encoding="utf-8")
    m = re.search(r"DEFAULT_DANGEROUS\s*:\s*RegExp\[\]\s*=\s*\[(.*?)\];", text, re.S)
    if not m:
        raise SystemExit(f"[ERROR] DEFAULT_DANGEROUS not found in {ts_path}")
    # Strip `//` line comments first — they contain '/' chars (e.g. "PutBucketPolicy/Delete...")
    # that would otherwise pollute regex-literal extraction. The regex bodies here contain no '/'.
    block = re.sub(r"//.*", "", m.group(1))
    bodies = re.findall(r"/([^/\n]+)/[a-z]*", block)
    if not bodies:
        raise SystemExit(f"[ERROR] no regex literals parsed from DEFAULT_DANGEROUS in {ts_path}")
    return [re.compile(b, re.I) for b in bodies]


def allowlist_services(ts_path: Path) -> set:
    """The write-allowlist (DEFAULT_SERVICE_ALLOWLIST): services a developer may REQUEST."""
    text = ts_path.read_text(encoding="utf-8")
    m = re.search(r"DEFAULT_SERVICE_ALLOWLIST\s*=\s*\[(.*?)\]", text, re.S)
    if not m:
        raise SystemExit(f"[ERROR] DEFAULT_SERVICE_ALLOWLIST not found in {ts_path}")
    return {s.lower() for g in re.findall(r'"([^"]+)"|\'([^\']+)\'', m.group(1)) for s in g if s}


READ_PREFIXES = ("get", "list", "describe", "batchget", "query", "scan")


def whole_service_denies(deny: set) -> set:
    """Services the boundary denies entirely (action == 'svc:*')."""
    return {d.split(":")[0] for d in deny if d.endswith(":*")}


def _requestable(action: str, allowlist: set) -> bool:
    """Could a well-formed self-service request for `action` be ACCEPTED by the tiered validator?
    Write tier: any verb on a write-allowlist service. Read tier: List*/Describe*/Get*/Query*/
    Scan*/BatchGet* on ANY service. (ARN rules still apply, but the action *kind* is acceptable.)"""
    svc, _, op = action.partition(":")
    return svc in allowlist or op.startswith(READ_PREFIXES)


def boundary_validator_incoherent(deny: set, patterns: list, allowlist: set) -> list:
    """Boundary-denied actions a self-service request could still be ACCEPTED for, yet the validator
    does NOT reject → "approved then silently runtime-denied" (empty = OK).

    Derived ENTIRELY from the boundary Deny set — NOT from a hand-maintained floor list — so a
    forgotten floor entry can never hide a drift (PR #71 review: the single-point-of-omission fix).
    Covers both the write-allowlist case (e.g. s3:PutBucketAcl) and the read-tier case (whole-service
    `svc:*` denies + read-verb-shaped specific denies like sts:GetFederationToken)."""
    bad = []
    for d in deny:
        if d.endswith("*"):
            # whole-service `svc:*` deny → reads are any-service requestable; probe must be rejected.
            if d.endswith(":*"):
                svc = d.split(":")[0]
                probe = f"{svc}:listprobe"
                if not any(p.search(probe) for p in patterns):
                    bad.append(f"{d} (read requests not rejected, e.g. {probe})")
            continue  # action-prefix wildcards (svc:Pre*) are invalid IAM — boundary never uses them
        if _requestable(d, allowlist) and not any(p.search(d) for p in patterns):
            bad.append(d)
    return sorted(bad)


# ----------------------------------------------------------------------------- self-test
def _self_test() -> int:
    # (a) coverage: `iam:*` covers iam:passrole; an enumerated-only deny does not cover a sibling.
    assert action_denied({"iam:*"}, "iam:passrole")
    assert action_denied({"sts:assumerole"}, "sts:assumerole")
    assert not action_denied({"s3:putbucketpolicy"}, "s3:putbucketacl")
    assert uncovered_floor({"iam:*"}) != []  # iam covered, rest missing → non-empty

    # a Deny set that mirrors the real boundary X should fully cover the floor.
    real_like = {
        "iam:*", "organizations:*", "account:*", "ram:*",
        "sso:*", "sso-directory:*", "identitystore:*",
        "lakeformation:grantpermissions", "lakeformation:batchgrantpermissions", "lakeformation:putdatalakesettings",
        "sts:assumerole", "sts:assumerolewithsaml", "sts:assumerolewithwebidentity",
        "sts:getfederationtoken", "sts:getsessiontoken",
        "backup:putbackupvaultaccesspolicy", "backup:deletebackupvaultaccesspolicy", "codebuild:updateprojectvisibility",
        "logs:putresourcepolicy", "logs:putdestinationpolicy", "logs:deleteresourcepolicy",
        "kinesis:putresourcepolicy", "kinesis:deleteresourcepolicy",
        "elasticfilesystem:putfilesystempolicy", "elasticfilesystem:deletefilesystempolicy",
        "codeartifact:putdomainpermissionspolicy", "codeartifact:putrepositorypermissionspolicy",
        "acm-pca:putpolicy", "acm-pca:deletepolicy",
        "kms:schedulekeydeletion", "kms:disablekey", "kms:putkeypolicy", "kms:creategrant",
        "lambda:addpermission", "lambda:removepermission", "lambda:addlayerversionpermission",
        "lambda:putfunctionconcurrency",
        "sns:addpermission", "sns:removepermission", "sqs:addpermission", "sqs:removepermission",
        "s3:putbucketpolicy", "s3:putbucketacl", "s3:putaccountpublicaccessblock", "s3:deletebucketpolicy",
        "dynamodb:putresourcepolicy", "dynamodb:deleteresourcepolicy",
        "secretsmanager:putresourcepolicy", "secretsmanager:deleteresourcepolicy",
        "ecr:setrepositorypolicy", "ecr:putregistrypolicy", "ecr:deleteregistrypolicy",
        "events:putpermission", "glue:putresourcepolicy", "ssm:modifydocumentpermission",
        "eks:createaccessentry", "eks:associateaccesspolicy", "eks:updateaccessentry",
        "ec2:modifysnapshotattribute", "ec2:modifyimageattribute",
        "ec2:modifysecuritygrouprules", "ec2:authorizesecuritygroupingress", "ec2:authorizesecuritygroupegress",
    }
    miss = uncovered_floor(real_like)
    assert miss == [], f"real-like deny set should cover the floor, missing: {miss}"

    # (b/d) boundary⇄validator coherence, derived from the boundary (no manual-floor dependency):
    # every boundary-denied action a request could be accepted for must be validator-rejected.
    pats = validator_dangerous_patterns(Path(ALLOWLIST_TS))
    alw = allowlist_services(Path(ALLOWLIST_TS))
    assert boundary_validator_incoherent(real_like, pats, alw) == [], \
        f"real boundary should be validator-coherent: {boundary_validator_incoherent(real_like, pats, alw)}"
    # positive fixtures: each silent-deny shape is caught when the validator does NOT reject it.
    assert boundary_validator_incoherent({"s3:putbucketacl"}, [], {"s3"}) == ["s3:putbucketacl"]  # write-allowlist
    assert boundary_validator_incoherent({"organizations:*"}, [], set()) != []                     # whole-service read
    assert boundary_validator_incoherent({"sts:getfederationtoken"}, [], set()) != []              # read-verb specific
    assert boundary_validator_incoherent({"backup:putbackupvaultaccesspolicy"}, [], set()) == []   # not requestable → OK

    # (c) account confinement detection.
    good = {"Statement": [{"Effect": "Allow", "Action": "*",
                           "Condition": {"StringEquals": {"aws:ResourceAccount": "123"}}}]}
    bad = {"Statement": [{"Effect": "Allow", "Action": "*"}]}
    assert account_confinement(good) and not account_confinement(bad)

    print("[self-test] OK — deny-floor coverage + validator coherence + account confinement verified")
    return 0


# ----------------------------------------------------------------------------- driver
def _load_template(args) -> dict:
    if args.template:
        return json.loads(Path(args.template).read_text(encoding="utf-8"))
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

    doc = _boundary_policy(_load_template(args))
    deny = deny_actions(doc)
    src = Path(args.allowlist_source)
    patterns = validator_dangerous_patterns(src)
    alw = allowlist_services(src)

    missing = uncovered_floor(deny)
    incoherent = boundary_validator_incoherent(deny, patterns, alw)
    confined = account_confinement(doc)

    print(f"boundary Deny actions: {len(deny)}")
    print(f"canonical deny-floor : {len(CANONICAL_DENY_FLOOR)}")
    print(f"account confinement  : {'present (aws:ResourceAccount)' if confined else 'MISSING'}")

    failed = False
    if missing:
        print(f"[FAIL] (a) escalation floor NOT denied by boundary (reachable despite grant): {sorted(missing)}", file=sys.stderr)
        failed = True
    if incoherent:
        print(f"[FAIL] (b/d) boundary-denied action a self-service request could be ACCEPTED for, but validator does NOT reject (silent-deny): {incoherent}", file=sys.stderr)
        failed = True
    if not confined:
        print("[FAIL] (c) no Allow Action:'*' statement with StringEquals aws:ResourceAccount (cross-account not fail-closed)", file=sys.stderr)
        failed = True
    if failed:
        return 1
    print("[OK] boundary denies the escalation floor; validator-coherent (writes + read-tier); account-confined")
    return 0


if __name__ == "__main__":
    sys.exit(main())
