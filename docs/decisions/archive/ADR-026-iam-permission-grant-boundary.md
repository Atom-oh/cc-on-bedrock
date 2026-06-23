---
status: Superseded
superseded_by: ADR-030
date: 2026-06-10
verification_required: true
builds_on: ADR-020
---

> **[ARCHIVED — SUPERSEDED, NOT CURRENT ARCHITECTURE]** Replaced by ADR-030. Do NOT use for current design. Current truth = `docs/decisions/BASELINE.md` + `docs/architecture.md`. Kept for history only.


# ADR-026: 사용자 IAM 권한 신청/승인 — 서비스 천장 boundary + admin 위임형 resource-specific 부여 (EC2/Local 양쪽)

> **⚠️ Superseded by [ADR-030](ADR-030-tiered-iam-grant.md) (2026-06-14).** per-service `GrantCeiling*`
> 천장 모델은 IAM 표현 한계로 폐기되고, tiered 신청 검증 + boundary X(AllowInAccount + DenyEscalation)로
> 대체됨. 신청/승인 워크플로우·Local 경로 부착 등 ADR-026 의 다른 결정은 유효.

**Status:** Superseded by ADR-030 (구현 pending)
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

**A + D 혼합(v3)**을 채택한다: permission boundary 는 **신청 가능 서비스의 천장(service ceiling)으로
정적 확장**하고(`boundary ⊇ 신청가능 서비스` 불변식을 **CI 게이트로 강제**), 부여는 고정 policy-set
카탈로그(`IAM_POLICY_SETS`)가 아닌 **자유형 resource-specific 신청**(구체 action + 구체 resource ARN,
`Resource:*` 금지)을 admin/dept-manager 가 승인하는 위임형으로 한다. 구현 계획:
`docs/superpowers/plans/2026-06-10-adr-026-iam-permission-grant.md` (T1~T8).

핵심 근거(패널 합의): **permission boundary 는 "상한"일 뿐 "부여"가 아니다.** inline Allow 가 없으면
실권한 = 0 (IAM 은 boundary ∩ inline 의 명시적 Allow 교집합). 따라서 boundary 를 카탈로그 서비스로
넓혀도 **미승인 사용자에게 실제 접근이 생기지 않으며**, "승인했는데 무효" 버그만 사라진다.

**리소스 스코프 정정 (2026-06-10, v2):** 초기엔 boundary 리소스를 `cc-on-bedrock-*` 로 좁히려 했으나,
이는 개발자가 **자기 프로젝트의 임의 SQS/SNS/S3/DynamoDB**(이름이 cc-on-bedrock-* 가 아닌)를 못 쓰게 만들어
플랫폼이 "그냥 IDE" 로 전락한다. 따라서 **최소권한을 boundary ARN 스코프가 아니라 "admin 위임형
resource-specific 승인"으로 달성**한다 — boundary 는 서비스 천장, 실제 통제는 승인 + no-wildcard 에서.

구체:
1. **boundary = 서비스 천장** — `cc-on-bedrock-task-boundary` 는 신청 가능 서비스(sqs/sns/s3/dynamodb/
   lambda/… )를 **서비스 단위로 허용**(천장). 안전은 좁은 boundary 가 아니라 아래 2~3 에서 나온다.
2. **결정의 admin 위임 + `Resource:*` 금지** — 개발자가 **구체 action + 구체 resource ARN** 을 신청.
   요청 검증이 `Resource:*`·`Action:*`·`*:*`·`NotResource/NotAction` 우회를 **거부**한다.
   단 **리소스 레벨 권한 미지원 액션**(`ec2:Describe*`, `s3:ListAllMyBuckets`, `cloudwatch:GetMetricData` 등)은
   `Resource:*` 예외 allowlist 로만 허용.
3. **LLM 보조 admin 리뷰** — 신청된 각 resource/action 의 의미·위험을 LLM 이 요약해 approval 메시지로
   저장 → admin 이 근거 있게 승인. (v1 은 라이브 조회 없는 **정적 설명**; 라이브 메타데이터 조회는 플랫폼이
   임의 리소스 read 권한을 갖게 되므로 보류.)
4. **`boundary ⊇ 신청가능 서비스` CI 게이트** — 신청 가능 서비스 allowlist 가 boundary 에 반영되지 않으면
   빌드 실패. (소스 regex 금지 — `cdk synth` JSON + export 된 allowlist JSON 비교.)
5. **부여를 EC2 task + Local 역할 양쪽에 적용** — `addIamPolicySet`/`removeIamPolicySet(subdomain, sub, …)` 가
   `cc-on-bedrock-task-{subdomain}` + `cc-on-bedrock-local-user-{sub}` 양쪽 대상. 역할 부재(NoSuchEntity)는
   skip, **기대 역할 부착 실패는 throw**(부분실패 은폐 금지). sub 는 신청 시 approval 행에 저장(Cognito lookup 회피).
6. boundary/검증 거부 시 **사용자에게 명확한 에러** 노출.
7. **승인 authz = admin OR dept-manager** — dept-manager 는 **DB 저장 request.department == 본인 부서**일 때만.
8. 기존 EC2-only 부여분은 **reconcile 스크립트**로 Local 역할에 소급 반영.

