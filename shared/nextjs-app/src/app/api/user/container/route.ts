import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  startContainer,
  stopContainer,
  listContainers,
  registerContainerInAlb,
  describeContainer,
  deregisterContainerFromAlb,
} from "@/lib/aws-clients";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const user = session.user;
  if (!user.subdomain) {
    return NextResponse.json({ error: "No subdomain assigned to user" }, { status: 400 });
  }

  try {
    const body = await req.json();
    const { action, taskArn } = body;

    if (action === "start") {
      // Check if user already has a running container
      const containers = await listContainers();
      const existingContainer = containers.find(
        (c) =>
          c.subdomain === user.subdomain &&
          (c.status === "RUNNING" || c.status === "PENDING" || c.status === "PROVISIONING")
      );

      if (existingContainer) {
        return NextResponse.json(
          { success: false, error: "You already have a running container" },
          { status: 409 }
        );
      }

      const newTaskArn = await startContainer({
        username: user.email,
        subdomain: user.subdomain,
        department: "default", // Could be extended to read from user attributes
        containerOs: user.containerOs ?? "ubuntu",
        resourceTier: user.resourceTier ?? "standard",
        securityPolicy: user.securityPolicy ?? "restricted",
      });

      // Auto-register in ALB after a short delay for IP assignment
      setTimeout(async () => {
        try {
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 5000));
            const info = await describeContainer(newTaskArn);
            if (info?.privateIp) {
              await registerContainerInAlb(user.subdomain!, info.privateIp);
              break;
            }
          }
        } catch (err) {
          console.error("[user/container] ALB register failed:", err);
        }
      }, 2000);

      return NextResponse.json({ success: true, data: { taskArn: newTaskArn } });
    }

    if (action === "stop") {
      if (!taskArn) {
        return NextResponse.json({ error: "taskArn required for stop action" }, { status: 400 });
      }

      // Verify this container belongs to the user
      const containers = await listContainers();
      const userContainer = containers.find(
        (c) => c.taskArn === taskArn && c.subdomain === user.subdomain
      );

      if (!userContainer) {
        return NextResponse.json(
          { success: false, error: "Container not found or not owned by you" },
          { status: 403 }
        );
      }

      // Deregister from ALB before stopping
      try {
        await deregisterContainerFromAlb(user.subdomain);
      } catch (err) {
        console.warn("[user/container] ALB deregister:", err);
      }

      await stopContainer({ taskArn, reason: "Stopped by user" });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[user/container] POST", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
