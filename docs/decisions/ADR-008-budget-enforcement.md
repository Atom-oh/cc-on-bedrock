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
| `cc-bedrock-user-daily-deny` | `budget-check` | 사용자 일일 달러 한도 초과 | 일일 자동 reset (UTC 자정) |
| `cc-bedrock-local-token-deny` | `token-limit-enforcer` | normalized 토큰 한도 초과 | period reset cron (`limit-reset`) |

- 세 정책은 **공존 가능**하고 IAM은 하나라도 있으면 호출 거부. 해제는 **부착 주체가 자신의 정책만** detach한다.
- 이 이름들이 canonical이다. 레거시 이름(`BudgetExceededDeny` / `DeptBudgetExceededDeny`)은 발견 시 자동 제거(007 runtime-upsert 패턴, 일회성 마이그레이션 스크립트 없음).
- 사용자 메시지는 가장 가까운 reset 순으로 표시: user-daily → local-token → dept-budget. 복수 부착 시 "여러 한도 초과" 배지 + 가장 이른 reset 시각.

### 부서 total cap × per-user default 두 차원 / Dept total vs per-user default

`cc-department-budgets`는 두 독립 필드를 갖는다:

- `monthlyBudget` — 부서 **누적** 한도. 도달 시 부서 **모든 멤버**에 `cc-bedrock-dept-budget-deny` 부착.
- `perUserMonthlyBudget` — 각 멤버의 **기본** per-user cap. 도달 시 **그 멤버만** 차단.

effective per-user budget은 3-tier 우선순위로 결정한다:

```
effective_user_budget(user, dept) =
    user.monthlyBudget          if > 0   # 명시적 override
    else dept.perUserMonthlyBudget if > 0   # 부서 기본값 (레거시 023)
    else DAILY_BUDGET env                   # 전역 fallback
```

- "engineering 인당 $200, 총 $1000" = dept row 하나(`monthlyBudget:1000`, `perUserMonthlyBudget:200`)로 표현. 멤버 5명이 각자 $200 → 부서 $1000 도달 → dept-deny로 전원 차단. 한 명만 $200 도달 → 그 멤버만 차단.
- 신규 입사자는 user row 없이도 부서 기본값을 **집행 시점에** 자동 상속(수동 bulk-apply 불필요). override는 outlier에게만 user row로 부여.

### USD → token 미러 (Local 롤) / USD→token mirror

대시보드 `/admin/budgets` PUT가 사용자 $ 예산을 바꿀 때, `cc-on-bedrock-limits`의 `LIMIT#monthly.max_normalized = floor(monthlyBudget × NORMALIZED_PER_USD)`를 upsert한다(`monthlyBudget=0`이면 행 삭제 → dept 기본값 인계). Stream consumer가 hot path에서 USD↔token 재계산을 하지 않도록, 변환은 저빈도 admin write 시점으로 이동시킨다. `NORMALIZED_PER_USD` 기본 `66667 ≈ 1_000_000/15`(Sonnet $15/1M, weight 1.0 기준); 비-Anthropic 모델 추가나 가격 변동 시 env로 override.

### 모드별 적용 범위 / Per-mode scope

- **EC2 모드** (`cc-on-bedrock-task-*`): 달러 예산 필수 + (옵션) 토큰 한도(`cc-on-bedrock-limits`에 행 있으면 활성).
- **Local 모드** (`cc-on-bedrock-local-user-*`): 토큰 한도 필수 + 부서 한도 설정 시 달러 예산. 부착/검사 사이트는 Cognito username → 실제 롤명을 IAM 태그로 역조회(`iam_role_lookup`)해 `NoSuchEntity` short-circuit을 방지한다.

## Consequences

긍정 / Positive
- 비용 폭주를 5분 이내 자동 차단; 수동 IAM 작업 불필요.
- 두 축의 의도가 분리되어 운영진·사용자 모두 이해 쉽고, 한쪽 시스템 장애 시 다른 쪽이 가드레일 유지.
- 모델 가격 변동이 토큰 한도 정책을 침범하지 않음(환산 금지).
- 부서 row 하나로 "인당 X, 총합 Y" 표현 + 신규 입사자 자동 상속(write storm 없음).
- dept-manager가 자기 부서 사용량을 직접 모니터링(admin 부하 분산).

부정·위험 / Negative & risk
- **5분 지연**: EventBridge 주기로 최대 5분간 초과 사용 가능(실시간 아님). 정확히 100%에서 동시 호출 race condition.
- **DynamoDB Scan 비용**: 매 주기 사용량 집계 — 대규모에서 RCU 부하(GSI 최적화 여지).
- 사용자당 deny 정책 최대 3개 동시 부착 → `iam:PutRolePolicy` 호출 증가(역할당 정책 10개 quota 내 안전). 대시보드는 세 종류 차단 사유를 모두 표기해야 함.
- **load-bearing 부재**: `cc-user-budgets` 행 부재 = 부서 기본값 상속(행이 literal $0이어도 상속). 의도된 동작, 문서화됨 — "명시적 $0"은 dept 기본값을 매우 낮게 두거나 legacy 토큰 트랙 사용.
- dept-manager는 조회만, 예산 변경은 admin 전용(위임 미지원).

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
      - "cc-bedrock-dept-budget-deny"
      - "cc-bedrock-user-daily-deny"
  - path: shared/nextjs-app/src/app/api/admin/budgets/route.ts
    must_contain:
      - "perUserMonthlyBudget"

# Tier 2: Semantic
semantic:
  - claim: "budget-check Lambda가 effective_user_budget(user, dept) 3-tier 우선순위(user.monthlyBudget > dept.perUserMonthlyBudget > DAILY_BUDGET env)를 따르고, 부서 total cap 초과 시 전 멤버에 cc-bedrock-dept-budget-deny를 부착한다"
    context_files:
      - lambda/budget-check.py
  - claim: "달러 예산과 normalized 토큰 한도는 독립 OR 평가되며, 각 사유는 별도 deny policy 이름(cc-bedrock-dept-budget-deny / cc-bedrock-user-daily-deny / cc-bedrock-local-token-deny)으로 구분되고 부착 주체만 자기 정책을 detach한다"
    context_files:
      - lambda/budget-check.py
  - claim: "admin/budgets PUT가 사용자 $ 예산 변경 시 cc-on-bedrock-limits의 max_normalized를 USD→token 미러로 upsert/삭제한다"
    context_files:
      - shared/nextjs-app/src/app/api/admin/budgets/route.ts
```
