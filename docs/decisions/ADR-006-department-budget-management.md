# ADR-006: 부서 예산 관리 — EventBridge + Lambda 동적 IAM 집행

## Status: Proposed

## Date: 2026-04-09

## Context

CC-on-Bedrock은 4,000명 규모의 멀티유저 Bedrock 개발환경이며, Bedrock API 비용이 사용자/부서별로 크게 차이난다. 현재 상태:

1. **개인 예산만 존재**: `budget-check.py` Lambda가 사용자별 일일 예산(`$50`)만 검사 — 부서 단위 월간 한도 없음
2. **부서 관리 부재**: Cognito `custom:department` 속성은 있지만, 부서별 사용량 합산이나 예산 배분 기능 없음
3. **dept-manager 역할 미활용**: middleware에서 dept-manager 라우트를 보호하고 있지만, 실제 부서 관리 기능이 없음
4. **비용 예측 불가**: admin이 전체 비용만 보고 부서별 소비를 추적할 수 없어, 비용 이상을 사전 감지 불가

Bedrock Opus 4.6 사용 시 단일 사용자가 일일 수십 달러를 소비할 수 있어, 부서 단위 예산 관리와 자동 차단이 필수.

## Decision

**EventBridge 5분 주기 Lambda 기반 부서 예산 관리 시스템**을 구현한다:

### 1. DynamoDB Schema

| 테이블 | PK | 주요 필드 | 용도 |
|--------|-----|----------|------|
| `cc-department-budgets` | `dept_id` | monthlyBudgetUsd, dailyLimitPerUser, allowedTiers, managerId, memberCount | 부서 예산 설정 |
| `cc-user-budgets` | `userId` | department, dailyTokenLimit, monthlyBudget, currentSpend | 개인 예산 (부서 종속) |
| `cc-on-bedrock-usage` | `DEPT#{dept_id}` | 월별 집계 | 부서 사용량 (기존 테이블 확장) |

### 2. Budget Enforcement Flow

```
EventBridge (5분 주기) → budget-check Lambda
  1. cc-on-bedrock-usage 테이블 Scan (DEPT# prefix)
     → 부서별 이번 달 비용 합산
  2. cc-department-budgets 테이블에서 한도 조회
  3. 비교:
     - 80% 도달: SNS 경고 알림 (dept-manager + admin)
     - 100% 초과: 부서 전체 사용자 차단
       → Cognito에서 부서 멤버 목록 조회
       → 각 멤버의 cc-on-bedrock-task-{subdomain} role에 DeptBudgetExceededDeny policy 부착
       → SNS 차단 알림
  4. 개인 일일 예산도 동일 루프에서 검사 (기존 로직 유지)
```

### 3. 차단/해제 메커니즘

- **차단**: `iam:PutRolePolicy`로 `DeptBudgetExceededDeny` policy 부착 — Bedrock `InvokeModel*` Deny
- **해제**: admin이 예산 증액 → 다음 5분 주기에 Lambda가 한도 미초과 확인 → `iam:DeleteRolePolicy`로 자동 해제
- **개인 일일**: 매일 자정(KST) 자동 해제 — Lambda가 날짜 변경 감지 후 `BudgetExceededDeny` 삭제

### 4. API 설계

| Method | Path | 역할 | 접근 |
|--------|------|------|------|
| GET | `/api/admin/budgets` | 전체 부서 + 개인 예산 현황 | admin |
| PUT | `/api/admin/budgets` | 부서 예산 설정/변경 | admin |
| GET | `/api/dept` | 본인 부서 정보 + 멤버 목록 | dept-manager |
| GET | `/api/dept?action=usage` | 부서 멤버별 사용량 | dept-manager |

### 5. dept-manager 대시보드

`/dept` 페이지:
- 예산 소진율 gauge chart (월간)
- 멤버별 사용량 테이블 (토큰, 비용, 요청 수)
- 월간 트렌드 차트
- 80% 경고 배지

## Consequences

### Positive

- **비용 통제**: 부서 단위 월간 예산으로 비용 폭주 방지 — 초과 시 5분 이내 자동 차단
- **가시성**: dept-manager가 자기 부서 사용량을 직접 모니터링, admin 부하 분산
- **유연성**: 부서별 allowedTiers 제한 (예: design 부서는 light만 허용) + 개인별 일일 한도 조합
- **자동화**: 차단/해제가 Lambda에서 자동 — 수동 IAM 작업 불필요
- **기존 인프라 재사용**: per-user role(ADR-004)에 deny policy 부착하는 기존 패턴 확장

### Negative

- **5분 지연**: EventBridge 주기로 인해 최대 5분간 초과 사용 가능 (실시간 차단 아님)
- **DynamoDB Scan 비용**: 매 5분 전체 사용량 스캔 — 4,000명 규모에서 RCU 부하 (GSI로 최적화 가능)
- **Cognito 조회 병목**: 부서 멤버 목록을 Cognito ListUsers로 조회 — 대규모 부서 시 pagination 필요
- **경계 조건**: 부서 예산 정확히 100%에서 race condition — 두 사용자가 동시에 호출하면 양쪽 모두 통과 후 초과 가능
- **dept-manager 권한 한계**: 예산 변경은 admin만 가능, dept-manager는 조회만 — 위임 구조 미지원

## Alternatives Considered

### Option 1: Bedrock Guardrails / Service Quotas 기반

- AWS 네이티브 Bedrock 사용량 제한 활용
- **Pros**: AWS managed, 실시간 차단 가능, 관리 코드 불필요
- **Cons**: Bedrock Guardrails는 콘텐츠 필터 전용 (비용 한도 아님), Service Quotas는 account 레벨 (per-user/dept 불가)
- **탈락 이유**: per-user/per-dept 단위 예산 관리를 지원하는 AWS 네이티브 기능 없음

### Option 2: 실시간 API Gateway + Lambda Authorizer 기반

- 모든 Bedrock 호출을 API Gateway를 경유시키고, Lambda Authorizer에서 실시간 예산 확인
- **Pros**: 실시간 차단, 초과 사용 0%, 세밀한 제어
- **Cons**: Bedrock VPC Endpoint 직접 호출을 포기해야 함, latency 증가, API Gateway 비용, 기존 아키텍처(ADR-004) 대규모 변경
- **탈락 이유**: latency 민감한 Claude Code CLI에 추가 hop 부적합, 아키텍처 변경 과다

### Option 3: CloudWatch Billing Alarm + Lambda 기반

- CloudWatch 비용 알람 → Lambda → IAM deny
- **Pros**: AWS 네이티브, 설정 간단
- **Cons**: Billing 데이터 최대 24시간 지연, per-user 세분화 불가, 부서 단위 불가
- **탈락 이유**: 지연이 5분 → 24시간으로 악화, 세분화 수준 불충분

## References

- Design Spec: `docs/superpowers/specs/2026-04-08-ec2-only-dept-budget-approval-design.md` §3
- Budget Lambda: `cdk/lib/lambda/budget-check.py`
- Budget API: `shared/nextjs-app/src/app/api/admin/budgets/route.ts`
- Per-user role: [ADR-004](ADR-004-ec2-per-user-devenv.md), [ADR-005](ADR-005-security-policy-access-control.md)
- Usage Tracking: `cdk/lib/lambda/bedrock-usage-tracker.py`
