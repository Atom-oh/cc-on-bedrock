import { describe, it, expect } from "vitest";
import { canApproveRequest } from "../approval-authz";

const admin = { isAdmin: true, groups: ["admin"], department: undefined };
const deptMgrEng = { isAdmin: false, groups: ["dept-manager"], department: "engineering" };
const deptMgrNoDept = { isAdmin: false, groups: ["dept-manager"], department: undefined };
const plainUser = { isAdmin: false, groups: ["user"], department: "engineering" };

describe("canApproveRequest — admin OR dept-manager(stored department)", () => {
  it("admin can approve any department", () => {
    expect(canApproveRequest(admin, "engineering")).toBe(true);
    expect(canApproveRequest(admin, "research")).toBe(true);
  });

  it("dept-manager can approve only their own department", () => {
    expect(canApproveRequest(deptMgrEng, "engineering")).toBe(true);
    expect(canApproveRequest(deptMgrEng, "research")).toBe(false);
  });

  it("dept-manager with no department cannot approve", () => {
    expect(canApproveRequest(deptMgrNoDept, "engineering")).toBe(false);
  });

it("dept-manager denied when the request has no stored department (fail-closed)", () => {
    expect(canApproveRequest(deptMgrEng, "")).toBe(false);
  });

  it("plain user cannot approve even in their department", () => {
    expect(canApproveRequest(plainUser, "engineering")).toBe(false);
  });
});
