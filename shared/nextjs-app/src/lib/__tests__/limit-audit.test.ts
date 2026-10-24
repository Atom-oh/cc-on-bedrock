import { describe, it, expect } from "vitest";
import { DeleteItemCommand, TransactWriteItemsCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { applyLimitChange, buildLimitChangeItem, pickNumbers } from "../limit-audit";
import { syncMonthlyLimitMirror } from "../limit-mirror";
import { NORMALIZED_PER_USD } from "../budget-increase";

const change = {
  actor: "M@X.com",
  actorRole: "dept-manager",
  targetType: "user" as const,
  email: "U@X.com",
  department: "engineering",
  before: { monthlyBudget: 100 },
  after: { monthlyBudget: 200 },
  appliedAt: "2026-10-24T05:00:00.000Z",
};

describe("limit_change audit record", () => {
  it("is an applied request listed by department and sorted by requestedAt", () => {
    const item = buildLimitChangeItem(change, "abc");
    expect(item).toMatchObject({
      PK: "REQUEST#abc",
      SK: "META",
      requestId: "abc",
      type: "limit_change",
      status: "applied",
      actor: "m@x.com",
      email: "u@x.com",
      department: "engineering",
      before: { monthlyBudget: 100 },
      after: { monthlyBudget: 200 },
      appliedAt: change.appliedAt,
      requestedAt: change.appliedAt,
    });
  });

  it("department change carries no email attribute", () => {
    const item = buildLimitChangeItem({ ...change, targetType: "department", email: undefined }, "d");
    expect("email" in item).toBe(false);
    expect(item.targetType).toBe("department");
  });

  it("applyLimitChange commits the row update and the audit Put in one transaction", async () => {
    const sent: unknown[] = [];
    const update = {
      TableName: "cc-user-budgets",
      Key: { user_id: { S: "u@x.com" } },
      UpdateExpression: "SET monthlyBudget = :m",
      ExpressionAttributeValues: { ":m": { N: "200" } },
    };
    const id = await applyLimitChange(update, change, async (c) => void sent.push(c));
    expect(sent).toHaveLength(1);
    const tx = sent[0] as TransactWriteItemsCommand;
    expect(tx).toBeInstanceOf(TransactWriteItemsCommand);
    const [first, second] = tx.input.TransactItems!;
    expect(first.Update).toEqual(update);
    expect(second.Put!.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(unmarshall(second.Put!.Item!)).toMatchObject({ PK: `REQUEST#${id}`, type: "limit_change" });
  });

  it("applyLimitChange propagates a failed transaction", async () => {
    await expect(
      applyLimitChange({ TableName: "t", Key: {}, UpdateExpression: "SET a = :a" }, change, async () => {
        throw new Error("TransactionCanceledException");
      })
    ).rejects.toThrow();
  });

  it("pickNumbers keeps only present numeric fields", () => {
    expect(pickNumbers({ dailyBudget: 5, weeklyBudget: undefined, updatedAt: "x" }, ["dailyBudget", "weeklyBudget"])).toEqual({
      dailyBudget: 5,
    });
    expect(pickNumbers(undefined, ["dailyBudget"])).toEqual({});
  });
});

describe("syncMonthlyLimitMirror", () => {
  it("monthly > 0 upserts LIMIT#monthly in normalized tokens", async () => {
    const sent: unknown[] = [];
    await syncMonthlyLimitMirror("u@x.com", 30, "now", async (c) => void sent.push(c));
    const upd = sent[0] as UpdateItemCommand;
    expect(upd).toBeInstanceOf(UpdateItemCommand);
    expect(upd.input.Key).toEqual({ PK: { S: "USER#u@x.com" }, SK: { S: "LIMIT#monthly" } });
    expect(upd.input.ExpressionAttributeValues?.[":mx"]).toEqual({ N: String(Math.floor(30 * NORMALIZED_PER_USD)) });
  });

  it("monthly 0 deletes the row so the department default takes over", async () => {
    const sent: unknown[] = [];
    await syncMonthlyLimitMirror("u@x.com", 0, "now", async (c) => void sent.push(c));
    expect(sent[0]).toBeInstanceOf(DeleteItemCommand);
    expect((sent[0] as DeleteItemCommand).input.Key).toEqual({ PK: { S: "USER#u@x.com" }, SK: { S: "LIMIT#monthly" } });
  });
});