## Considered Alternatives

### A. 정적 boundary 확장 (+ D 규율) — **채택** (v1 형태; v2~v3 에서 catalog→자유형 신청·서비스 천장으로 진화)
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
- boundary 는 서비스 천장으로 넓어짐(v2 정정) — 최소권한은 boundary ARN 스코프가 아니라 **신청 검증
  (`Resource:*` 금지) + admin 승인**에서 달성. boundary 에 새 서비스 추가는 보안 리뷰 대상.

**리스크 & 검증(verification_required):**
- boundary 확장 후 **미승인 사용자가 해당 서비스에 실제 접근 불가**함을 E2E 확인(inline 없으면 deny).
- 승인 후 EC2 task + Local 역할 양쪽에서 권한이 실제 동작함을 확인.
- CI 게이트가 `신청가능 서비스 allowlist ⊄ boundary` 일 때 빌드 실패시키는지 확인.

## Verification

```yaml
# Tier 1: Static — 현행 사실(결정의 전제) 검증. 구현 완료 시 Follow-ups 항목 기준으로 확장할 것.
files:
  - path: terraform/modules/security/main.tf
    must_contain:
      - "${var.project_prefix}-task-boundary"
  - path: lambda/role_factory.py
    must_contain:
      - "cc-on-bedrock-task-boundary"
  # NOTE: v3 구현(plan T1~T8)이 addIamPolicySet/IAM_POLICY_SETS 를 자유형 grant 로 대체할 예정이므로
  # 심볼 이름은 고정하지 않는다 — 구현 완료 시 applyIamGrant/validateIamRequest 기준으로 갱신할 것.
  - path: shared/nextjs-app/src/lib/ec2-clients.ts
    must_exist: true
  - path: shared/nextjs-app/src/app/api/admin/approval-requests/route.ts
    must_exist: true

# Tier 2: Semantic — 현행 상태 기준 claim (구현 pending인 Decision 항목은 구현 후 추가)
semantic:
  - claim: "EC2 task 역할과 Local Governance 역할이 동일한 permission boundary(cc-on-bedrock-task-boundary)를 공유한다"
    context_files:
      - terraform/modules/security/main.tf
      - lambda/role_factory.py
  - claim: "사용자 IAM 권한 확장은 admin 승인 플로우(approval-requests)를 거쳐야만 역할에 inline policy로 부착된다"
    context_files:
      - shared/nextjs-app/src/lib/ec2-clients.ts
      - shared/nextjs-app/src/app/api/admin/approval-requests/route.ts
```

## Follow-ups
구현 계획 `docs/superpowers/plans/2026-06-10-adr-026-iam-permission-grant.md` (v3, T1~T8):
- T1 요청 검증 모듈(`Resource:*` 금지 + 예외 allowlist) · T2 자유형 신청 라우트(sub/department 저장)
- T3 LLM advisory 주석(프롬프트 인젝션 격리) · T4 boundary 서비스 천장 — `02-security-stack.ts`
- T5 승인 시 양쪽 역할 부착(fail-loud, 보상 rollback) — `applyIamGrant`/`removeIamGrant`
- T6 `신청가능 서비스 allowlist ⊆ boundary` synth-JSON CI 게이트
- T7 승인 authz: admin OR dept-manager(저장된 부서) · T8 기존 부여분 reconcile + admin UI

## Update (2026-06-11) — T8 신청 UI 완료 + 읽기 와일드카드 허용
- **T8 신청 UI 완료**: `settings-tab.tsx` `IamRequestSection`을 프리셋 `POLICY_SETS` 객관식에서
  **resource-specific 커스텀 문장 폼**(service 드롭다운→actions→ARN, statement 반복)으로 교체.
  제출 = `{ type:iam_extension, statements:[{Action[],Resource[]}] }`. 클라이언트가
  `validateIamRequest`를 재사용해 사전 검증(단일 출처), 서버가 cross-account 포함 최종 검증(fail-closed).
  `policySets` API 분기는 backward-compat로 유지하되 UI는 미사용.
- **읽기 와일드카드 허용**: `validateIamRequest`가 읽기 전용 와일드카드 액션
  (`Get*`/`List*`/`Describe*`/`BatchGet*`/`Query*`/`Scan*`, 단일 후행 `*`)을 허용.
  service allowlist + dangerous-action denylist는 여전히 통과해야 하며, `*`·`s3:*`·쓰기/임베디드
  와일드카드(`Put*`/`Delete*`/`Get*Policy*`)·verb+suffix(`GetObject*`/`GetBucketPolicy*`)·교차계정은 계속 거부.
  **읽기 와일드카드는 `Resource:*`를 자동 부여하지 않음** — 구체 ARN으로 스코프해야 함(`s3:Get*`+`Resource:*`는 거부).
  Resource:*는 기존 `wildcardOkActions`(예: `ec2:describe*`)에만 한정. `(add|remove)permission`은 전 서비스 denylist.
