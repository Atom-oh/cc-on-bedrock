import importlib.util
import os
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path


REPO = Path(__file__).resolve().parents[3]
LAMBDA = REPO / "lambda/ec2-idle-stop.py"


class FakeDynamoResource:
    def __init__(self, tables):
        self.tables = tables

    def Table(self, name):
        return self.tables[name]


class FakeInstanceTable:
    def __init__(self, item=None):
        self.item = item or {}

    def get_item(self, **kwargs):
        return {"Item": self.item} if self.item else {}


class FailingInstanceTable:
    def get_item(self, **kwargs):
        raise RuntimeError("instance lookup unavailable")


class FakeUsageTable:
    def __init__(self, active_keys=(), rows_by_key=None):
        self.active_keys = set(active_keys)
        self.rows_by_key = rows_by_key or {}
        self.queries = []

    def query(self, **kwargs):
        key = kwargs["ExpressionAttributeValues"][":pk"]
        values = kwargs["ExpressionAttributeValues"]
        self.queries.append(kwargs)
        if key in self.active_keys:
            return {"Items": [{}]}

        items = [
            item
            for item in self.rows_by_key.get(key, [])
            if item["SK"].startswith(values[":date"])
        ]
        if "Limit" in kwargs:
            items = items[: kwargs["Limit"]]
        if kwargs.get("FilterExpression") == "updatedAt >= :cutoff":
            items = [item for item in items if item["updatedAt"] >= values[":cutoff"]]
        return {"Items": items}


def _load_module(fake_dynamodb=None):
    if fake_dynamodb is None:
        fake_dynamodb = FakeDynamoResource({
            "cc-user-instances": FakeInstanceTable(),
            "cc-on-bedrock-usage": FakeUsageTable(),
        })
    boto3_stub = types.ModuleType("boto3")
    boto3_stub.client = lambda *a, **k: types.SimpleNamespace()
    boto3_stub.resource = lambda *a, **k: fake_dynamodb
    sys.modules["boto3"] = boto3_stub

    sys.modules.setdefault("botocore", types.ModuleType("botocore"))
    botocore_exc = types.ModuleType("botocore.exceptions")
    botocore_exc.ClientError = type("ClientError", (Exception,), {})
    sys.modules["botocore.exceptions"] = botocore_exc

    os.environ.setdefault("REGION", "ap-northeast-2")
    spec = importlib.util.spec_from_file_location("ec2_idle_stop", LAMBDA)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_recent_token_usage_uses_email_key_from_instance_record():
    usage = FakeUsageTable(active_keys={"USER#atomoh@example.com"})
    instances = FakeInstanceTable({"user_id": "atomoh", "username": "atomoh@example.com"})
    fake_dynamodb = FakeDynamoResource({
        "cc-user-instances": instances,
        "cc-on-bedrock-usage": usage,
    })
    module = _load_module(fake_dynamodb)

    assert module.has_recent_token_usage("atomoh") is True
    assert usage.queries[0]["ExpressionAttributeValues"][":pk"] == "USER#atomoh@example.com"


def test_recent_token_usage_checks_all_rows_after_updated_at_filter():
    date_prefixes = [
        (datetime.utcnow() + timedelta(days=offset)).date().isoformat()
        for offset in (-1, 0, 1)
    ]
    old_ts = "2000-01-01T00:00:00"
    recent_ts = "2999-01-01T00:00:00"
    usage = FakeUsageTable(rows_by_key={
        "USER#atomoh@example.com": [
            row
            for date_prefix in date_prefixes
            for row in (
                {"SK": f"{date_prefix}#anthropic.claude-3", "updatedAt": old_ts},
                {"SK": f"{date_prefix}#us.anthropic.claude-opus-4-1", "updatedAt": recent_ts},
            )
        ],
    })
    instances = FakeInstanceTable({"user_id": "atomoh", "username": "atomoh@example.com"})
    fake_dynamodb = FakeDynamoResource({
        "cc-user-instances": instances,
        "cc-on-bedrock-usage": usage,
    })
    module = _load_module(fake_dynamodb)

    assert module.has_recent_token_usage("atomoh") is True
    assert all("Limit" not in query for query in usage.queries)


def test_recent_token_usage_fails_closed_when_instance_mapping_unavailable():
    usage = FakeUsageTable()
    fake_dynamodb = FakeDynamoResource({
        "cc-user-instances": FailingInstanceTable(),
        "cc-on-bedrock-usage": usage,
    })
    module = _load_module(fake_dynamodb)

    assert module.has_recent_token_usage("atomoh") is True


def test_check_idle_returns_skip_reasons_for_diagnostics():
    module = _load_module()
    module.get_running_instances = lambda: [{
        "InstanceId": "i-123",
        "LaunchTime": datetime(2026, 6, 25, 0, 0, tzinfo=timezone.utc),
        "Tags": [{"Key": "subdomain", "Value": "atomoh"}],
    }]
    module.is_keep_alive_active = lambda subdomain: False
    module.get_idle_minutes = lambda instance_id, subdomain: 0

    result = module.check_idle()

    assert result["body"]["checked"] == 1
    assert result["body"]["skipped"] == [
        {"instanceId": "i-123", "subdomain": "atomoh", "reason": "active", "idle_minutes": 0}
    ]
