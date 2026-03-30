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
} from "@aws-sdk/client-ecs";
import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
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

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
const ecsCluster = process.env.ECS_CLUSTER_NAME ?? "cc-on-bedrock-cluster";
const domainName = process.env.DOMAIN_NAME ?? "example.com";
const devSubdomain = process.env.DEV_SUBDOMAIN ?? "dev";
const accountId = process.env.AWS_ACCOUNT_ID ?? "";
const TASK_ROLE_PREFIX = "cc-on-bedrock-task";

const cognitoClient = new CognitoIdentityProviderClient({ region });
const ecsClient = new ECSClient({ region });
const dynamoClient = new DynamoDBClient({ region });
const iamClient = new IAMClient({ region });

const routingTableName = process.env.ROUTING_TABLE_NAME ?? "cc-routing-table";

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
    containerId: getAttr(attrs, "custom:container_id"),
    groups: [],
  };
}

// ─── Cognito: User CRUD ───

export async function listCognitoUsers(): Promise<CognitoUser[]> {
  const result = await cognitoClient.send(
    new ListUsersCommand({
      UserPoolId: userPoolId,
      Limit: 60,
    })
  );
  return (result.Users ?? []).map(toCognitoUser);
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
  const result = await cognitoClient.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: input.email,
      UserAttributes: [
        { Name: "email", Value: input.email },
        { Name: "email_verified", Value: "true" },
        { Name: "custom:subdomain", Value: input.subdomain },
        { Name: "custom:department", Value: input.department },
        { Name: "custom:container_os", Value: input.containerOs },
        { Name: "custom:resource_tier", Value: input.resourceTier },
        { Name: "custom:security_policy", Value: input.securityPolicy },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    })
  );

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
  if (!accountId) {
    throw new Error("AWS_ACCOUNT_ID environment variable is required for per-user IAM roles");
  }
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
      Description: `Per-user ECS Task Role for ${subdomain}`,
      Tags: [{ Key: "cc-on-bedrock", Value: "user-task-role" }, { Key: "subdomain", Value: subdomain }],
    }));

    // Attach Bedrock + basic permissions
    await iamClient.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "BedrockAccess",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"],
            Resource: [
              "arn:aws:bedrock:*::foundation-model/anthropic.*",
              `arn:aws:bedrock:*:${accountId}:inference-profile/*`,
            ],
          },
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject"],
            Resource: `arn:aws:s3:::cc-on-bedrock-*/*`,
          },
          {
            Effect: "Allow",
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: ["ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
            Resource: "*",
          },
        ],
      }),
    }));

    console.log(`[IAM] Created per-user role: ${roleName}`);
    // Wait for IAM propagation
    await new Promise((r) => setTimeout(r, 3000));
    return roleArn;
  } catch (err) {
    console.error(`[IAM] Failed to create role ${roleName}:`, err);
    // Fallback to shared role (accountId already validated above)
    return `arn:aws:iam::${accountId}:role/cc-on-bedrock-ecs-task`;
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

  const result = await ecsClient.send(
    new RunTaskCommand({
      cluster: ecsCluster,
      taskDefinition,
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
              { name: "CODESERVER_PASSWORD", value: process.env.CODESERVER_PASSWORD ?? crypto.randomUUID() },
              { name: "AWS_DEFAULT_REGION", value: region },
            ],
          },
        ],
      },
      tags: [
        { key: "username", value: input.username },
        { key: "subdomain", value: input.subdomain },
        { key: "department", value: input.department },
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

// Alias for SSE streaming container start (used by /api/user/container/stream)
export const startContainerWithProgress = startContainer;

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
      securityPolicy: "restricted" as ContainerInfo["securityPolicy"],
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
    securityPolicy: "restricted",
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

// ─── DynamoDB Routing Table (replaces ALB listener rules) ───
// Nginx polls S3 config generated from this table by nginx-config-gen Lambda

export async function registerContainerRoute(
  subdomain: string,
  privateIp: string
): Promise<void> {
  await dynamoClient.send(new PutItemCommand({
    TableName: routingTableName,
    Item: {
      subdomain: { S: subdomain },
      container_ip: { S: privateIp },
      port: { N: "8080" },
      status: { S: "active" },
      updated_at: { S: new Date().toISOString() },
    },
  }));
  console.log(`[Routing] Registered ${subdomain} → ${privateIp}:8080`);
}

export async function deregisterContainerRoute(
  subdomain: string
): Promise<void> {
  try {
    await dynamoClient.send(new DeleteItemCommand({
      TableName: routingTableName,
      Key: { subdomain: { S: subdomain } },
    }));
    console.log(`[Routing] Deregistered ${subdomain}`);
  } catch (err) {
    console.warn(`[Routing] Deregister ${subdomain} failed:`, err);
  }
}
