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
  ModifyInstanceAttributeCommand,
  ModifyNetworkInterfaceAttributeCommand,
} from "@aws-sdk/client-ec2";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
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
}

export interface InstanceInfo {
  instanceId: string;
  subdomain: string;
  username: string;
  status: string;  // running / stopped / terminated
  privateIp: string;
  instanceType: string;
  securityPolicy: string;
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

      // Update routing table
      await registerRoute(input.subdomain, info.privateIp);

      // Update DynamoDB
      await updateInstanceRecord(input.subdomain, {
        status: "running",
        privateIp: info.privateIp,
      });

      return { instanceId: existing.instanceId, ...info, subdomain: input.subdomain, username: input.username, securityPolicy: input.securityPolicy, status: "running" };
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
      };
    }
  }

  // No existing instance — create new from Launch Template
  console.log(`[EC2] Creating new instance for ${input.subdomain}`);

  // Get AMI ID from SSM
  let amiId: string | undefined;
  try {
    const param = await ssmClient.send(new GetParameterCommand({
      Name: "/cc-on-bedrock/devenv/ami-id",
    }));
    amiId = param.Parameter?.Value;
  } catch {
    throw new Error("AMI ID not found in SSM parameter /cc-on-bedrock/devenv/ami-id. Run scripts/build-ami.sh first.");
  }

  const sg = SG_MAP[input.securityPolicy] || SG_MAP.open;
  const subnet = VPC_SUBNET_IDS[Math.floor(Math.random() * VPC_SUBNET_IDS.length)];
  const tier = INSTANCE_TIERS[input.resourceTier ?? "standard"];

  // Per-user instance profile for individual Bedrock usage tracking
  const instanceProfileName = await ensureUserInstanceProfile(input.subdomain, input.username, input.department);

  // Per-user code-server password (Secrets Manager)
  const codeserverPassword = await ensureCodeserverPassword(input.subdomain);

  const result = await ec2Client.send(new RunInstancesCommand({
    ImageId: amiId!,
    IamInstanceProfile: { Name: instanceProfileName },
    InstanceType: tier.type as never,
    MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 2 },
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
        { Key: "managed_by", Value: "cc-on-bedrock" },
      ],
    }],
    UserData: Buffer.from([
      "#!/bin/bash",
      `echo "USER_SUBDOMAIN=${input.subdomain}" >> /etc/environment`,
      `echo "CLAUDE_CODE_USE_BEDROCK=1" >> /etc/environment`,
      `echo "ANTHROPIC_MODEL=global.anthropic.claude-sonnet-4-6" >> /etc/environment`,
      `echo "AWS_DEFAULT_REGION=${region}" >> /etc/environment`,
      `# Ensure workspace directory exists`,
      `sudo -u coder mkdir -p /home/coder/workspace`,
      `# Set per-user code-server password`,
      `mkdir -p /home/coder/.config/code-server`,
      `cat > /home/coder/.config/code-server/config.yaml << 'CSCFG'`,
      `bind-addr: 0.0.0.0:8080`,
      `auth: password`,
      `password: ${codeserverPassword}`,
      `cert: false`,
      `CSCFG`,
      `chown -R coder:coder /home/coder/.config`,
      `systemctl restart code-server || systemctl start code-server`,
      `# Start CloudWatch Agent for memory/disk metrics`,
      `if [ -f /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json ]; then`,
      `  amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json 2>/dev/null || true`,
      `else`,
      `  systemctl start amazon-cloudwatch-agent 2>/dev/null || true`,
      `fi`,
    ].join("\n")).toString("base64"),
  }));

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
  };
}

/**
 * Stop a user's instance. EBS volume preserved automatically.
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

  // Stop instance (EBS preserved)
  await ec2Client.send(new StopInstancesCommand({
    InstanceIds: [record.instanceId],
  }));

  await updateInstanceRecord(subdomain, { status: "stopped" });
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
      status: ec2Info.status,
      privateIp: ec2Info.privateIp,
      instanceType: ec2Info.instanceType,
      securityPolicy: r.securityPolicy ?? "open",
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

  // Stop if running
  if (wasRunning) {
    await ec2Client.send(new StopInstancesCommand({ InstanceIds: [record.instanceId] }));
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

async function getUserInstance(subdomain: string): Promise<{ instanceId: string } | null> {
  try {
    const result = await ddbClient.send(new GetItemCommand({
      TableName: INSTANCE_TABLE,
      Key: marshall({ user_id: subdomain }),
    }));
    if (!result.Item) return null;
    const item = unmarshall(result.Item);
    return { instanceId: item.instanceId };
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

async function ensureUserInstanceProfile(subdomain: string, username: string, department: string): Promise<string> {
  const roleName = `${ROLE_PREFIX}-${subdomain}`;
  const profileName = roleName;

  // Cost allocation tags for AWS Billing integration (Bedrock IAM Cost Allocation)
  const costAllocationTags = [
    { Key: "username", Value: username },
    { Key: "department", Value: department },
    { Key: "project", Value: "cc-on-bedrock" },
  ];

  // Check if role already exists
  try {
    await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
    // Sync cost allocation tags on existing role (ensures tags stay current)
    await iamClient.send(new TagRoleCommand({ RoleName: roleName, Tags: costAllocationTags }));
  } catch {
    // Create per-user role with EC2 trust
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
        { Key: "subdomain", Value: subdomain },
        ...costAllocationTags,
      ],
    }));

    // Attach Bedrock + SSM + CloudWatch permissions
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
            Action: ["cloudwatch:PutMetricData", "logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: "*",
          },
        ],
      }),
    }));

    // Wait for IAM propagation
    await new Promise(r => setTimeout(r, 8000));
  }

  // Ensure instance profile exists
  try {
    await iamClient.send(new GetInstanceProfileCommand({ InstanceProfileName: profileName }));
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
