import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  startContainer,
  stopContainer,
  listContainers,
  describeContainer,
} from "@/lib/aws-clients";
import type { StartContainerInput, StopContainerInput } from "@/lib/types";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const taskArn = searchParams.get("taskArn");

  try {
    if (taskArn) {
      const container = await describeContainer(taskArn);
      if (!container) {
        return NextResponse.json(
          { success: false, error: "Container not found" },
          { status: 404 }
        );
      }
      return NextResponse.json({ success: true, data: container });
    }

    const containers = await listContainers();
    return NextResponse.json({ success: true, data: containers });
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
    const body = (await req.json()) as StartContainerInput;
    const taskArn = await startContainer(body);
    return NextResponse.json({ success: true, data: { taskArn } });
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

  try {
    const body = (await req.json()) as StopContainerInput;
    await stopContainer(body);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
