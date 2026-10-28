import { describe, it, expect } from "vitest";
import { isAllowedPath } from "../route-access";

const ADMIN = ["admin"];
const MGR = ["dept-manager"];
const USER = ["user"];

describe("isAllowedPath", () => {
  it("admin may reach every admin path", () => {
    for (const p of ["/api/admin/budgets", "/api/admin/approval-requests", "/admin", "/admin/approvals", "/monitoring"]) {
      expect(isAllowedPath(p, ADMIN)).toBe(true);
    }
  });

  it("dept-manager may reach only the approval API and page under admin", () => {
    expect(isAllowedPath("/api/admin/approval-requests", MGR)).toBe(true);
    expect(isAllowedPath("/admin/approvals", MGR)).toBe(true);
    expect(isAllowedPath("/admin/approvals/x", MGR)).toBe(true);
    expect(isAllowedPath("/api/admin/budgets", MGR)).toBe(false);
    expect(isAllowedPath("/api/admin/users", MGR)).toBe(false);
    expect(isAllowedPath("/admin", MGR)).toBe(false);
    expect(isAllowedPath("/admin/budgets", MGR)).toBe(false);
    expect(isAllowedPath("/monitoring", MGR)).toBe(false);
    expect(isAllowedPath("/api/containers", MGR)).toBe(false);
  });

  it("the approver exception needs a path boundary", () => {
    expect(isAllowedPath("/api/admin/approval-requests-export", MGR)).toBe(false);
    expect(isAllowedPath("/admin/approvalsx", MGR)).toBe(false);
  });

  it("a plain user gets no admin or approver path", () => {
    expect(isAllowedPath("/api/admin/approval-requests", USER)).toBe(false);
    expect(isAllowedPath("/admin/approvals", USER)).toBe(false);
    expect(isAllowedPath("/api/admin/approval-requests", [])).toBe(false);
  });

  it("dept paths need dept-manager or admin", () => {
    expect(isAllowedPath("/dept", MGR)).toBe(true);
    expect(isAllowedPath("/api/dept/x", ADMIN)).toBe(true);
    expect(isAllowedPath("/dept", USER)).toBe(false);
    expect(isAllowedPath("/api/dept/x", USER)).toBe(false);
  });

  it("user paths are open to any authenticated user", () => {
    expect(isAllowedPath("/api/user/budget-increase", USER)).toBe(true);
    expect(isAllowedPath("/user", [])).toBe(true);
  });
});
