/**
 * EC2-per-user DevEnv client functions.
 * Replaces ECS container lifecycle with EC2 instance lifecycle.
 * Stop/Start preserves all state — no snapshot/restore needed.
 */

import {
  EC2Client,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  CreateTagsCommand,
  CreateSnapshotCommand,
  DescribeSnapshotsCommand,
  DescribeImagesCommand,
  RegisterImageCommand,
  DeregisterImageCommand,
  ModifyInstanceAttributeCommand,
  ModifyNetworkInterfaceAttributeCommand,
} from "@aws-sdk/client-ec2";
import {
  SSMClient,
  GetParameterCommand,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  BatchGetItemCommand,
  UpdateItemCommand,
  ScanCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  TagRoleCommand,
  CreateInstanceProfileCommand,
  AddRoleToInstanceProfileCommand,
  GetInstanceProfileCommand,
} from "@aws-sdk/client-iam";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { randomBytes } from "crypto";
import type { CustomRoute, CustomRoutesRecord } from "@/lib/types";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const ec2Client = new EC2Client({ region });
const ssmClient = new SSMClient({ region });
const ddbClient = new DynamoDBClient({ region });
const iamClient = new IAMClient({ region });
const secretsClient = new SecretsManagerClient({ region });
const accountId = process.env.AWS_ACCOUNT_ID ?? "";

const INSTANCE_TABLE = process.env.INSTANCE_TABLE ?? "cc-user-instances";
const ROUTING_TABLE = process.env.ROUTING_TABLE ?? "cc-routing-table";
const LAUNCH_TEMPLATE = process.env.LAUNCH_TEMPLATE ?? "cc-on-bedrock-devenv";
const VPC_SUBNET_IDS = (process.env.PRIVATE_SUBNET_IDS ?? "").split(",").filter(Boolean);
const HIBERNATE_ENABLED = (process.env.HIBERNATE_ENABLED ?? "false") === "true";
const DASHBOARD_URL = process.env.NEXTAUTH_URL ?? process.env.DASHBOARD_URL ?? "";
const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.OTEL_COLLECTOR_ENDPOINT ?? "";

// DLP Security Group IDs (from Terraform outputs / env vars)
const SG_MAP: Record<string, string> = {
  open: process.env.SG_DEVENV_OPEN ?? "",
  restricted: process.env.SG_DEVENV_RESTRICTED ?? "",
  locked: process.env.SG_DEVENV_LOCKED ?? "",
};

// ADR-005 container-layer DLP for EC2 mode: code-server reads these keys from
// config.yaml (equivalent to --disable-file-downloads / --disable-file-uploads).
// extensions-dir lock is applied separately with a directory-existence guard so
// code-server never fails to start on an AMI without the curated dirs.
function dlpCodeServerUserData(policy: string): { configLines: string[]; postLines: string[] } {
  if (policy !== "restricted" && policy !== "locked") {
    return { configLines: [], postLines: [] };
  }
  const extDir = policy === "locked" ? "/opt/extensions-readonly" : "/opt/extensions-approved";
  return {
    configLines: [
      `disable-file-downloads: true`,
      `disable-file-uploads: true`,
    ],
    postLines: [
      `# DLP (${policy}): lock extensions dir only when the curated dir exists on the AMI`,
      `if [ -d ${extDir} ]; then echo "extensions-dir: ${extDir}" >> /home/coder/.config/code-server/config.yaml; fi`,
      `echo "SECURITY_POLICY=${policy}" >> /etc/environment`,
    ],
  };
}

/**
 * Re-apply the container-layer DLP (code-server config) on a RUNNING instance
 * via SSM. Used on policy change and on every restart of an existing instance
 * (UserData only runs on first boot). Best-effort: the SG is the hard guarantee.
 */
async function syncDlpCodeServerConfig(
  instanceId: string,
  policy: "open" | "restricted" | "locked",
): Promise<void> {
  const extDir = policy === "locked" ? "/opt/extensions-readonly" : "/opt/extensions-approved";
  const dlpOn = policy === "restricted" || policy === "locked";
  await ssmClient.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: "AWS-RunShellScript",
    Parameters: {
      commands: [
        `CFG=/home/coder/.config/code-server/config.yaml`,
        `sed -i '/^disable-file-downloads:/d;/^disable-file-uploads:/d;/^extensions-dir:/d' "$CFG"`,
        ...(dlpOn ? [
          `printf 'disable-file-downloads: true\\ndisable-file-uploads: true\\n' >> "$CFG"`,
          `if [ -d ${extDir} ]; then echo "extensions-dir: ${extDir}" >> "$CFG"; fi`,
        ] : []),
        `grep -q '^SECURITY_POLICY=' /etc/environment && sed -i 's/^SECURITY_POLICY=.*/SECURITY_POLICY=${policy}/' /etc/environment || echo "SECURITY_POLICY=${policy}" >> /etc/environment`,
        `systemctl restart code-server 2>/dev/null || true`,
      ],
    },
    TimeoutSeconds: 30,
  }));
}

// Instance tier → EC2 instance type mapping
const INSTANCE_TIERS: Record<string, { type: string; cpu: string; memory: string }> = {
  light:    { type: "t4g.medium",  cpu: "2 vCPU",  memory: "4 GiB" },
  standard: { type: "t4g.large",   cpu: "2 vCPU",  memory: "8 GiB" },
  power:    { type: "m7g.xlarge",  cpu: "4 vCPU",  memory: "16 GiB" },
};

export interface StartInstanceInput {
  subdomain: string;
  username: string;  // email
  department: string;
  securityPolicy: "open" | "restricted" | "locked";
  resourceTier?: "light" | "standard" | "power";
  containerOs?: "ubuntu" | "al2023";
}

export interface InstanceInfo {
  instanceId: string;
  subdomain: string;
  username: string;
  status: string;  // running / stopped / terminated
  privateIp: string;
  instanceType: string;
  securityPolicy: string;
  containerOs?: string;
  launchTime?: string;
}

/**
 * Start a user's devenv instance.
 * - If instance exists (stopped): StartInstances
 * - If no instance: RunInstances from Launch Template
 */
