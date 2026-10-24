// ADR-006(legacy 014)/015: mirror a user's $ monthlyBudget into cc-on-bedrock-limits
// LIMIT#monthly so the Stream-driven token-limit-enforcer (near-real-time) can enforce
// it on the Local Governance role. Without this, the only enforcement path is
// budget-check (5-min cron) which used to silently skip Local-only users.
// Shared by /api/admin/budgets and /api/dept/user-budgets.

import {
  DeleteItemCommand,
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { LIMITS_TABLE, NORMALIZED_PER_USD } from "./budget-increase";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const dynamodb = new DynamoDBClient({ region });

type Send = (command: UpdateItemCommand | DeleteItemCommand) => Promise<unknown>;
const defaultSend: Send = (command) => dynamodb.send(command as never);

/**
 * monthlyBudget > 0 → upsert the LIMIT row; monthlyBudget === 0 → delete it so
 * dept.perUserMonthlyBudget (ADR-023) takes over. `userId` must already be the
 * lowercased email (ADR-031 B′), matching the tracker/enforcer key.
 */
export async function syncMonthlyLimitMirror(
  userId: string,
  monthlyBudget: number,
  now: string,
  send: Send = defaultSend
): Promise<void> {
  const Key = { PK: { S: `USER#${userId}` }, SK: { S: "LIMIT#monthly" } };
  if (monthlyBudget > 0) {
    const maxNormalized = Math.floor(monthlyBudget * NORMALIZED_PER_USD);
    await send(new UpdateItemCommand({
      TableName: LIMITS_TABLE,
      Key,
      UpdateExpression: "SET max_normalized = :mx, source_usd = :usd, normalized_per_usd = :rate, updatedAt = :now",
      ExpressionAttributeValues: {
        ":mx": { N: String(maxNormalized) },
        ":usd": { N: String(monthlyBudget) },
        ":rate": { N: String(NORMALIZED_PER_USD) },
        ":now": { S: now },
      },
    }));
    return;
  }
  // DynamoDB DeleteItem is a no-op when the item doesn't exist (it does NOT throw
  // ResourceNotFoundException for missing rows — that exception is reserved for
  // missing tables). Any other error (throttling, AccessDenied, network) must
  // propagate so the PUT returns 500: swallowing here would let
  // cc-user-budgets.monthlyBudget=0 commit while LIMIT#monthly keeps the stale cap,
  // leaving token-limit-enforcer blocking the user on an old threshold.
  await send(new DeleteItemCommand({ TableName: LIMITS_TABLE, Key }));
}
