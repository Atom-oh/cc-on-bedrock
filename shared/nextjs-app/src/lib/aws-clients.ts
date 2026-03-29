import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminAddUserToGroupCommand,
  ListUsersCommand,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  DescribeTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import {
  EFSClient,
  CreateAccessPointCommand,
  DescribeAccessPointsCommand,
} from "@aws-sdk/client-efs";
import {
  ElasticLoadBalancingV2Client,
  CreateTargetGroupCommand,
  RegisterTargetsCommand,
  DeregisterTargetsCommand,
  CreateRuleCommand,
  DeleteRuleCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  DescribeRulesCommand,
  DeleteTargetGroupCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type {
  CognitoUser,
  CreateUserInput,
  UpdateUserInput,
  ContainerInfo,
  StartContainerInput,
  StopContainerInput,
} from "./types";
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  GetRoleCommand,
} from "@aws-sdk/client-iam";
import {
  LambdaClient,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
const ecsCluster = process.env.ECS_CLUSTER_NAME ?? "cc-on-bedrock-cluster";
const domainName = process.env.DOMAIN_NAME ?? "atomai.click";
const devSubdomain = process.env.DEV_SUBDOMAIN ?? "dev";
const accountId = process.env.AWS_ACCOUNT_ID ?? "";
const TASK_ROLE_PREFIX = "cc-on-bedrock-task";
const lambdaClient = new LambdaClient({ region });
const s3SyncBucket = process.env.S3_SYNC_BUCKET ?? "";

const MAX_COGNITO_PAGES = 20;

const cognitoClient = new CognitoIdentityProviderClient({ region });
const ecsClient = new ECSClient({ region });
const elbv2Client = new ElasticLoadBalancingV2Client({ region });
const iamClient = new IAMClient({ region });
const secretsClient = new SecretsManagerClient({ region });
const efsClientSdk = new EFSClient({ region });
const efsFileSystemId = process.env.EFS_FILE_SYSTEM_ID ?? "";

const devenvAlbListenerArn = process.env.DEVENV_ALB_LISTENER_ARN ?? "";
const vpcId = process.env.VPC_ID ?? "";

// ─── Helper: Parse Cognito attributes ───

function getAttr(
  attrs: AttributeType[] | undefined,
  name: string
): string | undefined {
  return attrs?.find((a) => a.Name === name)?.Value;
}

function toCognitoUser(user: {
  Username?: string;
  Attributes?: AttributeType[];
  Enabled?: boolean;
  UserStatus?: string;
  UserCreateDate?: Date;
}): CognitoUser {
  const attrs = user.Attributes;
  return {
    username: user.Username ?? "",
    email: getAttr(attrs, "email") ?? "",
    enabled: user.Enabled ?? false,
    status: user.UserStatus ?? "UNKNOWN",
    createdAt: user.UserCreateDate?.toISOString() ?? "",
    subdomain: getAttr(attrs, "custom:subdomain") ?? "",
    department: getAttr(attrs, "custom:department") ?? "default",
    containerOs: (getAttr(attrs, "custom:container_os") as CognitoUser["containerOs"]) ?? "ubuntu",
    resourceTier: (getAttr(attrs, "custom:resource_tier") as CognitoUser["resourceTier"]) ?? "standard",
    securityPolicy: (getAttr(attrs, "custom:security_policy") as CognitoUser["securityPolicy"]) ?? "restricted",
    storageType: (getAttr(attrs, "custom:storage_type") as CognitoUser["storageType"]) ?? "ebs",
    litellmApiKey: getAttr(attrs, "custom:litellm_api_key"),
    containerId: getAttr(attrs, "custom:container_id"),
    groups: [],
  };
}

// ─── Cognito: User CRUD ───

export async function listCognitoUsers(): Promise<CognitoUser[]> {
  const allUsers: CognitoUser[] = [];
  let paginationToken: string | undefined;
  let pages = 0;
  do {
    const result = await cognitoClient.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Limit: 60,
        PaginationToken: paginationToken,
      })
    );
    allUsers.push(...(result.Users ?? []).map(toCognitoUser));
    paginationToken = result.PaginationToken;
    pages++;
  } while (paginationToken && pages < MAX_COGNITO_PAGES);
  return allUsers;
}

