# ADR-005: Security Policy & Access Control — DLP 3-tier + IAM Policy Set + 신청/승인

## Status: Accepted

## Date: 2026-04-09

## Context

EC2-per-user 전환(ADR-004) 이후, 각 사용자에게 독립 EC2 인스턴스와 per-user IAM Role (`cc-on-bedrock-task-{subdomain}`)이 부여된다. 이 아키텍처에서 다음 3가지 보안/접근 제어 문제가 발생:

1. **네트워크 보안 차별화**: 4,000명 사용자의 보안 요구가 다름 — 외부 API 연동이 필요한 사용자 vs. 내부 데이터만 다루는 사용자
2. **IAM 권한 확장 요구**: 기본 Bedrock 접근 외에 DynamoDB, S3, EKS 등 추가 AWS 서비스 접근이 필요한 사용자 존재
3. **변경 통제 부재**: 현재 admin이 직접 Cognito attribute를 수정하거나, 사용자가 tier를 직접 변경 가능 — 감사 추적(audit trail) 없음

보안 정책 변경이나 IAM 확장을 admin 승인 없이 허용하면 보안 사고 위험이 크고, 반대로 모든 변경을 수동 운영하면 4,000명 규모에서 운영 부하가 감당 불가.

## Decision

3가지 핵심 결정을 통합 설계:

### 1. DLP 보안 정책: Open / Restricted / Locked 3단계

사용자별 보안 수준을 3단계로 정의하고, **4개 레이어에서 동시 집행**:

| Layer | Open | Restricted | Locked |
|-------|------|-----------|--------|
| **Security Group** | all outbound | HTTPS + DNS only | VPC CIDR HTTPS only |
| **code-server** | 기본 | file upload/download 차단 | + extension 읽기 전용 |
| **DNS Firewall** | 허용 | 위협 도메인 차단 | 화이트리스트만 허용 |
| **Extension 제어** | 자유 설치 | 승인된 extension만 | 읽기 전용 (설치 불가) |

- Cognito `custom:security_policy` 속성에 저장
- 실행 중 인스턴스: `ec2:ModifyInstanceAttribute`로 SG 즉시 교체
- 정지 인스턴스: 다음 Start 시 해당 SG로 launch

### 2. IAM 확장: 사전 정의 Policy Set Catalog

사용자가 추가 AWS 서비스 접근을 요청할 때, **자유 IAM policy 작성이 아닌 사전 정의된 policy set에서 선택**:

| Policy Set | 서비스 | Actions | 리소스 선택 |
|-----------|--------|---------|-----------|
| `dynamodb-readwrite` | DynamoDB | CRUD | 테이블 목록에서 선택 |
| `dynamodb-readonly` | DynamoDB | Read only | 테이블 목록에서 선택 |
| `s3-readwrite` | S3 | Read/Write | 버킷 + prefix |
| `s3-readonly` | S3 | Read only | 버킷 선택 |
| `eks-access` | EKS | Describe + API | 클러스터 선택 |
| `sqs-readwrite` | SQS | Send/Receive | 큐 선택 |
| `sns-publish` | SNS | Publish | 토픽 선택 |
| `secretsmanager-read` | Secrets Manager | GetSecretValue | 시크릿 선택 (prefix 필터) |

- per-user role `cc-on-bedrock-task-{subdomain}`에 `iam:PutRolePolicy`로 부착
- **Permission Boundary** (`cc-on-bedrock-task-boundary`)가 최대 허용 범위 제한 — policy set이 boundary 밖 권한을 부여해도 실제 효과 없음
- 기간 선택 (7일/30일/90일/영구), EventBridge 스케줄로 자동 만료 (policy 삭제)

### 3. 신청/승인 Workflow

모든 보안 관련 변경을 DynamoDB 기반 신청/승인으로 통제:

```
User → POST /api/user/container-request
  body: { type: "tier_change" | "dlp_change" | "iam_extension", details: {...} }
  → DynamoDB cc-approval-requests (status: pending)

Admin → PUT /api/admin/approval-requests
  body: { requestId, action: "approve" | "reject" }
  → 승인 시 자동 적용:
    - tier_change  → Cognito custom:resource_tier + ModifyInstanceAttribute
    - dlp_change   → Cognito custom:security_policy + SG swap
    - iam_extension → PutRolePolicy on per-user role
  → DynamoDB status 업데이트 + 감사 기록 (reviewedBy, reviewedAt)
```

## Consequences

### Positive

