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
| `cc-bedrock-local-token-deny` | `token-limit-enforcer` | normalized 토큰 한도 초과 | period reset cron (`limit-reset`), admin 수동 reset, 또는 증액 승인 시 대시보드의 조건부 해제 (amendment 2026-10-24) |

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

### Amendment 2026-10-24 — 일회성 예산 증액 승인 · 부서장 위임 · 역할 그룹

Owner decision (설계: `docs/superpowers/specs/2026-10-24-editions-budget-increase-design.md`). LLM gateway가 없으므로 비용 한도·부서 예산·차단 목록·**한도 허용(증액)**이 이 제품의 통제 전부다. 차단된 사용자가 "관리자가 예산을 올릴 때까지 기다림" 외에 할 수 있는 일이 없던 공백을, 사용자 요청 → 부서장/admin 일회성 승인 흐름으로 메운다.

**에디션 (`deployment_mode`, ADR-006 amendment 2026-10-23)**

| 기능 | `governance` (기본) | `devenv` |
|---|---|---|
| 비용 현황 · 부서 예산 · 사용자 한도 · 차단 목록 | O | O |
| 예산 증액 요청(`budget_increase`) · 승인 | O | O |
| 부서장의 부서원 상시 한도 관리 | O | O |
| IAM 확장 / 컨테이너 / 티어 / DLP 승인 | X | O (admin 전용) |
| ccdash 링크 (선택, `ccdash_url`) | O | O |

governance 승인 화면은 `budget_increase`와 `limit_change` 이력만 보인다(`shared/nextjs-app/src/app/admin/approvals/page.tsx`). 인스턴스 권한 요청 타입은 dept-manager에게 403 `admin_only_request_type`이다(`lib/budget-increase.ts` `decideBudgetAction`).

**요청** — `POST /api/user/budget-increase` (두 모드 공통) `{period: daily|weekly|monthly, requestedAmount, reason}`. 금액은 기존 유효 한도에 **더하는** USD (0 < 금액 ≤ 10000, `MAX_INCREASE_USD`), 사유 1–500자. 요청자의 부서·역할은 Cognito에서 읽는다(클라이언트 값 불신; 실제 부서가 없으면 `""`로 저장 → admin만 승인). 요청 시점의 UTC `periodKey`와 `snapshotSpend`/`snapshotBudget`를 기록한다. 같은 사용자·기간 창에는 잠금 항목 `PENDING#{email}#{period}#{key}`로 pending 1건만 허용(중복 409 `pending_exists`). 무제한 기간은 차단될 수 없으므로 400 `unlimited_period`.

**일회성 grant (UTC 기간 키)**
- 기간 키는 budget-check과 같은 UTC: 일 `YYYY-MM-DD`, ISO 주 `YYYY-Www`(ISO 연도), 월 `YYYY-MM` (`lambda/budget-check.py` `period_key` = `lib/budget-grants.ts` `periodKey`).
- 승인은 `cc-user-budgets` 행에 평면 숫자 속성 `grant#{period}#{key}`를 DynamoDB `ADD`한다. 같은 창에 추가 승인되면 합산된다.
- **상위 기간 연쇄**: 일 → 일+주+월, 주 → 주+월, 월 → 월 (`cascade_targets` / `cascadeTargets`). 각 키는 승인 시점 기준 UTC로 계산하므로 월 경계를 넘는 주의 일 증액은 그날이 속한 월에 더해진다. 승인 시점에 무제한인 기간은 건너뛴다.
- 부서 grant 총액: 요청에 부서가 있으면 `cc-department-budgets`의 `grant#monthly#{key}`에 승인 금액을 **한 번만** ADD한다(연쇄 사본은 합산하지 않음). 부서 예산 초과 판정에만 쓰인다.
- 요청 상태 갱신(`pending`→`approved`, 조건 `status = pending`), 잠금 삭제, 사용자 grant ADD, 부서 grant ADD는 **하나의 `TransactWriteItems`**다. 커밋 후 지난 창의 `grant#*` 속성은 best-effort로 제거된다.
- budget-check: `get_user_budgets`가 스캔마다 한 시계로 `active_grants`(현재 창 키와 일치하는 grant만)를 계산하고, `_effective_user_limits`가 **cap이 있는(> 0) 기간에만** grant를 더한다(무제한은 무제한 유지). 기간이 바뀌면 키가 맞지 않아 자연히 0 → 원래 한도로 돌아간다(만료 작업 없음). 적용 grant는 `activeGrantDaily/Weekly/Monthly`로 `cc-user-budgets`에 기록되고 대시보드가 "기본 + 증액"을 표시한다.
- USD deny는 다음 budget-check 주기(최대 5분, `RELEASE_ETA_MINUTES`)에 기존 해제 경로로 풀린다. 부서 총액 deny(`cc-bedrock-dept-budget-deny`)는 개인 grant로 풀리지 않는다 — 부서 총액 상향은 admin 전용.

