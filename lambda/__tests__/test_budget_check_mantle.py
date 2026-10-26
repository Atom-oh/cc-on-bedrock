"""ADR-014 (amended 2026-10-26): Codex on bedrock-mantle is granted only to users
whose cost is unlimited (mantle is NOT metered). budget-check reconciles the
`cc-bedrock-mantle-unmetered` inline policy every run and fails safe."""
import os
import sys
import json
import importlib
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("COGNITO_USER_POOL_ID", "pool-1")

bc = importlib.import_module("budget-check")

NO_GLOBAL = {"daily": 0, "weekly": 0, "monthly": 0}


class NoSuchEntity(Exception):
    pass


class FakeIam:
    """In-memory inline policies; roles listed in `roles` exist."""

    def __init__(self, roles, policies=None):
        self.roles = set(roles)
        self.policies = dict(policies or {})  # (role, name) -> doc dict
        self.exceptions = mock.Mock(NoSuchEntityException=NoSuchEntity)
        self.puts, self.deletes = [], []

    def _role(self, name):
        if name not in self.roles:
            raise NoSuchEntity(name)

    def list_role_tags(self, RoleName):
        self._role(RoleName)
        return {"Tags": []}

    def get_role_policy(self, RoleName, PolicyName):
        self._role(RoleName)
        if (RoleName, PolicyName) not in self.policies:
            raise NoSuchEntity(PolicyName)
        return {"PolicyDocument": self.policies[(RoleName, PolicyName)]}

    def put_role_policy(self, RoleName, PolicyName, PolicyDocument):
        self._role(RoleName)
        self.policies[(RoleName, PolicyName)] = json.loads(PolicyDocument)
        self.puts.append(RoleName)

    def delete_role_policy(self, RoleName, PolicyName):
        self._role(RoleName)
        if self.policies.pop((RoleName, PolicyName), None) is None:
            raise NoSuchEntity(PolicyName)
        self.deletes.append(RoleName)

    def get_paginator(self, _):
        roles = [{"RoleName": r} for r in sorted(self.roles)]
        return mock.Mock(paginate=lambda **_: [{"Roles": roles}])


def _patched(iam, users, depts=None, **extra):
    return [
        mock.patch.object(bc, "iam_client", iam),
        mock.patch.object(bc, "MANTLE_ENABLED", True),
        mock.patch.object(bc, "ACCOUNT_ID", "123456789012"),
        mock.patch.object(bc, "_GLOBAL_BUDGETS", extra.pop("globals", NO_GLOBAL)),
        mock.patch.object(bc, "_email_subdomain_map", {e: s for e, (s, _) in users.items()}),
        mock.patch.object(bc, "_email_dept_map", {e: d for e, (_, d) in users.items()}),
        mock.patch.object(bc, "_budget_read_failed", extra.pop("read_failed", False)),
        mock.patch.object(bc, "_scan_limits_limits", lambda: extra.pop("token_limits", {})),
        mock.patch.object(bc, "list_mantle_projects", lambda: {"cc-alice": "proj_alice"}),
        mock.patch.object(bc, "_mantle_request", mock.Mock(return_value={"id": "proj_new"})),
    ]


def _reconcile(iam, users, user_budgets=None, dept_budgets=None, **extra):
    patches = _patched(iam, users, **extra)
    for p in patches:
        p.start()
    try:
        return bc.reconcile_mantle(user_budgets or {}, dept_budgets or {}), bc._mantle_request
    finally:
        for p in reversed(patches):
            p.stop()


def test_eligible_only_when_every_cap_is_unlimited():
    with mock.patch.object(bc, "_GLOBAL_BUDGETS", NO_GLOBAL):
        assert bc.mantle_eligible("a@x.com", "eng", {}, {}, {})
        assert not bc.mantle_eligible("a@x.com", "eng", {"a@x.com": {"weeklyBudget": 5}}, {}, {})
        assert not bc.mantle_eligible("a@x.com", "eng", {}, {"eng": {"perUserMonthlyBudget": 9}}, {})
        assert not bc.mantle_eligible("a@x.com", "eng", {}, {"eng": {"monthlyBudget": 100}}, {})
        assert not bc.mantle_eligible("a@x.com", "eng", {}, {}, {("USER", "a@x.com", "daily"): 1})
        assert not bc.mantle_eligible("a@x.com", "eng", {}, {}, {("DEPT", "eng", "monthly"): 1})
        # another user's / department's token limit does not count
        assert bc.mantle_eligible("a@x.com", "eng", {}, {}, {("USER", "b@x.com", "daily"): 1})
    with mock.patch.object(bc, "_GLOBAL_BUDGETS", {"daily": 50, "weekly": 0, "monthly": 0}):
        assert not bc.mantle_eligible("a@x.com", "eng", {}, {}, {})