export async function getCognitoUser(username: string): Promise<CognitoUser> {
  const result = await cognitoClient.send(
    new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    })
  );
  return toCognitoUser({
    Username: result.Username,
    Attributes: result.UserAttributes,
    Enabled: result.Enabled,
    UserStatus: result.UserStatus,
    UserCreateDate: result.UserCreateDate,
  });
}

export async function createCognitoUser(
  input: CreateUserInput
): Promise<CognitoUser> {
  // Generate initial temporary password for both Cognito and code-server
  const tempPassword = require("crypto").randomBytes(12).toString("base64").slice(0, 16) + "A1!";

  const result = await cognitoClient.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: input.email,
      TemporaryPassword: tempPassword,
      UserAttributes: [
        { Name: "email", Value: input.email },
        { Name: "email_verified", Value: "true" },
        { Name: "custom:subdomain", Value: input.subdomain },
        { Name: "custom:department", Value: input.department },
        { Name: "custom:container_os", Value: input.containerOs },
        { Name: "custom:resource_tier", Value: input.resourceTier },
        { Name: "custom:security_policy", Value: input.securityPolicy },
        { Name: "custom:storage_type", Value: input.storageType },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    })
  );

  // Store initial password in Secrets Manager for code-server sync
  const secretName = `cc-on-bedrock/codeserver/${input.subdomain}`;
  try {
    await secretsClient.send(new PutSecretValueCommand({
      SecretId: secretName,
      SecretString: tempPassword,
    }));
  } catch {
    try {
      await secretsClient.send(new CreateSecretCommand({
        Name: secretName,
        SecretString: tempPassword,
        Description: `code-server password for ${input.subdomain}`,
      }));
    } catch (smErr) {
      console.warn(`[createCognitoUser] Failed to store initial code-server password:`, smErr);
    }
  }

  // Add to 'user' group by default
  await cognitoClient.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: result.User?.Username ?? input.email,
      GroupName: "user",
    })
  );

  return toCognitoUser({
    Username: result.User?.Username,
    Attributes: result.User?.Attributes,
    Enabled: result.User?.Enabled,
    UserStatus: result.User?.UserStatus,
    UserCreateDate: result.User?.UserCreateDate,
  });
}

export async function updateCognitoUser(
  input: UpdateUserInput
): Promise<void> {
  const attrs: AttributeType[] = [];
  if (input.containerOs)
    attrs.push({ Name: "custom:container_os", Value: input.containerOs });
  if (input.resourceTier)
    attrs.push({ Name: "custom:resource_tier", Value: input.resourceTier });
  if (input.securityPolicy)
    attrs.push({
      Name: "custom:security_policy",
      Value: input.securityPolicy,
    });
  if (input.storageType)
    attrs.push({
      Name: "custom:storage_type",
      Value: input.storageType,
    });

  if (attrs.length > 0) {
    await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: input.username,
        UserAttributes: attrs,
      })
    );
  }
}

export async function updateCognitoUserAttribute(
  username: string,
  name: string,
  value: string
): Promise<void> {
  await cognitoClient.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: userPoolId,
      Username: username,
      UserAttributes: [{ Name: name, Value: value }],
    })
  );
}

export async function deleteCognitoUser(username: string): Promise<void> {
  await cognitoClient.send(
    new AdminDeleteUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    })
  );
}

export async function disableCognitoUser(username: string): Promise<void> {
  await cognitoClient.send(
    new AdminDisableUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    })
  );
}

export async function enableCognitoUser(username: string): Promise<void> {
  await cognitoClient.send(
    new AdminEnableUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    })
  );
}

// ─── ECS: Container Management ───

const TASK_DEFINITION_MAP: Record<string, string> = {
  "ubuntu-light": "devenv-ubuntu-light",
  "ubuntu-standard": "devenv-ubuntu-standard",
  "ubuntu-power": "devenv-ubuntu-power",
  "al2023-light": "devenv-al2023-light",
  "al2023-standard": "devenv-al2023-standard",
  "al2023-power": "devenv-al2023-power",
};

// ─── Per-user IAM Role for budget control ───

