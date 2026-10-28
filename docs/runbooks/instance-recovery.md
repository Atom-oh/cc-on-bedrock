# Runbook: EC2 DevEnv Instance Recovery

This runbook applies to the `devenv` deployment profile. Use the configured
region and Terraform routing-table output; these are deployment-specific inputs.

```bash
export AWS_REGION="<deployment-region>"
ROUTING_TABLE="$(terraform -chdir=terraform output -raw routing_table_name)"
```

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
  --region "$AWS_REGION" --output table
```

### 2. Check cloud-init logs (if instance is running)
```bash
INSTANCE_ID="<instance-id>"
aws ssm send-command --instance-ids $INSTANCE_ID \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["tail -50 /var/log/cloud-init-output.log"]' \
  --region "$AWS_REGION"
```

### 3. Check DynamoDB routing entry
```bash
aws dynamodb get-item --table-name "$ROUTING_TABLE" \
  --key '{"subdomain":{"S":"<subdomain>"}}' \
  --region "$AWS_REGION"
```

## Resolution

### Instance stuck in stopping
Confirm the normal stop has failed and preserve required data before a forced
stop. A forced stop can interrupt writes; use the dashboard's supported stop
flow first.

```bash
aws ec2 stop-instances --instance-ids $INSTANCE_ID --force --region "$AWS_REGION"
```

### Instance terminated unexpectedly
Recreate through the dashboard `/user` lifecycle flow after inspecting persistent
data. Instance termination does not delete the separate `/home/coder` data volume.
Stored `dataVolumeId` is authoritative; tag discovery is a fail-closed fallback.

```bash
SUBDOMAIN="<verified-user-subdomain>"
aws ec2 describe-volumes --region "$AWS_REGION" \
  --filters "Name=tag:cc:subdomain,Values=$SUBDOMAIN" \
    "Name=tag:cc:role,Values=data" "Name=tag:cc:project,Values=cc-on-bedrock" \
  --query 'Volumes[].{Id:VolumeId,AZ:AvailabilityZone,State:State,Attachments:Attachments}' \
  --output table
```

Confirm ownership, attachment state and a usable private subnet in the same AZ.
Duplicate tagged volumes or no subnet in that AZ require operator resolution;
the dashboard refuses to guess. Do not delete retained volumes to unblock a
launch. Verify the expected filesystem at `/home/coder` before reopening access.
Only a missing/deleted or damaged data volume requires snapshot/backup recovery.

Legacy root-only instances need migration/inspection before treating the root
as replaceable. Current runtime and Terraform retain roots too, despite the
ADR-002 ephemeral-root intent; inventory both volumes during cleanup.

### CWAgent not reporting
```bash
aws ssm send-command --instance-ids $INSTANCE_ID \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["amazon-cloudwatch-agent-ctl -a status","tail -10 /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log"]' \
  --region "$AWS_REGION"
```
Common cause: IAM role missing `cloudwatch:PutMetricData`. Fix: stop and start the instance (triggers IAM policy upsert).

### Routing table stale entry
Compare the read-only routing item above with the verified EC2 instance and
stored user environment. Retry the supported dashboard lifecycle operation,
which registers the route. Do not delete a row while provisioning/stop is in
progress or discard custom route/version metadata to force a retry. If repair
is still required, capture the exact stale record and inspect dashboard and
nginx-config generation logs before a targeted correction.

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
  --region "$AWS_REGION"
```
Verify against the **actual running** `claude` process's environment — not just the
file, which only proves the edit landed, not that anything picked it up:
```bash
aws ssm send-command --instance-ids $INSTANCE_ID --document-name AWS-RunShellScript \
  --parameters 'commands=["tr \"\\0\" \"\\n\" < /proc/$(pgrep -u coder -n claude)/environ | grep OTEL_EXPORTER_OTLP"]' \
  --region "$AWS_REGION"
```
If `pgrep` finds nothing, no `claude` process is running yet — open a terminal in
code-server first (a fresh terminal after the restart inherits the new environment).

To bulk-migrate every existing devenv instead of doing it one at a time:
```bash
NEW_ENDPOINT="http://<otel-nlb-dns>:4318"   # terraform output -raw otel_rollup_collector_endpoint, prefixed with http://

aws ec2 describe-instances \
  --filters "Name=tag:managed_by,Values=cc-on-bedrock" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --region "$AWS_REGION" --output text \
  | tr '\t' '\n' | while read -r id; do
    aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
      --parameters "commands=[
        \"mkdir -p /etc/systemd/system/code-server.service.d\",
        \"printf '[Service]\\nEnvironmentFile=-/etc/environment\\n' > /etc/systemd/system/code-server.service.d/env.conf\",
        \"systemctl daemon-reload\",
        \"grep -q '^OTEL_EXPORTER_OTLP_PROTOCOL=' /etc/environment && sed -i 's|^OTEL_EXPORTER_OTLP_PROTOCOL=.*|OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf|' /etc/environment || echo 'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf' >> /etc/environment\",
        \"grep -q '^OTEL_EXPORTER_OTLP_ENDPOINT=' /etc/environment && sed -i 's|^OTEL_EXPORTER_OTLP_ENDPOINT=.*|OTEL_EXPORTER_OTLP_ENDPOINT=${NEW_ENDPOINT}|' /etc/environment || echo 'OTEL_EXPORTER_OTLP_ENDPOINT=${NEW_ENDPOINT}' >> /etc/environment\",
        \"systemctl restart code-server\"
      ]" --region "$AWS_REGION"
  done
```
`send-command` fans out to every instance immediately (no built-in stagger), and
`systemctl restart code-server` drops any open terminal/websocket session for a few
seconds — avoid running this against every devenv at once if any are in active use; loop
in smaller batches with a pause between them instead.

## Escalation
If none of the above resolves the issue, check the dashboard EC2 ASG/container logs (not an ECS dashboard service):
```bash
aws logs tail /cc-on-bedrock/dashboard --since 30m --region "$AWS_REGION"
```
