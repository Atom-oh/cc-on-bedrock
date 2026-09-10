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

`ec2-clients.ts`'s UserData already creates a `code-server.service.d/env.conf` drop-in
(`EnvironmentFile=-/etc/environment`), so on instances that have it, editing the file and
restarting the service **does** pick up new values — no reboot required. The catch: two
things must both be true, and neither is guaranteed on an old instance:
1. The drop-in must exist — only instances launched after the UserData that creates it
   have one. Older instances have no drop-in at all, so editing `/etc/environment` alone
   is a silent no-op for them.
2. `sed`'s `s|^KEY=.*|...|` pattern only replaces an *existing* line — on an instance from
   before the OTel env vars existed at all, there's no line to replace and the edit does
   nothing (same failure mode as #1, different cause).

Patch idempotently — create the drop-in if missing, upsert each var with the same
`grep -q ... && sed || echo` pattern `ec2-clients.ts:181` already uses for
`SECURITY_POLICY` — then restart the service (no data loss, no instance reboot needed):
```bash
INSTANCE_ID="<instance-id>"
NEW_ENDPOINT="http://<otel-nlb-dns>:4318"   # from: terraform output -raw otel_rollup_collector_endpoint, prefixed with http:// (NOT otel_collector_endpoint -- that's the unrelated legacy ecs-devenv collector)

aws ssm send-command --instance-ids $INSTANCE_ID \
  --document-name AWS-RunShellScript \
  --parameters "commands=[
    \"mkdir -p /etc/systemd/system/code-server.service.d\",
    \"printf '[Service]\\nEnvironmentFile=-/etc/environment\\n' > /etc/systemd/system/code-server.service.d/env.conf\",
    \"systemctl daemon-reload\",
    \"grep -q '^OTEL_EXPORTER_OTLP_PROTOCOL=' /etc/environment && sed -i 's|^OTEL_EXPORTER_OTLP_PROTOCOL=.*|OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf|' /etc/environment || echo 'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf' >> /etc/environment\",
    \"grep -q '^OTEL_EXPORTER_OTLP_ENDPOINT=' /etc/environment && sed -i 's|^OTEL_EXPORTER_OTLP_ENDPOINT=.*|OTEL_EXPORTER_OTLP_ENDPOINT=${NEW_ENDPOINT}|' /etc/environment || echo 'OTEL_EXPORTER_OTLP_ENDPOINT=${NEW_ENDPOINT}' >> /etc/environment\",
    \"systemctl restart code-server\"
  ]" \
  --region ap-northeast-2
```
Verify against the **actual running** `claude` process's environment — not just the
file, which only proves the edit landed, not that anything picked it up:
```bash
aws ssm send-command --instance-ids $INSTANCE_ID --document-name AWS-RunShellScript \
  --parameters 'commands=["tr \"\\0\" \"\\n\" < /proc/$(pgrep -u coder -n claude)/environ | grep OTEL_EXPORTER_OTLP"]' \
  --region ap-northeast-2
```
If `pgrep` finds nothing, no `claude` process is running yet — open a terminal in
code-server first (a fresh terminal after the restart inherits the new environment).

To bulk-migrate every existing devenv instead of doing it one at a time:
```bash
NEW_ENDPOINT="http://<otel-nlb-dns>:4318"   # terraform output -raw otel_rollup_collector_endpoint, prefixed with http://

aws ec2 describe-instances \
  --filters "Name=tag:managed_by,Values=cc-on-bedrock" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --region ap-northeast-2 --output text \
  | tr '\t' '\n' | while read -r id; do
    aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
      --parameters "commands=[
        \"mkdir -p /etc/systemd/system/code-server.service.d\",
        \"printf '[Service]\\nEnvironmentFile=-/etc/environment\\n' > /etc/systemd/system/code-server.service.d/env.conf\",
        \"systemctl daemon-reload\",
        \"grep -q '^OTEL_EXPORTER_OTLP_PROTOCOL=' /etc/environment && sed -i 's|^OTEL_EXPORTER_OTLP_PROTOCOL=.*|OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf|' /etc/environment || echo 'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf' >> /etc/environment\",
        \"grep -q '^OTEL_EXPORTER_OTLP_ENDPOINT=' /etc/environment && sed -i 's|^OTEL_EXPORTER_OTLP_ENDPOINT=.*|OTEL_EXPORTER_OTLP_ENDPOINT=${NEW_ENDPOINT}|' /etc/environment || echo 'OTEL_EXPORTER_OTLP_ENDPOINT=${NEW_ENDPOINT}' >> /etc/environment\",
        \"systemctl restart code-server\"
      ]" --region ap-northeast-2
  done
```
`send-command` fans out to every instance immediately (no built-in stagger), and
`systemctl restart code-server` drops any open terminal/websocket session for a few
seconds — avoid running this against every devenv at once if any are in active use; loop
in smaller batches with a pause between them instead.

## Escalation
If none of the above resolves the issue, check ECS dashboard service logs:
```bash
aws logs tail /cc-on-bedrock/dashboard --since 30m --region ap-northeast-2
```
