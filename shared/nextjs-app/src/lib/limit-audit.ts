// Audit record for a standing-limit change (user or department), stored in the
// approval table as an already-applied `limit_change` request so the approvals
// history lists it (dept-managers see items of their own `department`). The limit
// row update and the audit Put commit in ONE transaction: every applied change is
// recorded (spec §5.6), and no audit exists for a change that did not apply.

import { randomUUID } from "crypto";
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  type TransactWriteItem,
  type TransactWriteItemsInput,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { APPROVAL_TABLE } from "./budget-increase";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const dynamodb = new DynamoDBClient({ region });

type Send = (command: TransactWriteItemsCommand) => Promise<unknown>;
const defaultSend: Send = (command) => dynamodb.send(command);

export type LimitRowUpdate = NonNullable<TransactWriteItem["Update"]>;

export interface LimitChange {
  /** Who made the change (lowercased email) and with which fresh role. */
  actor: string;
  actorRole: string;
  /** "user": `email` is the target; "department": the department row itself. */
  targetType: "user" | "department";
  /** Target user's email; omitted for a department change. */
  email?: string;
  /** Target user's department, or the changed department ("" when none). */
  department: string;
  /** Previous values of the changed fields (absent = was unset). */
  before: Record<string, number>;
  after: Record<string, number>;
  appliedAt: string;
}

export function buildLimitChangeItem(change: LimitChange, requestId: string) {
  return {
    PK: `REQUEST#${requestId}`,
    SK: "META",
    requestId,
    type: "limit_change",
    status: "applied",
    actor: change.actor.trim().toLowerCase(),
    actorRole: change.actorRole,
    targetType: change.targetType,
    ...(change.email ? { email: change.email.trim().toLowerCase() } : {}),
    // GSI key (department-status-index): omitted when empty, never "".
    ...(change.department ? { department: change.department } : {}),
    before: change.before,
    after: change.after,
    appliedAt: change.appliedAt,
    requestedAt: change.appliedAt,
  };
}

export function buildLimitChangeTransaction(
  update: LimitRowUpdate,
  change: LimitChange,
  requestId: string
): TransactWriteItemsInput {
  return {
    TransactItems: [
      { Update: update },
      {
        Put: {
          TableName: APPROVAL_TABLE,
          Item: marshall(buildLimitChangeItem(change, requestId)),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
    ],
  };
}

/** Apply the limit row update and record its audit atomically; returns the audit requestId. */
export async function applyLimitChange(
  update: LimitRowUpdate,
  change: LimitChange,
  send: Send = defaultSend
): Promise<string> {
  const requestId = randomUUID();
  await send(new TransactWriteItemsCommand(buildLimitChangeTransaction(update, change, requestId)));
  return requestId;
}

/** Numeric `fields` of a row (unmarshalled item, request body); missing fields are left out. */
export function pickNumbers(row: Record<string, unknown> | undefined, fields: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of fields) {
    const v = row?.[f];
    if (v !== undefined && v !== null && Number.isFinite(Number(v))) out[f] = Number(v);
  }
  return out;
}
