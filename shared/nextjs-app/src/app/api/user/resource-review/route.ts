import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listContainers } from "@/lib/aws-clients";
import { getTaskMetrics } from "@/lib/cloudwatch-client";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const bedrockClient = new BedrockRuntimeClient({ region });
const MODEL_ID = "global.anthropic.claude-sonnet-4-6[1m]";

const SYSTEM_PROMPT = `당신은 클라우드 리소스 최적화 전문가입니다.
사용자의 컨테이너 메트릭을 분석하고, 리소스 확장이 실제로 필요한지 판단해주세요.

## 판단 기준

### 디스크 확장 (EBS resize)
필요하지 않은 경우:
- 사용률이 80% 미만이면 아직 여유 있음
- docker system prune, npm cache clean, pip cache purge 등 정리로 확보 가능한 공간 안내
- ~/.cache, /tmp, node_modules/.cache 등 삭제 가능한 경로 안내

필요한 경우:
- 사용률 90% 이상 + 정리할 캐시가 적을 때
- 로그/데이터가 지속적으로 증가하는 패턴

### 티어 업그레이드 (CPU/Memory)
필요하지 않은 경우:
- CPU 평균 사용률이 50% 미만
- Memory 평균 사용률이 70% 미만
- 피크 시간에만 잠깐 높은 경우

필요한 경우:
- OOM (Out of Memory) 발생 또는 Memory 상시 90%+
- CPU throttle 또는 빌드 시간이 비정상적으로 긴 경우

## 응답 형식
반드시 다음 JSON을 마지막에 포함하세요:
\`\`\`json
{"recommended": true/false, "actions": ["구체적 액션1", "액션2"]}
\`\`\`

한국어로 답변하세요. 간결하게 3-5문장 분석 후 JSON.`;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const subdomain = session.user.subdomain;
  if (!subdomain) {
    return new Response(JSON.stringify({ error: "No subdomain assigned" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { reviewType, requestedValue, reason } = body as {
      reviewType: "ebs_resize" | "tier_upgrade";
      requestedValue: string;
      reason?: string;
    };

    // Gather metrics for the user's running container
    const containers = await listContainers();
    const userContainer = containers.find(
      (c) => c.subdomain === subdomain && c.status === "RUNNING"
    );

    let metricsContext = "컨테이너가 현재 실행 중이지 않습니다.";
    if (userContainer) {
      try {
        const metrics = await getTaskMetrics(userContainer.taskId);
        const cpuPct = metrics.cpuLimit > 0 ? (metrics.cpu / metrics.cpuLimit * 100).toFixed(1) : "N/A";
        const memPct = metrics.memoryLimit > 0 ? (metrics.memory / metrics.memoryLimit * 100).toFixed(1) : "N/A";

        metricsContext = [
          `## 현재 컨테이너 상태`,
          `- OS: ${userContainer.containerOs}, Tier: ${userContainer.resourceTier}`,
          `- CPU: ${metrics.cpu.toFixed(1)} / ${metrics.cpuLimit.toFixed(1)} units (${cpuPct}%)`,
          `- Memory: ${metrics.memory.toFixed(0)} / ${metrics.memoryLimit.toFixed(0)} MB (${memPct}%)`,
          `- Network Rx: ${(metrics.networkRx / 1024).toFixed(1)} KB/s, Tx: ${(metrics.networkTx / 1024).toFixed(1)} KB/s`,
          `- Disk Read: ${(metrics.diskRead / 1024).toFixed(1)} KB/s, Write: ${(metrics.diskWrite / 1024).toFixed(1)} KB/s`,
          `- 할당: CPU ${userContainer.cpu}, Memory ${userContainer.memory}`,
        ].join("\n");
      } catch {
        metricsContext = "메트릭 수집에 실패했습니다. 컨테이너는 실행 중입니다.";
      }
    }

    const requestContext = reviewType === "ebs_resize"
      ? `사용자가 EBS 디스크를 ${requestedValue}GB로 확장 요청했습니다.${reason ? ` 사유: "${reason}"` : ""}`
      : `사용자가 리소스 티어를 ${requestedValue}로 업그레이드 요청했습니다.${reason ? ` 사유: "${reason}"` : ""}`;

    const userMessage = `${requestContext}\n\n${metricsContext}\n\n이 요청이 실제로 필요한지 분석해주세요.`;

    // Call Bedrock Converse (non-streaming for simplicity)
    const response = await bedrockClient.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [
          { role: "user", content: [{ text: userMessage }] },
        ],
        inferenceConfig: { maxTokens: 500, temperature: 0.3 },
      })
    );

    const aiText = response.output?.message?.content?.[0]?.text ?? "분석을 완료할 수 없습니다.";

    // Extract verdict JSON from response
    let verdict = { recommended: true, actions: [] as string[] };
    const jsonMatch = aiText.match(/```json\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      try {
        verdict = JSON.parse(jsonMatch[1]);
      } catch { /* keep default */ }
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          analysis: aiText.replace(/```json[\s\S]*?```/, "").trim(),
          verdict,
          metricsAvailable: !!userContainer,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[user/resource-review] POST", err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ success: false, error: "AI review failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