- **보안 가시성**: 모든 변경이 DynamoDB에 기록되어 감사 추적 가능
- **운영 효율**: admin 승인 시 Cognito + IAM + EC2가 자동 적용 — 수동 작업 제거
- **권한 최소화**: Permission Boundary + 사전 정의 policy set으로 과도한 권한 부여 방지
- **유연성**: DLP 3단계가 대부분의 보안 요구를 커버, policy set catalog은 필요 시 확장 가능
- **일관성**: 4-layer enforcement로 단일 레이어 우회 불가

### Negative

- **DLP 3단계 한계**: 3단계로 커버 안 되는 중간 요구사항 존재 가능 (예: HTTPS + 특정 IP만 허용)
- **Policy set 관리**: 신규 서비스/패턴 추가 시 catalog 업데이트 필요 — 코드 변경 수반
- **SG swap 지연**: 실행 중 인스턴스의 SG 교체는 기존 TCP 세션에 영향 없음 — 새 연결부터 적용
- **단일 승인자 병목**: admin만 승인 가능 — dept-manager 위임은 미지원 (향후 확장 가능)
- **EventBridge 만료**: IAM policy 자동 만료가 EventBridge 의존 — Lambda 장애 시 만료 누락 가능

## Alternatives Considered

### Option 1: 사용자별 커스텀 보안 정책

- 사용자마다 SG 규칙, IAM policy를 자유 설정
- **Pros**: 최대 유연성, 특수 요구 100% 충족
- **Cons**: 4,000명 × 개별 정책 = 관리 불가능, SG 규칙 수 제한(60), IAM policy 검증 자동화 어려움
- **탈락 이유**: 운영 비용이 보안 이득을 초과

### Option 2: AWS SSO / IAM Identity Center 기반

- AWS SSO Permission Set으로 per-user 권한 관리
- **Pros**: AWS 네이티브, 중앙 관리, SSO 통합
- **Cons**: per-user EC2 Instance Profile과 SSO Permission Set 매핑이 복잡, Cognito와 이중 인증, EC2 Instance Profile에 SSO 직접 바인딩 불가
- **탈락 이유**: EC2-per-user + Cognito 아키텍처(ADR-004)와 통합이 부자연스러움

### Option 3: AWS Service Catalog 기반

- IAM policy를 Service Catalog Product로 패키징, 사용자가 셀프서비스
- **Pros**: AWS 네이티브 승인 workflow, CloudFormation 기반
- **Cons**: 학습 곡선, Service Catalog 자체 비용, DLP SG 변경과 IAM 확장이 별도 workflow
- **탈락 이유**: 단순한 요구에 과한 인프라, DynamoDB 기반이 더 경량

## Implementation

전 항목 구현 완료 (2026-04-16 기준).

| 구성요소 | 구현 위치 |
|---------|---------|
| DLP 3-tier Security Groups | `cdk/lib/07-ec2-devenv-stack.ts` — DevenvSgOpen / SgRestricted / SgLocked |
| 인스턴스별 SG 선택 | `shared/nextjs-app/src/lib/ec2-clients.ts` — `SG_MAP`, `startInstance()` |
| 실행 중 SG 교체 | `ec2-clients.ts` — `changeSecurityPolicy()` (ENI SG swap, 재시작 불필요) |
| IAM Policy Set Catalog | `ec2-clients.ts` — `IAM_POLICY_SETS` (7개 사전 정의 정책) |
| Policy 부착/제거 | `ec2-clients.ts` — `addIamPolicySet()`, `removeIamPolicySet()` |
| 승인 요청 테이블 | `cdk/lib/03-usage-tracking-stack.ts` — `cc-on-bedrock-approval-requests` |
| 사용자 신청 API | `src/app/api/user/container-request/route.ts` — tier/dlp/iam 3종 |
| Admin 승인 API | `src/app/api/admin/approval-requests/route.ts` — approve/reject + 자동 적용 |

### ADR 대비 변경사항
- 테이블명: `cc-approval-requests` → `cc-on-bedrock-approval-requests` (프로젝트 네이밍 규칙 적용)

## References

- Design Spec: `docs/superpowers/specs/2026-04-08-ec2-only-dept-budget-approval-design.md` §4
- Original DLP Design: `docs/superpowers/specs/2026-03-19-cc-on-bedrock-design.md`
- EC2-per-user 아키텍처: [ADR-004](ADR-004-ec2-per-user-devenv.md)
- IAM Review: `docs/reviews/iam-review.md`
