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

// DLP Security Group IDs (from CDK outputs / env vars)
const SG_MAP: Record<string, string> = {
  open: process.env.SG_DEVENV_OPEN ?? "",
  restricted: process.env.SG_DEVENV_RESTRICTED ?? "",
  locked: process.env.SG_DEVENV_LOCKED ?? "",
};

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

      console.log(`[EC2] Starting existing instance ${existing.instanceId} for ${input.subdomain}`);
      await ec2Client.send(new StartInstancesCommand({
        InstanceIds: [existing.instanceId],
      }));

      // Wait for running + get IP
      const info = await waitForRunning(existing.instanceId);

      // Sync code-server password from Secrets Manager (UserData only runs on first boot)
      await syncCodeserverPassword(existing.instanceId, input.subdomain);

      // Update Claude CLI + start CWAgent (fire-and-forget)
      postStartSetup(existing.instanceId);

      // Update routing table
      await registerRoute(input.subdomain, info.privateIp);

      // Update DynamoDB
      await updateInstanceRecord(input.subdomain, {
        status: "running",
        privateIp: info.privateIp,
      });

      return { instanceId: existing.instanceId, ...info, subdomain: input.subdomain, username: input.username, securityPolicy: input.securityPolicy, containerOs: existing.containerOs ?? "ubuntu", status: "running" };
    }

    if (desc && desc.status === "running") {
      console.log(`[EC2] Instance ${existing.instanceId} already running for ${input.subdomain}`);
      return {
        instanceId: existing.instanceId,
        subdomain: input.subdomain,
        username: input.username,
        status: "running",
        privateIp: desc.privateIp,
        instanceType: desc.instanceType,
        securityPolicy: input.securityPolicy,
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

  const sg = SG_MAP[input.securityPolicy] || SG_MAP.open;
  const subnet = VPC_SUBNET_IDS[Math.floor(Math.random() * VPC_SUBNET_IDS.length)];
  const tier = INSTANCE_TIERS[input.resourceTier ?? "standard"];

  // Per-user instance profile for individual Bedrock usage tracking
  const instanceProfileName = await ensureUserInstanceProfile(input.subdomain, input.username, input.department);

  // Per-user code-server password (Secrets Manager)
  const codeserverPassword = await ensureCodeserverPassword(input.subdomain);

  const result = await runInstancesWithIamRetry({
    ImageId: amiId!,
    IamInstanceProfile: { Name: instanceProfileName },
    InstanceType: tier.type as never,
    MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 2 },
    HibernationOptions: HIBERNATE_ENABLED ? { Configured: true } : undefined,
    MinCount: 1,
    MaxCount: 1,
    SubnetId: subnet,
    SecurityGroupIds: sg ? [sg] : undefined,
    TagSpecifications: [{
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
      ],
    }],
    UserData: Buffer.from([
      "#!/bin/bash",
      `echo "USER_SUBDOMAIN=${input.subdomain}" >> /etc/environment`,
      `echo "CLAUDE_CODE_USE_BEDROCK=1" >> /etc/environment`,
      `echo "ANTHROPIC_MODEL=global.anthropic.claude-sonnet-4-6" >> /etc/environment`,
      `echo "AWS_DEFAULT_REGION=${region}" >> /etc/environment`,
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
      `CSCFG`,
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
      `# Upgrade Claude Code + Kiro CLI (symlink to /usr/local/bin for PATH)`,
      `sudo -u coder bash -c 'curl -fsSL https://claude.ai/install.sh | bash' 2>/dev/null || true`,
      `[ -f /home/coder/.local/bin/claude ] && ln -sf /home/coder/.local/bin/claude /usr/local/bin/claude`,
      `sudo -u coder bash -c 'curl -fsSL https://cli.kiro.dev/install | bash' 2>/dev/null || true`,
      `[ -f /home/coder/.local/bin/kiro ] && ln -sf /home/coder/.local/bin/kiro /usr/local/bin/kiro`,
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
      securityPolicy: input.securityPolicy,
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
    securityPolicy: input.securityPolicy,
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
  const sg = SG_MAP[(record?.securityPolicy ?? "restricted")] || SG_MAP.open;
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
    TagSpecifications: [{
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
      ],
    }],
    UserData: Buffer.from([
      "#!/bin/bash",
      `echo "USER_SUBDOMAIN=${subdomain}" >> /etc/environment`,
      `echo "CLAUDE_CODE_USE_BEDROCK=1" >> /etc/environment`,
      `echo "ANTHROPIC_MODEL=global.anthropic.claude-sonnet-4-6" >> /etc/environment`,
      `echo "AWS_DEFAULT_REGION=${region}" >> /etc/environment`,
      `mkdir -p /home/coder/.config/code-server`,
      `cat > /home/coder/.config/code-server/config.yaml << 'CSCFG'`,
      `bind-addr: 0.0.0.0:8080`,
      `auth: password`,
      `password: "${codeserverPassword}"`,
      `cert: false`,
      `CSCFG`,
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
      `# Upgrade Claude Code + Kiro CLI (symlink to /usr/local/bin for PATH)`,
      `sudo -u coder bash -c 'curl -fsSL https://claude.ai/install.sh | bash' 2>/dev/null || true`,
      `[ -f /home/coder/.local/bin/claude ] && ln -sf /home/coder/.local/bin/claude /usr/local/bin/claude`,
      `sudo -u coder bash -c 'curl -fsSL https://cli.kiro.dev/install | bash' 2>/dev/null || true`,
      `[ -f /home/coder/.local/bin/kiro ] && ln -sf /home/coder/.local/bin/kiro /usr/local/bin/kiro`,
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
      securityPolicy: r.securityPolicy ?? "open",
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
  }

  // Update tags for next start
  await ec2Client.send(new CreateTagsCommand({
    Resources: [record.instanceId],
    Tags: [{ Key: "securityPolicy", Value: newPolicy }],
  }));

  await updateInstanceRecord(subdomain, { securityPolicy: newPolicy });
  return { applied: true };
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

async function describeInstance(instanceId: string): Promise<{ status: string; privateIp: string; instanceType: string } | null> {
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
  await ddbClient.send(new PutItemCommand({
    TableName: ROUTING_TABLE,
    Item: marshall({
      subdomain,
      container_ip: privateIp,
      port: 8080,
      status: "active",
      registered_at: new Date().toISOString(),
    }),
  }));
  console.log(`[Routing] Registered ${subdomain} → ${privateIp}:8080`);
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
          Resource: [
            `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
            `arn:aws:bedrock:*:${accountId}:inference-profile/*anthropic.claude-*`,
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