export async function startInstance(input: StartInstanceInput): Promise<InstanceInfo> {
  // Fail-closed: unknown/missing policy lands on the restricted tier, never open.
  // Computed up front so BOTH paths (restart of an existing stopped instance and
  // fresh RunInstances) enforce the same policy.
  const effectivePolicy = SG_MAP[input.securityPolicy] ? input.securityPolicy : "restricted";
  if (!SG_MAP[effectivePolicy]) {
    // Misconfigured deployment (SG_DEVENV_* env missing) — fail loud, not with a
    // cryptic RunInstances/ModifyNetworkInterface error downstream.
    throw new Error(`No security group configured for policy "${effectivePolicy}" — check SG_DEVENV_* env vars`);
  }

  // Check DynamoDB for existing instance
  const existing = await getUserInstance(input.subdomain);

  if (existing?.instanceId) {
    const desc = await describeInstance(existing.instanceId);

    // Wait if instance is transitioning (stopping → stopped, pending → running)
    if (desc && (desc.status === "stopping" || desc.status === "pending")) {
      console.log(`[EC2] Instance ${existing.instanceId} is ${desc.status}, waiting...`);
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const check = await describeInstance(existing.instanceId);
        if (!check || check.status === "stopped" || check.status === "running") {
          desc!.status = check?.status ?? "terminated";
          desc!.privateIp = check?.privateIp ?? "";
          break;
        }
      }
    }

    if (desc && desc.status === "stopped") {
      // Resize instance type if tier changed
      const newType = INSTANCE_TIERS[input.resourceTier ?? "standard"].type;
      if (desc.instanceType !== newType) {
        console.log(`[EC2] Resizing ${existing.instanceId}: ${desc.instanceType} → ${newType}`);
        await ec2Client.send(new ModifyInstanceAttributeCommand({
          InstanceId: existing.instanceId,
          InstanceType: { Value: newType },
        }));
      }

      // ADR-005: UserData only runs on first boot, so a policy change made while
      // the instance was stopped would otherwise never be enforced. Re-apply the
      // current SG before start (ENI groups are mutable on stopped instances)...
      try {
        if (desc.eniId) {
          await ec2Client.send(new ModifyNetworkInterfaceAttributeCommand({
            NetworkInterfaceId: desc.eniId,
            Groups: [SG_MAP[effectivePolicy]],
          }));
          console.log(`[EC2] Re-applied ${effectivePolicy} SG on restart for ${input.subdomain}`);
        }
      } catch (err) {
        console.warn(`[EC2] SG re-apply on restart failed for ${input.subdomain}:`, err);
      }

      console.log(`[EC2] Starting existing instance ${existing.instanceId} for ${input.subdomain}`);
      await ec2Client.send(new StartInstancesCommand({
        InstanceIds: [existing.instanceId],
      }));

      // Wait for running + get IP
      const info = await waitForRunning(existing.instanceId);

      // Sync code-server password from Secrets Manager (UserData only runs on first boot)
      await syncCodeserverPassword(existing.instanceId, input.subdomain);

      // ...and the container-layer DLP config once it's running (best-effort)
      try {
        await syncDlpCodeServerConfig(existing.instanceId, effectivePolicy);
        console.log(`[EC2] Re-applied ${effectivePolicy} code-server DLP on restart for ${input.subdomain}`);
      } catch (err) {
        console.warn(`[EC2] code-server DLP re-apply on restart failed for ${input.subdomain}:`, err);
      }

      // Update Claude CLI + start CWAgent (fire-and-forget)
      postStartSetup(existing.instanceId);

      // Update routing table
      await registerRoute(input.subdomain, info.privateIp);

      // Update DynamoDB
      await updateInstanceRecord(input.subdomain, {
        status: "running",
        privateIp: info.privateIp,
      });

      return { instanceId: existing.instanceId, ...info, subdomain: input.subdomain, username: input.username, securityPolicy: effectivePolicy, containerOs: existing.containerOs ?? "ubuntu", status: "running" };
    }

    if (desc && desc.status === "running") {
      console.log(`[EC2] Instance ${existing.instanceId} already running for ${input.subdomain}`);
      // Keep the SG in sync with the live policy so the returned securityPolicy
      // is what's actually enforced (idempotent, non-disruptive — no restarts).
      // Container-layer DLP resync is left to the changeSecurityPolicy path.
      try {
        if (desc.eniId) {
          await ec2Client.send(new ModifyNetworkInterfaceAttributeCommand({
            NetworkInterfaceId: desc.eniId,
            Groups: [SG_MAP[effectivePolicy]],
          }));
        }
      } catch (err) {
        console.warn(`[EC2] SG sync on already-running failed for ${input.subdomain}:`, err);
      }
      return {
        instanceId: existing.instanceId,
        subdomain: input.subdomain,
        username: input.username,
        status: "running",
        privateIp: desc.privateIp,
        instanceType: desc.instanceType,
        securityPolicy: effectivePolicy,
        containerOs: existing.containerOs ?? "ubuntu",
      };
    }
  }

  // No existing instance — create new from Launch Template
  console.log(`[EC2] Creating new instance for ${input.subdomain}`);

  // Get AMI ID from SSM (per-OS parameter with fallback)
  const osType = input.containerOs ?? "ubuntu";
  let amiId: string | undefined;
  try {
    const param = await ssmClient.send(new GetParameterCommand({
      Name: `/cc-on-bedrock/devenv/ami-id/${osType}`,
    }));
    amiId = param.Parameter?.Value;
  } catch {
    // Fallback: legacy single parameter
    try {
      const fallback = await ssmClient.send(new GetParameterCommand({
        Name: "/cc-on-bedrock/devenv/ami-id",
      }));
      amiId = fallback.Parameter?.Value;
    } catch {
      throw new Error(`AMI not found for OS '${osType}'. Run: scripts/build-ami.sh ${osType}`);
    }
  }

  const sg = SG_MAP[effectivePolicy];
  const dlp = dlpCodeServerUserData(effectivePolicy);
  const subnet = VPC_SUBNET_IDS[Math.floor(Math.random() * VPC_SUBNET_IDS.length)];
  const tier = INSTANCE_TIERS[input.resourceTier ?? "standard"];

  // Per-user instance profile for individual Bedrock usage tracking
  const instanceProfileName = await ensureUserInstanceProfile(input.subdomain, input.username, input.department);

  // Per-user code-server password (Secrets Manager)
  const codeserverPassword = await ensureCodeserverPassword(input.subdomain);

  // Resolve the AMI's actual root device name so the DeleteOnTermination override
  // below targets the real root volume (ubuntu=/dev/sda1; al2023 may differ).
  const amiDesc = await ec2Client.send(new DescribeImagesCommand({ ImageIds: [amiId!] }));
  const rootDeviceName = amiDesc.Images?.[0]?.RootDeviceName ?? "/dev/sda1";

  const result = await runInstancesWithIamRetry({
    ImageId: amiId!,
    // Preserve the per-user root volume on Terminate (not just Stop/Hibernate).
    // Golden AMIs default the root device to DeleteOnTermination=true; without this
    // override a Terminate destroys the user's workspace+system state. Mirrors the
    // Launch Template and the snapshot-restore path (which bake false in).
    BlockDeviceMappings: [{
      DeviceName: rootDeviceName,
      Ebs: { DeleteOnTermination: false },  // size/snapshot inherited from the AMI
    }],
    IamInstanceProfile: { Name: instanceProfileName },
    InstanceType: tier.type as never,
    MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 2 },
    HibernationOptions: HIBERNATE_ENABLED ? { Configured: true } : undefined,
    MinCount: 1,
    MaxCount: 1,
    SubnetId: subnet,
    SecurityGroupIds: sg ? [sg] : undefined,
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: `cc-devenv-${input.subdomain}` },
          { Key: "subdomain", Value: input.subdomain },
          { Key: "username", Value: input.username },
          { Key: "department", Value: input.department },
          { Key: "securityPolicy", Value: input.securityPolicy },
          { Key: "containerOs", Value: osType },
          { Key: "managed_by", Value: "cc-on-bedrock" },
          { Key: "hibernateCapable", Value: HIBERNATE_ENABLED ? "true" : "false" },
          { Key: "cc:user", Value: input.username },
          { Key: "cc:department", Value: input.department },
          { Key: "cc:project", Value: "cc-on-bedrock" },
          { Key: "cc:subdomain", Value: input.subdomain },
          { Key: "cc:cost-center", Value: input.department },
        ],
      },
      {
        ResourceType: "volume",
        Tags: [
          { Key: "Name", Value: `cc-devenv-${input.subdomain}` },
          { Key: "subdomain", Value: input.subdomain },
          { Key: "managed_by", Value: "cc-on-bedrock" },
          { Key: "cc:user", Value: input.username },
          { Key: "cc:department", Value: input.department },
          { Key: "cc:project", Value: "cc-on-bedrock" },
          { Key: "cc:subdomain", Value: input.subdomain },
          { Key: "cc:cost-center", Value: input.department },
        ],
      },
    ],
    UserData: Buffer.from([
      "#!/bin/bash",
      `echo "USER_SUBDOMAIN=${input.subdomain}" >> /etc/environment`,
      `echo "DEPARTMENT=${input.department}" >> /etc/environment`,
      `echo "CLAUDE_CODE_USE_BEDROCK=1" >> /etc/environment`,
      `echo "ANTHROPIC_DEFAULT_SONNET_MODEL=global.anthropic.claude-sonnet-4-6" >> /etc/environment`,
      `echo "AWS_DEFAULT_REGION=${region}" >> /etc/environment`,
      ...(OTEL_EXPORTER_OTLP_ENDPOINT ? [
        `echo "OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}" >> /etc/environment`,
      ] : []),
      `# Allow coder to use package managers without password`,
      `cat > /etc/sudoers.d/coder << 'SUDOEOF'`,
      `coder ALL=(root) NOPASSWD: /usr/bin/code-server`,
      `coder ALL=(root) NOPASSWD: /usr/local/bin/npm`,
      `coder ALL=(root) NOPASSWD: /usr/local/bin/npx`,
      `coder ALL=(root) NOPASSWD: /usr/bin/pip3`,
      `coder ALL=(root) NOPASSWD: /usr/bin/apt`,
      `coder ALL=(root) NOPASSWD: /usr/bin/apt-get`,
      `coder ALL=(root) NOPASSWD: /usr/bin/dnf`,
      `coder ALL=(root) NOPASSWD: /usr/bin/yum`,
      `SUDOEOF`,
      `chmod 0440 /etc/sudoers.d/coder`,
      `# Ensure workspace directory exists`,
      `sudo -u coder mkdir -p /home/coder/workspace`,
      `# Set per-user code-server password`,
      `mkdir -p /home/coder/.config/code-server`,
      `cat > /home/coder/.config/code-server/config.yaml << 'CSCFG'`,
      `bind-addr: 0.0.0.0:8080`,
      `auth: password`,
      `password: "${codeserverPassword}"`,
      `cert: false`,
      ...dlp.configLines,
      `CSCFG`,
      ...dlp.postLines,
      `chown -R coder:coder /home/coder/.config`,
      `systemctl restart code-server || systemctl start code-server`,
      `# Install CloudWatch Agent for memory/disk metrics`,
      `if ! command -v amazon-cloudwatch-agent-ctl &>/dev/null; then`,
      `  if command -v dnf &>/dev/null; then`,
      `    dnf install -y amazon-cloudwatch-agent 2>/dev/null || true`,
      `  elif command -v apt-get &>/dev/null; then`,
      `    wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb -O /tmp/cwagent.deb && dpkg -i /tmp/cwagent.deb && rm -f /tmp/cwagent.deb`,
      `  fi`,
      `fi`,
      `# Configure CWAgent`,
      `mkdir -p /opt/aws/amazon-cloudwatch-agent/etc`,
      `cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CWCFG'`,
      `{"agent":{"run_as_user":"root"},"metrics":{"namespace":"CWAgent","metrics_collected":{"mem":{"measurement":["mem_used_percent","mem_used","mem_total"]},"disk":{"measurement":["disk_used_percent"],"resources":["/"]},"diskio":{"measurement":["read_bytes","write_bytes"],"resources":["*"]},"net":{"measurement":["bytes_sent","bytes_recv"]}},"append_dimensions":{"InstanceId":"\${aws:InstanceId}"}}}`,
      `CWCFG`,
      `amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json 2>/dev/null || true`,
      ...(DASHBOARD_URL ? [
        `# OTEL code activity metrics: commits, LoC, review markers (60s cadence)`,
        `curl -fsSL "${DASHBOARD_URL.replace(/\/$/, "")}/api/install/otel" -o /usr/local/bin/cc-otel-code-metrics 2>/dev/null || true`,
        `chmod +x /usr/local/bin/cc-otel-code-metrics 2>/dev/null || true`,
        `if [ -x /usr/local/bin/cc-otel-code-metrics ] && [ -n "$OTEL_EXPORTER_OTLP_ENDPOINT" ]; then`,
        `cat > /etc/systemd/system/cc-otel-code-metrics.service << 'OTELSVC'`,
        `[Unit]`,
        `Description=CC-on-Bedrock OTEL code activity metrics`,
        `After=network-online.target`,
        `Wants=network-online.target`,
        `[Service]`,
        `Type=oneshot`,
        `User=coder`,
        `EnvironmentFile=-/etc/environment`,
        `Environment=WORKSPACE_ROOT=/home/coder/workspace`,
        `ExecStart=/usr/local/bin/cc-otel-code-metrics`,
        `OTELSVC`,
        `cat > /etc/systemd/system/cc-otel-code-metrics.timer << 'OTELTIMER'`,
        `[Unit]`,
        `Description=Run CC-on-Bedrock OTEL code metrics every minute`,
        `[Timer]`,
        `OnBootSec=90s`,
        `OnUnitActiveSec=60s`,
        `AccuracySec=10s`,
        `Persistent=true`,
        `[Install]`,
        `WantedBy=timers.target`,
        `OTELTIMER`,
        `systemctl daemon-reload`,
        `systemctl enable --now cc-otel-code-metrics.timer`,
        `fi`,
      ] : []),
      `# Ensure ~/.claude is coder-owned before installing (cc-mcp-sync may have`,
      `# created it as root first — breaks the installer and Claude Code state)`,
      `mkdir -p /home/coder/.claude && chown -R coder:coder /home/coder/.claude`,
      `# Upgrade Claude Code + Kiro CLI (first boot)`,
      `sudo -u coder bash -c 'curl -fsSL https://claude.ai/install.sh | bash' 2>/dev/null || true`,
      `[ -f /home/coder/.local/bin/claude ] && ln -sf /home/coder/.local/bin/claude /usr/local/bin/claude`,
      `sudo -u coder bash -c 'curl -fsSL https://cli.kiro.dev/install | bash' 2>/dev/null || true`,
      `[ -f /home/coder/.local/bin/kiro ] && ln -sf /home/coder/.local/bin/kiro /usr/local/bin/kiro`,
      `# Auto-update Claude Code + Kiro on every boot (start/restart)`,
      `cat > /etc/systemd/system/cc-cli-update.service << 'SVCEOF'`,
      `[Unit]`,
      `Description=Auto-update Claude Code and Kiro CLI`,
      `After=network-online.target`,
      `Wants=network-online.target`,
      `[Service]`,
      `Type=oneshot`,
      `User=coder`,
      `ExecStart=/bin/bash -lc 'curl -fsSL https://claude.ai/install.sh | bash; curl -fsSL https://cli.kiro.dev/install | bash'`,
      // `+` prefix runs the command as root, bypassing the unit's `User=coder`.
      // Required because /usr/local/bin is root-owned and the symlink update
      // would otherwise silently fail (with `; true` swallowing the error).
      `ExecStartPost=+/bin/bash -c '[ -f /home/coder/.local/bin/claude ] && ln -sf /home/coder/.local/bin/claude /usr/local/bin/claude; [ -f /home/coder/.local/bin/kiro ] && ln -sf /home/coder/.local/bin/kiro /usr/local/bin/kiro; true'`,
      `TimeoutStartSec=120`,
      `[Install]`,
      `WantedBy=multi-user.target`,
      `SVCEOF`,
      `systemctl daemon-reload`,
      `systemctl enable cc-cli-update.service`,
      `# MCP config sync — delegate to AMI script (ADR-007 §6)`,
      `[ -x /opt/cc-on-bedrock/sync-mcp-config.sh ] && bash /opt/cc-on-bedrock/sync-mcp-config.sh 2>/dev/null || true`,
    ].join("\n")).toString("base64"),
  });

  const instanceId = result.Instances?.[0]?.InstanceId;
  if (!instanceId) throw new Error("Failed to create instance");

  console.log(`[EC2] Created instance ${instanceId} for ${input.subdomain}`);

  // Wait for running
  const info = await waitForRunning(instanceId);

  // Register routing
  await registerRoute(input.subdomain, info.privateIp);

  // Save to DynamoDB
  await ddbClient.send(new PutItemCommand({
    TableName: INSTANCE_TABLE,
    Item: marshall({
      user_id: input.subdomain,
      instanceId,
      username: input.username,
      department: input.department,
      securityPolicy: effectivePolicy,
      containerOs: osType,
      instanceType: info.instanceType,
      privateIp: info.privateIp,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  }));

  return {
    instanceId,
    subdomain: input.subdomain,
    username: input.username,
    status: "running",
    privateIp: info.privateIp,
    instanceType: info.instanceType,
    securityPolicy: effectivePolicy,
    containerOs: osType,
  };
}

/**
 * Stop (or hibernate) a user's instance. EBS volume preserved automatically.
 * Hibernate preserves RAM state for instant resume (ADR-010).
 */
export async function stopInstance(subdomain: string, reason?: string): Promise<void> {
  const record = await getUserInstance(subdomain);
  if (!record?.instanceId) {
    console.warn(`[EC2] No instance found for ${subdomain}`);
    return;
  }

  console.log(`[EC2] Stopping instance ${record.instanceId} for ${subdomain}: ${reason ?? "user request"}`);

  // Deregister route first
  await deregisterRoute(subdomain);

  // Check if instance supports hibernation
  const shouldHibernate = HIBERNATE_ENABLED && await isHibernateCapable(record.instanceId);

  try {
    await ec2Client.send(new StopInstancesCommand({
      InstanceIds: [record.instanceId],
      Hibernate: shouldHibernate,
    }));
    await updateInstanceRecord(subdomain, {
      status: shouldHibernate ? "hibernated" : "stopped",
      ...(shouldHibernate ? { hibernatedAt: new Date().toISOString() } : {}),
    });
    if (shouldHibernate) {
      console.log(`[EC2] Hibernated instance ${record.instanceId}`);
    }
  } catch (err) {
    // Fallback: if hibernate fails, do a regular stop
    if (shouldHibernate) {
      console.warn(`[EC2] Hibernate failed for ${record.instanceId}, falling back to regular stop:`, err);
      await ec2Client.send(new StopInstancesCommand({
        InstanceIds: [record.instanceId],
      }));
      await updateInstanceRecord(subdomain, { status: "stopped" });
    } else {
      throw err;
    }
  }
}

/**
 * Terminate a user's instance (admin only). EBS deleted.
 */
export async function terminateInstance(subdomain: string): Promise<void> {
  const record = await getUserInstance(subdomain);
  if (!record?.instanceId) return;

  await deregisterRoute(subdomain);

  // Must disable termination protection first
  try {
    await ec2Client.send(new ModifyInstanceAttributeCommand({
      InstanceId: record.instanceId,
      DisableApiTermination: { Value: false },
    }));
  } catch { /* may not have protection */ }

  await ec2Client.send(new TerminateInstancesCommand({
    InstanceIds: [record.instanceId],
  }));

  await ddbClient.send(new DeleteItemCommand({
    TableName: INSTANCE_TABLE,
    Key: marshall({ user_id: subdomain }),
  }));
}

/**
 * Switch a user's instance OS. Snapshots the current root EBS for recovery,
 * terminates the old instance, and creates a new one with the target OS AMI.
 */
export async function switchOs(
  subdomain: string,
  newOs: "ubuntu" | "al2023",
): Promise<{ instanceInfo: InstanceInfo; snapshotId: string }> {
  const record = await getUserInstance(subdomain);
  if (!record?.instanceId) throw new Error(`No instance found for ${subdomain}`);

  const currentOs = record.containerOs ?? "ubuntu";
  if (currentOs === newOs) throw new Error(`Instance is already running ${newOs}`);

  // 1. Get instance details for volume ID
  const desc = await ec2Client.send(new DescribeInstancesCommand({
    InstanceIds: [record.instanceId],
  }));
  const instance = desc.Reservations?.[0]?.Instances?.[0];
  if (!instance) throw new Error(`Instance ${record.instanceId} not found in EC2`);

  // 2. Stop if running
  if (instance.State?.Name === "running") {
    console.log(`[EC2] Stopping ${record.instanceId} for OS switch`);
    await deregisterRoute(subdomain);
    await ec2Client.send(new StopInstancesCommand({ InstanceIds: [record.instanceId], Hibernate: false }));
    // Wait for stopped
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const check = await describeInstance(record.instanceId);
      if (check?.status === "stopped") break;
    }
  }

  // 3. Find root EBS volume
  const rootDevice = instance.BlockDeviceMappings?.find(
    b => b.DeviceName === instance.RootDeviceName
  );
  const volumeId = rootDevice?.Ebs?.VolumeId;
  if (!volumeId) throw new Error("Root EBS volume not found");

  // 4. Create snapshot for recovery
  console.log(`[EC2] Creating snapshot of ${volumeId} for ${subdomain} (${currentOs} → ${newOs})`);
  const snap = await ec2Client.send(new CreateSnapshotCommand({
    VolumeId: volumeId,
    Description: `OS switch backup: ${subdomain} ${currentOs} → ${newOs}`,
    TagSpecifications: [{
      ResourceType: "snapshot",
      Tags: [
        { Key: "Name", Value: `cc-devenv-${subdomain}-${currentOs}` },
        { Key: "subdomain", Value: subdomain },
        { Key: "previousOs", Value: currentOs },
        { Key: "purpose", Value: "os-switch" },
        { Key: "managed_by", Value: "cc-on-bedrock" },
        { Key: "cc:user", Value: record?.username ?? "" },
        { Key: "cc:department", Value: record?.department ?? "default" },
        { Key: "cc:project", Value: "cc-on-bedrock" },
        { Key: "cc:subdomain", Value: subdomain },
        { Key: "cc:cost-center", Value: record?.department ?? "default" },
      ],
    }],
  }));
  const snapshotId = snap.SnapshotId!;
  console.log(`[EC2] Snapshot ${snapshotId} created for ${subdomain}`);

  // 5. Save snapshot to DynamoDB (append to previousSnapshots)
  try {
    await ddbClient.send(new UpdateItemCommand({
      TableName: INSTANCE_TABLE,
      Key: marshall({ user_id: subdomain }),
      UpdateExpression: "SET previousSnapshots = list_append(if_not_exists(previousSnapshots, :empty), :snap), updatedAt = :now",
      ExpressionAttributeValues: marshall({
        ":snap": [{ snapshotId, os: currentOs, date: new Date().toISOString().slice(0, 10) }],
        ":empty": [],
        ":now": new Date().toISOString(),
      }),
    }));
  } catch (e) {
    console.error(`[EC2] Failed to save snapshot record: ${e}`);
  }

  // 6. Terminate old instance
  try {
    await ec2Client.send(new ModifyInstanceAttributeCommand({
      InstanceId: record.instanceId,
      DisableApiTermination: { Value: false },
    }));
  } catch { /* may not have protection */ }
  await ec2Client.send(new TerminateInstancesCommand({
    InstanceIds: [record.instanceId],
  }));
  // Delete DynamoDB record so startInstance creates fresh
  await ddbClient.send(new DeleteItemCommand({
    TableName: INSTANCE_TABLE,
    Key: marshall({ user_id: subdomain }),
  }));

  // 7. Create new instance with new OS
  console.log(`[EC2] Creating new ${newOs} instance for ${subdomain}`);
  const instanceInfo = await startInstance({
    subdomain,
    username: record.username ?? "",
    department: record.department ?? "default",
    securityPolicy: (record.securityPolicy ?? "restricted") as "open" | "restricted" | "locked",
    containerOs: newOs,
  });

  return { instanceInfo, snapshotId };
}