**승인 권한** (`lib/approval-authz.ts` `canApproveBudgetIncrease`, `lib/budget-increase.ts` `decideBudgetAction`)
- **자기 승인 금지**: 모든 요청 타입에서 승인자 email = 요청자 email이면 거부(대소문자 무시, 한쪽 identity가 비면 "self"로 fail-closed). admin 본인 요청은 다른 admin이 처리한다. admin이 한 명뿐이면 증액 요청 대신 본인 한도를 Admin → Budgets에서 직접 바꾸며, 이 변경도 `limit_change`로 감사 기록된다.
- admin: 모든 요청.
- dept-manager: 자기 부서(Cognito `custom:department`, 실제 부서여야 함)의 `budget_increase`만, 요청자가 plain user일 때만(`requester_is_manager` — manager/admin 요청은 admin만), 그리고 부서 예산을 넘지 않을 때만. 초과 정의: 부서 `monthlyBudget > 0`이고 `부서 월 지출(currentSpend) + 이번 달 부서 grant 총액 + 승인 금액 > monthlyBudget` → 403 `exceeds_department`(화면은 "admin 승인 필요"). 동시 승인 경쟁은 부서 grant ADD의 낙관적 조건(읽은 값과 같아야 함)으로 막고, 충돌 시 409 `department_changed_retry`.
- 승인자는 금액을 조정할 수 있고(같은 검사 적용) 거절 시 사유를 남긴다. 요청 창이 지난 pending 요청은 승인·거절 시 `expired`로 닫히고 409 `expired`.
- **Fresh role**: 세션 JWT의 그룹·부서는 최대 8h 낡을 수 있다. 승인, 한도 변경, 역할 변경 등 특권 쓰기는 `requireFreshRole`(`lib/role-admin.ts`, `AdminListGroupsForUser`)로 현재 Cognito 그룹을 다시 확인하고(조회 실패 503 `Role check unavailable`, 권한 없음 403), 승인자·대상의 부서도 `AdminGetUser`로 새로 읽는다.
- 경로: middleware는 `/api/admin*`·`/admin*`을 admin 전용으로 두되 `APPROVER_PATHS` (`/api/admin/approval-requests`, `/admin/approvals`)만 dept-manager에게 연다(`lib/route-access.ts`). 예전 `api/dept` POST(부서·pending 검사 없이 status만 바꾸던 승인)는 제거됐고, `api/dept` GET의 부서는 email 도메인이 아니라 Cognito에서 읽는다.

**토큰 축** (normalized token, `token-limit-enforcer`, KST)
- 모든 승인은 월까지 연쇄하므로, `LIMIT#monthly` 행이 있으면 대시보드가 `floor(금액 × NORMALIZED_PER_USD)`를 KST 월 `grant_bucket`의 `grant_normalized`에 더한다(다른 달 grant는 대체). enforcer `_user_cap`은 monthly 기간이고 `grant_bucket`이 현재 KST 월일 때만 `max_normalized + grant_normalized`를 cap으로 쓴다. grant는 무제한 사용자를 제한하지 않는다.
- enforcer는 `DENY#active`에 `scope`(`user` | `dept`), `period`, 사용자 `dept`를 기록한다. 대시보드는 `scope = user`·`period = monthly` deny이고, grant가 기록됐고, enforcer가 보는 **모든** cap(사용자·부서 × 일·주·월, 현재 KST 버킷)이 미만일 때만 deny를 detach·삭제한다. 그 외에는 deny를 유지하고 사유를 돌려준다: `dept_scope` / `non_monthly` / `legacy_deny` / `no_token_limit` / `still_over_cap` / `other_cap_exceeded` / `role_unresolved`. 결과는 승인 응답 `applied.tokenRelease`와 요청 레코드 `tokenRelease`에 남고, 화면은 "승인됐지만 토큰 한도로 계속 차단"을 경고로 보여준다. 토큰 축 실패는 이미 커밋된 USD 승인을 되돌리지 않는다.

