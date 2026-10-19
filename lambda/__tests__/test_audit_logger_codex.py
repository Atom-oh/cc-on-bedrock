"""ADR-014 audit: Codex `Responses` events are audited once (shadow stream
event skipped), attributed to the CLI from CloudTrail userAgent, and Local
Mode roles resolve to their subdomain (previously recorded as "unknown")."""
import os
import sys
import importlib
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")

audit = importlib.import_module("audit-logger")


def _event(name, params, role="cc-on-bedrock-local-user-bob",
           ua="codex_exec/0.163.0 (Amazon Linux AMI 2023.0.0; aarch64)", eid="e-1"):
    return {"detail": {
        "eventName": name,
        "eventTime": "2026-10-18T11:15:21Z",
        "eventID": eid,
        "userAgent": ua,
        "requestParameters": params,
        "additionalEventData": {"stream": True, "inferenceRegion": "us-east-1"},
        "awsRegion": "ap-northeast-2",
        "userIdentity": {"sessionContext": {"sessionIssuer": {"userName": role}}},
    }}


def _run(ev):
    with mock.patch.object(audit.table, "put_item") as put:
        audit.handler(ev, None)
    return [c.kwargs["Item"] for c in put.call_args_list]


def test_codex_responses_event_audited_with_tool_and_mode():
    items = _run(_event("Responses", {"modelId": "global.openai.gpt-6.1-sol"}))
    assert len(items) == 1
    it = items[0]
    assert it["user_id"] == "bob" and it["mode"] == "local"
    assert it["client_tool"] == "codex" and it["event_name"] == "Responses"
    assert it["timestamp"] == "2026-10-18T11:15:21Z#e-1"
    assert it["inference_region"] == "us-east-1"


def test_shadow_stream_event_without_params_is_skipped():
    assert _run(_event("InvokeModelWithResponseStream", None)) == []


def test_claude_code_ec2_event():
    items = _run(_event("ConverseStream", {"modelId": "global.anthropic.claude-opus-4-8"},
                        role="cc-on-bedrock-task-alice", ua="claude-cli/2.1.302 (external, sdk-cli)"))
    assert items[0]["user_id"] == "alice" and items[0]["mode"] == "ec2"
    assert items[0]["client_tool"] == "claude-code"


def test_non_platform_role_recorded_as_other():
    ev = _event("Responses", {"modelId": "x"}, role="some-admin")
    ev["detail"]["userIdentity"]["sessionContext"]["sessionIssuer"]["arn"] = "arn:aws:iam::1:role/some-admin"
    items = _run(ev)
    assert len(items) == 1 and items[0]["mode"] == "other"
    assert items[0]["user_id"] == "arn:aws:iam::1:role/some-admin"


def test_error_event_without_params_is_audited():
    ev = _event("InvokeModel", None)
    ev["detail"]["errorCode"] = "AccessDenied"
    items = _run(ev)
    assert len(items) == 1 and items[0]["error_code"] == "AccessDenied"
    assert items[0]["model_id"] == "unknown"


def test_tool_falls_back_to_model_vendor():
    assert audit.client_tool("", "global.openai.gpt-6-luna") == "codex"
    assert audit.client_tool("aws-sdk-go/1.0", "global.anthropic.claude-sonnet-5") == "claude-code"
    assert audit.client_tool("", "amazon.titan-embed-text-v2:0") == "other"


def test_null_user_name_does_not_crash():
    ev = _event("Responses", {"modelId": "global.openai.gpt-6.1-sol"})
    ev["detail"]["userIdentity"]["sessionContext"]["sessionIssuer"]["userName"] = None
    items = _run(ev)
    assert items[0]["mode"] == "other"


def test_non_shadow_event_without_params_still_audited():
    items = _run(_event("Converse", {}))
    assert len(items) == 1 and items[0]["model_id"] == "unknown"


def test_bare_prefix_role_is_not_platform():
    assert audit.user_from_role("cc-on-bedrock-task-") == (None, None)