/**
 * Restore a user's instance from a previous OS snapshot.
 * Creates an AMI from the snapshot and launches a new instance.
 */
export async function restoreFromSnapshot(
  subdomain: string,
  snapshotId: string,
): Promise<InstanceInfo> {
  // Verify snapshot exists and belongs to this user
  const snapDesc = await ec2Client.send(new DescribeSnapshotsCommand({
    SnapshotIds: [snapshotId],
  }));
  const snapshot = snapDesc.Snapshots?.[0];
  if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);

  const snapTags = Object.fromEntries((snapshot.Tags ?? []).map(t => [t.Key, t.Value]));
  if (snapTags.subdomain !== subdomain) throw new Error("Snapshot does not belong to this user");

  const previousOs = snapTags.previousOs ?? "ubuntu";

  // 1. Stop/terminate current instance if exists
  const record = await getUserInstance(subdomain);
  if (record?.instanceId) {
    await deregisterRoute(subdomain);
    try {
      await ec2Client.send(new ModifyInstanceAttributeCommand({
        InstanceId: record.instanceId,
        DisableApiTermination: { Value: false },
      }));
    } catch { /* may not have protection */ }
    await ec2Client.send(new TerminateInstancesCommand({
      InstanceIds: [record.instanceId],
    }));
    await ddbClient.send(new DeleteItemCommand({
      TableName: INSTANCE_TABLE,
      Key: marshall({ user_id: subdomain }),
    }));
    // Wait for termination
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const check = await describeInstance(record.instanceId);
      if (!check || check.status === "terminated") break;
    }
  }

  // 2. Register AMI from snapshot
  const amiName = `cc-devenv-restore-${subdomain}-${Date.now()}`;
  console.log(`[EC2] Registering AMI from snapshot ${snapshotId} for ${subdomain}`);
  const ami = await ec2Client.send(new RegisterImageCommand({
    Name: amiName,
    Architecture: "arm64",
    RootDeviceName: "/dev/sda1",
    VirtualizationType: "hvm",
    EnaSupport: true,
    BlockDeviceMappings: [{
      DeviceName: "/dev/sda1",
      Ebs: {
        SnapshotId: snapshotId,
        VolumeType: "gp3",
        DeleteOnTermination: false,
        Encrypted: true,
      },
    }],
  }));
  const restoredAmiId = ami.ImageId!;
  console.log(`[EC2] Registered AMI ${restoredAmiId} from snapshot ${snapshotId}`);

  // 3. Launch instance from restored AMI (bypass normal SSM AMI lookup)
  const restorePolicy = record?.securityPolicy && SG_MAP[record.securityPolicy]
    ? record.securityPolicy : "restricted";
  const sg = SG_MAP[restorePolicy];
  const dlp = dlpCodeServerUserData(restorePolicy);
  const subnet = VPC_SUBNET_IDS[Math.floor(Math.random() * VPC_SUBNET_IDS.length)];
  const tier = INSTANCE_TIERS["standard"];
  const instanceProfileName = await ensureUserInstanceProfile(subdomain, record?.username ?? "", record?.department ?? "default");
  const codeserverPassword = await ensureCodeserverPassword(subdomain);

  const result = await ec2Client.send(new RunInstancesCommand({
    ImageId: restoredAmiId,
    IamInstanceProfile: { Name: instanceProfileName },
    InstanceType: tier.type as never,
    MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 2 },
    HibernationOptions: HIBERNATE_ENABLED ? { Configured: true } : undefined,
    MinCount: 1, MaxCount: 1,
    SubnetId: subnet,
    SecurityGroupIds: sg ? [sg] : undefined,
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: `cc-devenv-${subdomain}` },
          { Key: "subdomain", Value: subdomain },
          { Key: "username", Value: record?.username ?? "" },
          { Key: "department", Value: record?.department ?? "default" },
          { Key: "securityPolicy", Value: record?.securityPolicy ?? "restricted" },
          { Key: "containerOs", Value: previousOs },
          { Key: "managed_by", Value: "cc-on-bedrock" },
          { Key: "restoredFrom", Value: snapshotId },
          { Key: "hibernateCapable", Value: HIBERNATE_ENABLED ? "true" : "false" },
          { Key: "cc:user", Value: record?.username ?? "" },
          { Key: "cc:department", Value: record?.department ?? "default" },
          { Key: "cc:project", Value: "cc-on-bedrock" },
          { Key: "cc:subdomain", Value: subdomain },
          { Key: "cc:cost-center", Value: record?.department ?? "default" },
        ],
      },
      {
        ResourceType: "volume",
        Tags: [
          { Key: "Name", Value: `cc-devenv-${subdomain}` },
          { Key: "subdomain", Value: subdomain },
          { Key: "managed_by", Value: "cc-on-bedrock" },
          { Key: "cc:user", Value: record?.username ?? "" },
          { Key: "cc:department", Value: record?.department ?? "default" },
          { Key: "cc:project", Value: "cc-on-bedrock" },
          { Key: "cc:subdomain", Value: subdomain },
          { Key: "cc:cost-center", Value: record?.department ?? "default" },
        ],
      },
    ],
    UserData: Buffer.from([
      "#!/bin/bash",
      `echo "USER_SUBDOMAIN=${subdomain}" >> /etc/environment`,
      `echo "CLAUDE_CODE_USE_BEDROCK=1" >> /etc/environment`,
      `echo "ANTHROPIC_DEFAULT_SONNET_MODEL=global.anthropic.claude-sonnet-4-6" >> /etc/environment`,
      `echo "AWS_DEFAULT_REGION=${region}" >> /etc/environment`,
      `mkdir -p /home/coder/.config/code-server`,
      `cat > /home/coder/.config/code-server/config.yaml << 'CSCFG'`,
      `bind-addr: 0.0.0.0:8080`,
      `auth: password`,
      `password: "${codeserverPassword}"`,
      `cert: false`,
      ...dlp.configLines,
      `CSCFG`,
      ...dlp.postLines,
      `chown -R coder:coder /home/coder/.config`,
      `systemctl restart code-server || systemctl start code-server`,
      `# Install CloudWatch Agent for memory/disk metrics`,
      `if ! command -v amazon-cloudwatch-agent-ctl &>/dev/null; then`,
      `  if command -v dnf &>/dev/null; then`,
      `    dnf install -y amazon-cloudwatch-agent 2>/dev/null || true`,
      `  elif command -v apt-get &>/dev/null; then`,
      `    wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb -O /tmp/cwagent.deb && dpkg -i /tmp/cwagent.deb && rm -f /tmp/cwagent.deb`,
      `  fi`,
      `fi`,
      `mkdir -p /opt/aws/amazon-cloudwatch-agent/etc`,
      `cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CWCFG'`,
      `{"agent":{"run_as_user":"root"},"metrics":{"namespace":"CWAgent","metrics_collected":{"mem":{"measurement":["mem_used_percent","mem_used","mem_total"]},"disk":{"measurement":["disk_used_percent"],"resources":["/"]},"diskio":{"measurement":["read_bytes","write_bytes"],"resources":["*"]},"net":{"measurement":["bytes_sent","bytes_recv"]}},"append_dimensions":{"InstanceId":"\${aws:InstanceId}"}}}`,
      `CWCFG`,
      `amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json 2>/dev/null || true`,
      `# Ensure ~/.claude is coder-owned before installing (cc-mcp-sync may have`,
      `# created it as root first — breaks the installer and Claude Code state)`,
      `mkdir -p /home/coder/.claude && chown -R coder:coder /home/coder/.claude`,
      `# Upgrade Claude Code + Kiro CLI (first boot)`,
      `sudo -u coder bash -c 'curl -fsSL https://claude.ai/install.sh | bash' 2>/dev/null || true`,
      `[ -f /home/coder/.local/bin/claude ] && ln -sf /home/coder/.local/bin/claude /usr/local/bin/claude`,
      `sudo -u coder bash -c 'curl -fsSL https://cli.kiro.dev/install | bash' 2>/dev/null || true`,
      `[ -f /home/coder/.local/bin/kiro ] && ln -sf /home/coder/.local/bin/kiro /usr/local/bin/kiro`,
      `# Auto-update Claude Code + Kiro on every boot (start/restart)`,
      `cat > /etc/systemd/system/cc-cli-update.service << 'SVCEOF'`,
      `[Unit]`,
      `Description=Auto-update Claude Code and Kiro CLI`,
      `After=network-online.target`,
      `Wants=network-online.target`,
      `[Service]`,
      `Type=oneshot`,
      `User=coder`,
      `ExecStart=/bin/bash -lc 'curl -fsSL https://claude.ai/install.sh | bash; curl -fsSL https://cli.kiro.dev/install | bash'`,
      // `+` prefix runs the command as root, bypassing the unit's `User=coder`.
      // Required because /usr/local/bin is root-owned and the symlink update
      // would otherwise silently fail (with `; true` swallowing the error).
      `ExecStartPost=+/bin/bash -c '[ -f /home/coder/.local/bin/claude ] && ln -sf /home/coder/.local/bin/claude /usr/local/bin/claude; [ -f /home/coder/.local/bin/kiro ] && ln -sf /home/coder/.local/bin/kiro /usr/local/bin/kiro; true'`,
      `TimeoutStartSec=120`,
      `[Install]`,
      `WantedBy=multi-user.target`,
      `SVCEOF`,
      `systemctl daemon-reload`,
      `systemctl enable cc-cli-update.service`,
      `# MCP config sync — delegate to AMI script (ADR-007 §6)`,
      `[ -x /opt/cc-on-bedrock/sync-mcp-config.sh ] && bash /opt/cc-on-bedrock/sync-mcp-config.sh 2>/dev/null || true`,
    ].join("\n")).toString("base64"),
  }));

  const instanceId = result.Instances?.[0]?.InstanceId;
  if (!instanceId) throw new Error("Failed to create restored instance");

  const info = await waitForRunning(instanceId);
  await registerRoute(subdomain, info.privateIp);

  await ddbClient.send(new PutItemCommand({
    TableName: INSTANCE_TABLE,
    Item: marshall({
      user_id: subdomain,
      instanceId,
      username: record?.username ?? "",
      department: record?.department ?? "default",
      securityPolicy: record?.securityPolicy ?? "restricted",
      containerOs: previousOs,
      instanceType: info.instanceType,
      privateIp: info.privateIp,
      status: "running",
      restoredFrom: snapshotId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  }));

  // Cleanup: deregister the temporary AMI (snapshot remains)
  try {
    await ec2Client.send(new DeregisterImageCommand({ ImageId: restoredAmiId }));
  } catch { /* non-critical */ }

  return {
    instanceId,
    subdomain,
    username: record?.username ?? "",
    status: "running",
    privateIp: info.privateIp,
    instanceType: info.instanceType,
    securityPolicy: record?.securityPolicy ?? "restricted",
    containerOs: previousOs,
  };
}

/**
 * List all devenv instances.
 */
export async function listInstances(): Promise<InstanceInfo[]> {
  const result = await ddbClient.send(new ScanCommand({
    TableName: INSTANCE_TABLE,
  }));

  const records = (result.Items ?? []).map(item => unmarshall(item));
  if (records.length === 0) return [];

  // Batch describe for current status
  const instanceIds = records.map(r => r.instanceId).filter(Boolean);
  if (instanceIds.length === 0) return [];

  const desc = await ec2Client.send(new DescribeInstancesCommand({
    InstanceIds: instanceIds,
  }));

  const instanceMap = new Map<string, { status: string; privateIp: string; instanceType: string }>();
  for (const reservation of desc.Reservations ?? []) {
    for (const inst of reservation.Instances ?? []) {
      instanceMap.set(inst.InstanceId!, {
        status: inst.State?.Name ?? "unknown",
        privateIp: inst.PrivateIpAddress ?? "",
        instanceType: inst.InstanceType ?? "",
      });
    }
  }

  return records.map(r => {
    const ec2Info = instanceMap.get(r.instanceId) ?? { status: "unknown", privateIp: "", instanceType: "" };
    return {
      instanceId: r.instanceId,
      subdomain: r.user_id,
      username: r.username ?? "",
      status: ec2Info.status === "stopped" && r.status === "hibernated" ? "hibernated" : ec2Info.status,
      privateIp: ec2Info.privateIp,
      instanceType: ec2Info.instanceType,
      securityPolicy: r.securityPolicy ?? "restricted",
      containerOs: r.containerOs ?? "ubuntu",
      launchTime: r.createdAt,
    };
  });
}

// ─── Helpers ───

// ─── Pre-defined IAM Policy Sets ───

export const IAM_POLICY_SETS: Record<string, { name: string; description: string; statements: object[] }> = {
  dynamodb: {
    name: "DynamoDB Access",
    description: "Read/write access to DynamoDB tables with cc-on-bedrock prefix",
    statements: [{
      Sid: "DynamoDBAccess",
      Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem"],
      Resource: `arn:aws:dynamodb:*:*:table/cc-on-bedrock-*`,
    }],
  },
  s3_readwrite: {
    name: "S3 Read/Write",
    description: "Read/write access to user's S3 prefix",
    statements: [{
      Sid: "S3UserAccess",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      Resource: [`arn:aws:s3:::cc-on-bedrock-user-data-*`, `arn:aws:s3:::cc-on-bedrock-user-data-*/*`],
    }],
  },
  sqs: {
    name: "SQS Access",
    description: "Send/receive messages on cc-on-bedrock SQS queues",
    statements: [{
      Sid: "SQSAccess",
      Effect: "Allow",
      Action: ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      Resource: `arn:aws:sqs:*:*:cc-on-bedrock-*`,
    }],
  },
  lambda_invoke: {
    name: "Lambda Invoke",
    description: "Invoke cc-on-bedrock Lambda functions",
    statements: [{
      Sid: "LambdaInvoke",
      Effect: "Allow",
      Action: ["lambda:InvokeFunction"],
      Resource: `arn:aws:lambda:*:*:function:cc-on-bedrock-*`,
    }],
  },
  eks_readonly: {
    name: "EKS Read-Only",
    description: "Read-only access to EKS clusters for debugging",
    statements: [{
      Sid: "EKSReadOnly",
      Effect: "Allow",
      Action: ["eks:DescribeCluster", "eks:ListClusters", "eks:ListNodegroups", "eks:DescribeNodegroup"],
      Resource: "*",
    }],
  },
  cloudwatch_full: {
    name: "CloudWatch Full",
    description: "CloudWatch logs, metrics, and dashboards",
    statements: [{
      Sid: "CloudWatchFull",
      Effect: "Allow",
      Action: ["cloudwatch:*", "logs:*"],
      Resource: "*",
    }],
  },
  sns_publish: {
    name: "SNS Publish",
    description: "Publish to cc-on-bedrock SNS topics",
    statements: [{
      Sid: "SNSPublish",
      Effect: "Allow",
      Action: ["sns:Publish", "sns:ListTopics"],
      Resource: `arn:aws:sns:*:*:cc-on-bedrock-*`,
    }],
  },
  stepfunctions: {
    name: "Step Functions",
    description: "Execute and describe cc-on-bedrock state machines",
    statements: [{
      Sid: "StepFunctions",
      Effect: "Allow",
      Action: ["states:StartExecution", "states:DescribeExecution", "states:ListExecutions"],
      Resource: `arn:aws:states:*:*:stateMachine:cc-on-bedrock-*`,
    }],
  },
};

// ─── Tier/DLP/IAM Change Functions ───

/**
 * Change instance tier (instance type). Requires stop → resize → start.
 * If instance is running, it will be stopped first.
 */
export async function changeTier(
  subdomain: string,
  newTier: "light" | "standard" | "power",
): Promise<{ previousType: string; newType: string; restarted: boolean }> {
  const record = await getUserInstance(subdomain);
  if (!record?.instanceId) throw new Error(`No instance found for ${subdomain}`);

  const desc = await describeInstance(record.instanceId);
  if (!desc) throw new Error(`Instance ${record.instanceId} not found`);

  const newType = INSTANCE_TIERS[newTier].type;
  const previousType = desc.instanceType;

  if (previousType === newType) {
    return { previousType, newType, restarted: false };
  }

  const wasRunning = desc.status === "running";

  // Stop if running (must be regular stop, not hibernate — need to modify instance type)
  if (wasRunning) {
    await ec2Client.send(new StopInstancesCommand({ InstanceIds: [record.instanceId], Hibernate: false }));
    // Wait for stopped
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const check = await describeInstance(record.instanceId);
      if (check?.status === "stopped") break;
    }
  }

  // Resize
  await ec2Client.send(new ModifyInstanceAttributeCommand({
    InstanceId: record.instanceId,
    InstanceType: { Value: newType },
  }));

  // Restart if was running
  if (wasRunning) {
    await ec2Client.send(new StartInstancesCommand({ InstanceIds: [record.instanceId] }));
    const info = await waitForRunning(record.instanceId);
    await registerRoute(subdomain, info.privateIp);
  }

  await updateInstanceRecord(subdomain, { instanceType: newType });
  console.log(`[EC2] Tier changed for ${subdomain}: ${previousType} → ${newType}`);
  return { previousType, newType, restarted: wasRunning };
}

