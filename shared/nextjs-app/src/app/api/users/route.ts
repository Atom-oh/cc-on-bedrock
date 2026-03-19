import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  listCognitoUsers,
  getCognitoUser,
  createCognitoUser,
  updateCognitoUser,
  deleteCognitoUser,
  disableCognitoUser,
  enableCognitoUser,
  updateCognitoUserAttribute,
} from "@/lib/aws-clients";
import { generateKey, deleteKey } from "@/lib/litellm-client";
import type { CreateUserInput, UpdateUserInput } from "@/lib/types";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const username = searchParams.get("username");

  try {
    if (username) {
      const user = await getCognitoUser(username);
      return NextResponse.json({ success: true, data: user });
    }

    const users = await listCognitoUsers();
    return NextResponse.json({ success: true, data: users });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  try {
    const body = (await req.json()) as CreateUserInput;

    // 1. Create Cognito user
    const cognitoUser = await createCognitoUser(body);

    // 2. Generate LiteLLM virtual key
    const litellmKey = await generateKey({
      user_id: cognitoUser.username,
      key_alias: `key-${body.subdomain}`,
      models: ["claude-opus-4-6", "claude-sonnet-4-6"],
    });

    // 3. Store LiteLLM key in Cognito custom attribute
    await updateCognitoUserAttribute(
      cognitoUser.username,
      "custom:litellm_api_key",
      litellmKey.key
    );

    return NextResponse.json({
      success: true,
      data: { ...cognitoUser, litellmApiKey: litellmKey.key },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  try {
    const body = (await req.json()) as UpdateUserInput;
    await updateCognitoUser(body);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const username = searchParams.get("username");
  const action = searchParams.get("action");

  if (!username) {
    return NextResponse.json(
      { error: "Username required" },
      { status: 400 }
    );
  }

  try {
    switch (action) {
      case "disable":
        await disableCognitoUser(username);
        return NextResponse.json({ success: true });
      case "enable":
        await enableCognitoUser(username);
        return NextResponse.json({ success: true });
      default: {
        // Full delete: remove LiteLLM key, then Cognito user
        const user = await getCognitoUser(username);
        if (user.litellmApiKey) {
          try {
            await deleteKey(user.litellmApiKey);
          } catch {
            // Key may already be deleted; continue
          }
        }
        await deleteCognitoUser(username);
        return NextResponse.json({ success: true });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
