---
status: Accepted
date: 2026-06-10
verification_required: true
builds_on: ADR-020
---

# ADR-026: 사용자 IAM 권한 신청/승인 — boundary⊇catalog 정적 확장 + EC2/Local 양쪽 부여

**Status:** Accepted (구현 pending)
**Date:** 2026-06-10
**Builds on:** [ADR-020 Runtime IAM Policy Upsert](ADR-020-runtime-iam-policy-upsert.md) · 관련 [ADR-005 Security Policy Access Control](ADR-005-security-policy-access-control.md), [ADR-014 Local Governance Mode](ADR-014-local-governance-mode.md), [ADR-021 Wildcard Claude IAM](ADR-021-wildcard-claude-iam.md)
**Collaboration:** co-agent 패널(Kiro CLI · Codex · Gemini) 의사결정, Claude chair 합성

## Context

사용자가 IAM 권한(policy set)을 신청 → admin 이 승인 → 역할에 부여하는 셀프서비스
워크플로우가 구현돼 있으나, 감사 결과 **부여한 권한이 상당수 silently 무효**임이 확인됐다.

확인된 현 구현 (2026-06-10):
- 신청: `api/user/container-request` `type=iam_extension` + `policySets[]`
- 승인: `api/admin/approval-requests` → `addIamPolicySet(subdomain, policySetId)` (`ec2-clients.ts`)
- `addIamPolicySet` 은 inline policy 를 **`cc-on-bedrock-task-{subdomain}` (EC2 instance-profile 역할)에만**
  부착. **Local Governance 역할 `cc-on-bedrock-local-user-{sub}` 엔 부착하지 않음.**
- 두 역할 모두 permission boundary **`cc-on-bedrock-task-boundary`** 를 가짐.
- boundary 허용 범위: Bedrock(claude), S3(`cc-on-bedrock-user-data-*`), KMS, CloudWatch(`PutMetricData`)+
  Logs(`/cc-on-bedrock/*`), ECR, SSM messages, Secrets(`cc-on-bedrock/*`), AgentCore, DynamoDB(`cc-dept-mcp-config`).
- 부여 카탈로그 `IAM_POLICY_SETS`: dynamodb(`*`), s3(user-data), sqs, lambda:Invoke, eks:Describe,
  cloudwatch:*+logs:*, sns, stepfunctions. (ec2:Describe 는 카탈로그에 없음.)

문제:
1. **boundary ∩ inline 교집합 밖** — SQS/Lambda/EKS/SNS/StepFunctions/임의 DynamoDB 는 boundary 가 허용하지
   않아, 승인·부착해도 IAM 상 **효력 0**. 사용자·admin 에게 "승인했는데 안 됨" 혼란.
2. **Local 경로 누락** — `[cc-bedrock]` 프로파일(Local STS 역할)은 Bedrock 전용이고, 부여 플로우가
   이 역할을 건드리지 않아 Local 에서 추가 권한을 얻을 방법이 없다.
3. **승인 권한** — `approval-requests` 는 `isAdmin` 만 허용 → 부서 admin(dept-manager) 승인 불가.

위협 모델: per-user 역할은 그 사용자(Local CLI) 또는 그 사용자 DevEnv 코드가 사용 — 이미 사용자 통제
하에 있다. boundary 는 "한 사용자가 얻을 수 있는 **최대 권한 상한**"으로 계정/테넌트를 보호한다.

## Decision

**A + D 혼합**을 채택한다: permission boundary 를 **카탈로그의 상위집합(boundary ⊇ catalog)으로
정적 확장**하되, 그 불변식을 **CI 게이트로 강제**한다.

핵심 근거(패널 합의): **permission boundary 는 "상한"일 뿐 "부여"가 아니다.** inline Allow 가 없으면
실권한 = 0 (IAM 은 boundary ∩ inline 의 명시적 Allow 교집합). 따라서 boundary 를 카탈로그 서비스로
넓혀도 **미승인 사용자에게 실제 접근이 생기지 않으며**, "승인했는데 무효" 버그만 사라진다.

구체:
1. `cc-on-bedrock-task-boundary` 에 카탈로그 서비스를 추가하되 **리소스를 최대한 좁게**
   스코프(임의 `*` 지양, 계정/프로젝트 스코프 우선).
