/**
 * Usage Tracking Client (replaces litellm-client.ts)
 * Reads from DynamoDB cc-on-bedrock-usage table
 * Data source: Bedrock Invocation Logging → Lambda → DynamoDB
 */
import {
  DynamoDBClient,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const TABLE_NAME = process.env.USAGE_TABLE_NAME ?? "cc-on-bedrock-usage";

const dynamodb = new DynamoDBClient({ region });
const MAX_PAGES = 100;

// ─── Types ───

export interface UsageRecord {
  userId: string;
  department: string;
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  estimatedCost: number;
  latencySumMs: number;
}

export interface UserUsageSummary {
  userId: string;
  department: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  requests: number;
  models: string[];
}

export interface DepartmentSummary {
  department: string;
  totalTokens: number;
  totalCost: number;
  requests: number;
  userCount: number;
}

export interface ModelSummary {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  requests: number;
  avgLatencyMs: number;
}

export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  estimatedCost: number;
}

// ─── Query Functions ───

function toUsageRecord(item: Record<string, AttributeValue>): UsageRecord {
  const u = unmarshall(item);
  return {
    userId: (u.PK as string).replace("USER#", ""),
    department: u.department ?? "default",
    date: u.date ?? (u.SK as string).split("#")[0],
    model: u.model ?? (u.SK as string).split("#")[1] ?? "unknown",
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    totalTokens: u.totalTokens ?? 0,
    requests: u.requests ?? 0,
    estimatedCost: Number(u.estimatedCost ?? 0),
    latencySumMs: Number(u.latencySumMs ?? 0),
  };
}

export async function getUsageRecords(params?: {
  startDate?: string;
  endDate?: string;
  userId?: string;
  department?: string;
}): Promise<UsageRecord[]> {
  // When userId is known, use Query (single partition) instead of Scan
  if (params?.userId) {
    const keyParts = ["PK = :pk"];
    const exprValues: Record<string, AttributeValue> = {
      ":pk": { S: `USER#${params.userId}` },
    };
    if (params.startDate && params.endDate) {
      keyParts.push("SK BETWEEN :start AND :end");
      exprValues[":start"] = { S: params.startDate };
      exprValues[":end"] = { S: `${params.endDate}~` };
    } else if (params.startDate) {
      keyParts.push("SK >= :start");
      exprValues[":start"] = { S: params.startDate };
    } else if (params.endDate) {
      keyParts.push("SK <= :end");
      exprValues[":end"] = { S: `${params.endDate}~` };
    }

    const items: Record<string, AttributeValue>[] = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    let pages = 0;
    do {
      const result = await dynamodb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: keyParts.join(" AND "),
        ExpressionAttributeValues: exprValues,
        ExclusiveStartKey: lastKey,
      }));
      items.push(...(result.Items ?? []));
      lastKey = result.LastEvaluatedKey;
      pages++;
    } while (lastKey && pages < MAX_PAGES);

    return items.map(toUsageRecord);
  }

  // No userId: paginated Scan with optional filters
  const filterParts: string[] = ["begins_with(PK, :userPrefix)"];
  const exprValues: Record<string, AttributeValue> = {
    ":userPrefix": { S: "USER#" },
  };
  if (params?.startDate) {
    filterParts.push("SK >= :startDate");
    exprValues[":startDate"] = { S: params.startDate };
  }
  if (params?.endDate) {
    filterParts.push("SK <= :endDate");
    exprValues[":endDate"] = { S: `${params.endDate}~` };
  }
  if (params?.department) {
    filterParts.push("department = :dept");
    exprValues[":dept"] = { S: params.department };
  }

  const items: Record<string, AttributeValue>[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  let pages = 0;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: filterParts.join(" AND "),
      ExpressionAttributeValues: exprValues,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
    pages++;
  } while (lastKey && pages < MAX_PAGES);

  return items.map(toUsageRecord);
}

export async function getUserSummaries(params?: {
  startDate?: string;
  endDate?: string;
}): Promise<UserUsageSummary[]> {
  const records = await getUsageRecords(params);

  const userMap = new Map<string, UserUsageSummary>();
  for (const r of records) {
    const existing = userMap.get(r.userId) ?? {
      userId: r.userId,
      department: r.department,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      requests: 0,
      models: [],
    };
    existing.totalTokens += r.totalTokens;
    existing.inputTokens += r.inputTokens;
    existing.outputTokens += r.outputTokens;
    existing.totalCost += r.estimatedCost;
    existing.requests += r.requests;
    if (!existing.models.includes(r.model)) existing.models.push(r.model);
    userMap.set(r.userId, existing);
  }

  return Array.from(userMap.values()).sort((a, b) => b.totalCost - a.totalCost);
}

