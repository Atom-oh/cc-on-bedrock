"""ADR-016: the STS issuer names the Local role by the caller-supplied (pinned)
subdomain, not the email, and binds it to the caller's immutable Cognito sub. A
refused ensure_role (owner email/sub mismatch) issues no credentials."""
import os
import sys
import json
import importlib
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("ACCOUNT_ID", "123456789012")
os.environ.setdefault("ASSUMER_ROLE_ARN", "arn:aws:iam::123456789012:role/cc-on-bedrock-sts-issuer-role")

sts_issuer = importlib.import_module("sts-issuer")


def _invoke(payload, ensure):
    with mock.patch.object(sts_issuer, "ensure_role", ensure), \
         mock.patch.object(sts_issuer, "_assume_role_with_retry", side_effect=RuntimeError("stop after ensure_role")):
        return sts_issuer.handler({"body": json.dumps(payload)}, None)


def test_pinned_subdomain_and_sub_reach_ensure_role():
    ensure = mock.Mock(return_value={"roleArn": "arn:aws:iam::123456789012:role/x", "created": False})
    _invoke({"sub": "sub-1", "email": "new.address@x.com", "subdomain": "old-name", "department": "eng"}, ensure)
    args, kwargs = ensure.call_args
    assert args[0] == "old-name"  # pinned value, not derived from the (changed) email
    assert args[1] == "new.address@x.com"
    assert kwargs["sub"] == "sub-1"


def test_refused_ensure_role_issues_no_credentials():
    ensure = mock.Mock(side_effect=RuntimeError("subdomain collision on role: owned by another email"))
    res = _invoke({"sub": "sub-1", "email": "new@x.com", "subdomain": "old-name"}, ensure)
    assert res["statusCode"] == 500
    assert "credentials" not in json.loads(res["body"])
