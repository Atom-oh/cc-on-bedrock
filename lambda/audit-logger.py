"""
Prompt Audit Logger Lambda
Triggered by: EventBridge rule (CloudTrail Bedrock inference events)

Stores one audit record per Bedrock inference call in DynamoDB (cc-prompt-audit):
- user_id (subdomain), timestamp (`{eventTime}#{eventID}` — unique, sortable),
  mode (ec2|local), client_tool (claude-code|codex|other), api, model_id,
  user_agent, source_ip
- Prompt content is NOT stored (privacy). Token counts come from the usage table
  (invocation logs, ADR-005); CloudTrail carries no usage for these calls.

ADR-014: Codex on bedrock-runtime emits a `Responses` event (with modelId) plus a
shadow `InvokeModelWithResponseStream` event whose requestParameters is null.
The shadow is skipped so each Codex turn is audited once. Error events are always
recorded, and non-platform principals are recorded with mode='other' (account-wide audit).
"""
import os
from datetime import datetime

import boto3

REGION = os.environ.get('REGION', 'ap-northeast-2')
AUDIT_TABLE = os.environ.get('AUDIT_TABLE', 'cc-prompt-audit')

INFERENCE_EVENTS = (
    'InvokeModel', 'InvokeModelWithResponseStream',
    'Converse', 'ConverseStream',
    'Responses',  # OpenAI Responses API on bedrock-runtime (Codex, ADR-014)
)
ROLE_PREFIXES = (
    (os.environ.get('TASK_ROLE_PREFIX', 'cc-on-bedrock-task-'), 'ec2'),
    (os.environ.get('LOCAL_ROLE_PREFIX', 'cc-on-bedrock-local-user-'), 'local'),
)

dynamodb = boto3.resource('dynamodb', region_name=REGION)
table = dynamodb.Table(AUDIT_TABLE)


def client_tool(user_agent: str, model_id: str) -> str:
    """Which CLI made the call. CloudTrail userAgent is authoritative
    (`claude-cli/…`, `codex_exec/…`, `codex_cli_rs/…`); fall back to the model
    vendor when the agent string is absent or unrecognized."""
    ua = (user_agent or '').lower()
    if 'codex' in ua:
        return 'codex'
    if 'claude-cli' in ua or 'claude-code' in ua:
        return 'claude-code'
    m = (model_id or '').lower()
    if 'openai' in m or 'gpt' in m:
        return 'codex'
    if 'anthropic' in m or 'claude' in m:
        return 'claude-code'
    return 'other'


def user_from_role(role_name: str):
    """(subdomain, mode) from a platform role name, or (None, None)."""
    for prefix, mode in ROLE_PREFIXES:
        if role_name.startswith(prefix):
            return role_name[len(prefix):], mode
    return None, None


def handler(event, context):
    """Process CloudTrail Bedrock inference events."""
    detail = event.get('detail', {}) or {}

    event_name = detail.get('eventName', '')
    if event_name not in INFERENCE_EVENTS:
        return {'statusCode': 200, 'body': 'Skipped: not a Bedrock invocation'}

    request_params = detail.get('requestParameters')
    error_code = detail.get('errorCode') or ''
    if (not isinstance(request_params, dict) or not request_params) and not error_code:
        # Only the Responses API's shadow stream event (no params, no error) is skipped —
        # error events are always audited (e.g. AccessDenied from a budget deny).
        return {'statusCode': 200, 'body': f'Skipped: shadow {event_name} without requestParameters'}
    request_params = request_params if isinstance(request_params, dict) else {}

    identity = detail.get('userIdentity') or {}
    issuer = (identity.get('sessionContext') or {}).get('sessionIssuer') or {}
    user_id, mode = user_from_role(issuer.get('userName') or '')
    if user_id is None:
        # Non-platform principal (admin, CI, other workloads): still audited, keyed by ARN.
        user_id, mode = (issuer.get('arn') or identity.get('arn') or 'unknown'), 'other'

    model_id = request_params.get('modelId', 'unknown')
    user_agent = detail.get('userAgent', '') or ''
    event_time = detail.get('eventTime') or datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    event_id = detail.get('eventID', '')

    audit_record = {
        'user_id': user_id,
        # eventID suffix: two calls in the same second must not overwrite each other.
        'timestamp': f"{event_time}#{event_id}",
        'event_time': event_time,
        'event_id': event_id,
        'event_name': event_name,
        'mode': mode,
        'client_tool': client_tool(user_agent, model_id),
        'model_id': model_id,
        'user_agent': user_agent[:256],
        'source_ip': detail.get('sourceIPAddress', ''),
        'aws_region': detail.get('awsRegion', ''),
    }
    if error_code:
        audit_record['error_code'] = error_code
    inference_region = (detail.get('additionalEventData') or {}).get('inferenceRegion')
    if inference_region:
        audit_record['inference_region'] = inference_region

    try:
        table.put_item(Item=audit_record)
        print(f"Audit logged: user={user_id} mode={mode} tool={audit_record['client_tool']} "
              f"api={event_name} model={model_id}")
    except Exception as e:
        print(f"Error writing audit record: {e}")
        raise

    return {'statusCode': 200, 'body': f'Audit logged for {user_id}'}