export async function getDepartmentSummaries(params?: {
  startDate?: string;
  endDate?: string;
}): Promise<DepartmentSummary[]> {
  const records = await getUsageRecords(params);

  const deptMap = new Map<string, DepartmentSummary & { users: Set<string> }>();
  for (const r of records) {
    const existing = deptMap.get(r.department) ?? {
      department: r.department,
      totalTokens: 0,
      totalCost: 0,
      requests: 0,
      userCount: 0,
      users: new Set<string>(),
    };
    existing.totalTokens += r.totalTokens;
    existing.totalCost += r.estimatedCost;
    existing.requests += r.requests;
    existing.users.add(r.userId);
    existing.userCount = existing.users.size;
    deptMap.set(r.department, existing);
  }

  return Array.from(deptMap.values())
    .map(({ users, ...rest }) => rest)
    .sort((a, b) => b.totalCost - a.totalCost);
}

export async function getModelSummaries(params?: {
  startDate?: string;
  endDate?: string;
}): Promise<ModelSummary[]> {
  const records = await getUsageRecords(params);

  const modelMap = new Map<string, ModelSummary & { latencySum: number }>();
  for (const r of records) {
    const existing = modelMap.get(r.model) ?? {
      model: r.model,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      requests: 0,
      avgLatencyMs: 0,
      latencySum: 0,
    };
    existing.totalTokens += r.totalTokens;
    existing.inputTokens += r.inputTokens;
    existing.outputTokens += r.outputTokens;
    existing.totalCost += r.estimatedCost;
    existing.requests += r.requests;
    existing.latencySum += r.latencySumMs;
    modelMap.set(r.model, existing);
  }

  return Array.from(modelMap.values())
    .map(({ latencySum, ...rest }) => ({
      ...rest,
      avgLatencyMs: rest.requests > 0 ? Math.round(latencySum / rest.requests) : 0,
    }))
    .sort((a, b) => b.requests - a.requests);
}

export async function getDailyUsage(params?: {
  startDate?: string;
  endDate?: string;
  userId?: string;
}): Promise<DailyUsage[]> {
  const records = await getUsageRecords(params);

  const dateMap = new Map<string, DailyUsage>();
  for (const r of records) {
    const existing = dateMap.get(r.date) ?? {
      date: r.date,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0,
      estimatedCost: 0,
    };
    existing.inputTokens += r.inputTokens;
    existing.outputTokens += r.outputTokens;
    existing.totalTokens += r.totalTokens;
    existing.requests += r.requests;
    existing.estimatedCost += r.estimatedCost;
    dateMap.set(r.date, existing);
  }

  return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Bedrock Usage Snapshot (for Monitoring page) ───

export interface BedrockUsageSnapshot {
  /** Today's input tokens (cc-on-bedrock only) */
  inputTokensToday: number;
  /** Today's output tokens */
  outputTokensToday: number;
  /** Today's total tokens */
  totalTokensToday: number;
  /** Today's total API invocations */
  invocationsToday: number;
  /** Average latency in ms (today, from DynamoDB latencySumMs / requests) */
  avgLatencyMs: number;
  /** Today's estimated cost in USD */
  estimatedCostToday: number;
  /** Average tokens per hour (totalTokens / hours elapsed today) */
  tokensPerHour: number;
  /** Average cost per hour */
  costPerHour: number;
  /** Hours elapsed today (for rate computation) */
  hoursElapsed: number;
}

export interface BedrockUsageTimeSeriesPoint {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  invocations: number;
  estimatedCost: number;
}

/**
 * Query DEPT# aggregate records for a date range.
 * These are pre-aggregated by the Lambda (one row per dept per day).
 */
async function getDeptAggregates(startDate: string, endDate: string): Promise<{
  inputTokens: number; outputTokens: number; totalTokens: number;
  requests: number; estimatedCost: number; latencySumMs: number;
}> {
  const items: Record<string, AttributeValue>[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  let pages = 0;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "begins_with(PK, :deptPrefix) AND SK BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":deptPrefix": { S: "DEPT#" },
        ":start": { S: startDate },
        ":end": { S: `${endDate}~` },
      },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
    pages++;
  } while (lastKey && pages < MAX_PAGES);

  let inputTokens = 0, outputTokens = 0, totalTokens = 0;
  let requests = 0, estimatedCost = 0, latencySumMs = 0;
  for (const item of items) {
    const u = unmarshall(item);
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    totalTokens += u.totalTokens ?? 0;
    requests += u.requests ?? 0;
    estimatedCost += Number(u.estimatedCost ?? 0);
    latencySumMs += Number(u.latencySumMs ?? 0);
  }
  return { inputTokens, outputTokens, totalTokens, requests, estimatedCost, latencySumMs };
}