**부서장의 상시 한도** — `PUT /api/dept/user-budgets` `{email, dailyBudget?, weeklyBudget?, monthlyBudget?}` (기간별 0–100000 USD, 0 = 상속; `lib/dept-limit-authz.ts`). dept-manager는 같은 실제 부서의 plain user만(`self` / `other_department` / `target_is_manager` 거부), 부서 총액이 설정돼 있으면 개인 월 한도는 총액 이하(`exceeds_department_total`). admin은 제한 없음. 부서 총액·부서 인당 기본값은 계속 `PUT /api/admin/budgets`(admin 전용)로만 바꾼다.

**감사** — `PUT /api/dept/user-budgets`와 `PUT /api/admin/budgets`(사용자·부서 행)는 행 갱신과 `limit_change` 감사 레코드(승인 테이블, actor·actorRole·before·after·appliedAt, status `applied`)를 **한 트랜잭션**으로 커밋한다(`lib/limit-audit.ts`). 승인·거절은 요청 레코드에 승인자·금액·시각·사유가 남는다. dept-manager는 자기 부서의 `budget_increase`·`limit_change`만 본다.

**역할 = Cognito 그룹 하나 (필수)**
- 역할의 정본은 Cognito 그룹 `admin` / `dept-manager` / `user`뿐이다. 커스텀 속성·DynamoDB에 역할을 두지 않는다. 모든 사용자는 그룹을 **정확히 하나** 가진다.
- admin만 관리자 사용자 페이지에서 역할을 지정한다: 생성 폼의 역할은 필수(`createUserSchema.role`), 목록의 역할 열에서 변경한다. 저장하면 서버가 Cognito에 바로 반영한다 — 새 그룹 `AdminAddUserToGroup` 후 나머지 역할 그룹 `AdminRemoveUserFromGroup`, 그리고 `AdminUserGlobalSignOut`(다음 로그인부터 적용). 같은 API의 CloudTrail 이벤트로 `user-role-provisioner`가 부서원의 `custom:dept_manager_sub`를 갱신한다.
- 가드: admin 자기 강등 금지(`self_demotion`), 마지막 활성 admin 강등·비활성화·삭제 금지(`last_admin`), `dept-manager`는 실제 부서 필수(빈 값이나 `default`는 부서 없음 → `dept_required`).
- 기존 데이터: 그룹 없음 = `user`로 간주. 여러 그룹 = 가장 높은 권한으로 해석하고(`roleFromGroups`) 목록에 "역할 정리 필요"로 표시, admin이 저장하면 하나로 정규화. 자동 일괄 변경 없음.
- 대시보드 IAM(`terraform/modules/security/main.tf` `dashboard_cognito`)에 `AdminRemoveUserFromGroup`, `AdminUserGlobalSignOut`, `ListUsersInGroup`을 추가했다.

**ccdash (선택)** — 별도 제품·별도 배포이며 이 저장소는 ccdash를 배포·수정하지 않는다. Terraform `ccdash_url`(https, 끝 `/` 없음; 기본 `""`)만 둔다. 설정 시 사이드바 외부 링크와 `/local`·LocalSetup의 수집기 설치 안내(`{ccdash_url}/collector` 링크 + `user.email`로 쓸 Cognito 로그인 이메일 표시)를 보여주고, 미설정 시 모두 숨긴다. cc는 사용자 PC에 텔레메트리 설정을 쓰지 않는다(설치는 ccdash 자체 스크립트 몫). 비용 통제는 ccdash에 의존하지 않는다.

