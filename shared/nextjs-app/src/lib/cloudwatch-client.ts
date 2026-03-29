import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const clusterName = process.env.ECS_CLUSTER_NAME ?? "cc-on-bedrock-devenv";
const cwClient = new CloudWatchClient({ region });

export interface ContainerMetrics {
  cpuUtilized: number;
  cpuReserved: number;
  cpuUtilizationPct: number;
  memoryUtilized: number;
  memoryReserved: number;
  memoryUtilizationPct: number;
  networkRxBytes: number;
  networkTxBytes: number;
  storageReadBytes: number;
  storageWriteBytes: number;
  taskCount: number;
  containerInstanceCount: number;
}

export interface ContainerMetricsTimeSeries {
  timestamps: string[];
  cpuUtilized: number[];
  memoryUtilized: number[];
  networkRx: number[];
  networkTx: number[];
}

export interface TaskDefMetrics {
  taskDefFamily: string;
  cpuUtilized: number;
  cpuReserved: number;
  memoryUtilized: number;
  memoryReserved: number;
}

function makeQuery(
  id: string,
  metricName: string,
  stat: string,
  period: number,
  extraDims?: { Name: string; Value: string }[]
): MetricDataQuery {
  const dims = [{ Name: "ClusterName", Value: clusterName }];
  if (extraDims) dims.push(...extraDims);
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: "ECS/ContainerInsights",
        MetricName: metricName,
        Dimensions: dims,
      },
      Period: period,
      Stat: stat,
    },
  };
}

export async function getContainerMetrics(): Promise<ContainerMetrics> {
  const end = new Date();
  const start = new Date(end.getTime() - 10 * 60 * 1000); // last 10 min

  const result = await cwClient.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        makeQuery("cpu", "CpuUtilized", "Average", 300),
        makeQuery("cpuRes", "CpuReserved", "Average", 300),
        makeQuery("mem", "MemoryUtilized", "Average", 300),
        makeQuery("memRes", "MemoryReserved", "Average", 300),
        makeQuery("netRx", "NetworkRxBytes", "Sum", 300),
        makeQuery("netTx", "NetworkTxBytes", "Sum", 300),
        makeQuery("stRead", "StorageReadBytes", "Sum", 300),
        makeQuery("stWrite", "StorageWriteBytes", "Sum", 300),
        makeQuery("tasks", "TaskCount", "Average", 300),
        makeQuery("instances", "ContainerInstanceCount", "Average", 300),
      ],
    })
  );

  const get = (id: string) =>
    result.MetricDataResults?.find((r) => r.Id === id)?.Values?.[0] ?? 0;

  const cpuUtilized = get("cpu");
  const cpuReserved = get("cpuRes");
  const memoryUtilized = get("mem");
  const memoryReserved = get("memRes");

  return {
    cpuUtilized,
    cpuReserved,
    cpuUtilizationPct: cpuReserved > 0 ? (cpuUtilized / cpuReserved) * 100 : 0,
    memoryUtilized,
    memoryReserved,
    memoryUtilizationPct: memoryReserved > 0 ? (memoryUtilized / memoryReserved) * 100 : 0,
    networkRxBytes: get("netRx"),
    networkTxBytes: get("netTx"),
    storageReadBytes: get("stRead"),
    storageWriteBytes: get("stWrite"),
    taskCount: get("tasks"),
    containerInstanceCount: get("instances"),
  };
}

export async function getContainerMetricsTimeSeries(
  hours: number = 6
): Promise<ContainerMetricsTimeSeries> {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const period = hours <= 6 ? 300 : 900; // 5min or 15min

  const result = await cwClient.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        makeQuery("cpu", "CpuUtilized", "Average", period),
        makeQuery("mem", "MemoryUtilized", "Average", period),
        makeQuery("netRx", "NetworkRxBytes", "Sum", period),
        makeQuery("netTx", "NetworkTxBytes", "Sum", period),
      ],
    })
  );

  const cpuResult = result.MetricDataResults?.find((r) => r.Id === "cpu");
  const timestamps = (cpuResult?.Timestamps ?? [])
    .map((t) => t.toISOString())
    .reverse();

  const getValues = (id: string) =>
    (result.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []).reverse();

  return {
    timestamps,
    cpuUtilized: getValues("cpu"),
    memoryUtilized: getValues("mem"),
    networkRx: getValues("netRx"),
    networkTx: getValues("netTx"),
  };
}