/**
 * Get today's Bedrock usage from DynamoDB (cc-on-bedrock project only).
 * Tries USER# records first; falls back to DEPT# aggregates if none found.
 */
export async function getBedrockUsageSnapshot(): Promise<BedrockUsageSnapshot> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const records = await getUsageRecords({ startDate: today, endDate: today });

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let requests = 0;
  let cost = 0;
  let latencySum = 0;

  if (records.length > 0) {
    for (const r of records) {
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      totalTokens += r.totalTokens;
      requests += r.requests;
      cost += r.estimatedCost;
      latencySum += r.latencySumMs;
    }
  } else {
    const dept = await getDeptAggregates(today, today);
    inputTokens = dept.inputTokens;
    outputTokens = dept.outputTokens;
    totalTokens = dept.totalTokens;
    requests = dept.requests;
    cost = dept.estimatedCost;
    latencySum = dept.latencySumMs;
  }

  // Hours elapsed since midnight UTC
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const hoursElapsed = Math.max((now.getTime() - midnight.getTime()) / 3_600_000, 0.1);

  return {
    inputTokensToday: inputTokens,
    outputTokensToday: outputTokens,
    totalTokensToday: totalTokens,
    invocationsToday: requests,
    avgLatencyMs: requests > 0 ? Math.round(latencySum / requests) : 0,
    estimatedCostToday: cost,
    tokensPerHour: totalTokens / hoursElapsed,
    costPerHour: cost / hoursElapsed,
    hoursElapsed: Math.round(hoursElapsed * 10) / 10,
  };
}

/**
 * Get daily Bedrock usage time series from DynamoDB (cc-on-bedrock project only).
 * Tries USER# records first; falls back to DEPT# aggregates if none found.
 */
export async function getBedrockUsageTimeSeries(
  days: number = 7,
): Promise<BedrockUsageTimeSeriesPoint[]> {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const daily = await getDailyUsage({ startDate, endDate });

  if (daily.length > 0) {
    return daily.map((d) => ({
      date: d.date,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      totalTokens: d.totalTokens,
      invocations: d.requests,
      estimatedCost: d.estimatedCost,
    }));
  }

  // Fallback: use DEPT# aggregates (one record per dept per day)
  const items: Record<string, AttributeValue>[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  let pages = 0;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "begins_with(PK, :deptPrefix) AND SK BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":deptPrefix": { S: "DEPT#" },
        ":start": { S: startDate },
        ":end": { S: `${endDate}~` },
      },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
    pages++;
  } while (lastKey && pages < MAX_PAGES);

  const dateMap = new Map<string, BedrockUsageTimeSeriesPoint>();
  for (const item of items) {
    const u = unmarshall(item);
    const date = u.SK as string;
    const existing = dateMap.get(date) ?? {
      date, inputTokens: 0, outputTokens: 0, totalTokens: 0, invocations: 0, estimatedCost: 0,
    };
    existing.inputTokens += u.inputTokens ?? 0;
    existing.outputTokens += u.outputTokens ?? 0;
    existing.totalTokens += u.totalTokens ?? 0;
    existing.invocations += u.requests ?? 0;
    existing.estimatedCost += Number(u.estimatedCost ?? 0);
    dateMap.set(date, existing);
  }

  return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Total Spend ───

export async function getTotalUsage(params?: {
  startDate?: string;
  endDate?: string;
}): Promise<{
  totalCost: number;
  totalTokens: number;
  totalRequests: number;
  userCount: number;
}> {
  const records = await getUsageRecords(params);
  const users = new Set(records.map((r) => r.userId));

  return {
    totalCost: records.reduce((s, r) => s + r.estimatedCost, 0),
    totalTokens: records.reduce((s, r) => s + r.totalTokens, 0),
    totalRequests: records.reduce((s, r) => s + r.requests, 0),
    userCount: users.size,
  };
}