async function ensureUserTaskRole(subdomain: string): Promise<string> {
  const roleName = `${TASK_ROLE_PREFIX}-${subdomain}`;
  const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;

  try {
    await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
    return roleArn; // Already exists
  } catch {
    // Create new per-user role
  }

  try {
    await iamClient.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
      PermissionsBoundary: `arn:aws:iam::${accountId}:policy/cc-on-bedrock-task-boundary`,
      Description: `Per-user ECS Task Role for ${subdomain}`,
      Tags: [{ Key: "cc-on-bedrock", Value: "user-task-role" }, { Key: "subdomain", Value: subdomain }],
    }));

    // Attach scoped Bedrock + S3 + Logs + ECR + Secrets permissions
    await iamClient.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "BedrockAccess",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "BedrockClaude",
            Effect: "Allow",
            Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"],
            Resource: [
              `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-*`,
              `arn:aws:bedrock:${region}:${accountId}:inference-profile/*anthropic.claude-*`,
            ],
          },
          {
            Sid: "S3UserData",
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject"],
            Resource: [
              `arn:aws:s3:::cc-on-bedrock-user-data-${accountId}`,
              `arn:aws:s3:::cc-on-bedrock-user-data-${accountId}/users/${subdomain}/*`,
            ],
          },
          {
            Sid: "CloudWatchLogs",
            Effect: "Allow",
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: `arn:aws:logs:*:${accountId}:log-group:/cc-on-bedrock/*`,
          },
          {
            Sid: "EcrAuth",
            Effect: "Allow",
            Action: ["ecr:GetAuthorizationToken"],
            Resource: "*",
          },
          {
            Sid: "EcrPull",
            Effect: "Allow",
            Action: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
            Resource: `arn:aws:ecr:${region}:${accountId}:repository/cc-on-bedrock/*`,
          },
          {
            Sid: "SecretsRead",
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue"],
            Resource: `arn:aws:secretsmanager:${region}:${accountId}:secret:cc-on-bedrock/codeserver/*`,
          },
        ],
      }),
    }));

    console.log(`[IAM] Created per-user role: ${roleName}`);
    // Wait for IAM propagation (ECS needs role to be fully available)
    await new Promise((r) => setTimeout(r, 10000));
    return roleArn;
  } catch (err) {
    console.error(`[IAM] Failed to create role ${roleName}:`, err);
    // Fallback to shared role
    return `arn:aws:iam::${accountId}:role/cc-on-bedrock-ecs-task`;
  }
}

// ─── Per-user EFS Access Point for file isolation ───

async function ensureUserAccessPoint(subdomain: string): Promise<string> {
  if (!efsFileSystemId) return "";

  try {
    const existing = await efsClientSdk.send(new DescribeAccessPointsCommand({
      FileSystemId: efsFileSystemId,
    }));
    const userAp = existing.AccessPoints?.find(
      ap => ap.RootDirectory?.Path === `/users/${subdomain}`
    );
    if (userAp?.AccessPointId) return userAp.AccessPointId;
  } catch (err) {
    console.error(`[EFS] Describe access points failed:`, err);
  }

  try {
    const result = await efsClientSdk.send(new CreateAccessPointCommand({
      FileSystemId: efsFileSystemId,
      PosixUser: { Uid: 1001, Gid: 1001 },
      RootDirectory: {
        Path: `/users/${subdomain}`,
        CreationInfo: {
          OwnerUid: 1001,
          OwnerGid: 1001,
          Permissions: "0755",
        },
      },
      Tags: [
        { Key: "Name", Value: `cc-devenv-${subdomain}` },
        { Key: "managed_by", Value: "cc-on-bedrock" },
        { Key: "subdomain", Value: subdomain },
      ],
    }));
    console.log(`[EFS] Created access point for ${subdomain}: ${result.AccessPointId}`);
    return result.AccessPointId ?? "";
  } catch (err) {
    console.error(`[EFS] Create access point failed for ${subdomain}:`, err);
    return "";
  }
}

const SECURITY_GROUP_MAP: Record<string, string> = {
  open: process.env.SG_DEVENV_OPEN ?? "",
  restricted: process.env.SG_DEVENV_RESTRICTED ?? "",
  locked: process.env.SG_DEVENV_LOCKED ?? "",
};

