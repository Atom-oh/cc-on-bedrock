import { describe, it, expect } from "vitest";
import {
  MAX_INCREASE_USD,
  MAX_REASON_LENGTH,
  actionableCount,
  budgetRequestGate,
  errorKey,
  isExpiredRequest,
  isRequestTypeVisible,
  releaseNotice,
  validIncreaseForm,
  fill,
  nearLimit,
  APPROVAL_ERRORS,
  type ViewRequest,
} from "../budget-ui";
import * as server from "../budget-increase";

const NOW = new Date("2026-10-24T12:00:00Z");
const ADMIN = { email: "admin@x.com", isAdmin: true };
const MGR = { email: "mgr@x.com", isAdmin: false };

const req = (over: Partial<ViewRequest> = {}): ViewRequest => ({
  type: "budget_increase",
  email: "dev@x.com",
  status: "pending",
  period: "daily",
  periodKey: "2026-10-24",
  requesterRole: "user",
  ...over,
});

describe("budget-ui bounds match the server", () => {
  it("uses the server's amount and reason limits", () => {
    expect(MAX_INCREASE_USD).toBe(server.MAX_INCREASE_USD);
    expect(MAX_REASON_LENGTH).toBe(server.MAX_REASON_LENGTH);
  });
});

describe("isRequestTypeVisible — governance shows no instance-permission requests", () => {
  it("hides iam_extension, tier_change, dlp_change, container_request in governance only", () => {
    for (const t of ["iam_extension", "tier_change", "dlp_change", "container_request"]) {
      expect(isRequestTypeVisible(t, "governance")).toBe(false);
      expect(isRequestTypeVisible(t, "devenv")).toBe(true);
    }
    expect(isRequestTypeVisible("budget_increase", "governance")).toBe(true);
    expect(isRequestTypeVisible("limit_change", "governance")).toBe(true);
  });
});

describe("budgetRequestGate", () => {
  const dept = { monthlyBudget: 100, monthSpend: 80, monthGranted: 10 };

  it("expired when the request's window is no longer current", () => {
    expect(isExpiredRequest(req({ periodKey: "2026-10-23" }), NOW)).toBe(true);
    expect(budgetRequestGate(req({ periodKey: "2026-10-23" }), ADMIN, 5, null, NOW)).toBe("expired");
    expect(isExpiredRequest(req({ periodKey: "2026-10-23", status: "approved" }), NOW)).toBe(false);
  });

  it("self for the viewer's own request (case-insensitive)", () => {
    expect(budgetRequestGate(req({ email: "Admin@X.com" }), ADMIN, 5, null, NOW)).toBe("self");
  });

  it("a manager needs an admin for a manager's request or one over the department total", () => {
    expect(budgetRequestGate(req({ requesterRole: "dept-manager" }), MGR, 5, null, NOW)).toBe("admin_required");
    expect(budgetRequestGate(req(), MGR, 11, dept, NOW)).toBe("admin_required");
    expect(budgetRequestGate(req(), MGR, 10, dept, NOW)).toBe("actionable");
    expect(budgetRequestGate(req(), MGR, 500, { ...dept, monthlyBudget: 0 }, NOW)).toBe("actionable");
  });

  it("an admin is not limited by the department total or the requester role", () => {
    expect(budgetRequestGate(req({ requesterRole: "dept-manager" }), ADMIN, 500, dept, NOW)).toBe("actionable");
  });
});

describe("actionableCount — sidebar badge", () => {
  const list: ViewRequest[] = [
    req(),
    req({ email: "mgr@x.com" }), // manager's own
    req({ requesterRole: "dept-manager" }), // admin-only
    req({ periodKey: "2026-10-01" }), // expired
    req({ type: "iam_extension", period: undefined, periodKey: undefined }),
    req({ type: "limit_change", status: "applied" }),
    req({ status: "approved" }),
  ];

  it("a manager counts only budget_increase they can decide", () => {
    expect(actionableCount(list, MGR, "devenv", NOW)).toBe(1);
  });

  it("an admin counts every visible pending type except their own", () => {
    expect(actionableCount(list, ADMIN, "devenv", NOW)).toBe(4);
    expect(actionableCount(list, ADMIN, "governance", NOW)).toBe(3);
    expect(actionableCount([req({ type: "tier_change", email: "admin@x.com" })], ADMIN, "devenv", NOW)).toBe(0);
  });
});

describe("errorKey", () => {
  it("maps known codes and falls back for unknown ones", () => {
    expect(errorKey("approvals.error", "expired", APPROVAL_ERRORS)).toBe("approvals.error.expired");
    expect(errorKey("approvals.error", "weird", APPROVAL_ERRORS)).toBe("approvals.error.unknown");
    expect(errorKey("approvals.error", undefined, APPROVAL_ERRORS)).toBe("approvals.error.unknown");
  });
});

describe("releaseNotice — never just 'approved' while still token-blocked", () => {
  it("ok when the token axis was released", () => {
    expect(releaseNotice({ released: true, denyCleared: true })).toEqual({ tone: "ok", tokenCleared: true });
    expect(releaseNotice(undefined)).toEqual({ tone: "ok", tokenCleared: false });
  });

  it("warns with the reason when a token deny stays", () => {
    expect(releaseNotice({ released: false, reason: "dept_scope" })).toEqual({ tone: "warn", tokenHeldReason: "dept_scope" });
  });

  it("no_token_limit is not a held deny", () => {
    expect(releaseNotice({ released: false, reason: "no_token_limit", noTokenLimit: true }).tone).toBe("ok");
  });

  it("a failed release is reported as unknown", () => {
    expect(releaseNotice({ released: false, warning: "boom" })).toEqual({ tone: "warn", tokenUnknown: true, warning: "boom" });
  });
});

describe("validIncreaseForm", () => {
  it("accepts 1..10000 USD and a 1..500 character reason", () => {
    expect(validIncreaseForm("20", "deadline")).toBe(true);
    expect(validIncreaseForm("10000", "x")).toBe(true);
    expect(validIncreaseForm("10000.01", "x")).toBe(false);
    expect(validIncreaseForm("0", "x")).toBe(false);
    expect(validIncreaseForm("0.5", "x")).toBe(false);
    expect(validIncreaseForm("", "x")).toBe(false);
    expect(validIncreaseForm("5", "   ")).toBe(false);
    expect(validIncreaseForm("5", "x".repeat(501))).toBe(false);
  });
});

describe("fill / nearLimit", () => {
  it("fills placeholders and keeps unknown ones", () => {
    expect(fill("base {base} + {grant} {x}", { base: "$10", grant: 5 })).toBe("base $10 + 5 {x}");
  });

  it("near limit is 80%..100% of a set cap", () => {
    expect(nearLimit(8, 10)).toBe(true);
    expect(nearLimit(7.9, 10)).toBe(false);
    expect(nearLimit(10, 10)).toBe(false); // over, not near
    expect(nearLimit(100, 0)).toBe(false); // unlimited
  });
});