/**
 * Change DLP security policy on a running instance by swapping security groups.
 * Works instantly — no restart required.
 */
export async function changeSecurityPolicy(
  subdomain: string,
  newPolicy: "open" | "restricted" | "locked",
): Promise<{ applied: boolean }> {
  const record = await getUserInstance(subdomain);
  if (!record?.instanceId) throw new Error(`No instance found for ${subdomain}`);

  const newSgId = SG_MAP[newPolicy];
  if (!newSgId) throw new Error(`No security group configured for policy: ${newPolicy}`);

  // Get instance ENI
  const descResult = await ec2Client.send(new DescribeInstancesCommand({
    InstanceIds: [record.instanceId],
  }));
  const inst = descResult.Reservations?.[0]?.Instances?.[0];
  if (!inst) throw new Error(`Instance ${record.instanceId} not found`);

  // Only apply to running instances (stopped instances get new SG on next start)
  if (inst.State?.Name === "running") {
    const eniId = inst.NetworkInterfaces?.[0]?.NetworkInterfaceId;
    if (!eniId) throw new Error("No network interface found on instance");

    await ec2Client.send(new ModifyNetworkInterfaceAttributeCommand({
      NetworkInterfaceId: eniId,
      Groups: [newSgId],
    }));
    console.log(`[EC2] Security policy changed for ${subdomain}: → ${newPolicy} (SG: ${newSgId})`);

    // ADR-005: also re-apply the container-layer DLP (code-server config) on the
    // running instance so a tier change takes effect without a relaunch.
    // Best-effort: SG swap above is the hard guarantee; config sync may lag.
    try {
      await syncDlpCodeServerConfig(record.instanceId, newPolicy);
      console.log(`[EC2] code-server DLP config re-applied for ${subdomain} (${newPolicy})`);
    } catch (err) {
      console.warn(`[EC2] code-server DLP config sync failed for ${subdomain}:`, err);
    }
  }

  // Update tags for next start
  await ec2Client.send(new CreateTagsCommand({
    Resources: [record.instanceId],
    Tags: [{ Key: "securityPolicy", Value: newPolicy }],
  }));

  await updateInstanceRecord(subdomain, { securityPolicy: newPolicy });
  return { applied: true };
}