export async function startContainer(
  input: StartContainerInput
): Promise<string> {
  const taskDefKey = `${input.containerOs}-${input.resourceTier}`;
  const taskDefinition = TASK_DEFINITION_MAP[taskDefKey];
  if (!taskDefinition) {
    throw new Error(`Invalid container config: ${taskDefKey}`);
  }

  // Duplicate check: prevent multiple containers for the same user
  const existing = await listContainers();
  const userContainers = existing.filter(
    (c) =>
      (c.username === input.username || c.subdomain === input.subdomain) &&
      (c.status === "RUNNING" || c.status === "PENDING" || c.status === "PROVISIONING")
  );
  if (userContainers.length > 0) {
    throw new Error(
      `User "${input.username}" already has a running container (${userContainers[0].taskId}). Stop it first.`
    );
  }

  const securityGroup = SECURITY_GROUP_MAP[input.securityPolicy];

  // Create or get per-user IAM Task Role for budget control
  const userTaskRoleArn = await ensureUserTaskRole(input.subdomain);

  // Create or get per-user EFS Access Point for file isolation
  const accessPointId = await ensureUserAccessPoint(input.subdomain);

  // If access point available, register task def revision with EFS isolation
  let finalTaskDefinition = taskDefinition;
  if (accessPointId) {
    try {
      const descResult = await ecsClient.send(new DescribeTaskDefinitionCommand({
        taskDefinition,
      }));
      const td = descResult.taskDefinition;
      if (td) {
        const volumes = (td.volumes ?? []).map(v => {
          if (v.name === "efs-workspace" && v.efsVolumeConfiguration) {
            return {
              ...v,
              efsVolumeConfiguration: {
                ...v.efsVolumeConfiguration,
                rootDirectory: "/",
                transitEncryption: "ENABLED" as const,
                authorizationConfig: {
                  accessPointId,
                  iam: "ENABLED" as const,
                },
              },
            };
          }
          return v;
        });

        const regResult = await ecsClient.send(new RegisterTaskDefinitionCommand({
          family: td.family,
          taskRoleArn: userTaskRoleArn,
          executionRoleArn: td.executionRoleArn,
          networkMode: td.networkMode,
          containerDefinitions: td.containerDefinitions,
          volumes,
          requiresCompatibilities: td.requiresCompatibilities,
        }));
        finalTaskDefinition = `${regResult.taskDefinition?.family}:${regResult.taskDefinition?.revision}`;
        console.log(`[EFS] Registered task def with access point: ${finalTaskDefinition}`);
      }
    } catch (err) {
      console.warn(`[EFS] Task def registration failed, using default:`, err);
    }
  }

  // Generate per-user code-server password and store in Secrets Manager
  const codeserverPassword = require("crypto").randomBytes(16).toString("hex");
  const secretName = `cc-on-bedrock/codeserver/${input.subdomain}`;
  try {
    await secretsClient.send(new PutSecretValueCommand({
      SecretId: secretName,
      SecretString: codeserverPassword,
    }));
  } catch {
    // Secret doesn't exist yet — create it
    await secretsClient.send(new CreateSecretCommand({
      Name: secretName,
      SecretString: codeserverPassword,
      Description: `code-server password for ${input.subdomain}`,
    }));
  }
  const secretArn = `arn:aws:secretsmanager:${region}:${accountId}:secret:${secretName}`;

  const result = await ecsClient.send(
    new RunTaskCommand({
      cluster: ecsCluster,
      taskDefinition: finalTaskDefinition,
      count: 1,
      launchType: "EC2",
      enableExecuteCommand: true,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: (process.env.PRIVATE_SUBNET_IDS ?? "").split(","),
          securityGroups: securityGroup ? [securityGroup] : [],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: {
        // Per-user Task Role for individual budget control
        taskRoleArn: userTaskRoleArn,
        containerOverrides: [
          {
            name: "devenv",
            environment: [
              // Direct Bedrock mode: Claude Code uses Task Role via IMDS
              { name: "SECURITY_POLICY", value: input.securityPolicy },
              { name: "USER_SUBDOMAIN", value: input.subdomain },
              // Password stored in Secrets Manager — pass ARN only (entrypoint fetches actual value)
              { name: "CODESERVER_SECRET_ARN", value: secretArn },
              { name: "AWS_DEFAULT_REGION", value: region },
              ...(s3SyncBucket ? [{ name: "S3_SYNC_BUCKET", value: s3SyncBucket }] : []),
            ],
          },
        ],
      },
      tags: [
        { key: "username", value: input.username },
        { key: "subdomain", value: input.subdomain },
        { key: "department", value: input.department },
        { key: "securityPolicy", value: input.securityPolicy },
        { key: "storageType", value: input.storageType ?? "efs" },
        { key: "domain", value: `${input.subdomain}.${devSubdomain}.${domainName}` },
      ],
    })
  );

  const taskArn = result.tasks?.[0]?.taskArn;
  if (!taskArn) {
    throw new Error("Failed to start container: no task ARN returned");
  }
  return taskArn;
}

