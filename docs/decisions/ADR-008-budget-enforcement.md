---
status: Accepted
date: 2026-06-23
consolidates: [ADR-006, ADR-015, ADR-023]
---

# 008: 예산 집행 (부서/개인 $·token 한도 · EventBridge → IAM deny)

## Status

Accepted (2026-06-23)

## Context

Bedrock 비용은 사용자·부서별로 크게 차이나고, Opus 사용 시 단일 사용자가 하루에 수십 달러를 쓸 수 있다. 중앙 예산 통제가 없으면 비용 폭주를 사전에 막을 수 없다. 세 가지 결정이 누적되어 현재 모델을 형성했다.

1. **부서 단위 예산 + 자동 집행 (레거시 ADR-006).** 개인 일일 예산만 있던 상태에서, 부서 월간 한도(USD)와 80% 경고 / 100% 차단을 EventBridge 주기 Lambda(`budget-check.py`)로 도입했다. 차단은 per-user 롤에 IAM deny 정책을 동적으로 부착하는 방식.
2. **달러 × normalized-token 통합 (레거시 ADR-015).** Local Governance Mode(006)가 normalized token 한도를 추가하면서, 달러 예산과 토큰 한도라는 두 축이 공존하게 됐다. 두 축의 관계, 충돌 표시, 모드별 적용 범위, Lambda 책임 경계를 정해야 했다.
3. **부서 per-user 기본값 (레거시 ADR-023).** "팀 인당 $200, 부서 총합 $1000" 같은 흔한 요구가 표현 불가능했다 — 모든 멤버를 user 테이블에 수동 등록해야 했고 이는 입·퇴사 시 drift를 유발했다.

The platform needs central, automatic budget control: per-department and per-user limits, expressed in both dollars and normalized tokens, enforced by attaching IAM deny policies to per-user roles. Three legacy decisions accumulated into the current model — dept budget + EventBridge enforcement (006), dollar×token integration (015), and a dept per-user default to avoid manual per-member rows (023).

사용량 미터링(usage 테이블·email canonical key·모델 정규화)은 **005**가, per-user 롤·permission boundary·IAM deny 부착 메커니즘 기반은 **007**이 정본이다 — 여기서 재유도하지 않는다.

## Decision

**부서·개인 예산을 달러와 normalized token 두 축으로 정의하고, EventBridge가 구동하는 Lambda가 한도 초과 시 per-user IAM 롤에 deny 정책을 동적 부착/해제한다.**

**Define per-department and per-user budgets along two axes — USD and normalized token — and let EventBridge-driven Lambda attach/detach IAM deny policies on per-user roles when limits are exceeded.**

### 집행 흐름 / Enforcement flow

EventBridge 5분 주기로 `budget-check.py`가 동작한다. (Local 모드 토큰 한도는 DynamoDB Stream 기반 `token-limit-enforcer`가 ~1-2초 내 별도 부착; `budget-check`은 backup 경로.)

```
EventBridge (5분) → budget-check
  1. usage 테이블 집계 (부서별 / 사용자별 이번 기간 spend)  ← 미터링은 005
  2. cc-department-budgets / cc-user-budgets 한도 조회
  3. 평가 (OR 조건, §아래):
     - 80% 도달 → SNS 경고 (dept-manager + admin)
     - 100% 초과 → 대상 롤에 deny 정책 부착
  4. 토큰 한도 backup 검사 (Stream이 이미 부착했으면 skip)
```

### 두 축은 독립이며 OR 평가 / Two independent axes, OR-evaluated

- 달러 예산(레거시 006)과 normalized token 한도(006 Local Mode)는 서로 다른 신호다 — 달러는 재무 가드레일, 토큰은 워크로드 가드레일. **둘 다 유지**하고 **하나라도 초과하면 차단**(논리합)한다.
- **환산하지 않는다.** 모델 가격 변동 시 환산식이 깨지면 두 의도 모두 손상되므로, 차단 결정에는 환산을 쓰지 않는다(애널리틱스 표시는 가능).

### Deny 정책 이름으로 사유 구분 / Reason encoded in policy name