def test_policy_scopes_inference_to_the_users_own_project():
    with mock.patch.object(bc, "ACCOUNT_ID", "123456789012"):
        doc = json.loads(bc.mantle_policy_doc("proj_alice"))
    infer, search = doc["Statement"]
    assert infer["Resource"] == "arn:aws:bedrock-mantle:us-east-1:123456789012:project/proj_alice"
    assert "bedrock-mantle:CreateInference" in infer["Action"]
    assert search["Action"] == ["bedrock-websearch:InvokeSearch", "bedrock-websearch:InvokeFetch"]


def test_grant_reuses_project_and_is_idempotent():
    alice = "cc-on-bedrock-local-user-alice"
    iam = FakeIam([alice])
    out, req = _reconcile(iam, {"alice@x.com": ("alice", "eng")})
    assert out["granted"] == 1 and iam.puts == [alice]
    assert iam.policies[(alice, bc.MANTLE_POLICY_NAME)]["Statement"][0]["Resource"].endswith("/proj_alice")
    req.assert_not_called()  # existing project reused, none created
    out, _ = _reconcile(iam, {"alice@x.com": ("alice", "eng")})
    assert out["granted"] == 0 and iam.puts == [alice]  # unchanged doc → no second put


def test_new_user_gets_a_tagged_project():
    bob = "cc-on-bedrock-local-user-bob"
    iam = FakeIam([bob])
    _, req = _reconcile(iam, {"bob@x.com": ("bob", "eng")})
    method, path, body = req.call_args.args
    assert (method, path) == ("POST", "/v1/organization/projects")
    assert body["name"] == "cc-bob" and body["tags"]["cc-on-bedrock:user"] == "bob@x.com"
    assert iam.policies[(bob, bc.MANTLE_POLICY_NAME)]["Statement"][0]["Resource"].endswith("/proj_new")


def test_no_local_role_means_no_project_and_no_grant():
    iam = FakeIam([])
    out, req = _reconcile(iam, {"bob@x.com": ("bob", "eng")})
    assert out["granted"] == 0
    req.assert_not_called()


def test_cap_appearing_revokes_the_grant():
    alice = "cc-on-bedrock-local-user-alice"
    iam = FakeIam([alice], {(alice, bc.MANTLE_POLICY_NAME): {"Statement": []}})
    out, _ = _reconcile(iam, {"alice@x.com": ("alice", "eng")},
                        user_budgets={"alice@x.com": {"dailyBudget": 1}})
    assert out["revoked"] == 1 and (alice, bc.MANTLE_POLICY_NAME) not in iam.policies


def test_read_failure_revokes_everything():
    alice = "cc-on-bedrock-local-user-alice"
    other = "cc-on-bedrock-local-user-zed"
    iam = FakeIam([alice, other, "unrelated-role"], {
        (alice, bc.MANTLE_POLICY_NAME): {}, (other, bc.MANTLE_POLICY_NAME): {}})
    out, _ = _reconcile(iam, {"alice@x.com": ("alice", "eng")}, read_failed=True)
    assert out["failsafe"] and out["revoked"] == 2 and not iam.puts


def test_empty_cognito_map_fails_safe():
    alice = "cc-on-bedrock-local-user-alice"
    iam = FakeIam([alice], {(alice, bc.MANTLE_POLICY_NAME): {}})
    out, _ = _reconcile(iam, {})
    assert out["failsafe"] and out["revoked"] == 1


def test_disabled_makes_no_calls():
    with mock.patch.object(bc, "MANTLE_ENABLED", False), mock.patch.object(bc, "iam_client", None):
        assert bc.reconcile_mantle({}, {}) == {"enabled": False}


