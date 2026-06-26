"""P1-T6: the otel-metrics-rollup Lambda role must allow dynamodb:TransactWriteItems
(the handler writes per-user rows via TransactWriteItems — without it the function
AccessDenies at runtime). Also asserts the rollup package bundles both source files.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2] / "terraform" / "modules" / "usage-tracking"


def _main():
    return (ROOT / "main.tf").read_text(encoding="utf-8")


def test_rollup_role_allows_transact_write_items():
    assert "dynamodb:TransactWriteItems" in _main()


def test_rollup_package_includes_both_sources():
    m = _main()
    assert "otel-metrics-rollup.py" in m and "otel_rollup.py" in m


def test_rollup_lambda_knows_usage_table():
    assert "USAGE_TABLE_NAME" in _main()
