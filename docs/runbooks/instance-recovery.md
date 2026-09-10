# Runbook: EC2 DevEnv Instance Recovery

## Symptoms
- User reports "Environment not starting" or stuck provisioning
- Dashboard shows instance in `stopped`/`terminated` state but user expects it running
- CWAgent metrics missing for a specific instance

## Diagnosis

### 1. Check instance state
```bash
SUBDOMAIN="<user-subdomain>"
aws ec2 describe-instances \
  --filters "Name=tag:subdomain,Values=$SUBDOMAIN" "Name=tag:managed_by,Values=cc-on-bedrock" \
  --query 'Reservations[].Instances[].{Id:InstanceId,State:State.Name,LaunchTime:LaunchTime}' \
  --region ap-northeast-2 --output table
```

### 2. Check cloud-init logs (if instance is running)
```bash
INSTANCE_ID="<instance-id>"
aws ssm send-command --instance-ids $INSTANCE_ID \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["tail -50 /var/log/cloud-init-output.log"]' \
  --region ap-northeast-2
```

### 3. Check DynamoDB routing entry
```bash
aws dynamodb get-item --table-name cc-routing-table \
  --key '{"subdomain":{"S":"<subdomain>"}}' \
  --region ap-northeast-2
```

## Resolution

### Instance stuck in stopping
```bash
aws ec2 stop-instances --instance-ids $INSTANCE_ID --force --region ap-northeast-2
```

### Instance terminated unexpectedly
User can recreate via dashboard `/user` page. Old EBS data is lost unless snapshot exists.

### CWAgent not reporting
```bash
aws ssm send-command --instance-ids $INSTANCE_ID \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["amazon-cloudwatch-agent-ctl -a status","tail -10 /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log"]' \
  --region ap-northeast-2
```
Common cause: IAM role missing `cloudwatch:PutMetricData`. Fix: stop and start the instance (triggers IAM policy upsert).

### Routing table stale entry
```bash
aws dynamodb delete-item --table-name cc-routing-table \
  --key '{"subdomain":{"S":"<subdomain>"}}' \
  --region ap-northeast-2
```
Then restart instance from dashboard.

### Stale OTLP/gRPC telemetry config after the HTTP/4318 migration (PR #100)
`otelEnvUserData()` (`shared/nextjs-app/src/lib/ec2-clients.ts`) only writes
`/etc/environment` at first boot. Any instance already running before this migration
still has the old `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` + a `:4317` endpoint baked in, and
won't pick up the new HTTP/4318 config on a simple stop/start (UserData doesn't re-run).
Symptom: no telemetry/events reach the collector for pre-existing instances even though
new instances work.

Patch the running instance in place via SSM (no data loss, no relaunch required):
```bash
INSTANCE_ID="<instance-id>"
NEW_ENDPOINT="http://<otel-nlb-dns>:4318"   # from: terraform output -json | jq -r .otel_collector_endpoint (or the module's otel_collector_endpoint output), prefixed with http://

aws ssm send-command --instance-ids $INSTANCE_ID \
  --document-name AWS-RunShellScript \
  --parameters "commands=[
    \"sed -i 's|^OTEL_EXPORTER_OTLP_PROTOCOL=.*|OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf|' /etc/environment\",
    \"sed -i 's|^OTEL_EXPORTER_OTLP_ENDPOINT=.*|OTEL_EXPORTER_OTLP_ENDPOINT=${NEW_ENDPOINT}|' /etc/environment\",
    \"pkill -u coder -f 'claude' || true\"
  ]" \
  --region ap-northeast-2
```
The `claude` CLI reads `/etc/environment` at process start (login shell), so a fresh
`claude` invocation after this picks up the new values — no reboot needed. Verify with
`cat /etc/environment | grep OTEL_EXPORTER_OTLP` over SSM.

To bulk-migrate every existing devenv instead of doing it one at a time:
```bash
aws ec2 describe-instances \
  --filters "Name=tag:managed_by,Values=cc-on-bedrock" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --region ap-northeast-2 --output text \
  | tr '\t' '\n' | while read -r id; do
    aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
      --parameters "commands=[...]" --region ap-northeast-2
  done
```

## Escalation
If none of the above resolves the issue, check ECS dashboard service logs:
```bash
aws logs tail /cc-on-bedrock/dashboard --since 30m --region ap-northeast-2
```
