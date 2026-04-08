import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const cwClient = new CloudWatchClient({ region });

// ─── EC2 Instance Metrics ───

export interface InstanceMetrics {
  cpu: number;            // CPUUtilization % (0-100)
  cpuLimit: number;       // always 100
  memory: number;         // mem_used_percent % (0-100), from CWAgent
  memoryLimit: number;    // always 100
  memoryUsedBytes: number; // mem_used (bytes) from CWAgent
  memoryTotalBytes: number; // mem_total (bytes) from CWAgent
  networkRx: number;      // bytes received
  networkTx: number;      // bytes sent
  diskRead: number;       // always 0 (use diskUsedPercent instead)
  diskWrite: number;      // always 0
  diskUsedPercent: number; // disk_used_percent from CWAgent
  timeseries: Array<{
    time: string;
    cpu: number;
    memory: number;
    networkRx: number;
    networkTx: number;
  }>;
}

export interface InstanceTimeSeries {
  timestamps: string[];
  cpu: number[];
  memory: number[];
  networkRx: number[];
  networkTx: number[];
}

export interface AggregateMetrics {
  avgCpu: number;
  avgMemory: number;
  totalNetworkRx: number;
  totalNetworkTx: number;
  instanceCount: number;
  instances: Array<{
    instanceId: string;
    cpu: number;
    memory: number;
    networkRx: number;
    networkTx: number;
  }>;
}

function ec2Query(
  id: string,
  namespace: string,
  metricName: string,
  stat: string,
  period: number,
  instanceId: string,
): MetricDataQuery {
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: [{ Name: "InstanceId", Value: instanceId }],
      },
      Period: period,
      Stat: stat,
    },
  };
}

/**
 * Get metrics for a single EC2 instance.
 * CPU/Network from AWS/EC2, Memory/Disk from CWAgent namespace.
 */
export async function getEc2Metrics(instanceId: string): Promise<InstanceMetrics> {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000); // last 1 hour
  const period = 60;

  const result = await cwClient.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        ec2Query("cpu", "AWS/EC2", "CPUUtilization", "Average", period, instanceId),
        ec2Query("mem", "CWAgent", "mem_used_percent", "Average", period, instanceId),
        ec2Query("netRx", "AWS/EC2", "NetworkIn", "Sum", period, instanceId),
        ec2Query("netTx", "AWS/EC2", "NetworkOut", "Sum", period, instanceId),
        ec2Query("disk", "CWAgent", "disk_used_percent", "Average", period, instanceId),
        ec2Query("memUsed", "CWAgent", "mem_used", "Average", period, instanceId),
        ec2Query("memTotal", "CWAgent", "mem_total", "Average", period, instanceId),
      ],
    })
  );

  const getLatest = (id: string) =>
    result.MetricDataResults?.find((r) => r.Id === id)?.Values?.[0] ?? 0;

  // Build timeseries from CPU timestamps
  const cpuResult = result.MetricDataResults?.find((r) => r.Id === "cpu");
  const memResult = result.MetricDataResults?.find((r) => r.Id === "mem");
  const rxResult = result.MetricDataResults?.find((r) => r.Id === "netRx");
  const txResult = result.MetricDataResults?.find((r) => r.Id === "netTx");

  const timestamps = (cpuResult?.Timestamps ?? []).map((t) => t.toISOString());
  const cpuVals = cpuResult?.Values ?? [];
  const memVals = memResult?.Values ?? [];
  const rxVals = rxResult?.Values ?? [];
  const txVals = txResult?.Values ?? [];

  // CloudWatch returns newest-first, reverse for chart display
  const timeseries = timestamps.map((time, i) => ({
    time,
    cpu: cpuVals[i] ?? 0,
    memory: memVals[i] ?? 0,
    networkRx: rxVals[i] ?? 0,
    networkTx: txVals[i] ?? 0,
  })).reverse();

  return {
    cpu: getLatest("cpu"),
    cpuLimit: 100,
    memory: getLatest("mem"),
    memoryLimit: 100,
    memoryUsedBytes: getLatest("memUsed"),
    memoryTotalBytes: getLatest("memTotal"),
    networkRx: getLatest("netRx"),
    networkTx: getLatest("netTx"),
    diskRead: 0,
    diskWrite: 0,
    diskUsedPercent: getLatest("disk"),
    timeseries,
  };
}

/**
 * Get time series for a single EC2 instance (for charts).
 */
