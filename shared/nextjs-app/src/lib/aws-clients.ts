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
import type {
  CognitoUser,
  CreateUserInput,
  UpdateUserInput,
} from "./types";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
const domainName = process.env.DOMAIN_NAME ?? "atomai.click";
const devSubdomain = process.env.DEV_SUBDOMAIN ?? "dev";
const MAX_COGNITO_PAGES = 20;

const cognitoClient = new CognitoIdentityProviderClient({ region });
const secretsClient = new SecretsManagerClient({ region });

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

/**
 * Soft-delete: remove user's container environment while keeping Cognito account.
 * 1. Stop running container  2. Deregister Nginx route  3. Trigger EBS snapshot
 * 4. Clear subdomain in Cognito  5. User can re-request after re-login.
 */
export async function resetUserEnvironment(
  username: string,
  subdomain: string,
): Promise<{ stopped: boolean; routeCleared: boolean }> {
  const result = { stopped: false, routeCleared: false };

  // 1. Stop running EC2 instance
  try {
    const { stopInstance } = await import("@/lib/ec2-clients");
    await stopInstance(subdomain, "Environment reset by admin");
    result.stopped = true;
  } catch (err) {
    console.warn("[resetUserEnvironment] Failed to stop instance:", err);
  }

  // 2. Deregister Nginx route (DynamoDB cc-routing-table)
  try {
    await deregisterContainerRoute(subdomain);
    result.routeCleared = true;
  } catch (err) {
    console.warn("[resetUserEnvironment] Failed to deregister route:", err);
  }

  // 3. Clear subdomain in Cognito (user becomes "unassigned")
  await updateCognitoUserAttribute(username, "custom:subdomain", "");

  return result;
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