| Deny policy 이름 | 부착 주체 | 사유 | 해제 조건 |
|---|---|---|---|
| `cc-bedrock-dept-budget-deny` | `budget-check` | 부서 월간 달러 예산 초과 | 예산 증액 또는 월 reset |
| `cc-bedrock-user-daily-deny` | `budget-check` | User USD cap exceeded — daily, weekly **or** monthly (amendment 2026-10-18; name kept for compatibility) | Every period back under its cap (period rollover at UTC midnight / Monday 00:00 UTC / 1st 00:00 UTC, a raised cap, or an approved one-time grant — amendment 2026-10-24) |
| `cc-bedrock-local-token-deny` | `token-limit-enforcer` | normalized 토큰 한도 초과 | period reset cron (`limit-reset`); also an admin manual reset, or a conditional dashboard release on an approved increase (amendment 2026-10-24) |

- 세 정책은 **공존 가능**하고 IAM은 하나라도 있으면 호출 거부. 해제는 **부착 주체가 자신의 정책만** detach한다.
- 이 이름들이 canonical이다. 레거시 이름(`BudgetExceededDeny` / `DeptBudgetExceededDeny`)은 발견 시 자동 제거(007 runtime-upsert 패턴, 일회성 마이그레이션 스크립트 없음).
- 사용자 메시지는 가장 가까운 reset 순으로 표시: user-daily → local-token → dept-budget. 복수 부착 시 "여러 한도 초과" 배지 + 가장 이른 reset 시각.

### 부서 total cap × per-user default 두 차원 / Dept total vs per-user default

`cc-department-budgets`는 두 독립 필드를 갖는다:

- `monthlyBudget` — 부서 **누적** 한도. 도달 시 부서 **모든 멤버**에 `cc-bedrock-dept-budget-deny` 부착.
- `perUserMonthlyBudget` — 각 멤버의 **기본** per-user cap. 도달 시 **그 멤버만** 차단.

### Amendment 2026-10-18 — per-user daily / weekly / monthly USD caps

Owner decision: admins set **three independent per-user USD caps** in Admin → Budgets —
daily, weekly and monthly (e.g. $50 / $100 / $200). **Exceeding any one blocks** the
user (`cc-bedrock-user-daily-deny`); the deny lifts only when every period is back under
its cap. This replaces the previous behavior, where the single effective budget
(`monthlyBudget` first) was compared with *today's* spend and so acted as a daily cap.

- Windows are UTC, matching the usage rows' `{YYYY-MM-DD}#{model}` keys: day, ISO week
  (Monday 00:00 UTC) and calendar month. Spend includes every AI CLI (Claude Code and
  Codex, ADR-014) because both write the same usage table.
- Each period resolves independently (`_effective_user_limits`):

```
cap(period) =
    user.{daily|weekly|monthly}Budget                 if > 0   # explicit override
    else dept.perUser{Daily|Weekly|Monthly}Budget     if > 0   # dept per-member default (legacy 023)
    else {DAILY|WEEKLY|MONTHLY}_BUDGET_USD env        if > 0   # global default (TF daily/weekly/monthly_budget_usd)
    else no cap for that period
```

- Defaults: `DAILY_BUDGET_USD=50`, `WEEKLY_BUDGET_USD=0`, `MONTHLY_BUDGET_USD=0`.
- `budget-check` writes `currentDaily/Weekly/MonthlySpend`, `effective*Budget`,
  `budgetExceeded` (period list) and `budgetReleaseAt` to `cc-user-budgets`;
  `currentSpend` is month-to-date. The dashboard and Local Mode status read them.
- Migration: a pre-amendment `monthlyBudget` (previously a daily threshold) is now enforced month-to-date, and the daily cap falls to `dailyBudget` / dept `perUserDailyBudget` / `DAILY_BUDGET_USD`. Review existing rows on upgrade (the 2026-10-18 production check found none affected).
- The USD→token mirror below still applies to `monthlyBudget` only (daily/weekly token
  limits are set separately in Admin → Limits and are not overwritten).

- "engineering 인당 $200, 총 $1000" = dept row 하나(`monthlyBudget:1000`, `perUserMonthlyBudget:200`)로 표현. 멤버 5명이 각자 $200 → 부서 $1000 도달 → dept-deny로 전원 차단. 한 명만 $200 도달 → 그 멤버만 차단.
- 신규 입사자는 user row 없이도 부서 기본값을 **집행 시점에** 자동 상속(수동 bulk-apply 불필요). override는 outlier에게만 user row로 부여.

### USD → token 미러 (Local 롤) / USD→token mirror

