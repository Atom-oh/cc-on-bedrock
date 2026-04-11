import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const GATEWAY_MANAGER_FUNCTION = process.env.GATEWAY_MANAGER_FUNCTION ?? "cc-on-bedrock-gateway-manager";
const lambdaClient = new LambdaClient({ region });

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { dept_id } = body as { dept_id: string };

    if (!dept_id) {
      return NextResponse.json({ error: "dept_id is required" }, { status: 400 });
    }

    await lambdaClient.send(new InvokeCommand({
      FunctionName: GATEWAY_MANAGER_FUNCTION,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({
        action: "sync",
        dept_id,
      })),
    }));

    return NextResponse.json({ success: true, message: `Sync initiated for ${dept_id}` });
  } catch (err) {
    console.error("[admin/mcp/gateways/sync] POST", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
