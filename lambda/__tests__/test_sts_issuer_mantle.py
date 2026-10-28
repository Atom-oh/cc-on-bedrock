"""ADR-014: the credentials response reports the mantle grant (the inline policy
budget-check maintains) so the CLI can write / remove `codex -p mantle`."""
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


def _doc(project_arn):
    return {"Statement": [
        {"Effect": "Allow", "Action": ["bedrock-mantle:CreateInference"], "Resource": project_arn},
        {"Effect": "Allow", "Action": ["bedrock-websearch:InvokeSearch"], "Resource": "*"},
    ]}


def test_grant_present_reports_project_and_unmetered():
    iam = mock.Mock()
    iam.get_role_policy.return_value = {"PolicyDocument": _doc(
        "arn:aws:bedrock-mantle:us-east-1:123456789012:project/proj_bob")}
    with mock.patch.object(sts_issuer, "iam", iam):
        m = sts_issuer._mantle_status("cc-on-bedrock-local-user-bob")
    assert m == {"enabled": True, "projectId": "proj_bob", "region": "us-east-1",
                 "model": sts_issuer.MANTLE_MODEL_ID, "metered": False}
    assert iam.get_role_policy.call_args.kwargs["PolicyName"] == "cc-bedrock-mantle-unmetered"


def test_url_encoded_document_is_parsed():
    from urllib.parse import quote
    iam = mock.Mock()
    iam.get_role_policy.return_value = {"PolicyDocument": quote(json.dumps(_doc(
        "arn:aws:bedrock-mantle:us-east-1:123456789012:project/proj_x")))}
    with mock.patch.object(sts_issuer, "iam", iam):
        assert sts_issuer._mantle_status("r")["projectId"] == "proj_x"


def test_no_grant_or_error_reports_disabled():
    iam = mock.Mock()
    iam.get_role_policy.side_effect = RuntimeError("NoSuchEntity")
    with mock.patch.object(sts_issuer, "iam", iam):
        assert sts_issuer._mantle_status("r") == {"enabled": False}