// ─── ADR-026 T5: resource-specific grant onto BOTH the EC2 task role and the
// Local Governance role. Server-side re-validates statements (never trust stored
// data), skips legitimately-absent roles, and fail-loud with compensating rollback
// on partial failure so approval state never diverges from actual IAM state. ───

const GRANT_LOCAL_ROLE_PREFIX = "cc-on-bedrock-local-user-";

function isNoSuchEntity(e: unknown): boolean {
  return (e as { name?: string })?.name === "NoSuchEntityException";
}

interface GrantArgs {
  subdomain: string;
  sub: string;
  requestId: string;
  statements: IamStatementInput[];
  iam?: IAMClient;
  accountId?: string;
  region?: string;
}
type IamStatementInput = import("./iam-request-validation").IamStatement;

function grantRoleNames(subdomain: string, sub: string): string[] {
  const roles: string[] = [];
  if (subdomain) roles.push(`cc-on-bedrock-task-${subdomain}`);
  if (sub) roles.push(`${GRANT_LOCAL_ROLE_PREFIX}${sub}`);
  return roles;
}

export async function applyIamGrant(args: GrantArgs): Promise<{ attached: string[] }> {
  const { validateIamRequest, DEFAULT_SERVICE_ALLOWLIST, DEFAULT_WILDCARD_OK_ACTIONS } = await import("./iam-request-validation");
  // Symmetric with the request-time path (container-request): without the account id
  // the cross-account guard cannot run, so fail closed rather than silently skip it
  // (review MINOR).
  const accountId = args.accountId ?? process.env.AWS_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("grant re-validation requires AWS_ACCOUNT_ID (cross-account guard) — server misconfigured");
  }
  const v = validateIamRequest(args.statements, {
    serviceAllowlist: DEFAULT_SERVICE_ALLOWLIST,
    wildcardOkActions: DEFAULT_WILDCARD_OK_ACTIONS,
    accountId,
    region: args.region ?? process.env.AWS_REGION,
  });
  if (!v.ok) throw new Error(`grant re-validation failed (not valid): ${v.errors.join("; ")}`);

  const iam = args.iam ?? iamClient;
  // PolicyName is per-requestId; requestId is a randomUUID per request (container-request),
  // so there is no cross-request name collision — re-approving the same request just
  // re-puts identical content (idempotent).
  const policyName = `Grant-${args.requestId}`;
  const roles = grantRoleNames(args.subdomain, args.sub);
  if (roles.length === 0) {
    // gate round-1 (Codex MAJOR): never silently "succeed" with zero target roles.
    throw new Error("grant has no target role — both subdomain and sub are empty");
  }
  const doc = JSON.stringify({
    Version: "2012-10-17",
    Statement: args.statements.map((s) => ({ Effect: "Allow", Action: s.Action, Resource: s.Resource })),
  });
  const attached: string[] = [];
  for (const roleName of roles) {
    try {
      await iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: policyName, PolicyDocument: doc }));
      attached.push(roleName);
    } catch (e) {
      if (isNoSuchEntity(e)) continue; // role legitimately absent (that mode unused)
      // compensating rollback of already-attached roles, then fail loud.
      const rollbackFailed: string[] = [];
      for (const done of attached) {
        try {
          await iam.send(new DeleteRolePolicyCommand({ RoleName: done, PolicyName: policyName }));
        } catch {
          rollbackFailed.push(done); // orphan grant — surfaced below; reconcile (T8) is the backstop
        }
      }
      const orphan = rollbackFailed.length ? ` ORPHAN GRANT on ${rollbackFailed.join(", ")} (run reconcile)` : "";
      throw new Error(`grant attach failed on ${roleName}: ${e instanceof Error ? e.message : e}; rolled back ${attached.filter((r) => !rollbackFailed.includes(r)).join(", ") || "none"}.${orphan}`);
    }
  }
  return { attached };
}

