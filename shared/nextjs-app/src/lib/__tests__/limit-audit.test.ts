import { describe, it, expect } from "vitest";
import { DeleteItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { buildLimitChangeItem, pickNumbers, recordLimitChange } from "../limit-audit";
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

  it("recordLimitChange puts a new item without overwriting", async () => {
    const sent: unknown[] = [];
    const id = await recordLimitChange(change, async (c) => void sent.push(c));
    expect(sent).toHaveLength(1);
    const put = sent[0] as PutItemCommand;
    expect(put).toBeInstanceOf(PutItemCommand);
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(unmarshall(put.input.Item!)).toMatchObject({ PK: `REQUEST#${id}`, type: "limit_change" });
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
