# ADR-015: Dollar Budget × Normalized Token Limit Integration

## Status
Accepted (2026-05-12) — implemented in `cdk/lib/lambda/budget-check.py` (canonical policy names + Local Governance role coverage)

## Context
ADR-006은 부서 단위 **달러 월간 예산**을 정의하고, 초과 시 5분 cycle의 `budget-check.py`가 부서 전체 사용자에게 IAM Deny를 부착한다. ADR-014는 Local Governance Mode에 **normalized token 한도**(사용자/부서, daily/weekly/monthly)를 도입하고, DynamoDB Stream 기반으로 1-3분 내 Deny를 부착한다.

두 축이 동시에 존재하면서 다음 결정이 필요하다:

1. 두 한도는 **독립적**인가, 아니면 한쪽이 다른 쪽으로 환산되는가?
2. 둘 다 Deny를 부착할 수 있는데 **충돌**(예: 토큰 한도는 OK, 달러 예산은 초과)이 일어나면 어떻게 표시·해제하는가?
3. EC2 모드 사용자도 토큰 한도를 적용받는가?
4. 사용자에게 보여지는 **차단 사유**는 어느 축의 메시지를 우선하는가?
5. `budget-check.py`와 `token-limit-enforcer`의 **책임 경계**는?

## Decision

### 1. 두 축은 독립이며 OR 조건으로 평가
- 달러 예산(ADR-006)과 토큰 한도(ADR-014)는 서로 다른 신호이므로 **둘 다 유지**하고, **둘 중 하나라도 초과**하면 차단한다 (논리합).
- 환산하지 않는 이유: 달러는 실제 청구 가드레일(부서 재무), 토큰은 워크로드 가드레일(개인/부서 페어 유스). 모델 가격 변동 시 환산식이 깨지면 두 의도 모두 손상.

### 2. Deny policy 이름으로 사유 구분
| Deny policy 이름 | 부착 주체 | 사유 | 해제 조건 |
|---|---|---|---|
| `cc-bedrock-dept-budget-deny` | `budget-check.py` | 부서 월간 달러 예산 초과 (ADR-006) | 예산 증액 또는 월 reset |
| `cc-bedrock-local-token-deny` | `token-limit-enforcer` | 사용자/부서 normalized 토큰 한도 초과 (ADR-014) | period reset cron |
| `cc-bedrock-user-daily-deny` | `budget-check.py` | 사용자 일일 달러 한도 초과 (ADR-006 기존) | 일일 자동 reset |

세 policy는 **공존 가능**하며 IAM은 하나라도 있으면 호출 거부. 해제는 부착 주체가 자신의 policy만 detach한다.

### 3. 모드별 적용 범위
- **EC2 모드 사용자** (`cc-on-bedrock-task-*` role): 달러 예산 + (옵션) 토큰 한도. 토큰 한도는 기본 비활성, `cc-on-bedrock-limits`에 사용자/부서 아이템이 있으면 활성화.
- **Local 모드 사용자** (`cc-on-bedrock-local-user-*` role): 토큰 한도 필수, 달러 예산은 부서 한도가 설정되어 있으면 적용.

`token-limit-enforcer`는 role prefix를 가리지 않고 한도가 정의된 사용자에 대해 동작한다.

### 4. 사용자 메시지 우선순위
대시보드와 CLI wrapper(`cc-bedrock-local`)는 다음 순서로 가장 가까운 reset을 보여준다:
1. `cc-bedrock-user-daily-deny` (오늘 자정 reset)
2. `cc-bedrock-local-token-deny` (period에 따라)
3. `cc-bedrock-dept-budget-deny` (월 reset)

복수 부착 시 "여러 한도가 초과됨" 배지와 가장 이른 reset 시각 표시.

### 5. Lambda 책임 경계
- **`token-limit-enforcer`** (Stream, 1-3분): normalized 토큰 한도만 검사 → `cc-bedrock-local-token-deny`
- **`budget-check.py`** (5분 cycle): 달러 예산 두 종(부서 월간, 사용자 일일) + **토큰 한도의 backup 검사** → 각자의 policy 이름으로 부착
- backup 경로가 토큰 한도를 중복 부착하지 않도록 `budget-check.py`는 `cc-bedrock-local-token-deny`가 이미 있으면 토큰 검사 skip
- **`limit-reset`** (cron): `cc-bedrock-local-token-deny`만 detach. 다른 policy는 각 cycle/cron이 담당.

## Consequences

### Positive
- 두 축의 의도가 명확히 분리되어 운영진과 사용자 모두 이해 쉬움
- 어느 한쪽 시스템 장애 시 다른 쪽이 계속 가드레일 역할
- 모델 가격 변동이 토큰 한도 정책을 침범하지 않음
- ADR-006/ADR-014 기존 구현을 거의 그대로 유지

### Negative
- IAM Deny policy가 사용자당 최대 3개 동시 부착 가능 — `iam:PutRolePolicy` 호출 수 증가 (역할당 정책 개수 quota 10개 한도 내에서 안전)
- 대시보드 UI에 "왜 차단됐는지" 표기 로직이 한 가지가 아니라 세 종류를 다뤄야 함
- 운영자가 한도 정책을 한 화면에서 보려면 두 테이블(`cc-department-budgets`, `cc-on-bedrock-limits`)을 함께 조회해야 함

### Out of Scope
- 토큰 → 달러 자동 환산(애널리틱스 표시는 가능, 차단 결정에는 사용하지 않음)
- 모델 tier 제한(ADR-006의 `allowedTiers`)과 토큰 한도의 조합 — 별도 ADR에서 다룸

## Implementation Notes
- `budget-check.py` 확장 시 `LIMIT_POLICY_NAMES = {"dept_budget": "...", "user_daily": "...", "local_token": "..."}` 상수로 정책 이름 통일
- 대시보드 `/admin/limits`와 `/admin/budgets`는 별개 페이지 유지, 사이드바에서 "Limits & Budgets" 그룹으로 묶음
- 사용자 페이지(`/local`, `/user`)는 부착된 모든 deny policy를 조회해 통합 배지 렌더링

## References
- ADR-006: Department Budget Management
- ADR-011: Bedrock IAM Cost Allocation
- ADR-014: Local Governance Mode