type ProgressCallback = (step: number, name: string, status: string, message?: string) => void;

export async function startContainerWithProgress(
  input: StartContainerInput,
  onProgress: ProgressCallback
): Promise<string> {
  const taskDefKey = `${input.containerOs}-${input.resourceTier}`;
  const taskDefinition = TASK_DEFINITION_MAP[taskDefKey];
  if (!taskDefinition) {
    throw new Error(`Invalid container config: ${taskDefKey}`);
  }

  const securityGroup = SECURITY_GROUP_MAP[input.securityPolicy];

  // Step 1: IAM Role
  onProgress(1, "iam_role", "in_progress", "Creating per-user IAM role...");
  const userTaskRoleArn = await ensureUserTaskRole(input.subdomain);
  onProgress(1, "iam_role", "completed", "IAM role ready");

  // Step 2: EFS Access Point
  onProgress(2, "efs_access_point", "in_progress", "Creating EFS access point...");
  const accessPointId = await ensureUserAccessPoint(input.subdomain);
  onProgress(2, "efs_access_point", "completed", "EFS access point ready");

  // Step 3: Task Definition
  onProgress(3, "task_definition", "in_progress", "Registering task definition...");
  let finalTaskDefinition = taskDefinition;
  if (accessPointId) {
    try {
      const descResult = await ecsClient.send(new DescribeTaskDefinitionCommand({ taskDefinition }));
      const td = descResult.taskDefinition;
      if (td) {
        const volumes = (td.volumes ?? []).map(v => {
          if (v.name === "efs-workspace" && v.efsVolumeConfiguration) {
            return {
              ...v,
              efsVolumeConfiguration: {
                ...v.efsVolumeConfiguration,
                rootDirectory: "/",
                transitEncryption: "ENABLED" as const,
                authorizationConfig: { accessPointId, iam: "ENABLED" as const },
              },
            };
          }
          return v;
        });
        const regResult = await ecsClient.send(new RegisterTaskDefinitionCommand({
          family: td.family,
          taskRoleArn: userTaskRoleArn,
          executionRoleArn: td.executionRoleArn,
          networkMode: td.networkMode,
          containerDefinitions: td.containerDefinitions,
          volumes,
          requiresCompatibilities: td.requiresCompatibilities,
        }));
        finalTaskDefinition = `${regResult.taskDefinition?.family}:${regResult.taskDefinition?.revision}`;
      }
    } catch (err) {
      console.warn(`[SSE] Task def registration failed, using default:`, err);
    }
  }
  onProgress(3, "task_definition", "completed", "Task definition registered");

  // Step 4: Password Store
  onProgress(4, "password_store", "in_progress", "Storing code-server password...");
  const secretName = `cc-on-bedrock/codeserver/${input.subdomain}`;
  let codeserverPassword: string;
  try {
    // Try to read existing password first
    const existing = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    codeserverPassword = existing.SecretString ?? require("crypto").randomBytes(16).toString("hex");
  } catch {
    // No existing password — generate a new one
    codeserverPassword = require("crypto").randomBytes(16).toString("hex");
  }
  try {
    await secretsClient.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: codeserverPassword }));
  } catch {
    await secretsClient.send(new CreateSecretCommand({
      Name: secretName,
      SecretString: codeserverPassword,
      Description: `code-server password for ${input.subdomain}`,
    }));
  }
  const secretArn = `arn:aws:secretsmanager:${region}:${accountId}:secret:${secretName}`;
  onProgress(4, "password_store", "completed", "Password stored");

  // Step 5: Container Start
  onProgress(5, "container_start", "in_progress", "Starting ECS task...");
  const result = await ecsClient.send(
    new RunTaskCommand({
      cluster: ecsCluster,
      taskDefinition: finalTaskDefinition,
      count: 1,
      launchType: "EC2",
      enableExecuteCommand: true,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: (process.env.PRIVATE_SUBNET_IDS ?? "").split(","),
          securityGroups: securityGroup ? [securityGroup] : [],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: {
        taskRoleArn: userTaskRoleArn,
        containerOverrides: [
          {
            name: "devenv",
            environment: [
              { name: "SECURITY_POLICY", value: input.securityPolicy },
              { name: "USER_SUBDOMAIN", value: input.subdomain },
              { name: "CODESERVER_SECRET_ARN", value: secretArn },
              { name: "AWS_DEFAULT_REGION", value: region },
              ...(s3SyncBucket ? [{ name: "S3_SYNC_BUCKET", value: s3SyncBucket }] : []),
            ],
          },
        ],
      },
      tags: [
        { key: "username", value: input.username },
        { key: "subdomain", value: input.subdomain },
        { key: "department", value: input.department },
        { key: "securityPolicy", value: input.securityPolicy },
        { key: "storageType", value: input.storageType ?? "efs" },
        { key: "domain", value: `${input.subdomain}.${devSubdomain}.${domainName}` },
      ],
    })
  );

  const taskArn = result.tasks?.[0]?.taskArn;
  if (!taskArn) {
    throw new Error("Failed to start container: no task ARN returned");
  }
  onProgress(5, "container_start", "completed", `Task started: ${taskArn.split("/").pop()}`);

  return taskArn;
}

