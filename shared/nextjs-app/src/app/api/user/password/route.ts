import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { changePassword } from "@/lib/cognito-password";
import { validatePassword } from "@/lib/password-policy";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const secretsClient = new SecretsManagerClient({ region });

// GET: Retrieve current code-server password from Secrets Manager
// Returns password with no-store cache headers to prevent caching
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const subdomain = session.user.subdomain;
  if (!subdomain) {
    return NextResponse.json({ error: "No subdomain assigned" }, { status: 400 });
  }

  const headers = {
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
  };

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
    }, { headers });
  } catch {
    return NextResponse.json({
      success: true,
      data: { password: "", lastChanged: null },
    }, { headers });
  }
}

// POST: Change the Cognito login password (re-authenticates with the current
// password). In DevEnv mode the code-server secret follows the new password.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const user = session.user;
  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { currentPassword, newPassword } = body;
  if (typeof currentPassword !== "string" || !currentPassword) {
    return NextResponse.json({ error: "currentPassword is required" }, { status: 400 });
  }
  const policyError = validatePassword(newPassword);
  if (policyError) {
    return NextResponse.json({ error: policyError }, { status: 400 });
  }

  const result = await changePassword(user.email, currentPassword, newPassword as string);
  if (!result.ok) {
    const error =
      result.code === "invalid_credentials" ? "Current password is incorrect"
      : result.code === "invalid_password" ? "New password does not meet the password policy"
      : result.code === "too_many_attempts" ? "Too many attempts. Try again later"
      : "Failed to change password";
    const status = result.code === "invalid_credentials" ? 401 : result.code === "too_many_attempts" ? 429 : result.code === "invalid_password" ? 400 : 500;
    return NextResponse.json({ success: false, error }, { status });
  }

  const subdomain = user.subdomain;
  if (!subdomain) {
    return NextResponse.json({ success: true, message: "Password changed successfully." });
  }

  // DevEnv: keep the code-server password in sync with the login password.
  try {
    const secretName = `cc-on-bedrock/codeserver/${subdomain}`;
    try {
      await secretsClient.send(
        new PutSecretValueCommand({
          SecretId: secretName,
          SecretString: newPassword as string,
        })
      );
    } catch {
      // Secret doesn't exist yet — create it
      await secretsClient.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: newPassword as string,
          Description: `code-server password for ${subdomain}`,
        })
      );
    }
  } catch (err) {
    console.error("[user/password] code-server secret", err instanceof Error ? err.message : err);
    return NextResponse.json({
      success: true,
      message: "Login password changed, but the code-server password could not be updated. Change it again to retry.",
    });
  }

  return NextResponse.json({
    success: true,
    message: "Password changed successfully. Code-server will use the new password on next container start.",
  });
}