export async function removeIamGrant(args: { subdomain: string; sub: string; requestId: string; iam?: IAMClient }): Promise<void> {
  const iam = args.iam ?? iamClient;
  const policyName = `Grant-${args.requestId}`;
  for (const roleName of grantRoleNames(args.subdomain, args.sub)) {
    try {
      await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
    } catch (e) {
      if (isNoSuchEntity(e)) continue; // role or policy already gone — fine
      throw new Error(`grant remove failed on ${roleName}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/**
 * Add IAM policy set to a user's per-user role.
 * Uses pre-defined policy sets from IAM_POLICY_SETS.
 */
export async function addIamPolicySet(
  subdomain: string,
  policySetId: string,
): Promise<{ policyName: string; applied: boolean }> {
  const policySet = IAM_POLICY_SETS[policySetId];
  if (!policySet) throw new Error(`Unknown policy set: ${policySetId}`);

  const roleName = `cc-on-bedrock-task-${subdomain}`;
  const policyName = `PolicySet-${policySetId}`;

  // Verify role exists
  try {
    await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
  } catch {
    throw new Error(`Per-user role not found: ${roleName}. Start the instance first.`);
  }

  // Attach policy
  await iamClient.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: policyName,
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: policySet.statements,
    }),
  }));

  console.log(`[IAM] Policy set "${policySetId}" added to role ${roleName}`);
  return { policyName, applied: true };
}

/**
 * Remove IAM policy set from a user's per-user role.
 */
export async function removeIamPolicySet(
  subdomain: string,
  policySetId: string,
): Promise<void> {
  const roleName = `cc-on-bedrock-task-${subdomain}`;
  const policyName = `PolicySet-${policySetId}`;

  const { DeleteRolePolicyCommand } = await import("@aws-sdk/client-iam");
  await iamClient.send(new DeleteRolePolicyCommand({
    RoleName: roleName,
    PolicyName: policyName,
  }));

  console.log(`[IAM] Policy set "${policySetId}" removed from role ${roleName}`);
}

// ─── Internal Helpers ───

interface UserInstanceRecord {
  instanceId: string;
  username?: string;
  department?: string;
  securityPolicy?: string;
  containerOs?: string;
  [key: string]: unknown;
}

async function getUserInstance(subdomain: string): Promise<UserInstanceRecord | null> {
  try {
    const result = await ddbClient.send(new GetItemCommand({
      TableName: INSTANCE_TABLE,
      Key: marshall({ user_id: subdomain }),
    }));
    if (!result.Item) return null;
    const item = unmarshall(result.Item);
    return item as UserInstanceRecord;
  } catch {
    return null;
  }
}

async function describeInstance(instanceId: string): Promise<{ status: string; privateIp: string; instanceType: string; eniId?: string } | null> {
  try {
    const result = await ec2Client.send(new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    }));
    const inst = result.Reservations?.[0]?.Instances?.[0];
    if (!inst) return null;
    return {
      status: inst.State?.Name ?? "unknown",
      privateIp: inst.PrivateIpAddress ?? "",
      instanceType: inst.InstanceType ?? "",
      eniId: inst.NetworkInterfaces?.[0]?.NetworkInterfaceId,
    };
  } catch {
    return null;
  }
}

async function waitForRunning(instanceId: string): Promise<{ privateIp: string; instanceType: string }> {
  // Poll for running state (max 60 attempts × 5s = 5 min)
  for (let i = 0; i < 60; i++) {
    const desc = await describeInstance(instanceId);
    if (desc?.status === "running" && desc.privateIp) {
      return { privateIp: desc.privateIp, instanceType: desc.instanceType };
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Instance ${instanceId} did not reach running state`);
}

async function isHibernateCapable(instanceId: string): Promise<boolean> {
  try {
    const result = await ec2Client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const inst = result.Reservations?.[0]?.Instances?.[0];
    return inst?.HibernationOptions?.Configured === true;
  } catch {
    return false;
  }
}

async function registerRoute(subdomain: string, privateIp: string): Promise<void> {
  // ADR-027: seed default routes on first boot; carry authoritative customRoutes onto the
  // routing-table row so config-gen renders them. (This is the LIVE path — startInstance/
  // restoreFromSnapshot/changeTier/switchOs all call here.)
  await seedCustomRoutesIfUnset(subdomain);
  const { customRoutes, routesVersion } = await getCustomRoutes(subdomain);

  // M7: UpdateItem (not PutItem) so a concurrent settings mirror with a newer routesVersion
  // isn't wiped on restart/resize. Core registration fields always set.
  await ddbClient.send(new UpdateItemCommand({
    TableName: ROUTING_TABLE,
    Key: marshall({ subdomain }),
    // NOTE: both `port` and `status` are DynamoDB reserved words → must be aliased.
    UpdateExpression: "SET container_ip = :ip, #pt = :p, #st = :s, registered_at = :t",
    ExpressionAttributeNames: { "#st": "status", "#pt": "port" },
    ExpressionAttributeValues: marshall({
      ":ip": privateIp, ":p": 8080, ":s": "active", ":t": new Date().toISOString(),
    }),
  }));

  // version-guarded customRoutes write (don't clobber a newer concurrent settings mirror)
  try {
    await ddbClient.send(new UpdateItemCommand({
      TableName: ROUTING_TABLE,
      Key: marshall({ subdomain }),
      UpdateExpression: "SET customRoutes = :r, routesVersion = :v",
      ConditionExpression: "attribute_not_exists(routesVersion) OR routesVersion <= :v",
      ExpressionAttributeValues: marshall({ ":r": JSON.stringify(customRoutes), ":v": routesVersion }),
    }));
  } catch (err) {
    if (!(err instanceof Error && err.name === "ConditionalCheckFailedException")) throw err;
    // newer mirror exists → keep it
  }
  console.log(`[Routing] Registered ${subdomain} → ${privateIp}:8080 (+${customRoutes.length} custom)`);
}

async function deregisterRoute(subdomain: string): Promise<void> {
  try {
    await ddbClient.send(new DeleteItemCommand({
      TableName: ROUTING_TABLE,
      Key: marshall({ subdomain }),
    }));
    console.log(`[Routing] Deregistered ${subdomain}`);
  } catch (err) {
    console.warn(`[Routing] Deregister failed for ${subdomain}:`, err);
  }
}

/**
 * Sync code-server password from Secrets Manager to a running EC2 instance.
 * UserData only runs on first boot; this ensures password changes are applied on Start.
 */
async function syncCodeserverPassword(instanceId: string, subdomain: string): Promise<void> {
  try {
    const password = await ensureCodeserverPassword(subdomain);
    await ssmClient.send(new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: {
        commands: [
          `sed -i 's/^password:.*/password: "${password}"/' /home/coder/.config/code-server/config.yaml`,
          `systemctl restart code-server 2>/dev/null || true`,
        ],
      },
      TimeoutSeconds: 30,
    }));
    console.log(`[EC2] Synced code-server password for ${subdomain} on ${instanceId}`);
  } catch (err) {
    console.warn(`[EC2] Password sync failed for ${subdomain}:`, err);
  }
}