// Per-task metrics for individual user containers
export interface TaskMetrics {
  cpu: number;        // CPU units utilized
  cpuLimit: number;   // CPU units reserved
  memory: number;     // Memory MB utilized
  memoryLimit: number; // Memory MB reserved
  networkRx: number;  // bytes received (last period)
  networkTx: number;  // bytes sent (last period)
  diskRead: number;   // bytes read (last period)
  diskWrite: number;  // bytes written (last period)
  timeseries: Array<{
    time: string;
    cpu: number;
    memory: number;
    networkRx: number;
    networkTx: number;
  }>;
}

export async function getTaskMetrics(taskId: string): Promise<TaskMetrics> {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000); // last 1 hour
  const taskDims = [{ Name: "TaskId", Value: taskId }];

  const result = await cwClient.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        makeQuery("cpu", "CpuUtilized", "Average", 60, taskDims),
        makeQuery("cpuR", "CpuReserved", "Average", 60, taskDims),
        makeQuery("mem", "MemoryUtilized", "Average", 60, taskDims),
        makeQuery("memR", "MemoryReserved", "Average", 60, taskDims),
        makeQuery("netRx", "NetworkRxBytes", "Sum", 60, taskDims),
        makeQuery("netTx", "NetworkTxBytes", "Sum", 60, taskDims),
        makeQuery("stRd", "StorageReadBytes", "Sum", 60, taskDims),
        makeQuery("stWr", "StorageWriteBytes", "Sum", 60, taskDims),
      ],
    })
  );

  const getLatest = (id: string) =>
    result.MetricDataResults?.find((r) => r.Id === id)?.Values?.[0] ?? 0;

  // Build timeseries from CPU timestamps
  const cpuResult = result.MetricDataResults?.find((r) => r.Id === "cpu");
  const timestamps = (cpuResult?.Timestamps ?? []).map((t) => t.toISOString());
  const getAll = (id: string) =>
    result.MetricDataResults?.find((r) => r.Id === id)?.Values ?? [];

  const cpuVals = getAll("cpu");
  const memVals = getAll("mem");
  const rxVals = getAll("netRx");
  const txVals = getAll("netTx");

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
    cpuLimit: getLatest("cpuR"),
    memory: getLatest("mem"),
    memoryLimit: getLatest("memR"),
    networkRx: getLatest("netRx"),
    networkTx: getLatest("netTx"),
    diskRead: getLatest("stRd"),
    diskWrite: getLatest("stWr"),
    timeseries,
  };
}

export async function getTaskDefMetrics(): Promise<TaskDefMetrics[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 10 * 60 * 1000);

  const families = [
    "devenv-ubuntu-light",
    "devenv-ubuntu-standard",
    "devenv-ubuntu-power",
    "devenv-al2023-light",
    "devenv-al2023-standard",
    "devenv-al2023-power",
  ];

  const queries: MetricDataQuery[] = [];
  for (const [i, family] of families.entries()) {
    const dims = [{ Name: "TaskDefinitionFamily", Value: family }];
    queries.push(
      makeQuery(`cpu${i}`, "CpuUtilized", "Average", 300, dims),
      makeQuery(`cpuR${i}`, "CpuReserved", "Average", 300, dims),
      makeQuery(`mem${i}`, "MemoryUtilized", "Average", 300, dims),
      makeQuery(`memR${i}`, "MemoryReserved", "Average", 300, dims),
    );
  }

  const result = await cwClient.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: queries,
    })
  );

  const get = (id: string) =>
    result.MetricDataResults?.find((r) => r.Id === id)?.Values?.[0] ?? 0;

  return families
    .map((family, i) => ({
      taskDefFamily: family,
      cpuUtilized: get(`cpu${i}`),
      cpuReserved: get(`cpuR${i}`),
      memoryUtilized: get(`mem${i}`),
      memoryReserved: get(`memR${i}`),
    }))
    .filter((m) => m.cpuReserved > 0 || m.memoryReserved > 0);
}
