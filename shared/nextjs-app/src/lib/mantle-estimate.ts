/**
 * ADR-014 §9 stage 1: ESTIMATED Codex-on-bedrock-mantle cost per user.
 *
 * The usage tracker writes MANTLE#{YYYY-MM} rows (SK `{email}#{date}#{model}`) from the
 * AWS/BedrockMantle per-project token metrics × the price table. They are an
 * estimate only: budgets and the usage pages never read this PK prefix.
 */
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

const TABLE_NAME = process.env.USAGE_TABLE_NAME ?? "cc-on-bedrock-usage";
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-northeast-2" });
const MAX_PAGES = 50;

/** Shown wherever the estimate appears (UI + docs say the same). */
export const MANTLE_ESTIMATE_CAVEAT =
  "Estimate only — may differ from the AWS bill: runtime price table (not mantle in-region rates), " +
  "cached input priced as full input, no discounts/EDP, web-search query charges excluded, metrics lag up to ~15 min. " +
  "Not counted toward any budget.";

export interface MantleEstimateRow {
  email: string;
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  updatedAt: string;
}

export interface MantleUserEstimate {
  email: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  models: string[];
  updatedAt: string;
}

export function toMantleRow(item: Record<string, AttributeValue>): MantleEstimateRow {
  const r = unmarshall(item);
  const parts = String(r.SK ?? "").split("#");
  const model = parts.pop() ?? "";
  const date = parts.pop() ?? "";
  return {
    email: r.email != null ? String(r.email) : parts.join("#"),
    date,
    model,
    inputTokens: Number(r.inputTokens ?? 0),
    outputTokens: Number(r.outputTokens ?? 0),
    estimatedCost: Number(r.estimatedCost ?? 0),
    updatedAt: String(r.updatedAt ?? ""),
  };
}

/** Per-user totals for rows whose date starts with `period` (e.g. "2026-10"), costliest first. */
export function summarizeMantle(rows: MantleEstimateRow[], period: string): MantleUserEstimate[] {
  const byUser = new Map<string, MantleUserEstimate>();
  for (const r of rows) {
    if (!r.date.startsWith(period)) continue;
    const u = byUser.get(r.email) ?? {
      email: r.email, inputTokens: 0, outputTokens: 0, estimatedCost: 0, models: [], updatedAt: "",
    };
    u.inputTokens += r.inputTokens;
    u.outputTokens += r.outputTokens;
    u.estimatedCost += r.estimatedCost;
    if (!u.models.includes(r.model)) u.models.push(r.model);
    if (r.updatedAt > u.updatedAt) u.updatedAt = r.updatedAt;
    byUser.set(r.email, u);
  }
  return [...byUser.values()].sort((a, b) => b.estimatedCost - a.estimatedCost);
}

/**
 * MANTLE#{period} rows via a single-partition Query: everyone, or one user
 * (SK prefix `{email}#`, then an exact email match). `truncated` is true when
 * MAX_PAGES stopped the read before the partition was exhausted.
 */
export async function getMantleRows(
  params: { email?: string; period: string },
): Promise<{ rows: MantleEstimateRow[]; truncated: boolean }> {
  const items: Record<string, AttributeValue>[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  let pages = 0;
  do {
    const result = await dynamodb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: params.email ? "PK = :pk AND begins_with(SK, :user)" : "PK = :pk",
      ExpressionAttributeValues: params.email
        ? { ":pk": { S: `MANTLE#${params.period}` }, ":user": { S: `${params.email}#` } }
        : { ":pk": { S: `MANTLE#${params.period}` } },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
    pages++;
  } while (lastKey && pages < MAX_PAGES);
  let rows = items.map(toMantleRow);
  // An email containing `#` must not match another user's SK prefix.
  if (params.email) rows = rows.filter((r) => r.email === params.email);
  return { rows, truncated: Boolean(lastKey) };
}