2. **`boundary ⊇ catalog` CI 게이트** — `IAM_POLICY_SETS` 에 서비스를 추가하면서 boundary 에 반영하지
   않으면 빌드 실패(드리프트·"승인했는데 무효" 재발 방지).
3. **부여를 EC2 task + Local 역할 양쪽에 적용** — `addIamPolicySet`/`removeIamPolicySet` 가
   `cc-on-bedrock-task-{subdomain}` + `cc-on-bedrock-local-user-{sub}` 양쪽을 대상으로,
   **역할 미존재 시 graceful skip**(모드 미사용 사용자).
4. boundary 거부 시 **사용자에게 명확한 에러** ("이 권한은 플랫폼 상한 밖") 노출.
5. (별개·동반) 승인 authz 를 **admin OR 해당 부서 dept-manager** 로 확장.
6. (선택) `ec2:Describe` read-only policy set 추가 + boundary 허용.

## Considered Alternatives

### A. 정적 boundary 확장 (+ D 규율) — **채택**
- **장점(검증):** boundary=상한이라 확장해도 실권한 증분 없음(Kiro). 운영 단순 — boundary managed policy
  1개만 관리, per-user 분기·race 없음(Kiro). 승인 즉시 효력, 셀프서비스 UX 최상(Gemini). 카탈로그+boundary
  를 한 PR 로 리뷰 → 감사성↑(Codex).
- **단점:** 전 사용자의 이론적 권한 상한이 카탈로그 합집합으로 동일하게 상승 → CI 게이트(D)로 드리프트 통제.

### B. per-grant 동적 boundary — 기각
- 승인 시 유저별 boundary 를 받은 policy set 합집합으로 동적 생성/교체. 최소권한 정밀하나 **유저별 boundary
  관리·교체 race·drift** 운영 부담. boundary=상한이라 A 로 충분 → 복잡도 정당화 안 됨(패널 0표).

### C. 별도 확장 역할(assume) — 기각
- 추가 권한을 넓은 boundary 별도 역할에 부여하고 사용자가 assume. 분리는 깔끔하나 **"어느 역할로 호출?"**
  사용 흐름 복잡 — 특히 Local `[cc-bedrock]` 프로파일 + DevEnv 양쪽에서 role 전환 부담(패널 0표).

### D. boundary-정합 카탈로그 — A 에 흡수
- 카탈로그를 boundary 허용 범위로 한정 + 추가 시 함께 확장. Codex 1순위였으나, 셀프서비스 범위가 과도하게
  좁아지는 단점 → **A 의 "확장 + CI 게이트" 규율**로 D 의 정합성 이점을 흡수하는 형태로 합성.

## Consequences

**긍정:**
- 승인된 권한이 **실제 효력**을 가짐 — "승인했는데 안 됨" 제거.
- EC2 DevEnv + Local `[cc-bedrock]` 양쪽에서 동일하게 권한 반영.
- 운영 단순(단일 boundary), per-user boundary 복잡도/리스크 회피.
- CI 게이트로 boundary 무한 확장(드리프트) 방지.

**부정/비용:**
- 전 사용자의 이론적 권한 상한이 카탈로그 합집합으로 상승 — 단 실효 권한은 승인된 inline 에만 의존하므로
  실질 위험 증분 미미(boundary breach 조건 = inline 탈취와 동일). 보안 리뷰 대상.
- boundary 는 계정/프로젝트 스코프로 좁게 유지해야 의미 — 리소스 스코핑 설계 필요.

**리스크 & 검증(verification_required):**
- boundary 확장 후 **미승인 사용자가 해당 서비스에 실제 접근 불가**함을 E2E 확인(inline 없으면 deny).
- 승인 후 EC2 task + Local 역할 양쪽에서 권한이 실제 동작함을 확인.
- CI 게이트가 `IAM_POLICY_SETS ⊄ boundary` 일 때 빌드 실패시키는지 확인.

## Follow-ups
- `cc-on-bedrock-task-boundary` 확장(스코프된 리소스) — `02-security-stack.ts`.
- `addIamPolicySet`/`removeIamPolicySet` 양쪽 역할 대상 + graceful skip — `ec2-clients.ts`.
- `IAM_POLICY_SETS ⊆ boundary` CI 검증 스크립트.
- `approval-requests` authz: admin OR dept-manager(해당 부서).
- (선택) `ec2:Describe` read-only policy set.
