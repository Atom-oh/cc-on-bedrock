"""T1 (ADR-029 B′): usage tracker keys rows by USER#{email.lower()}, never sub.

The canonical key is the (lowercased) email. subdomain is a row attribute used
downstream for IAM role names. Cognito sub is eliminated: no sub resolution,
no _sub_cache, no sub in the row.
"""
import os
import sys
import importlib
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("USAGE_TABLE_NAME", "cc-on-bedrock-usage")
os.environ.setdefault("COGNITO_USER_POOL_ID", "pool-1")

tracker = importlib.import_module("bedrock-usage-tracker")


def _reset_caches():
    tracker._task_cache.clear()
    tracker._dept_cache.clear()
    if hasattr(tracker, "_email_cache"):
        tracker._email_cache.clear()
    tracker._sd_email_map = None


def test_sub_resolution_removed():
    # Cognito sub is eliminated — the broken custom:subdomain filter resolver
    # and its cache must be gone.
    assert not hasattr(tracker, "_resolve_sub_from_subdomain")
    assert not hasattr(tracker, "_sub_cache")


def test_upsert_usage_keys_by_lowercased_email():
    _reset_caches()
    captured = {}

    def fake_update_item(**kwargs):
        # capture the user row (first call), ignore the DEPT# aggregate
        key = kwargs.get("Key", {})
        if key.get("PK", "").startswith("USER#"):
            captured["key"] = key
            captured["values"] = kwargs.get("ExpressionAttributeValues", {})

    with mock.patch.object(tracker.table, "update_item", side_effect=fake_update_item):
        tracker.upsert_usage(
            "Alice@Example.COM", "alice", "eng", "2026-06-12", "claude-opus-4-8",
            100, 50, 0.01,
        )

    assert captured["key"]["PK"] == "USER#alice@example.com"
    assert captured["values"][":subdomain"] == "alice"


def test_resolve_ec2_path_returns_email():
    _reset_caches()
    arn = "arn:aws:sts::123:assumed-role/cc-on-bedrock-task-alice/sess"
    # dept lookup + email lookup both go through ec2 describe-instances tags
    ec2 = mock.Mock()
    ec2.describe_instances.return_value = {
        "Reservations": [{"Instances": [{"Tags": [
            {"Key": "subdomain", "Value": "alice"},
            {"Key": "department", "Value": "eng"},
            {"Key": "cc:user", "Value": "alice@example.com"},
        ]}]}]
    }
    with mock.patch.object(tracker, "ec2_client", ec2):
        email, subdomain, dept = tracker.resolve_user_from_arn(arn)
    assert email == "alice@example.com"
    assert subdomain == "alice"
    assert dept == "eng"


def test_resolve_local_path_reads_email_tag():
    _reset_caches()
    arn = "arn:aws:sts::123:assumed-role/cc-on-bedrock-local-user-bob/sess"
    iam = mock.Mock()
    iam.get_role.return_value = {"Role": {"Tags": [
        {"Key": "email", "Value": "bob@example.com"},
        {"Key": "subdomain", "Value": "bob"},
        {"Key": "department", "Value": "sales"},
    ]}}
    with mock.patch("boto3.client", return_value=iam):
        email, subdomain, dept = tracker.resolve_user_from_arn(arn)
    assert email == "bob@example.com"
    assert subdomain == "bob"
    assert dept == "sales"


def test_resolve_ec2_no_email_skips():
    _reset_caches()
    arn = "arn:aws:sts::123:assumed-role/cc-on-bedrock-task-ghost/sess"
    ec2 = mock.Mock()
    ec2.describe_instances.return_value = {"Reservations": []}
    cog = mock.Mock()
    cog.list_users.return_value = {"Users": []}
    with mock.patch.object(tracker, "ec2_client", ec2), \
         mock.patch.object(tracker, "cognito_client", cog):
        email, subdomain, dept = tracker.resolve_user_from_arn(arn)
    # no email resolvable → email None so caller skips the record (no bad key)
    assert email is None
