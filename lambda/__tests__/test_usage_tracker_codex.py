"""ADR-014: a Codex (OpenAI Responses API on bedrock-runtime) invocation-log
record flows through the same tracker path as Claude Code — normalized model,
GPT pricing, and tool="codex" on the usage row.

The fixture is the shape of a real record captured 2026-10-18 (samples acct,
ap-northeast-2, codex-cli 0.163 `amazon-bedrock-runtime` provider), with the
account id and role replaced.
"""
import json
import os
import sys
import importlib
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("USAGE_TABLE_NAME", "cc-on-bedrock-usage")

tracker = importlib.import_module("bedrock-usage-tracker")

CODEX_RECORD = {
    "schemaType": "ModelInvocationLog",
    "schemaVersion": "1.0",
    "timestamp": "2026-10-18T11:15:21Z",
    "region": "ap-northeast-2",
    "operation": "Responses",
    "modelId": "arn:aws:bedrock:ap-northeast-2:111122223333:inference-profile/global.openai.gpt-5.5",
    "identity": {"arn": "arn:aws:sts::111122223333:assumed-role/cc-on-bedrock-local-user-bob/local-bob"},
    "input": {"inputTokenCount": 11799, "cacheReadInputTokenCount": 0, "cacheWriteInputTokenCount": 0},
    "output": {"outputTokenCount": 6},
}


def test_codex_invocation_log_tracked_as_codex():
    rows = []

    def fake_update_item(**kwargs):
        rows.append(kwargs)

    with mock.patch.object(tracker, "resolve_user_from_arn", return_value=("bob@example.com", "bob", "eng")), \
            mock.patch.object(tracker.table, "update_item", side_effect=fake_update_item):
        tracker.process_invocation_log({"message": json.dumps(CODEX_RECORD)})

    user = next(r for r in rows if r["Key"]["PK"].startswith("USER#"))
    assert user["Key"] == {"PK": "USER#bob@example.com", "SK": "2026-10-18#gpt-5.5"}
    vals = user["ExpressionAttributeValues"]
    assert vals[":tool"] == "codex"
    assert vals[":inp"] == 11799 and vals[":out"] == 6
    expected = (11799 * 5.0 + 6 * 30.0) / 1e6
    assert abs(float(vals[":cost"]) - expected) < 1e-6
    assert user["ExpressionAttributeNames"]["#tool"] == "tool"