/**
 * Post-start setup: update Claude Code CLI + start CWAgent.
 * Runs on every instance start (not just first boot) via SSM Run Command.
 * Fire-and-forget: non-blocking to avoid slowing instance start.
 */
async function postStartSetup(instanceId: string): Promise<void> {
  try {
    await ssmClient.send(new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: {
        commands: [
          `# Heal ~/.claude ownership (old AMI's cc-mcp-sync created it as root,`,
          `# which breaks Claude Code state writes + the self-update below)`,
          `mkdir -p /home/coder/.claude && chown -R coder:coder /home/coder/.claude`,
          `# Upgrade Claude Code + Kiro CLI (as coder user, symlink to /usr/local/bin)`,
          `sudo -u coder bash -c 'curl -fsSL https://claude.ai/install.sh | bash' 2>&1 || true`,
          `[ -f /home/coder/.local/bin/claude ] && ln -sf /home/coder/.local/bin/claude /usr/local/bin/claude`,
          `sudo -u coder bash -c 'curl -fsSL https://cli.kiro.dev/install | bash' 2>&1 || true`,
          `[ -f /home/coder/.local/bin/kiro ] && ln -sf /home/coder/.local/bin/kiro /usr/local/bin/kiro`,
          `# Start CWAgent for memory/disk metrics`,
          `if command -v amazon-cloudwatch-agent-ctl &>/dev/null; then`,
          `  amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json 2>/dev/null || amazon-cloudwatch-agent-ctl -a start 2>/dev/null || true`,
          `fi`,
        ],
      },
      TimeoutSeconds: 120,
    }));
    console.log(`[EC2] Post-start setup initiated for ${instanceId}`);
  } catch (err) {
    console.warn(`[EC2] Post-start setup failed for ${instanceId}:`, err);
  }
}

const ROLE_PREFIX = "cc-on-bedrock-task";  // Reuse same naming convention as ECS for CloudTrail compatibility

async function ensureCodeserverPassword(subdomain: string): Promise<string> {
  const secretName = `cc-on-bedrock/codeserver/${subdomain}`;
  // Read existing or generate new
  try {
    const existing = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    if (existing.SecretString) return existing.SecretString;
  } catch { /* not found — create */ }

  const password = randomBytes(16).toString("hex");
  try {
    await secretsClient.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: password }));
  } catch {
    await secretsClient.send(new CreateSecretCommand({
      Name: secretName,
      SecretString: password,
      Description: `code-server password for ${subdomain}`,
    }));
  }
  console.log(`[Password] Generated code-server password for ${subdomain}`);
  return password;
}

/**
 * Apply AgentCore Gateway inline policy to per-user role.
 * Grants InvokeGateway on the common gateway + department-specific gateway.
 * Called on every instance start to keep gateway ARNs current.
 */
async function applyGatewayPolicy(roleName: string, department: string): Promise<void> {
  try {
    // Query DDB for department and common gateway IDs
    const { DynamoDBDocumentClient, GetCommand } = await import("@aws-sdk/lib-dynamodb");
    const docClient = DynamoDBDocumentClient.from(ddbClient);

    const gatewayArns: string[] = [];

    // Common gateway
    const commonResult = await docClient.send(new GetCommand({
      TableName: "cc-dept-mcp-config",
      Key: { PK: "COMMON", SK: "GATEWAY" },
    }));
    if (commonResult.Item?.gatewayId) {
      gatewayArns.push(`arn:aws:bedrock-agentcore:${region}:${accountId}:gateway/${commonResult.Item.gatewayId}`);
    }

    // Department gateway
    if (department) {
      const deptResult = await docClient.send(new GetCommand({
        TableName: "cc-dept-mcp-config",
        Key: { PK: `DEPT#${department}`, SK: "GATEWAY" },
      }));
      if (deptResult.Item?.gatewayId) {
        gatewayArns.push(`arn:aws:bedrock-agentcore:${region}:${accountId}:gateway/${deptResult.Item.gatewayId}`);
      }
    }

    if (gatewayArns.length === 0) {
      console.log(`[IAM] No gateways found for dept=${department}, skipping gateway policy`);
      return;
    }

    // Also allow DDB read for boot-time MCP config sync
    await iamClient.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "AgentCoreGatewayAccess",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "InvokeGateway",
            Effect: "Allow",
            Action: "bedrock-agentcore:InvokeGateway",
            Resource: gatewayArns,
          },
          {
            Sid: "McpConfigRead",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Resource: `arn:aws:dynamodb:${region}:${accountId}:table/cc-dept-mcp-config`,
          },
        ],
      }),
    }));

    console.log(`[IAM] Applied gateway policy to ${roleName}: ${gatewayArns.length} gateway(s)`);
  } catch (err) {
    console.warn(`[IAM] Failed to apply gateway policy to ${roleName}:`, err);
    // Non-fatal — instance can still start without gateway access
  }
}

