[32mAll tools are now trusted ([0m[31m![0m[32m). Kiro will execute tools without asking for confirmation.[0m
Agents can sometimes do unexpected things so understand the risks.

Learn more at [38;5;141mhttps://kiro.dev/docs/cli/chat/security/#using-tools-trust-all-safely[0m



[38;5;252m[0m[?25l[38;5;141m> [0m[0m[0m
[0m[0m
Let me start by examining the uncommitted changes.[0m[0m
[?25l[0m[0mI will run the following command: [38;5;141mcd /home/ec2-user/cc-on-bedrock && git diff --stat[0m[38;5;244m (using tool: shell)[0m
Purpose: Get overview of changed files

 CHANGELOG.md                                       |   2 +-
 docs/architecture.md                               |   4 +-
 docs/decisions/ADR-012-devenv-cognito-auth.md      |   2 +-
 docs/reviews/gemini.md                             |  68 ----
 docs/reviews/kiro.md                               | 385 ---------------------
 shared/nextjs-app/CLAUDE.md                        |  56 ++-
 .../src/app/api/container-metrics/route.ts         |  12 +-
 .../src/app/monitoring/monitoring-dashboard.tsx    |  86 +++--
 shared/nextjs-app/src/lib/cloudwatch-client.ts     | 157 +--------
 shared/nextjs-app/src/lib/usage-client.ts          |  97 ++++++
 shared/nextjs-app/tsconfig.tsbuildinfo             |   2 +-
 11 files changed, 203 insertions(+), 668 deletions(-)
[38;5;244m - Completed in 0.13s[0m

[?25l[0m[?25l[0m[0mI will run the following command: [38;5;141mcd /home/ec2-user/cc-on-bedrock && git diff -- shared/nextjs-app/src/lib/usage-client.ts[0m[38;5;244m (using tool: shell)[0m
Purpose: Review the new usage-client.ts

diff --git a/shared/nextjs-app/src/lib/usage-client.ts b/shared/nextjs-app/src/lib/usage-client.ts
index 49558c9..6d2787c 100644
--- a/shared/nextjs-app/src/lib/usage-client.ts
+++ b/shared/nextjs-app/src/lib/usage-client.ts
@@ -288,6 +288,103 @@ export async function getDailyUsage(params?: {
   return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
 }
 
+// ─── Bedrock Usage Snapshot (for Monitoring page) ───
+
+export interface BedrockUsageSnapshot {
+  /** Today's input tokens (cc-on-bedrock only) */
+  inputTokensToday: number;
+  /** Today's output tokens */
+  outputTokensToday: number;
+  /** Today's total tokens */
+  totalTokensToday: number;
+  /** Today's total API invocations */
+  invocationsToday: number;
+  /** Average latency in ms (today, from DynamoDB latencySumMs / requests) */
+  avgLatencyMs: number;
+  /** Today's estimated cost in USD */
+  estimatedCostToday: number;
+  /** Average tokens per hour (totalTokens / hours elapsed today) */
+  tokensPerHour: number;
+  /** Average cost per hour */
+  costPerHour: number;
+  /** Hours elapsed today (for rate computation) */
+  hoursElapsed: number;
+}
+
+export interface BedrockUsageTimeSeriesPoint {
+  date: string;
+  inputTokens: number;
+  outputTokens: number;
+  totalTokens: number;
+  invocations: number;
+  estimatedCost: number;
+}
+
+/**
+ * Get today's Bedrock usage from DynamoDB (cc-on-bedrock project only).
+ * Unlike CloudWatch AWS/Bedrock metrics, this only includes invocations
+ * made through cc-on-bedrock IAM roles (cc-on-bedrock-task-* prefix).
+ */
+export async function getBedrockUsageSnapshot(): Promise<BedrockUsageSnapshot> {
+  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
+  const records = await getUsageRecords({ startDate: today, endDate: today });
+
+  let inputTokens = 0;
+  let outputTokens = 0;
+  let totalTokens = 0;
+  let requests = 0;
+  let cost = 0;
+  let latencySum = 0;
+
+  for (const r of records) {
+    inputTokens += r.inputTokens;
+    outputTokens += r.outputTokens;
+    totalTokens += r.totalTokens;
+    requests += r.requests;
+    cost += r.estimatedCost;
+    latencySum += r.latencySumMs;
+  }
+
+  // Hours elapsed since midnight UTC
+  const now = new Date();
+  const midnight = new Date(now);
+  midnight.setUTCHours(0, 0, 0, 0);
+  const hoursElapsed = Math.max((now.getTime() - midnight.getTime()) / 3_600_000, 0.1);
+
+  return {
+    inputTokensToday: inputTokens,
+    outputTokensToday: outputTokens,
+    totalTokensToday: totalTokens,
+    invocationsToday: requests,
+    avgLatencyMs: requests > 0 ? Math.round(latencySum / requests) : 0,
+    estimatedCostToday: cost,
+    tokensPerHour: totalTokens / hoursElapsed,
+    costPerHour: cost / hoursElapsed,
+    hoursElapsed: Math.round(hoursElapsed * 10) / 10,
+  };
+}
+
+/**
+ * Get daily Bedrock usage time series from DynamoDB (cc-on-bedrock project only).
+ */
+export async function getBedrockUsageTimeSeries(
+  days: number = 7,
+): Promise<BedrockUsageTimeSeriesPoint[]> {
+  const endDate = new Date().toISOString().slice(0, 10);
+  const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
+
+  const daily = await getDailyUsage({ startDate, endDate });
+
+  return daily.map((d) => ({
+    date: d.date,
+    inputTokens: d.inputTokens,
+    outputTokens: d.outputTokens,
+    totalTokens: d.totalTokens,
+    invocations: d.requests,
+    estimatedCost: d.estimatedCost,
+  }));
+}
+
 // ─── Total Spend ───
 
 export async function getTotalUsage(): Promise<{
[38;5;244m - Completed in 0.7s[0m

[?25l[0m[?25l[0m[0mI will run the following command: [38;5;141mcd /home/ec2-user/cc-on-bedrock && git diff -- shared/nextjs-app/src/lib/cloudwatch-client.ts[0m[38;5;244m (using tool: shell)[0m
Purpose: Review cloudwatch-client.ts changes

diff --git a/shared/nextjs-app/src/lib/cloudwatch-client.ts b/shared/nextjs-app/src/lib/cloudwatch-client.ts
index ad0ac0e..e8de8ba 100644
--- a/shared/nextjs-app/src/lib/cloudwatch-client.ts
+++ b/shared/nextjs-app/src/lib/cloudwatch-client.ts
@@ -232,156 +232,7 @@ export async function getEc2AggregateMetrics(instanceIds: string[]): Promise<Agg
   };
 }
 
-// ─── Bedrock Usage Metrics (AWS/Bedrock namespace) ───
-
-const BEDROCK_MODELS = [
-  { id: "global.anthropic.claude-opus-4-8", inputPricePer1M: 15, outputPricePer1M: 75 },
-  { id: "global.anthropic.claude-sonnet-5", inputPricePer1M: 3, outputPricePer1M: 15 },
-  { id: "global.anthropic.claude-haiku-4-5-20251001-v1:0", inputPricePer1M: 1, outputPricePer1M: 5 },
-];
-
-export interface BedrockMetrics {
-  inputTokensPerMin: number;
-  outputTokensPerMin: number;
-  totalTokensPerMin: number;
-  invocationsPerMin: number;
-  avgLatencyMs: number;
-  estimatedCostPerMin: number;
-}
-
-export interface BedrockMetricsTimeSeries {
-  timestamps: string[];
-  inputTokens: number[];
-  outputTokens: number[];
-  invocations: number[];
-  estimatedCost: number[];
-}
-
-function makeBedrockQuery(
-  id: string,
-  metricName: string,
-  stat: string,
-  period: number,
-  modelId?: string,
-): MetricDataQuery {
-  const dims = modelId ? [{ Name: "ModelId", Value: modelId }] : [];
-  return {
-    Id: id,
-    MetricStat: {
-      Metric: {
-        Namespace: "AWS/Bedrock",
-        MetricName: metricName,
-        Dimensions: dims,
-      },
-      Period: period,
-      Stat: stat,
-    },
-  };
-}
-
-export async function getBedrockMetrics(): Promise<BedrockMetrics> {
-  const periodMinutes = 5;
-  const periodSec = periodMinutes * 60;
-  const end = new Date();
-  const start = new Date(end.getTime() - periodSec * 1000);
-
-  const queries: MetricDataQuery[] = [
-    makeBedrockQuery("agg_in", "InputTokenCount", "Sum", periodSec),
-    makeBedrockQuery("agg_out", "OutputTokenCount", "Sum", periodSec),
-    makeBedrockQuery("agg_inv", "Invocations", "Sum", periodSec),
-    makeBedrockQuery("agg_lat", "InvocationLatency", "Average", periodSec),
-  ];
-  for (const [i, m] of BEDROCK_MODELS.entries()) {
-    queries.push(
-      makeBedrockQuery(`m${i}_in`, "InputTokenCount", "Sum", periodSec, m.id),
-      makeBedrockQuery(`m${i}_out`, "OutputTokenCount", "Sum", periodSec, m.id),
-    );
-  }
-
-  const result = await cwClient.send(
-    new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: queries }),
-  );
-
-  const get = (id: string) =>
-    result.MetricDataResults?.find((r) => r.Id === id)?.Values?.[0] ?? 0;
-
-  const totalInput = get("agg_in");
-  const totalOutput = get("agg_out");
-
-  let totalCost = 0;
-  for (const [i, m] of BEDROCK_MODELS.entries()) {
-    totalCost +=
-      (get(`m${i}_in`) * m.inputPricePer1M + get(`m${i}_out`) * m.outputPricePer1M) / 1_000_000;
-  }
-
-  return {
-    inputTokensPerMin: totalInput / periodMinutes,
-    outputTokensPerMin: totalOutput / periodMinutes,
-    totalTokensPerMin: (totalInput + totalOutput) / periodMinutes,
-    invocationsPerMin: get("agg_inv") / periodMinutes,
-    avgLatencyMs: get("agg_lat"),
-    estimatedCostPerMin: totalCost / periodMinutes,
-  };
-}
-
-export async function getBedrockMetricsTimeSeries(
-  hours: number = 6,
-): Promise<BedrockMetricsTimeSeries> {
-  const periodSec = hours <= 6 ? 300 : 900;
-  const periodMinutes = periodSec / 60;
-  const end = new Date();
-  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
-
-  const queries: MetricDataQuery[] = [
-    makeBedrockQuery("agg_in", "InputTokenCount", "Sum", periodSec),
-    makeBedrockQuery("agg_out", "OutputTokenCount", "Sum", periodSec),
-    makeBedrockQuery("agg_inv", "Invocations", "Sum", periodSec),
-  ];
-  for (const [i, m] of BEDROCK_MODELS.entries()) {
-    queries.push(
-      makeBedrockQuery(`m${i}_in`, "InputTokenCount", "Sum", periodSec, m.id),
-      makeBedrockQuery(`m${i}_out`, "OutputTokenCount", "Sum", periodSec, m.id),
-    );
-  }
-
-  const result = await cwClient.send(
-    new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: queries }),
-  );
-
-  const aggResult = result.MetricDataResults?.find((r) => r.Id === "agg_in");
-  const timestamps = (aggResult?.Timestamps ?? []).map((t) => t.toISOString());
-
-  const modelMaps: { inMap: Map<string, number>; outMap: Map<string, number>; model: typeof BEDROCK_MODELS[number] }[] = [];
-  for (const [i, m] of BEDROCK_MODELS.entries()) {
-    const inResult = result.MetricDataResults?.find((r) => r.Id === `m${i}_in`);
-    const outResult = result.MetricDataResults?.find((r) => r.Id === `m${i}_out`);
-    const inMap = new Map<string, number>();
-    const outMap = new Map<string, number>();
-    (inResult?.Timestamps ?? []).forEach((t, j) => inMap.set(t.toISOString(), inResult?.Values?.[j] ?? 0));
-    (outResult?.Timestamps ?? []).forEach((t, j) => outMap.set(t.toISOString(), outResult?.Values?.[j] ?? 0));
-    modelMaps.push({ inMap, outMap, model: m });
-  }
-
-  const getValues = (id: string) =>
-    (result.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []).reverse();
-
-  const costArr: number[] = [];
-  for (const ts of timestamps) {
-    let cost = 0;
-    for (const { inMap, outMap, model } of modelMaps) {
-      cost += ((inMap.get(ts) ?? 0) * model.inputPricePer1M + (outMap.get(ts) ?? 0) * model.outputPricePer1M) / 1_000_000;
-    }
-    costArr.push(cost / periodMinutes);
-  }
-
-  timestamps.reverse();
-  costArr.reverse();
-
-  return {
-    timestamps,
-    inputTokens: getValues("agg_in").map((v) => v / periodMinutes),
-    outputTokens: getValues("agg_out").map((v) => v / periodMinutes),
-    invocations: getValues("agg_inv").map((v) => v / periodMinutes),
-    estimatedCost: costArr,
-  };
-}
+// ─── Bedrock Usage Metrics ───
+// Removed: CloudWatch AWS/Bedrock queries showed account-wide usage.
+// Bedrock metrics now come from DynamoDB cc-on-bedrock-usage table
+// via usage-client.ts (filtered to cc-on-bedrock IAM roles only).
[38;5;244m - Completed in 0.6s[0m

[?25l[0m[?25l[0m[0mI will run the following command: [38;5;141mcd /home/ec2-user/cc-on-bedrock && git diff -- shared/nextjs-app/src/app/api/container-metrics/route.ts[0m[38;5;244m (using tool: shell)[0m
Purpose: Review API route changes

diff --git a/shared/nextjs-app/src/app/api/container-metrics/route.ts b/shared/nextjs-app/src/app/api/container-metrics/route.ts
index 352b2b6..5baf71e 100644
--- a/shared/nextjs-app/src/app/api/container-metrics/route.ts
+++ b/shared/nextjs-app/src/app/api/container-metrics/route.ts
@@ -4,10 +4,12 @@ import { authOptions } from "@/lib/auth";
 import {
   getEc2AggregateMetrics,
   getEc2TimeSeries,
-  getBedrockMetrics,
-  getBedrockMetricsTimeSeries,
 } from "@/lib/cloudwatch-client";
 import { listInstances } from "@/lib/ec2-clients";
+import {
+  getBedrockUsageSnapshot,
+  getBedrockUsageTimeSeries,
+} from "@/lib/usage-client";
 
 export async function GET(req: NextRequest) {
   const session = await getServerSession(authOptions);
@@ -59,12 +61,12 @@ export async function GET(req: NextRequest) {
         return NextResponse.json({ success: true, data: instanceData });
       }
       case "bedrock": {
-        const brMetrics = await getBedrockMetrics();
+        const brMetrics = await getBedrockUsageSnapshot();
         return NextResponse.json({ success: true, data: brMetrics });
       }
       case "bedrock_timeseries": {
-        const brHours = parseInt(searchParams.get("hours") ?? "6", 10);
-        const brTs = await getBedrockMetricsTimeSeries(brHours);
+        const brDays = parseInt(searchParams.get("days") ?? "7", 10);
+        const brTs = await getBedrockUsageTimeSeries(brDays);
         return NextResponse.json({ success: true, data: brTs });
       }
       default:
[38;5;244m - Completed in 0.6s[0m

[?25l[0m[?25l[0m[0mI will run the following command: [38;5;141mcd /home/ec2-user/cc-on-bedrock && git diff -- shared/nextjs-app/src/app/monitoring/monitoring-dashboard.tsx[0m[38;5;244m (using tool: shell)[0m
Purpose: Review monitoring dashboard UI changes

diff --git a/shared/nextjs-app/src/app/monitoring/monitoring-dashboard.tsx b/shared/nextjs-app/src/app/monitoring/monitoring-dashboard.tsx
index f255120..415ea01 100644
--- a/shared/nextjs-app/src/app/monitoring/monitoring-dashboard.tsx
+++ b/shared/nextjs-app/src/app/monitoring/monitoring-dashboard.tsx
@@ -50,22 +50,28 @@ interface InstanceMetricsRow {
 }
 
 interface BedrockMetricsSnapshot {
-  inputTokensPerMin: number;
-  outputTokensPerMin: number;
-  totalTokensPerMin: number;
-  invocationsPerMin: number;
+  inputTokensToday: number;
+  outputTokensToday: number;
+  totalTokensToday: number;
+  invocationsToday: number;
   avgLatencyMs: number;
-  estimatedCostPerMin: number;
+  estimatedCostToday: number;
+  tokensPerHour: number;
+  costPerHour: number;
+  hoursElapsed: number;
 }
 
-interface BedrockTsData {
-  timestamps: string[];
-  inputTokens: number[];
-  outputTokens: number[];
-  invocations: number[];
-  estimatedCost: number[];
+interface BedrockTsPoint {
+  date: string;
+  inputTokens: number;
+  outputTokens: number;
+  totalTokens: number;
+  invocations: number;
+  estimatedCost: number;
 }
 
+type BedrockTsData = BedrockTsPoint[];
+
 // EC2 on-demand pricing (ap-northeast-2, Seoul)
 const EC2_PRICING: Record<string, number> = {
   "m7g.4xlarge": 0.8208,  // 16 vCPU, 64 GiB
@@ -179,11 +185,11 @@ export default function MonitoringDashboard({
         console.error("EC2 metrics fetch failed:", ec2Err);
       }
 
-      // Bedrock Usage metrics
+      // Bedrock Usage metrics (DynamoDB — cc-on-bedrock project only)
       try {
         const [brRes, brTsRes] = await Promise.all([
           fetch("/api/container-metrics?action=bedrock"),
-          fetch("/api/container-metrics?action=bedrock_timeseries&hours=6"),
+          fetch("/api/container-metrics?action=bedrock_timeseries&days=7"),
         ]);
         if (brRes.ok) {
           const brJson = (await brRes.json()) as ApiResponse<BedrockMetricsSnapshot>;
@@ -375,23 +381,25 @@ export default function MonitoringDashboard({
       <section>
         <h2 className="text-lg font-semibold text-gray-100 mb-4">Bedrock Usage</h2>
 
-        {/* Stat Cards */}
+        {/* Stat Cards — DynamoDB-based, cc-on-bedrock project only */}
         <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
           <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
-            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Tokens / min</p>
+            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Tokens Today</p>
             <p className="text-2xl font-bold text-emerald-400">
-              {bedrockMetrics ? formatNumber(bedrockMetrics.totalTokensPerMin) : "-"}
+              {bedrockMetrics ? formatNumber(bedrockMetrics.totalTokensToday) : "-"}
             </p>
             <p className="text-[10px] text-gray-600 mt-0.5">
-              {bedrockMetrics ? `In ${formatNumber(bedrockMetrics.inputTokensPerMin)} · Out ${formatNumber(bedrockMetrics.outputTokensPerMin)}` : "No data"}
+              {bedrockMetrics ? `In ${formatNumber(bedrockMetrics.inputTokensToday)} · Out ${formatNumber(bedrockMetrics.outputTokensToday)}` : "No data"}
             </p>
           </div>
           <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
-            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Invocations / min</p>
+            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Invocations Today</p>
             <p className="text-2xl font-bold text-blue-400">
-              {bedrockMetrics ? bedrockMetrics.invocationsPerMin.toFixed(1) : "-"}
+              {bedrockMetrics ? formatNumber(bedrockMetrics.invocationsToday) : "-"}
+            </p>
+            <p className="text-[10px] text-gray-600 mt-0.5">
+              {bedrockMetrics ? `~${(bedrockMetrics.invocationsToday / Math.max(bedrockMetrics.hoursElapsed, 0.1)).toFixed(0)}/hr avg` : "Bedrock API calls"}
             </p>
-            <p className="text-[10px] text-gray-600 mt-0.5">Bedrock API calls</p>
           </div>
           <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
             <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Avg Latency</p>
@@ -401,11 +409,13 @@ export default function MonitoringDashboard({
             <p className="text-[10px] text-gray-600 mt-0.5">Response time</p>
           </div>
           <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
-            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Bedrock Cost / hr</p>
+            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Bedrock Cost Today</p>
             <p className="text-2xl font-bold text-rose-400">
-              {bedrockMetrics ? `$${(bedrockMetrics.estimatedCostPerMin * 60).toFixed(2)}` : "-"}
+              {bedrockMetrics ? `$${bedrockMetrics.estimatedCostToday.toFixed(2)}` : "-"}
+            </p>
+            <p className="text-[10px] text-gray-600 mt-0.5">
+              {bedrockMetrics ? `~$${bedrockMetrics.costPerHour.toFixed(2)}/hr avg` : "Token usage cost"}
             </p>
-            <p className="text-[10px] text-gray-600 mt-0.5">Token usage cost</p>
           </div>
         </div>
 
@@ -414,7 +424,7 @@ export default function MonitoringDashboard({
           const devCount = ec2Metrics?.instanceCount ?? 0;
           const devCostHr = devCount * (EC2_PRICING[CLUSTER_INSTANCE_TYPE] ?? 0);
           const dashCostHr = EC2_PRICING[DASHBOARD_INSTANCE_TYPE] ?? 0;
-          const bedrockCostHr = (bedrockMetrics?.estimatedCostPerMin ?? 0) * 60;
+          const bedrockCostHr = bedrockMetrics?.costPerHour ?? 0;
           const totalCostHr = bedrockCostHr + devCostHr + dashCostHr;
           return (
             <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5 mb-4">
@@ -458,31 +468,31 @@ export default function MonitoringDashboard({
           );
         })()}
 
-        {/* Time Series Charts */}
-        {bedrockTimeSeries && bedrockTimeSeries.timestamps.length > 0 && (
+        {/* Time Series Charts — daily from DynamoDB */}
+        {bedrockTimeSeries && bedrockTimeSeries.length > 0 && (
           <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
             <AreaTrendChart
-              data={bedrockTimeSeries.timestamps.map((ts, i) => ({
-                date: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
-                input: bedrockTimeSeries.inputTokens[i] ?? 0,
-                output: bedrockTimeSeries.outputTokens[i] ?? 0,
+              data={bedrockTimeSeries.map((d) => ({
+                date: d.date.slice(5), // MM-DD
+                input: d.inputTokens,
+                output: d.outputTokens,
               }))}
               series={[
-                { key: "input", name: "Input Tokens/min", color: "#34d399" },
-                { key: "output", name: "Output Tokens/min", color: "#f472b6" },
+                { key: "input", name: "Input Tokens", color: "#34d399" },
+                { key: "output", name: "Output Tokens", color: "#f472b6" },
               ]}
-              title="Token Throughput (Last 6h)"
+              title="Daily Token Usage (Last 7 days)"
               height={220}
             />
             <AreaTrendChart
