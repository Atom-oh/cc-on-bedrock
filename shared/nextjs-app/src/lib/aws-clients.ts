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
import type {
  CognitoUser,
  CreateUserInput,
  UpdateUserInput,
  ContainerInfo,
  StartContainerInput,
  StopContainerInput,
} from "./types";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
const ecsCluster = process.env.ECS_CLUSTER_NAME ?? "cc-on-bedrock-cluster";
const domainName = process.env.DOMAIN_NAME ?? "example.com";
const devSubdomain = process.env.DEV_SUBDOMAIN ?? "dev";

const cognitoClient = new CognitoIdentityProviderClient({ region });
const ecsClient = new ECSClient({ region });

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
    containerOs: (getAttr(attrs, "custom:container_os") as CognitoUser["containerOs"]) ?? "ubuntu",
    resourceTier: (getAttr(attrs, "custom:resource_tier") as CognitoUser["resourceTier"]) ?? "standard",
    securityPolicy: (getAttr(attrs, "custom:security_policy") as CognitoUser["securityPolicy"]) ?? "restricted",
    litellmApiKey: getAttr(attrs, "custom:litellm_api_key"),
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

  const securityGroup = SECURITY_GROUP_MAP[input.securityPolicy];
  const litellmUrl = process.env.LITELLM_API_URL ?? "";

  const result = await ecsClient.send(
    new RunTaskCommand({
      cluster: ecsCluster,
      taskDefinition,
      count: 1,
      launchType: "EC2",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: (process.env.PRIVATE_SUBNET_IDS ?? "").split(","),
          securityGroups: securityGroup ? [securityGroup] : [],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "devenv",
            environment: [
              { name: "ANTHROPIC_BASE_URL", value: litellmUrl },
              { name: "ANTHROPIC_API_KEY", value: input.litellmApiKey },
              { name: "SECURITY_POLICY", value: input.securityPolicy },
              { name: "USER_SUBDOMAIN", value: input.subdomain },
              { name: "AWS_DEFAULT_REGION", value: region },
            ],
          },
        ],
      },
      tags: [
        { key: "username", value: input.username },
        { key: "subdomain", value: input.subdomain },
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
      cpu: task.cpu ?? "0",
      memory: task.memory ?? "0",
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
    cpu: task.cpu ?? "0",
    memory: task.memory ?? "0",
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