export async function getEc2TimeSeries(instanceId: string, hours: number = 6): Promise<InstanceTimeSeries> {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const period = hours <= 6 ? 300 : 900;

  const result = await cwClient.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        ec2Query("cpu", "AWS/EC2", "CPUUtilization", "Average", period, instanceId),
        ec2Query("mem", "CWAgent", "mem_used_percent", "Average", period, instanceId),
        ec2Query("netRx", "AWS/EC2", "NetworkIn", "Sum", period, instanceId),
        ec2Query("netTx", "AWS/EC2", "NetworkOut", "Sum", period, instanceId),
      ],
    })
  );

  const cpuResult = result.MetricDataResults?.find((r) => r.Id === "cpu");
  const timestamps = (cpuResult?.Timestamps ?? []).map((t) => t.toISOString()).reverse();

  const getValues = (id: string) =>
    (result.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []).reverse();

  return {
    timestamps,
    cpu: getValues("cpu"),
    memory: getValues("mem"),
    networkRx: getValues("netRx"),
    networkTx: getValues("netTx"),
  };
}

/**
 * Get aggregate metrics across multiple EC2 instances (admin dashboard).
 */
export async function getEc2AggregateMetrics(instanceIds: string[]): Promise<AggregateMetrics> {
  if (instanceIds.length === 0) {
    return { avgCpu: 0, avgMemory: 0, totalNetworkRx: 0, totalNetworkTx: 0, instanceCount: 0, instances: [] };
  }

  const end = new Date();
  const start = new Date(end.getTime() - 10 * 60 * 1000);
  const period = 300;

  const queries: MetricDataQuery[] = [];
  for (const [i, id] of instanceIds.entries()) {
    queries.push(
      ec2Query(`cpu${i}`, "AWS/EC2", "CPUUtilization", "Average", period, id),
      ec2Query(`mem${i}`, "CWAgent", "mem_used_percent", "Average", period, id),
      ec2Query(`rx${i}`, "AWS/EC2", "NetworkIn", "Sum", period, id),
      ec2Query(`tx${i}`, "AWS/EC2", "NetworkOut", "Sum", period, id),
    );
  }

  // CloudWatch allows max 500 queries; batch if needed
  const batchSize = 500;
  const allResults: Map<string, number> = new Map();
  for (let offset = 0; offset < queries.length; offset += batchSize) {
    const batch = queries.slice(offset, offset + batchSize);
    const result = await cwClient.send(
      new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: batch })
    );
    for (const r of result.MetricDataResults ?? []) {
      allResults.set(r.Id!, r.Values?.[0] ?? 0);
    }
  }

  const instances = instanceIds.map((id, i) => ({
    instanceId: id,
    cpu: allResults.get(`cpu${i}`) ?? 0,
    memory: allResults.get(`mem${i}`) ?? 0,
    networkRx: allResults.get(`rx${i}`) ?? 0,
    networkTx: allResults.get(`tx${i}`) ?? 0,
  }));

  const running = instances.filter((inst) => inst.cpu > 0 || inst.memory > 0);
  const count = running.length || 1;

  return {
    avgCpu: instances.reduce((sum, i) => sum + i.cpu, 0) / count,
    avgMemory: instances.reduce((sum, i) => sum + i.memory, 0) / count,
    totalNetworkRx: instances.reduce((sum, i) => sum + i.networkRx, 0),
    totalNetworkTx: instances.reduce((sum, i) => sum + i.networkTx, 0),
    instanceCount: instanceIds.length,
    instances,
  };
}

// ─── Bedrock Usage Metrics (AWS/Bedrock namespace) ───

const BEDROCK_MODELS = [
  { id: "global.anthropic.claude-opus-4-6-v1", inputPricePer1M: 15, outputPricePer1M: 75 },
  { id: "global.anthropic.claude-sonnet-4-6", inputPricePer1M: 3, outputPricePer1M: 15 },
  { id: "global.anthropic.claude-haiku-4-5-20251001-v1:0", inputPricePer1M: 1, outputPricePer1M: 5 },
];

export interface BedrockMetrics {
  inputTokensPerMin: number;
  outputTokensPerMin: number;
  totalTokensPerMin: number;
  invocationsPerMin: number;
  avgLatencyMs: number;
  estimatedCostPerMin: number;
}

export interface BedrockMetricsTimeSeries {
  timestamps: string[];
  inputTokens: number[];
  outputTokens: number[];
  invocations: number[];
  estimatedCost: number[];
}

function makeBedrockQuery(
  id: string,
  metricName: string,
  stat: string,
  period: number,
  modelId?: string,
): MetricDataQuery {
  const dims = modelId ? [{ Name: "ModelId", Value: modelId }] : [];
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: "AWS/Bedrock",
        MetricName: metricName,
        Dimensions: dims,
      },
      Period: period,
      Stat: stat,
    },
  };
}