export async function stopContainer(input: StopContainerInput): Promise<void> {
  await ecsClient.send(
    new StopTaskCommand({
      cluster: ecsCluster,
      task: input.taskArn,
      reason: input.reason ?? "Stopped by dashboard admin",
    })
  );
}

export async function listContainers(): Promise<ContainerInfo[]> {
  const listResult = await ecsClient.send(
    new ListTasksCommand({
      cluster: ecsCluster,
      maxResults: 100,
    })
  );

  const taskArns = listResult.taskArns ?? [];
  if (taskArns.length === 0) return [];

  const descResult = await ecsClient.send(
    new DescribeTasksCommand({
      cluster: ecsCluster,
      tasks: taskArns,
      include: ["TAGS"],
    })
  );

  return (descResult.tasks ?? []).map((task) => {
    const tags = task.tags ?? [];
    const getTag = (key: string) =>
      tags.find((t) => t.key === key)?.value ?? "";

    const taskArnStr = task.taskArn ?? "";
    const taskId = taskArnStr.split("/").pop() ?? taskArnStr;

    // Extract OS and tier from task definition
    const taskDef = task.taskDefinitionArn ?? "";
    const taskDefName = taskDef.split("/").pop()?.split(":")[0] ?? "";
    let containerOs: ContainerInfo["containerOs"] = "ubuntu";
    let resourceTier: ContainerInfo["resourceTier"] = "standard";
    if (taskDefName.includes("al2023")) containerOs = "al2023";
    if (taskDefName.includes("light")) resourceTier = "light";
    else if (taskDefName.includes("power")) resourceTier = "power";

    return {
      taskArn: taskArnStr,
      taskId,
      status: task.lastStatus ?? "UNKNOWN",
      desiredStatus: task.desiredStatus ?? "UNKNOWN",
      username: getTag("username"),
      subdomain: getTag("subdomain"),
      containerOs,
      resourceTier,
      securityPolicy: (getTag("securityPolicy") || "restricted") as ContainerInfo["securityPolicy"],
      storageType: (getTag("storageType") || undefined) as ContainerInfo["storageType"],
      cpu: task.cpu ?? task.containers?.[0]?.cpu?.toString() ?? ({ light: "1024", standard: "2048", power: "4096" }[resourceTier] || "0"),
      memory: task.memory ?? task.containers?.[0]?.memory?.toString() ?? ({ light: "4096", standard: "8192", power: "12288" }[resourceTier] || "0"),
      createdAt: task.createdAt?.toISOString() ?? "",
      startedAt: task.startedAt?.toISOString(),
      stoppedAt: task.stoppedAt?.toISOString(),
      healthStatus: task.healthStatus,
      privateIp:
        task.attachments
          ?.find((a) => a.type === "ElasticNetworkInterface")
          ?.details?.find((d) => d.name === "privateIPv4Address")?.value ??
        undefined,
    };
  });
}

