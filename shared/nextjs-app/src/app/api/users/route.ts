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
} from "@/lib/aws-clients";
import { createUserSchema, updateUserSchema } from "@/lib/validation";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
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
    console.error("[users] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const raw = await req.json();
    const parsed = createUserSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    const body = parsed.data;
    const cognitoUser = await createCognitoUser(body);
    return NextResponse.json({ success: true, data: cognitoUser });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[users] POST", message);
    const isUserExists = message.includes("already exists") || message.includes("UsernameExists");
    return NextResponse.json(
      { success: false, error: isUserExists ? "User account already exists" : message },
      { status: isUserExists ? 409 : 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const raw = await req.json();
    const parsed = updateUserSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    await updateCognitoUser(parsed.data);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[users] PUT", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const username = searchParams.get("username");
  const action = searchParams.get("action");

  if (!username) {
    return NextResponse.json({ error: "Username required" }, { status: 400 });
  }

  try {
    switch (action) {
      case "disable":
        await disableCognitoUser(username);
        return NextResponse.json({ success: true });
      case "enable":
        await enableCognitoUser(username);
        return NextResponse.json({ success: true });
      default:
        await deleteCognitoUser(username);
        return NextResponse.json({ success: true });
    }
  } catch (err) {
    console.error("[users] DELETE", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
