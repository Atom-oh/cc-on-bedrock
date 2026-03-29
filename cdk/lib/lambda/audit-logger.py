"""
Prompt Audit Logger Lambda
Triggered by: EventBridge rule (CloudTrail Bedrock InvokeModel events)

Stores audit records in DynamoDB:
- user_id, timestamp, model_id, input_tokens, output_tokens, prompt_hash
- Prompt content is NOT stored (privacy) - only hash for dedup
"""
import boto3
import json
import os
import hashlib
from datetime import datetime

REGION = os.environ.get('REGION', 'ap-northeast-2')
AUDIT_TABLE = os.environ.get('AUDIT_TABLE', 'cc-prompt-audit')

dynamodb = boto3.resource('dynamodb', region_name=REGION)
table = dynamodb.Table(AUDIT_TABLE)


def handler(event, context):
    """Process CloudTrail Bedrock InvokeModel events."""
    records = event.get('detail', {})

    # CloudTrail event structure
    event_name = records.get('eventName', '')
    if event_name not in ('InvokeModel', 'InvokeModelWithResponseStream', 'Converse', 'ConverseStream'):
        return {'statusCode': 200, 'body': 'Skipped: not a Bedrock invocation'}

    user_identity = records.get('userIdentity', {})
    request_params = records.get('requestParameters', {})
    response_elements = records.get('responseElements', {})

    # Extract user info from assumed role ARN
    # Format: arn:aws:sts::123456:assumed-role/cc-on-bedrock-task-{subdomain}/...
    session_context = user_identity.get('sessionContext', {})
    session_issuer = session_context.get('sessionIssuer', {})
    role_arn = session_issuer.get('arn', '')

    user_id = 'unknown'
    if 'cc-on-bedrock-task-' in role_arn:
        user_id = role_arn.split('cc-on-bedrock-task-')[-1].split('/')[0]

    # Extract model info
    model_id = request_params.get('modelId', 'unknown')

    # Extract token usage (varies by API)
    usage = response_elements.get('usage', {})
    input_tokens = usage.get('inputTokens', 0)
    output_tokens = usage.get('outputTokens', 0)

    # Create audit record
    timestamp = records.get('eventTime', datetime.utcnow().isoformat())
    event_id = records.get('eventID', '')

    audit_record = {
        'user_id': user_id,
        'timestamp': timestamp,
        'event_id': event_id,
        'model_id': model_id,
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'total_tokens': input_tokens + output_tokens,
        'event_name': event_name,
        'source_ip': records.get('sourceIPAddress', ''),
    }

    try:
        table.put_item(Item=audit_record)
        print(f"Audit logged: user={user_id} model={model_id} tokens={input_tokens}+{output_tokens}")
    except Exception as e:
        print(f"Error writing audit record: {e}")
        raise

    return {'statusCode': 200, 'body': f'Audit logged for {user_id}'}