export async function describeContainer(
  taskArn: string
): Promise<ContainerInfo | null> {
  const result = await ecsClient.send(
    new DescribeTasksCommand({
      cluster: ecsCluster,
      tasks: [taskArn],
      include: ["TAGS"],
    })
  );

  const task = result.tasks?.[0];
  if (!task) return null;

  const tags = task.tags ?? [];
  const getTag = (key: string) =>
    tags.find((t) => t.key === key)?.value ?? "";

  const taskArnStr = task.taskArn ?? "";
  const taskId = taskArnStr.split("/").pop() ?? taskArnStr;

  const taskDef = task.taskDefinitionArn ?? "";
  const taskDefName = taskDef.split("/").pop()?.split(":")[0] ?? "";
  let containerOs: ContainerInfo["containerOs"] = "ubuntu";
  let resourceTier: ContainerInfo["resourceTier"] = "standard";
  if (taskDefName.includes("al2023")) containerOs = "al2023";
  if (taskDefName.includes("light")) resourceTier = "light";
  else if (taskDefName.includes("power")) resourceTier = "power";

  return {
    taskArn: taskArnStr,
    taskId,
    status: task.lastStatus ?? "UNKNOWN",
    desiredStatus: task.desiredStatus ?? "UNKNOWN",
    username: getTag("username"),
    subdomain: getTag("subdomain"),
    containerOs,
    resourceTier,
    securityPolicy: (getTag("securityPolicy") || "restricted") as ContainerInfo["securityPolicy"],
    storageType: (getTag("storageType") || undefined) as ContainerInfo["storageType"],
    cpu: task.cpu ?? task.containers?.[0]?.cpu?.toString() ?? ({ light: "1024", standard: "2048", power: "4096" }[resourceTier] || "0"),
    memory: task.memory ?? task.containers?.[0]?.memory?.toString() ?? ({ light: "4096", standard: "8192", power: "12288" }[resourceTier] || "0"),
    createdAt: task.createdAt?.toISOString() ?? "",
    startedAt: task.startedAt?.toISOString(),
    stoppedAt: task.stoppedAt?.toISOString(),
    healthStatus: task.healthStatus,
    privateIp:
      task.attachments
        ?.find((a) => a.type === "ElasticNetworkInterface")
        ?.details?.find((d) => d.name === "privateIPv4Address")?.value ??
      undefined,
  };
}

// ─── DynamoDB Routing Table ───

const ROUTING_TABLE = process.env.ROUTING_TABLE ?? "cc-routing-table";

export async function registerContainerRoute(
  subdomain: string,
  privateIp: string
): Promise<void> {
  const { DynamoDBClient, PutItemCommand } = await import("@aws-sdk/client-dynamodb");
  const ddb = new DynamoDBClient({ region });

  await ddb.send(new PutItemCommand({
    TableName: ROUTING_TABLE,
    Item: {
      subdomain: { S: subdomain },
      targetIp: { S: privateIp },
      port: { N: "8080" },
      status: { S: "active" },
      updatedAt: { S: new Date().toISOString() },
      domain: { S: `${subdomain}.${devSubdomain}.${domainName}` },
    },
  }));

  console.log(`[Routing] Registered: ${subdomain} → ${privateIp}:8080`);
}

export async function deregisterContainerRoute(
  subdomain: string
): Promise<void> {
  const { DynamoDBClient, DeleteItemCommand } = await import("@aws-sdk/client-dynamodb");
  const ddb = new DynamoDBClient({ region });

  await ddb.send(new DeleteItemCommand({
    TableName: ROUTING_TABLE,
    Key: { subdomain: { S: subdomain } },
  }));

  console.log(`[Routing] Deregistered: ${subdomain}`);
}

// ─── ALB Target Auto-Registration (DEPRECATED: use registerContainerRoute / deregisterContainerRoute) ───