대시보드 `/admin/budgets` PUT가 사용자 $ 예산을 바꿀 때, `cc-on-bedrock-limits`의 `LIMIT#monthly.max_normalized = floor(monthlyBudget × NORMALIZED_PER_USD)`를 upsert한다(`monthlyBudget=0`이면 행 삭제 → dept 기본값 인계). Stream consumer가 hot path에서 USD↔token 재계산을 하지 않도록, 변환은 저빈도 admin write 시점으로 이동시킨다. `NORMALIZED_PER_USD` 기본 `66667 ≈ 1_000_000/15`(Sonnet $15/1M, weight 1.0 기준); 비-Anthropic 모델 추가나 가격 변동 시 env로 override.

### 모드별 적용 범위 / Per-mode scope

- **EC2 모드** (`cc-on-bedrock-task-*`): 달러 예산 필수 + (옵션) 토큰 한도(`cc-on-bedrock-limits`에 행 있으면 활성).
- **Local 모드** (`cc-on-bedrock-local-user-*`): 토큰 한도 필수 + 부서 한도 설정 시 달러 예산. 부착/검사 사이트는 Cognito username → 실제 롤명을 IAM 태그로 역조회(`iam_role_lookup`)해 `NoSuchEntity` short-circuit을 방지한다.

### Amendment 2026-10-24 — one-time budget increase approvals, dept-manager delegation, role groups

Owner decision (design: `docs/superpowers/specs/2026-10-24-editions-budget-increase-design.md`). There is no LLM gateway, so cost caps, department budgets, the blocked list and **cap allowances (increases)** are the whole of this product's control surface. A blocked user used to have nothing to do but wait for an admin to raise the budget; this amendment fills that gap with a user request → one-time approval by a dept-manager or admin.

**Editions (`deployment_mode`, ADR-006 amendment 2026-10-23)**

| Capability | `governance` (default) | `devenv` |
|---|---|---|
| Cost overview · department budgets · user caps · blocked list | O | O |
| Budget increase request (`budget_increase`) · approval | O | O |
| Dept-manager standing limits for members | O | O |
| IAM extension / container / tier / DLP approvals | X | O (admin only) |
| ccdash link (optional, `ccdash_url`) | O | O |

In governance mode the approvals page shows only `budget_increase` and the `limit_change` history (`shared/nextjs-app/src/app/admin/approvals/page.tsx`). Instance-permission request types return 403 `admin_only_request_type` to a dept-manager (`lib/budget-increase.ts` `decideBudgetAction`).

**Request** — `POST /api/user/budget-increase` (both modes) `{period: daily|weekly|monthly, requestedAmount, reason}`. The amount is USD **added to** the current effective cap (0 < amount ≤ 10000, `MAX_INCREASE_USD`); the reason is 1–500 characters. The requester's department and role are read from Cognito (client values are not trusted; with no real department it is stored as `""` → only an admin can approve). The request stores the UTC `periodKey` at request time plus `snapshotSpend` / `snapshotBudget`. A lock item `PENDING#{email}#{period}#{key}` allows one pending request per user and period window (duplicate → 409 `pending_exists`). An uncapped period cannot be blocked, so it returns 400 `unlimited_period`.

**One-time grants (UTC period keys)**
- Period keys use the same UTC windows as budget-check: day `YYYY-MM-DD`, ISO week `YYYY-Www` (ISO year), month `YYYY-MM` (`lambda/budget-check.py` `period_key` = `lib/budget-grants.ts` `periodKey`).
- An approval DynamoDB-`ADD`s a flat numeric attribute `grant#{period}#{key}` on the `cc-user-budgets` row. Further approvals in the same window accumulate.
- **Cascade to longer periods**: daily → daily + weekly + monthly, weekly → weekly + monthly, monthly → monthly (`cascade_targets` / `cascadeTargets`). Every key is computed in UTC from the approval time, so a daily increase in a week that spans a month boundary is added to the month that day belongs to. Periods that are uncapped at approval time are skipped.
- Department grant total: when the request has a department, the approved amount is ADDed **once** to `grant#monthly#{key}` on `cc-department-budgets` (cascaded copies are not summed). It is used only for the department-budget check.
- The request status change (`pending`→`approved`, condition `status = pending`), lock delete, user grant ADD and department grant ADD are **one `TransactWriteItems`**. After commit, `grant#*` attributes of past windows are removed best-effort.
- budget-check: `get_user_budgets` computes `active_grants` (only grants whose key matches the current window) with one clock per scan, and `_effective_user_limits` adds them **only to a capped (> 0) period** (uncapped stays uncapped). When the window rolls over the key no longer matches, so the cap falls back to the standing value (no expiry job). Applied grants are written to `cc-user-budgets` as `activeGrantDaily/Weekly/Monthly`, and the dashboard shows "base + increase".
- The USD deny lifts on the next budget-check run (up to 5 minutes, `RELEASE_ETA_MINUTES`) through the existing release path. The department-total deny (`cc-bedrock-dept-budget-deny`) is not lifted by a personal grant — raising the department total is admin-only.