#### 알려진 제약 (2026-10-24)
- budget-check이 아직 평가하지 않은 사용자는 전역 기본값(TF `*_budget_usd`)만으로 cap이 걸린 기간을 대시보드가 알 수 없어, 첫 5분 주기 전에는 요청이 `unlimited_period`로 거부된다. 차단된 사용자는 항상 평가된 상태다.
- 이 개정 이전에 붙은 토큰 deny(`DENY#active`에 `scope` 없음)는 승인으로 풀리지 않는다(`legacy_deny`) → admin 수동 reset(`POST /api/admin/limits/reset` `{email}`) 필요. 토큰 일·주 deny(`non_monthly`)와 부서 토큰 deny(`dept_scope`)도 KST 기간 reset 또는 수동 reset까지 유지된다.
- `DENY#active`의 `dept`는 부착 시점 값으로 고정된다. 토큰 grant ADD는 응답 유실 후 재시도되면 그 KST 월 동안 한 번 더 더해질 수 있다.
- 부서 예산 초과 판정의 부서 지출은 budget-check이 마지막으로 기록한 `currentSpend`(최대 5분 지연)다. admin이 동시에 부서 총액을 낮추는 경우까지 원자적으로 막지는 않는다(부서 grant 동시 승인만 조건으로 막음).
- 세션의 부서·그룹은 재로그인 전까지 낡을 수 있다. 특권 쓰기와 부서 조회는 Cognito를 새로 읽어 보정하지만, 세션 기반 표시는 다음 로그인까지 이전 값을 보일 수 있다. devEnv usage-tracker는 사용량의 부서를 EC2 태그에서 먼저 가져온다.
- 역할 변경 중 Cognito 호출이 일부 실패하면 500 `role_change_failed`이고 사용자가 두 그룹에 남을 수 있다(목록에 "역할 정리 필요" 표시, 다시 저장하면 정규화).
- 사이드바 승인 배지는 dept-manager에게 부서 예산 초과로 admin만 처리할 수 있는 요청도 센다. subdomain 키로 남은 옛 `cc-user-budgets` 행은 차단 목록에서 토큰 원인이 빠질 수 있다.
- 기존 결함(이번 범위 밖): `api/dept/mcp`는 클라이언트가 보낸 부서를 신뢰한다. enforcer는 일 deny 시점에 주·월 카운터 증가 전에 반환한다(과소 집계).

## Consequences

긍정 / Positive
- 비용 폭주를 5분 이내 자동 차단; 수동 IAM 작업 불필요.
- 두 축의 의도가 분리되어 운영진·사용자 모두 이해 쉽고, 한쪽 시스템 장애 시 다른 쪽이 가드레일 유지.
- 모델 가격 변동이 토큰 한도 정책을 침범하지 않음(환산 금지).
- 부서 row 하나로 "인당 X, 총합 Y" 표현 + 신규 입사자 자동 상속(write storm 없음).
- dept-manager가 자기 부서 사용량을 직접 모니터링하고, 부서원 상시 한도와 부서 총액 안의 일회성 증액을 직접 처리(admin 부하 분산, amendment 2026-10-24).

부정·위험 / Negative & risk
- **5분 지연**: EventBridge 주기로 최대 5분간 초과 사용 가능(실시간 아님). 정확히 100%에서 동시 호출 race condition.
- **DynamoDB Scan 비용**: 매 주기 사용량 집계 — 대규모에서 RCU 부하(GSI 최적화 여지).
- 사용자당 deny 정책 최대 3개 동시 부착 → `iam:PutRolePolicy` 호출 증가(역할당 정책 10개 quota 내 안전). 대시보드는 세 종류 차단 사유를 모두 표기해야 함.
- **load-bearing 부재**: `cc-user-budgets` 행 부재 = 부서 기본값 상속(행이 literal $0이어도 상속). 의도된 동작, 문서화됨 — "명시적 $0"은 dept 기본값을 매우 낮게 두거나 legacy 토큰 트랙 사용.
- ~~dept-manager는 조회만, 예산 변경은 admin 전용(위임 미지원).~~ → **amendment 2026-10-24로 개정**: dept-manager는 자기 부서 plain user(`user` 그룹)의 상시 일·주·월 한도를 설정하고, 자기 부서 `budget_increase` 요청을 부서 총액 안에서 일회성으로 승인한다. 부서 총액·부서 인당 기본값·manager/admin 본인 한도는 admin 전용으로 남는다.

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
  - claim: "budget_increase 승인은 cc-user-budgets에 grant#{period}#{key}를 요청 기간부터 월까지 연쇄 ADD하고(무제한 기간 제외), budget-check은 현재 UTC 창 키와 일치하는 grant만 cap이 있는 기간에 더한다"
    context_files:
      - lambda/budget-check.py
      - shared/nextjs-app/src/lib/budget-increase.ts
  - claim: "자기 승인은 금지되고, dept-manager는 자기 부서 plain user의 budget_increase만 부서 월 총액(지출 + 이번 달 부서 grant + 금액) 안에서 승인하며, 그 외 요청 타입은 admin만 처리한다"
    context_files:
      - shared/nextjs-app/src/lib/approval-authz.ts
      - shared/nextjs-app/src/lib/budget-increase.ts
```