/** @deprecated Use registerContainerRoute instead */
export async function registerContainerInAlb_legacy(
  subdomain: string,
  privateIp: string
): Promise<void> {
  if (!devenvAlbListenerArn || !vpcId) {
    console.warn("[ALB] Missing DEVENV_ALB_LISTENER_ARN or VPC_ID");
    return;
  }

  const tgName = `devenv-${subdomain}`;

  // Check if target group exists
  let tgArn: string | undefined;
  try {
    const existing = await elbv2Client.send(
      new DescribeTargetGroupsCommand({ Names: [tgName] })
    );
    tgArn = existing.TargetGroups?.[0]?.TargetGroupArn;
  } catch {
    // Target group doesn't exist, create it
  }

  if (!tgArn) {
    const createResult = await elbv2Client.send(
      new CreateTargetGroupCommand({
        Name: tgName,
        Protocol: "HTTP",
        Port: 8080,
        VpcId: vpcId,
        TargetType: "ip",
        HealthCheckPath: "/",
        HealthCheckIntervalSeconds: 30,
        HealthyThresholdCount: 2,
        UnhealthyThresholdCount: 3,
        Matcher: { HttpCode: "200-399" },
      })
    );
    tgArn = createResult.TargetGroups?.[0]?.TargetGroupArn;
    if (!tgArn) throw new Error("Failed to create target group");

    // Find next available priority
    const rules = await elbv2Client.send(
      new DescribeRulesCommand({ ListenerArn: devenvAlbListenerArn })
    );
    const usedPriorities = (rules.Rules ?? [])
      .map((r) => parseInt(r.Priority ?? "0", 10))
      .filter((p) => !isNaN(p));
    const nextPriority = Math.max(...usedPriorities, 0) + 1;

    // Create listener rule
    await elbv2Client.send(
      new CreateRuleCommand({
        ListenerArn: devenvAlbListenerArn,
        Priority: nextPriority,
        Conditions: [
          { Field: "host-header", Values: [`${subdomain}.${devSubdomain}.${domainName}`] },
        ],
        Actions: [{ Type: "forward", TargetGroupArn: tgArn }],
      })
    );
  }

  // Deregister stale targets before registering new IP
  try {
    const health = await elbv2Client.send(
      new DescribeTargetHealthCommand({ TargetGroupArn: tgArn })
    );
    const staleTargets = (health.TargetHealthDescriptions ?? [])
      .filter((t) => t.Target?.Id !== privateIp)
      .map((t) => ({ Id: t.Target!.Id!, Port: t.Target!.Port! }));
    if (staleTargets.length > 0) {
      await elbv2Client.send(
        new DeregisterTargetsCommand({ TargetGroupArn: tgArn, Targets: staleTargets })
      );
      console.log(`[ALB] Deregistered ${staleTargets.length} stale target(s) from ${subdomain}`);
    }
  } catch (err) {
    console.warn(`[ALB] Stale target cleanup for ${subdomain}:`, err);
  }

  // Register the container IP
  await elbv2Client.send(
    new RegisterTargetsCommand({
      TargetGroupArn: tgArn,
      Targets: [{ Id: privateIp, Port: 8080 }],
    })
  );

  console.log(`[ALB] Registered ${subdomain} → ${privateIp}:8080`);
}

/** @deprecated Use deregisterContainerRoute instead */
export async function deregisterContainerFromAlb_legacy(
  subdomain: string
): Promise<void> {
  try {
    const tgName = `devenv-${subdomain}`;
    const existing = await elbv2Client.send(
      new DescribeTargetGroupsCommand({ Names: [tgName] })
    );
    const tgArn = existing.TargetGroups?.[0]?.TargetGroupArn;
    if (!tgArn) return;

    // Find and delete the listener rule
    if (devenvAlbListenerArn) {
      const rules = await elbv2Client.send(
        new DescribeRulesCommand({ ListenerArn: devenvAlbListenerArn })
      );
      for (const rule of rules.Rules ?? []) {
        if (rule.Actions?.some((a) => a.TargetGroupArn === tgArn) && !rule.IsDefault) {
          await elbv2Client.send(new DeleteRuleCommand({ RuleArn: rule.RuleArn }));
        }
      }
    }

    // Delete target group
    await elbv2Client.send(new DeleteTargetGroupCommand({ TargetGroupArn: tgArn }));
    console.log(`[ALB] Deregistered ${subdomain}`);
  } catch (err) {
    console.warn(`[ALB] Deregister ${subdomain} failed:`, err);
  }
}
