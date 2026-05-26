# ADR-023: USD Budget — Department Per-User Default

## Status
Accepted (2026-05-14)

## Context

`cc-department-budgets` 테이블의 `monthlyBudget` 필드는 부서 **전체 누적 한도**(USD)였고, `cc-user-budgets`의 `monthlyBudget`은 **사용자별 명시적 한도**였다. 그러나 다음 흔한 요구사항이 표현 불가능했다:

> "engineering 팀 — 인당 $200, 부서 총합 $1000"

기존 구조에서 이를 표현하려면:
1. 부서 monthlyBudget=$1000 (총액)
2. **모든 engineering 사용자를 일일이 user 테이블에 $200으로 등록**

수동 등록은 사용자 증가/이직 시 drift, 신규 가입자 누락, 일괄 변경 불가 같은 운영 문제를 야기했다. 또한 토큰 단위 한도(`dailyTokenLimit` legacy field)는 모델별 비용 차이를 흡수 못해 USD 한도와 의미적으로 충돌했다.

## Decision

`cc-department-budgets` 테이블에 **`perUserMonthlyBudget`** 필드를 추가하고, budget-check Lambda가 사용자 effective budget을 결정할 때 다음 우선순위를 따른다:

```
effective_user_budget(user, dept) =
    user.monthlyBudget    if user.monthlyBudget > 0     # explicit override
    else dept.perUserMonthlyBudget                       # ADR-023 dept default
    if dept.perUserMonthlyBudget > 0
    else DAILY_BUDGET env                                # global fallback
```

`dept.monthlyBudget`(total cap)과 `dept.perUserMonthlyBudget`(per-member default)는 **독립 차원**으로 작동한다:
- `dept.monthlyBudget`: 부서 누적 사용량이 도달하면 부서 모든 멤버에 dept-deny IAM policy 부착 (ADR-015 §3 기존 동작)
- `dept.perUserMonthlyBudget`: 각 멤버의 일일 spending 한도. 도달 시 그 멤버에만 deny 부착

### "engineering 인당 $200, 총 $1000" 매핑

```yaml
dept_id: engineering
monthlyBudget: 1000          # total cap, dept-wide deny when reached
perUserMonthlyBudget: 200    # auto-applied to each member with no override
```

- engineering 멤버 5명이 각자 $200 쓰면 → 부서 총 $1000 도달 → dept-deny → 모든 멤버 차단 (정상 동작)
- engineering 멤버 1명이 $200 도달 → 그 멤버만 차단, 다른 멤버 계속 사용 가능
- 특정 멤버(예: 시니어)에게 $400 override 필요 시 → `cc-user-budgets` 그 사용자 row의 `monthlyBudget=400` 설정 → dept default 무시

### dailyTokenLimit (legacy) 정리

`cc-user-budgets.dailyTokenLimit`은 ADR-014 normalized-token enforcer(`token-limit-enforcer.py`)가 사용하는 별도 차원으로 유지. UI에서는 "Advanced (token limit, ADR-014)" 토글 뒤로 숨겨 일반 사용자가 USD 한도로만 작업하게 한다. 백엔드 코드는 backward compat을 위해 그대로 둠.

## Implementation

### Schema (DynamoDB, schema-less — code-only)

`cc-department-budgets` row:
```typescript
{
  dept_id: string,
  monthlyBudget: number,         // total dept cap (existing)
  perUserMonthlyBudget: number,  // NEW — default per-member cap (ADR-023)
  currentSpend: number,          // computed by budget-check Lambda
  allowedTiers?: string[],
  updatedAt: string,
}
```

### Lambda (`cdk/lib/lambda/budget-check.py`)
- `get_department_budgets()` returns `{dept: {monthlyBudget, perUserMonthlyBudget}}` dict (was: flat float)
- New helpers: `_dept_total_budget()`, `_dept_per_user_default()`, `_effective_user_budget()`
- `handler()` calls `_effective_user_budget()` for per-user check, replacing the `user_limit if > 0 else DAILY_BUDGET` two-tier fallback with the three-tier ADR-023 logic
- `check_department_budgets()` reads dept total via `_dept_total_budget()` (existing 100%-deny path unchanged)

