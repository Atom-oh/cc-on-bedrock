"""Cognito user pool trigger shim → user-role-provisioner (ADR-027).

Wired as POST_CONFIRMATION + POST_AUTHENTICATION on the user pool. Covers the
gap in ADR-022: federated (SAML/OIDC) JIT-created users emit no AdminCreateUser
/ SignUp CloudTrail event, so the EventBridge path never fires for them.
PostConfirmation catches the JIT-creation moment (PostConfirmation_ConfirmSignUp);
PostAuthentication is the every-login backstop that self-heals any user the
EventBridge path missed.

Constraints (Cognito invokes triggers synchronously, 5s hard timeout, and a
trigger error FAILS the user's login):
  - fast no-op path: if custom:subdomain is already set, return immediately
  - async invoke (InvocationType=Event) — never wait on the provisioner
  - fail-open: any exception is logged and swallowed; the event is always
    returned so the login proceeds
"""
import json
import os

import boto3
from botocore.config import Config

PROVISIONER_FUNCTION_NAME = os.environ.get(
    "PROVISIONER_FUNCTION_NAME", "cc-on-bedrock-user-role-provisioner"
)

# Tight client budget: Cognito gives the whole trigger 5 seconds. No retries —
# the PostAuthentication backstop fires again on the next login anyway.
_lambda = boto3.client(
    "lambda",
    config=Config(connect_timeout=2, read_timeout=3, retries={"max_attempts": 0}),
)


def handler(event, context):
    try:
        attrs = (event.get("request") or {}).get("userAttributes") or {}

        # Fast path: already provisioned (ADR-022 EventBridge path or a previous
        # trigger invocation). Zero added latency for the common case.
        if attrs.get("custom:subdomain"):
            return event

        sub = attrs.get("sub")
        if not sub:
            # event.userName is the provider-prefixed alias for federated users,
            # not the Cognito sub — without sub there is nothing to ensure.
            print(f"WARN no sub in userAttributes, skipping (triggerSource={event.get('triggerSource')})")
            return event

        # ADR-022 §6 direct-invoke contract; async so the login never waits.
        _lambda.invoke(
            FunctionName=PROVISIONER_FUNCTION_NAME,
            InvocationType="Event",
            Payload=json.dumps({"action": "ensure", "sub": sub}).encode(),
        )
        print(f"invoked provisioner ensure sub={sub} triggerSource={event.get('triggerSource')}")
    except Exception as e:  # noqa: BLE001 — fail-open: never block a login
        print(f"WARN provisioner invoke failed (fail-open): {e}")
    return event