export async function getBedrockMetrics(): Promise<BedrockMetrics> {
  const periodMinutes = 5;
  const periodSec = periodMinutes * 60;
  const end = new Date();
  const start = new Date(end.getTime() - periodSec * 1000);

  const queries: MetricDataQuery[] = [
    makeBedrockQuery("agg_in", "InputTokenCount", "Sum", periodSec),
    makeBedrockQuery("agg_out", "OutputTokenCount", "Sum", periodSec),
    makeBedrockQuery("agg_inv", "Invocations", "Sum", periodSec),
    makeBedrockQuery("agg_lat", "InvocationLatency", "Average", periodSec),
  ];
  for (const [i, m] of BEDROCK_MODELS.entries()) {
    queries.push(
      makeBedrockQuery(`m${i}_in`, "InputTokenCount", "Sum", periodSec, m.id),
      makeBedrockQuery(`m${i}_out`, "OutputTokenCount", "Sum", periodSec, m.id),
    );
  }

  const result = await cwClient.send(
    new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: queries }),
  );

  const get = (id: string) =>
    result.MetricDataResults?.find((r) => r.Id === id)?.Values?.[0] ?? 0;

  const totalInput = get("agg_in");
  const totalOutput = get("agg_out");

  let totalCost = 0;
  for (const [i, m] of BEDROCK_MODELS.entries()) {
    totalCost +=
      (get(`m${i}_in`) * m.inputPricePer1M + get(`m${i}_out`) * m.outputPricePer1M) / 1_000_000;
  }

  return {
    inputTokensPerMin: totalInput / periodMinutes,
    outputTokensPerMin: totalOutput / periodMinutes,
    totalTokensPerMin: (totalInput + totalOutput) / periodMinutes,
    invocationsPerMin: get("agg_inv") / periodMinutes,
    avgLatencyMs: get("agg_lat"),
    estimatedCostPerMin: totalCost / periodMinutes,
  };
}

export async function getBedrockMetricsTimeSeries(
  hours: number = 6,
): Promise<BedrockMetricsTimeSeries> {
  const periodSec = hours <= 6 ? 300 : 900;
  const periodMinutes = periodSec / 60;
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);

  const queries: MetricDataQuery[] = [
    makeBedrockQuery("agg_in", "InputTokenCount", "Sum", periodSec),
    makeBedrockQuery("agg_out", "OutputTokenCount", "Sum", periodSec),
    makeBedrockQuery("agg_inv", "Invocations", "Sum", periodSec),
  ];
  for (const [i, m] of BEDROCK_MODELS.entries()) {
    queries.push(
      makeBedrockQuery(`m${i}_in`, "InputTokenCount", "Sum", periodSec, m.id),
      makeBedrockQuery(`m${i}_out`, "OutputTokenCount", "Sum", periodSec, m.id),
    );
  }

  const result = await cwClient.send(
    new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: queries }),
  );

  const aggResult = result.MetricDataResults?.find((r) => r.Id === "agg_in");
  const timestamps = (aggResult?.Timestamps ?? []).map((t) => t.toISOString());

  const modelMaps: { inMap: Map<string, number>; outMap: Map<string, number>; model: typeof BEDROCK_MODELS[number] }[] = [];
  for (const [i, m] of BEDROCK_MODELS.entries()) {
    const inResult = result.MetricDataResults?.find((r) => r.Id === `m${i}_in`);
    const outResult = result.MetricDataResults?.find((r) => r.Id === `m${i}_out`);
    const inMap = new Map<string, number>();
    const outMap = new Map<string, number>();
    (inResult?.Timestamps ?? []).forEach((t, j) => inMap.set(t.toISOString(), inResult?.Values?.[j] ?? 0));
    (outResult?.Timestamps ?? []).forEach((t, j) => outMap.set(t.toISOString(), outResult?.Values?.[j] ?? 0));
    modelMaps.push({ inMap, outMap, model: m });
  }

  const getValues = (id: string) =>
    (result.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []).reverse();

  const costArr: number[] = [];
  for (const ts of timestamps) {
    let cost = 0;
    for (const { inMap, outMap, model } of modelMaps) {
      cost += ((inMap.get(ts) ?? 0) * model.inputPricePer1M + (outMap.get(ts) ?? 0) * model.outputPricePer1M) / 1_000_000;
    }
    costArr.push(cost / periodMinutes);
  }

  timestamps.reverse();
  costArr.reverse();

  return {
    timestamps,
    inputTokens: getValues("agg_in").map((v) => v / periodMinutes),
    outputTokens: getValues("agg_out").map((v) => v / periodMinutes),
    invocations: getValues("agg_inv").map((v) => v / periodMinutes),
    estimatedCost: costArr,
  };
}