### API (`shared/nextjs-app/src/app/api/admin/budgets/route.ts`)
- GET response: dept rows include `perUserMonthlyBudget`
- PUT department: accepts `perUserMonthlyBudget` (at least one of `monthlyBudget` / `perUserMonthlyBudget` required)

### UI (`shared/nextjs-app/src/app/admin/budgets/budget-management.tsx`)
- Dept table: new "Per-User Default" column between Department and Total Budget
- User table: replaced "Daily Token Limit" + "Monthly Budget" columns with "Effective Budget" + "Individual Override". Effective budget shows resolution source (`override` blue / `dept default` purple / `global` gray)
- Edit/Create dept modal: dual input (Total Budget + Per-User Default) with inline help text
- Edit/Create user modal: `dailyTokenLimit` field moved behind "Advanced (legacy token limit)" toggle. Empty user budget = inherits dept default automatically (no manual bulk-apply needed)

### Bulk Apply — Not Implemented

The plan considered an explicit "Apply default to all members" button (writing every dept member's `cc-user-budgets.monthlyBudget`), but it became redundant once the Lambda fallback was added: a dept member with no explicit override automatically picks up `dept.perUserMonthlyBudget` at enforcement time. Override is only needed for outliers (specific user gets a different cap).

## Rationale

| Approach | Pros | Cons |
|---|---|---|
| Status quo (manual per-user rows) | No code change | Drift on hire/leave; bulk-change requires N writes |
| Bulk-apply on dept setting | Explicit per-user rows visible in UI | DDB write amplification on every dept-budget change; race vs new joiners |
| **ADR-023 (Lambda fallback)** | One dept setting covers all members + future joiners; explicit overrides still expressible | Effective value computed at enforce time, not stored on user row |

The third approach is preferable because:
- New hires are auto-covered without any admin action
- Bulk change = single PUT on dept row (vs N user rows)
- Existing override mechanism (user.monthlyBudget > 0) preserved
- No write storms on dept-budget edits

## Consequences

### Positive
- "engineering 인당 $200, 총 $1000" expressible in one dept row
- New department members auto-inherit per-user cap on first usage (no admin action required)
- USD-first UX: token-based limit visually de-emphasized (Advanced toggle); USD effective budget shown prominently
- ADR-015 dept-deny path unchanged — total cap still enforced separately

### Negative
- `cc-user-budgets` row absence is now load-bearing — if a user has a $0 row, they get dept default (inherit) rather than what the row literally says. Documented; intentional. Admins who want "explicitly $0 for this user" must use the legacy `dailyTokenLimit` track or set dept default to a very low number.
- `get_department_budgets()` return shape changed from `{dept: float}` to `{dept: dict}`. All in-Lambda callers updated; external callers (if any) not affected (the function is module-private to budget-check.py).

### Migration
- Existing dept rows have no `perUserMonthlyBudget` attribute → DDB returns missing → Lambda treats as 0 → falls back to global `DAILY_BUDGET` env (current behavior preserved). Admins opt in by setting the new field via the UI.
- No data migration required.

### Validation
- `npx tsc --noEmit` passes
- `python3 ast.parse` passes for budget-check.py
- Manual UI test: dept edit modal accepts both inputs, user table effective-budget column reflects resolution

## Out of Scope
- Per-user weekly/daily granularity (currently monthly only)
- Currency other than USD
- Dynamic cost forecasting (current spend vs budget burn rate)
- Cognito-driven member enumeration (Lambda discovers users via usage table, not via Cognito list — fine while membership ≤ usage)

## References
- ADR-011: Bedrock IAM Cost Allocation
- ADR-014: Local Governance Mode (normalized token enforcer — separate dimension)
- ADR-015: Dollar Budget × Normalized Token Limit Integration (dept-deny mechanism)
- ADR-021: Wildcard Claude-Family IAM (USD-first enforcement context)
- Code: `cdk/lib/lambda/budget-check.py:110-180`, `shared/nextjs-app/src/app/api/admin/budgets/route.ts`, `shared/nextjs-app/src/app/admin/budgets/budget-management.tsx`