**Approval authorization** (`lib/approval-authz.ts` `canApproveBudgetIncrease`, `lib/budget-increase.ts` `decideBudgetAction`)
- **No self-approval**: for every request type, approver email = requester email is refused (case-insensitive; an empty identity on either side fails closed as "self"). An admin's own request is decided by another admin. A sole admin changes their own cap directly in Admin → Budgets instead of requesting an increase; that change is also audited as `limit_change`.
- admin: any request.
- dept-manager: only `budget_increase` of their own department (Cognito `custom:department`, which must be a real department), only when the requester is a plain user (`requester_is_manager` — manager/admin requests are admin-only), and only within the department budget. Over-budget means: department `monthlyBudget > 0` and `department month spend (currentSpend) + this month's department grant total + amount > monthlyBudget` → 403 `exceeds_department` (shown as "admin approval required"). Concurrent approvals are guarded by an optimistic condition on the department grant ADD (must equal the value read); a conflict returns 409 `department_changed_retry`.
- Approvers may adjust the amount (same checks apply) and give a reason when rejecting. A pending request whose window has passed is closed as `expired` on approve or reject, returning 409 `expired`.
- **Fresh role**: session JWT groups and department can be up to 8h stale. Privileged writes (approvals, limit changes, role changes) re-check the current Cognito group with `requireFreshRole` (`lib/role-admin.ts`, `AdminListGroupsForUser`; lookup failure 503 `Role check unavailable`, no permission 403), and read the approver's and target's department fresh with `AdminGetUser`.
- Routing: middleware keeps `/api/admin*` and `/admin*` admin-only but opens `APPROVER_PATHS` (`/api/admin/approval-requests`, `/admin/approvals`) to dept-managers (`lib/route-access.ts`). The old `api/dept` POST (which changed only the status, without department or pending checks) was removed, and `api/dept` GET reads the department from Cognito instead of the email domain.

**Token axis** (normalized token, `token-limit-enforcer`, KST)
- Every approval cascades to monthly, so when a `LIMIT#monthly` row exists the dashboard adds `floor(amount × NORMALIZED_PER_USD)` to `grant_normalized` for the KST-month `grant_bucket` (a grant from another month is replaced). The enforcer's `_user_cap` uses `max_normalized + grant_normalized` as the cap only for the monthly period and only when `grant_bucket` is the current KST month. A grant never caps an uncapped user.
- The enforcer records `scope` (`user` | `dept`), `period` and the user's `dept` on `DENY#active`. The dashboard detaches and deletes the deny only when it is a `scope = user`, `period = monthly` deny, the grant was written, and **every** cap the enforcer applies (user and department × daily/weekly/monthly, current KST buckets) is under. Otherwise the deny stays and a reason is returned: `dept_scope` / `non_monthly` / `legacy_deny` / `no_token_limit` / `still_over_cap` / `other_cap_exceeded` / `role_unresolved`. The result is stored in the approval response `applied.tokenRelease` and on the request record `tokenRelease`, and the UI warns "approved but still token-blocked". A token-axis failure does not roll back the already-committed USD approval.

**Dept-manager standing limits** — `PUT /api/dept/user-budgets` `{email, dailyBudget?, weeklyBudget?, monthlyBudget?}` (0–100000 USD per period, 0 = inherit; `lib/dept-limit-authz.ts`). A dept-manager may target only plain users of the same real department (`self` / `other_department` / `target_is_manager` refused), and when a department total is set the personal monthly cap must not exceed it (`exceeds_department_total`). Admins are unrestricted. Department totals and department per-user defaults still change only through `PUT /api/admin/budgets` (admin-only).

**Audit** — `PUT /api/dept/user-budgets` and `PUT /api/admin/budgets` (user and department rows) commit the row update and a `limit_change` audit record (approval table; actor, actorRole, before, after, appliedAt, status `applied`) **in one transaction** (`lib/limit-audit.ts`). Approvals and rejections keep the approver, amount, time and reason on the request record. A dept-manager sees only their own department's `budget_increase` and `limit_change` items.

