import { describe, expect, it } from "vitest";
import { syncMonthlyLimitMirror } from "@/lib/limit-mirror";

type Cmd = { input: Record<string, unknown>; constructor: { name: string } };

function recorder(fail?: string) {
  const sent: Cmd[] = [];
  const send = async (c: unknown) => {
    sent.push(c as Cmd);
    if (fail) throw Object.assign(new Error(fail), { name: fail });
    return {};
  };
  return { sent, send };
}

describe("syncMonthlyLimitMirror", () => {
  it("admin writes are unconditional (upsert / delete)", async () => {
    const up = recorder();
    expect(await syncMonthlyLimitMirror("a@x.com", 10, "t", up.send)).toBe("written");
    expect(up.sent[0].input.ConditionExpression).toBeUndefined();
    const del = recorder();
    await syncMonthlyLimitMirror("a@x.com", 0, "t", del.send);
    expect(del.sent[0].constructor.name).toBe("DeleteItemCommand");
    expect(del.sent[0].input.ConditionExpression).toBeUndefined();
  });

  it("manager writes only touch mirror-created rows and never delete a granted row", async () => {
    const up = recorder();
    await syncMonthlyLimitMirror("a@x.com", 10, "t", up.send, { mirrorRowsOnly: true });
    expect(up.sent[0].input.ConditionExpression).toBe("attribute_not_exists(PK) OR attribute_exists(source_usd)");
    const del = recorder();
    await syncMonthlyLimitMirror("a@x.com", 0, "t", del.send, { mirrorRowsOnly: true });
    expect(del.sent[0].input.ConditionExpression).toBe(
      "attribute_exists(source_usd) AND attribute_not_exists(grant_normalized)"
    );
  });

  it("an admin-set token cap is preserved, not an error, on a manager write", async () => {
    const r = recorder("ConditionalCheckFailedException");
    expect(await syncMonthlyLimitMirror("a@x.com", 0, "t", r.send, { mirrorRowsOnly: true })).toBe("preserved");
  });

  it("other failures still propagate", async () => {
    const r = recorder("ThrottlingException");
    await expect(syncMonthlyLimitMirror("a@x.com", 0, "t", r.send, { mirrorRowsOnly: true })).rejects.toThrow();
    const a = recorder("ConditionalCheckFailedException");
    await expect(syncMonthlyLimitMirror("a@x.com", 0, "t", a.send)).rejects.toThrow();
  });
});
