import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  CognitoIdentityProviderClient,
  AdminSetUserPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";

const cognitoClient = new CognitoIdentityProviderClient({ region });
const secretsClient = new SecretsManagerClient({ region });

// GET: Retrieve current code-server password from Secrets Manager
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const subdomain = session.user.subdomain;
  if (!subdomain) {
    return NextResponse.json({ error: "No subdomain assigned" }, { status: 400 });
  }

  try {
    const secretName = `cc-on-bedrock/codeserver/${subdomain}`;
    const result = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );

    return NextResponse.json({
      success: true,
      data: {
        password: result.SecretString ?? "",
        lastChanged: result.CreatedDate?.toISOString(),
      },
    });
  } catch (err) {
    // Secret doesn't exist yet
    return NextResponse.json({
      success: true,
      data: { password: "", lastChanged: null },
    });
  }
}

// POST: Change password (updates both Cognito and Secrets Manager)
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const user = session.user;
  const subdomain = user.subdomain;
  if (!subdomain) {
    return NextResponse.json({ error: "No subdomain assigned" }, { status: 400 });
  }

  let body: { newPassword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { newPassword } = body;
  if (!newPassword) {
    return NextResponse.json({ error: "newPassword is required" }, { status: 400 });
  }

  // Validate password policy (matching Cognito User Pool policy)
  if (newPassword.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }
  if (!/[A-Z]/.test(newPassword)) {
    return NextResponse.json({ error: "Password must contain an uppercase letter" }, { status: 400 });
  }
  if (!/[0-9]/.test(newPassword)) {
    return NextResponse.json({ error: "Password must contain a number" }, { status: 400 });
  }
  if (!/[^A-Za-z0-9]/.test(newPassword)) {
    return NextResponse.json({ error: "Password must contain a special character" }, { status: 400 });
  }

  try {
    // 1. Update Cognito password
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: user.email,
        Password: newPassword,
        Permanent: true,
      })
    );

    // 2. Update Secrets Manager for code-server
    const secretName = `cc-on-bedrock/codeserver/${subdomain}`;
    try {
      await secretsClient.send(
        new PutSecretValueCommand({
          SecretId: secretName,
          SecretString: newPassword,
        })
      );
    } catch {
      // Secret doesn't exist yet — create it
      await secretsClient.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: newPassword,
          Description: `code-server password for ${subdomain}`,
        })
      );
    }

    return NextResponse.json({
      success: true,
      message: "Password changed successfully. Code-server will use the new password on next container start.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to change password";
    console.error("[user/password] POST", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