**Role = exactly one Cognito group (required)**
- The only source of a role is the Cognito group `admin` / `dept-manager` / `user`. Roles are not kept in custom attributes or DynamoDB. Every user has **exactly one** group.
- Only admins assign roles, on the admin users page: the role is required on the create form (`createUserSchema.role`) and changed from the list's role column. On save the server writes straight to Cognito — `AdminAddUserToGroup` for the new group, then `AdminRemoveUserFromGroup` for the other role groups, then `AdminUserGlobalSignOut` (applies from the next sign-in). The CloudTrail events of these APIs let `user-role-provisioner` update the members' `custom:dept_manager_sub`.
- Guards: an admin cannot demote themselves (`self_demotion`); the last enabled admin cannot be demoted, disabled or deleted (`last_admin`); `dept-manager` requires a real department (blank or `default` means no department → `dept_required`).
- Existing data: no group = treated as `user`. Several groups = resolved to the highest privilege (`roleFromGroups`) and flagged "needs cleanup" in the list; an admin save normalizes to one group. No automatic bulk change.
- The dashboard IAM policy (`terraform/modules/security/main.tf` `dashboard_cognito`) adds `AdminRemoveUserFromGroup`, `AdminUserGlobalSignOut` and `ListUsersInGroup`.

**ccdash (optional)** — a separate product with its own deployment; this repository neither deploys nor modifies ccdash. Terraform has only `ccdash_url` (https, no trailing `/`; default `""`). When set, the dashboard shows a sidebar external link and collector setup guidance on `/local` and LocalSetup (a `{ccdash_url}/collector` link plus the Cognito login email to use as `user.email`); when unset, all of it is hidden. cc writes no telemetry settings to user machines (installation is ccdash's own script). Cost control does not depend on ccdash.

#### Known limitations (2026-10-24)
- For a user budget-check has not evaluated yet, the dashboard cannot see a cap that comes only from the global default (TF `*_budget_usd`), so requests are refused with `unlimited_period` until the first 5-minute run. Blocked users are always already evaluated.
- Token denies attached before this amendment (`DENY#active` without `scope`) are not lifted by an approval (`legacy_deny`) → an admin manual reset (`POST /api/admin/limits/reset` `{email}`) is needed. Daily/weekly token denies (`non_monthly`) and department token denies (`dept_scope`) also stay until the KST period reset or a manual reset.
- The `dept` on `DENY#active` is frozen at attach time. If the token grant ADD is retried after a lost response, it can be added once more for that KST month.
- The department spend in the department-budget check is the `currentSpend` budget-check last wrote (up to 5 minutes stale). A concurrent admin cut of the department total is not blocked atomically (only concurrent department-grant approvals are guarded by the condition).
- Session department and groups can be stale until the next sign-in. Privileged writes and department reads compensate by reading Cognito fresh, but session-based display can show old values until the next sign-in. The devEnv usage-tracker takes a usage row's department from the EC2 tag first.
- If a Cognito call fails partway through a role change, the result is 500 `role_change_failed` and the user may remain in two groups (flagged "needs cleanup" in the list; saving again normalizes).
- For a dept-manager the sidebar approvals badge also counts requests that only an admin can decide because they exceed the department budget. Old `cc-user-budgets` rows still keyed by subdomain can miss the token cause in the blocked list.
- Pre-existing defects (out of scope): `api/dept/mcp` trusts a client-sent department. The enforcer returns on a daily deny before incrementing the weekly/monthly counters (under-count).

## Consequences

긍정 / Positive
- 비용 폭주를 5분 이내 자동 차단; 수동 IAM 작업 불필요.
- 두 축의 의도가 분리되어 운영진·사용자 모두 이해 쉽고, 한쪽 시스템 장애 시 다른 쪽이 가드레일 유지.
- 모델 가격 변동이 토큰 한도 정책을 침범하지 않음(환산 금지).
- 부서 row 하나로 "인당 X, 총합 Y" 표현 + 신규 입사자 자동 상속(write storm 없음).
- dept-manager가 자기 부서 사용량을 직접 모니터링(admin 부하 분산).
- Dept-managers also handle their members' standing limits and one-time increases within the department total themselves (amendment 2026-10-24).

부정·위험 / Negative & risk
- **5분 지연**: EventBridge 주기로 최대 5분간 초과 사용 가능(실시간 아님). 정확히 100%에서 동시 호출 race condition.
- **DynamoDB Scan 비용**: 매 주기 사용량 집계 — 대규모에서 RCU 부하(GSI 최적화 여지).
- 사용자당 deny 정책 최대 3개 동시 부착 → `iam:PutRolePolicy` 호출 증가(역할당 정책 10개 quota 내 안전). 대시보드는 세 종류 차단 사유를 모두 표기해야 함.
- **load-bearing 부재**: `cc-user-budgets` 행 부재 = 부서 기본값 상속(행이 literal $0이어도 상속). 의도된 동작, 문서화됨 — "명시적 $0"은 dept 기본값을 매우 낮게 두거나 legacy 토큰 트랙 사용.
- ~~dept-manager는 조회만, 예산 변경은 admin 전용(위임 미지원).~~ → **Revised by amendment 2026-10-24**: a dept-manager sets standing daily/weekly/monthly limits for plain users (`user` group) of their own department and approves their own department's `budget_increase` requests one-time within the department total. Department totals, department per-user defaults and manager/admin own limits remain admin-only.

보안 / Security
- 차단/해제 모두 부착 주체만 자기 정책을 다루므로 cross-Lambda 간섭 없음. deny는 per-user 롤 한정, blast radius는 롤 prefix로 제한.

## Consolidates

- **ADR-006** (Department Budget Management — EventBridge + Lambda 동적 IAM 집행)
- **ADR-015** (Dollar Budget × Normalized Token Limit Integration)
- **ADR-023** (USD Budget — Department Per-User Default)

미터링(usage 테이블·email canonical key)은 **005**, IAM 신청·permission boundary·deny 부착 기반은 **007** 정본이다(중복 금지, 교차참조). Local Governance Mode normalized-token enforcer는 **006**.

레거시 ADR 본문은 트리에서 제거되었고 git tag `adr-legacy-2026-06-23` + `../history/ADR-MAPPING.md`에 보존된다. 번호 재사용 금지.
Legacy bodies live in git tag `adr-legacy-2026-06-23` and `../history/ADR-MAPPING.md`.

## Verification

```yaml
# Tier 1: Static
files:
  - path: lambda/budget-check.py
    must_contain:
      - "perUserMonthlyBudget"
      - "perUserWeeklyBudget"
      - "def evaluate_user_budget"
      - "cc-bedrock-dept-budget-deny"
      - "cc-bedrock-user-daily-deny"
  - path: shared/nextjs-app/src/app/api/admin/budgets/route.ts
    must_contain:
      - "perUserMonthlyBudget"
      - "applyLimitChange"
  - path: lambda/budget-check.py
    must_contain:
      - "def active_grants"
      - "def cascade_targets"
  - path: lambda/token-limit-enforcer.py
    must_contain:
      - "def _user_cap"
      - "grant_normalized"
  - path: shared/nextjs-app/src/lib/approval-authz.ts
    must_contain:
      - "exceeds_department"
      - "requester_is_manager"
  - path: shared/nextjs-app/src/lib/route-access.ts
    must_contain:
      - "APPROVER_PATHS"

# Tier 2: Semantic
semantic:
  - claim: "budget-check enforces per-user daily, weekly and monthly USD caps independently (each resolved user > dept per-user default > global env) and blocks when any one is exceeded; a department total cap breach attaches cc-bedrock-dept-budget-deny to every member"
    context_files:
      - lambda/budget-check.py
  - claim: "달러 예산과 normalized 토큰 한도는 독립 OR 평가되며, 각 사유는 별도 deny policy 이름(cc-bedrock-dept-budget-deny / cc-bedrock-user-daily-deny / cc-bedrock-local-token-deny)으로 구분되고 부착 주체만 자기 정책을 detach한다"
    context_files:
      - lambda/budget-check.py
  - claim: "admin/budgets PUT가 사용자 $ 예산 변경 시 cc-on-bedrock-limits의 max_normalized를 USD→token 미러로 upsert/삭제한다"
    context_files:
      - shared/nextjs-app/src/app/api/admin/budgets/route.ts
  - claim: "A budget_increase approval ADDs grant#{period}#{key} on cc-user-budgets for the requested period cascading up through monthly (uncapped periods skipped), and budget-check adds only grants whose key matches the current UTC window, and only to capped periods"
    context_files:
      - lambda/budget-check.py
      - shared/nextjs-app/src/lib/budget-increase.ts
  - claim: "Self-approval is refused; a dept-manager approves only budget_increase from plain users of their own department within the department monthly total (spend + this month's department grants + amount); every other request type is admin-only"
    context_files:
      - shared/nextjs-app/src/lib/approval-authz.ts
      - shared/nextjs-app/src/lib/budget-increase.ts
```