// RunInstances right after CreateInstanceProfile + AddRoleToInstanceProfile occasionally
// fails with InvalidParameterValue "Invalid IAM Instance Profile name" because the EC2
// control plane hasn't yet seen the new profile (IAM eventual consistency). A short
// sleep after CreateInstanceProfile is not always enough; retry on that specific error.
async function runInstancesWithIamRetry(
  params: ConstructorParameters<typeof RunInstancesCommand>[0],
  maxAttempts = 6,
) {
  let delay = 2000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await ec2Client.send(new RunInstancesCommand(params));
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      const isPropagation =
        msg.includes("Invalid IAM Instance Profile name") ||
        msg.includes("iamInstanceProfile.name is invalid");
      if (!isPropagation || attempt === maxAttempts - 1) throw err;
      console.warn(`[EC2] IAM instance profile not yet visible (attempt ${attempt + 1}/${maxAttempts}); sleeping ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }
  // Unreachable — the last iteration either returns or throws.
  throw new Error("runInstancesWithIamRetry: exhausted retries (should not happen)");
}

async function ensureUserInstanceProfile(subdomain: string, username: string, department: string): Promise<string> {
  const roleName = `${ROLE_PREFIX}-${subdomain}`;
  const profileName = roleName;

  // Cost allocation tags for AWS Billing integration (ADR-011 canonical schema).
  // Same key set is emitted by sts-issuer.py for Local Governance role tags so CUR 2.0
  // sees a unified attribution surface across EC2 DevEnv and Local Governance modes.
  const costAllocationTags = [
    { Key: "username", Value: username },
    { Key: "department", Value: department },
    { Key: "project", Value: "cc-on-bedrock" },
    { Key: "subdomain", Value: subdomain },
    { Key: "cost-center", Value: department },
  ];

  // Check if role already exists
  let roleExists = false;
  try {
    await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
    roleExists = true;
    await iamClient.send(new TagRoleCommand({ RoleName: roleName, Tags: costAllocationTags }));
  } catch {
    console.log(`[IAM] Creating per-user role: ${roleName}`);
    await iamClient.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "ec2.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
      PermissionsBoundary: `arn:aws:iam::${accountId}:policy/cc-on-bedrock-task-boundary`,
      Description: `Per-user EC2 DevEnv Role for ${subdomain}`,
      Tags: [
        { Key: "cc-on-bedrock", Value: "user-instance-role" },
        // subdomain is part of costAllocationTags; spreading it again here causes
        // CreateRole to reject with "Duplicate tag keys found".
        ...costAllocationTags,
      ],
    }));
    // Short propagation sleep so the immediately-following PutRolePolicy +
    // applyGatewayPolicy calls don't race CreateRole with NoSuchEntity (their
    // failure path is not wrapped in retry — only RunInstances has
    // runInstancesWithIamRetry below). 3s is enough for IAM internal
    // consistency; the RunInstances-vs-instance-profile race takes longer and
    // is absorbed by the retry helper.
    await new Promise(r => setTimeout(r, 3000));
  }

  // Upsert Bedrock + SSM + CloudWatch permissions (runs on every start to fix legacy roles)
  await iamClient.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: "DevenvAccess",
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "BedrockClaude",
          Effect: "Allow",
          Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"],
          // ADR-021: wildcard Claude-family across all region prefixes
          // (anthropic./global./us./apac./eu./future). MUST mirror
          // lambda/user-role-provisioner.py:_ec2_task_inline_policy and
          // Terraform task permission boundary — otherwise
          // EC2-mode users get AccessDenied on `global.anthropic.claude-*`
          // direct InvokeModel.
          Resource: [
            `arn:aws:bedrock:*::foundation-model/*anthropic.claude-*`,
            `arn:aws:bedrock:*:${accountId}:inference-profile/*anthropic.claude-*`,
            `arn:aws:bedrock:*::foundation-model/*embed*`,
            `arn:aws:bedrock:*:${accountId}:inference-profile/*embed*`,
            `arn:aws:bedrock:*:${accountId}:application-inference-profile/*`,
          ],
        },
        {
          Sid: "SSMSessionManager",
          Effect: "Allow",
          Action: ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel", "ssm:UpdateInstanceInformation"],
          Resource: "*",
        },
        {
          Sid: "CloudWatch",
          Effect: "Allow",
          Action: ["cloudwatch:PutMetricData", "logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"],
          Resource: "*",
        },
      ],
    }),
  }));

  // Apply AgentCore Gateway access policy (updates on every start to reflect dept changes)
  await applyGatewayPolicy(roleName, department);

  // Ensure instance profile exists AND has the role attached. Handles the orphan
  // case where a previous run created the profile but crashed before attaching the
  // role (the provisioner Lambda for example, before PassRole permission was added).
  try {
    const got = await iamClient.send(new GetInstanceProfileCommand({ InstanceProfileName: profileName }));
    const attached = got.InstanceProfile?.Roles ?? [];
    if (!attached.some(r => r.RoleName === roleName)) {
      await iamClient.send(new AddRoleToInstanceProfileCommand({
        InstanceProfileName: profileName,
        RoleName: roleName,
      }));
      await new Promise(r => setTimeout(r, 5000)); // propagation
    }
  } catch {
    await iamClient.send(new CreateInstanceProfileCommand({ InstanceProfileName: profileName }));
    await iamClient.send(new AddRoleToInstanceProfileCommand({
      InstanceProfileName: profileName,
      RoleName: roleName,
    }));
    await new Promise(r => setTimeout(r, 5000)); // propagation
  }

  return profileName;
}

async function updateInstanceRecord(subdomain: string, updates: Record<string, string>): Promise<void> {
  const { DynamoDBDocumentClient, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const docClient = DynamoDBDocumentClient.from(ddbClient);

  const expressions: string[] = ["#updatedAt = :now"];
  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, string> = { ":now": new Date().toISOString() };

  for (const [key, value] of Object.entries(updates)) {
    expressions.push(`#${key} = :${key}`);
    names[`#${key}`] = key;
    values[`:${key}`] = value;
  }

  await docClient.send(new UpdateCommand({
    TableName: INSTANCE_TABLE,
    Key: { user_id: subdomain },
    UpdateExpression: `SET ${expressions.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// ─── Custom Port Routes store (ADR-027) ───

export const DEFAULT_SEED_ROUTES: CustomRoute[] = [
  { path: "/", port: 3000, label: "Frontend" },
  { path: "/api", port: 8000, label: "API" },
];

/** cc-user-instances 에서 customRoutes + version 조회. 없으면 [] / 0. */
export async function getCustomRoutes(subdomain: string): Promise<CustomRoutesRecord> {
  const result = await ddbClient.send(new GetItemCommand({
    TableName: INSTANCE_TABLE,
    Key: marshall({ user_id: subdomain }),
  }));
  if (!result.Item) return { customRoutes: [], routesVersion: 0, exists: false };
  const item = unmarshall(result.Item);
  return {
    customRoutes: (item.customRoutes as CustomRoute[]) ?? [],
    routesVersion: (item.routesVersion as number) ?? 0,
    routeStatus: item.routeStatus,
    exists: true,
  };
}

/**
 * 여러 subdomain의 customRoutes를 BatchGetItem 한 번(들)으로 조회 (M2: admin 목록 N+1 제거).
 * 반환: Map<subdomain, CustomRoute[]>. 행 없으면 키 부재.
 */
export async function batchGetCustomRoutes(
  subdomains: string[],
): Promise<Map<string, CustomRoute[]>> {
  const out = new Map<string, CustomRoute[]>();
  const uniq = [...new Set(subdomains.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    let keys = chunk.map((s) => marshall({ user_id: s }));
    // BatchGetItem may return UnprocessedKeys — retry a few times.
    for (let attempt = 0; attempt < 3 && keys.length > 0; attempt++) {
      const res = await ddbClient.send(new BatchGetItemCommand({
        RequestItems: {
          [INSTANCE_TABLE]: { Keys: keys, ProjectionExpression: "user_id, customRoutes" },
        },
      }));
      for (const raw of res.Responses?.[INSTANCE_TABLE] ?? []) {
        const item = unmarshall(raw);
        out.set(item.user_id as string, (item.customRoutes as CustomRoute[]) ?? []);
      }
      keys = res.UnprocessedKeys?.[INSTANCE_TABLE]?.Keys ?? [];
    }
  }
  return out;
}

/**
 * customRoutes 를 expectedVersion 기반 조건부 쓰기로 갱신(lost-update 방지).
 * 성공 시 새 version(=expectedVersion+1) 반환. 충돌 시 throw('version-conflict').
 */
export async function putCustomRoutes(
  subdomain: string,
  routes: CustomRoute[],
  expectedVersion: number,
): Promise<number> {
  const nextVersion = expectedVersion + 1;
  try {
    await ddbClient.send(new UpdateItemCommand({
      TableName: INSTANCE_TABLE,
      Key: marshall({ user_id: subdomain }),
      UpdateExpression: "SET customRoutes = :r, routesVersion = :nv",
      // attribute_exists(user_id): the instance row must already exist, so a delete
      // racing between the PUT handler's existence check and this UpdateItem cannot
      // UPSERT a phantom row (without it, attribute_not_exists(routesVersion) is true
      // on a missing row → upsert). Mirrors config-gen's write_route_status guard.
      ConditionExpression: "attribute_exists(user_id) AND (attribute_not_exists(routesVersion) OR routesVersion = :ev)",
      ExpressionAttributeValues: marshall({
        ":r": routes,
        ":nv": nextVersion,
        ":ev": expectedVersion,
      }),
    }));
    return nextVersion;
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      throw new Error("version-conflict");
    }
    throw err;
  }
}

/** customRoutes 미설정(속성 없음)이면 seed 1회 주입. 빈 배열은 "전부 삭제"로 보고 주입 안 함. */
export async function seedCustomRoutesIfUnset(subdomain: string): Promise<CustomRoute[]> {
  const result = await ddbClient.send(new GetItemCommand({
    TableName: INSTANCE_TABLE,
    Key: marshall({ user_id: subdomain }),
  }));
  const item = result.Item ? unmarshall(result.Item) : null;
  if (item && Array.isArray(item.customRoutes)) {
    return item.customRoutes as CustomRoute[]; // 이미 설정됨(빈 배열 포함)
  }
  try {
    await ddbClient.send(new UpdateItemCommand({
      TableName: INSTANCE_TABLE,
      Key: marshall({ user_id: subdomain }),
      UpdateExpression: "SET customRoutes = :r, routesVersion = if_not_exists(routesVersion, :z)",
      ConditionExpression: "attribute_not_exists(customRoutes)",
      ExpressionAttributeValues: marshall({ ":r": DEFAULT_SEED_ROUTES, ":z": 0 }),
    }));
  } catch (err) {
    // Only the seed race (someone else seeded first) is expected/ignorable; surface anything else.
    if (!(err instanceof Error && err.name === "ConditionalCheckFailedException")) {
      console.warn("[seedCustomRoutesIfUnset] unexpected error:", err instanceof Error ? err.message : err);
    }
  }
  return DEFAULT_SEED_ROUTES;
}