def test_budget_reader_failure_sets_the_flag():
    tbl = mock.Mock()
    tbl.scan.side_effect = RuntimeError("boom")
    with mock.patch.object(bc, "user_budgets_table", tbl), mock.patch.object(bc, "_budget_read_failed", False):
        assert bc.get_user_budgets() == {}
        assert bc._budget_read_failed is True


def test_every_deny_also_blocks_mantle_and_web_search():
    captured = []
    iam = mock.Mock()
    iam.put_role_policy.side_effect = lambda **kw: captured.append(json.loads(kw["PolicyDocument"]))
    with mock.patch.object(bc, "iam_client", iam), \
            mock.patch.object(bc, "_email_subdomain_map", {"a@x.com": "a"}):
        bc.attach_deny_policy("a@x.com")
        bc.attach_dept_deny_policy("a@x.com")
        bc._attach_local_token_deny("cc-on-bedrock-local-user-a", "t")
    assert captured
    for doc in captured:
        actions = doc["Statement"][0]["Action"]
        assert "bedrock-mantle:*" in actions and "bedrock-websearch:*" in actions


def test_cap_rows_match_despite_case_legacy_key_or_other_dept():
    with mock.patch.object(bc, "_GLOBAL_BUDGETS", NO_GLOBAL):
        # mixed-case budget key
        assert not bc.mantle_eligible("a@x.com", "eng", {"A@X.com": {"dailyBudget": 5}}, {}, {})
        # legacy subdomain-keyed row
        assert not bc.mantle_eligible("a@x.com", "eng", {"alice": {"monthlyBudget": 5}}, {}, {},
                                      aliases=("alice",))
        # department recorded on the budget row differs from Cognito's
        assert not bc.mantle_eligible("a@x.com", "eng", {"a@x.com": {"department": "ops"}},
                                      {"ops": {"monthlyBudget": 10}}, {})
        # token limit keyed with different case
        assert not bc.mantle_eligible("a@x.com", "eng", {}, {}, {("USER", "A@x.com", "daily"): 1})


def test_deprovisioned_users_role_loses_its_grant():
    alice = "cc-on-bedrock-local-user-alice"
    gone = "cc-on-bedrock-local-user-gone"
    iam = FakeIam([alice, gone], {(gone, bc.MANTLE_POLICY_NAME): {}})
    out, _ = _reconcile(iam, {"alice@x.com": ("alice", "eng")})
    assert (gone, bc.MANTLE_POLICY_NAME) not in iam.policies and out["revoked"] == 1
    assert (alice, bc.MANTLE_POLICY_NAME) in iam.policies


def test_shared_subdomain_is_never_granted():
    shared = "cc-on-bedrock-local-user-sam"
    iam = FakeIam([shared])
    out, _ = _reconcile(iam, {"sam@x.com": ("sam", "eng"), "sam@y.com": ("sam", "eng")})
    assert out["granted"] == 0 and not iam.puts


def test_truncated_scans_fail_safe():
    tbl = mock.Mock()
    tbl.scan.return_value = {"Items": [], "LastEvaluatedKey": {"k": 1}}
    with mock.patch.object(bc, "user_budgets_table", tbl), mock.patch.object(bc, "MAX_SCAN_PAGES", 2), \
            mock.patch.object(bc, "_budget_read_failed", False):
        bc.get_user_budgets()
        assert bc._budget_read_failed is True
    with mock.patch.object(bc, "limits_table", tbl), mock.patch.object(bc, "MAX_SCAN_PAGES", 2), \
            mock.patch.object(bc, "_budget_read_failed", False):
        bc._scan_limits_limits()
        assert bc._budget_read_failed is True


def test_case_colliding_rows_are_all_checked():
    with mock.patch.object(bc, "_GLOBAL_BUDGETS", NO_GLOBAL):
        users = {"a@x.com": {}, "A@x.com": {"dailyBudget": 5}}
        assert not bc.mantle_eligible("a@x.com", "eng", users, {}, {})
        users = {"A@x.com": {"dailyBudget": 5}, "a@x.com": {}}
        assert not bc.mantle_eligible("a@x.com", "eng", users, {}, {})
        depts = {"eng": {}, "ENG": {"monthlyBudget": 9}}
        assert not bc.mantle_eligible("a@x.com", "eng", {}, depts, {})
