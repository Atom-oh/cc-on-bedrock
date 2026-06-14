---
status: Accepted
date: 2026-06-14
verification_required: true
supersedes: ADR-026
builds_on: ADR-026
---

# ADR-030: Tiered IAM 권한 신청 + boundary X — admin 승인 1차 통제 + escalation 하드 플로어

**Status:** Accepted (구현 완료, 배포 pending)
**Date:** 2026-06-14
**Supersedes:** [ADR-026 IAM 권한 신청/승인 — 서비스 천장 boundary](ADR-026-iam-permission-grant-boundary.md) (per-service `GrantCeiling*` 천장 모델)
**Builds on:** ADR-026 · 관련 [ADR-020](ADR-020-runtime-iam-policy-upsert.md), [ADR-021](ADR-021-wildcard-claude-iam.md), [ADR-014](ADR-014-local-governance-mode.md)
**Collaboration:** co-agent 멀티모델 패널(Codex gpt-5.5 · Gemini · AWS Access Analyzer) 리뷰, Claude chair 합성

## Context

ADR-026 은 셀프서비스 IAM 권한 신청에서 "승인했는데 효력 0(silent-deny)" 문제를 해결하려고
per-user task 역할의 permission boundary `cc-on-bedrock-task-boundary` 를 **신청가능 서비스의
안전 액션을 열거한 천장**(`GrantCeiling*` 문 + `DEFAULT_SERVICE_ALLOWLIST` 9개 서비스)으로 정의했다.

구현/감사 과정에서 두 가지가 드러났다:

1. **per-service 안전 액션 천장은 IAM 으로 표현 불가능하다.** `*:Describe*`, `*:Get*` 같은
   서비스-부분 와일드카드는 **invalid IAM** (Access Analyzer 검증). 즉 "읽기는 전 서비스 넓게,
   쓰기는 좁게"를 boundary 한 장으로 표현할 수 없다. 서비스를 늘릴수록 천장 열거는 불완전·취약해진다.
2. **천장 모델은 통제 지점을 잘못 잡았다.** 실제 1차 통제는 이미 **admin 승인**(사람이 read/write
   스코프를 게이트)이다. boundary 가 read/write 스코프까지 흉내 내려다 신청가능 서비스가 늘 때마다
   깨졌다. boundary 의 본질은 "**admin 이 무엇을 승인하든 절대 넘을 수 없는 하드 플로어**"여야 한다.

위협 모델: per-user 역할은 그 사용자(Local CLI / DevEnv 코드)가 사용 — 이미 사용자 통제 하에 있다.
boundary 는 한 사용자가 **계정/다른 테넌트로 권한을 확대(escalation)하거나 교차계정으로 리소스를
노출**하는 것을 막는, 4000-user 플랫폼의 최후 방어선이다.

## Decision

ADR-026 의 per-service 천장을 폐기하고 **2중 방어**로 재설계한다.

### 1. Tier 기반 신청 검증 (request-time, `iam-request-validation.ts`)
사람이 게이트하는 1차 통제를 합리적으로 넓히되 위험은 거른다:
- **Tier-1 메타데이터** (`List*`/`Describe*`): 전 서비스, `Resource:*` 허용 (비-mutating, 데이터/시크릿 미노출).
- **Tier-2 데이터 읽기** (`Get*`/`Query*`/`Scan*`/…): 전 서비스이되 **concrete ARN 필수** (`Resource:*` 거부).
- **Tier-3 시크릿 읽기**: concrete secret ARN, path 와일드카드 금지.
- **Tier-4 쓰기** (`Put`/`Update`/`Delete`/`Create`/…): **write-allowlist 9개 서비스로 한정** (보수적 유지).
- **dangerous 하드 거부**: 권한위임·리소스정책 노출·공개화·교차계정 액션(`DEFAULT_DANGEROUS` 정규식).

### 2. boundary X (runtime, `02-security-stack.ts` `cc-on-bedrock-task-boundary`)
per-service 천장 대신:
- `AllowInAccount` — `Action:"*"`, `Resource:"*"`, `Condition StringEquals aws:ResourceAccount = <account>`.
  계정 내 임의 액션 허용. **교차계정은 fail-closed**(키 미지원 서비스는 조건 불충족 → deny).
- `AllowBedrockGoverned`/운영 baseline — account-less foundation-model 등 `aws:ResourceAccount` 로
  덮이지 않는 task 역할 필수 권한은 명시 Allow 유지.
- `DenyEscalation` — **절대 도달 불가 액션 열거**(Deny always wins). admin 이 무엇을 승인하든 차단.

### 3. 통제 모델
- **admin 승인 = 1차 통제** (read/write 스코프는 사람이 게이트, ARN 한정).
- **boundary X = 하드 플로어** (escalation/교차계정/리소스정책 노출만 사람과 무관하게 항상 deny).
- **검증기 ⇄ boundary 일관성(불변식)**: boundary 가 deny 하는 액션이 *신청가능(allowlist)* 서비스에
  있으면, 검증기도 그것을 request-time 에 거부해야 한다 — 안 그러면 "승인 후 런타임 silent-deny".
  `scripts/check-policyset-boundary.py` (CI, `tests/run-all.sh`)가 강제: (a) escalation 플로어 ⊆
  boundary Deny, (b) 신청가능-서비스 플로어 액션 ⊆ 검증기 dangerous, (c) `aws:ResourceAccount` 조건 존재.

### 4. IaC 소유 (T3)
boundary X 는 **CDK Stack 02 단일 정본**. 36+ 액션 deny 플로어를 TF/CFN 에 손으로 복제하면
silent drift 위험(CI 불변식은 CDK synth 만 검증). TF/CFN 역할은 `task_permission_boundary_arn`
(tfvars)로 ARN 만 소비. → `terraform/CLAUDE.md` 에 "의도적 CDK-only" 명시.

## DenyEscalation 플로어 구성 (T4 멀티모델 완전성 리뷰)

Codex + Gemini + Access Analyzer 패널이 "AllowInAccount 가 열어둔, 합법적 dev 용도가 없는
escalation/노출 액션"을 도출. **Access Analyzer 로 모든 추가 액션의 실존을 검증**(Gemini 가
환각한 `ram:PromoteResourceShareFromMember`·`lambda:PutResourcePolicy` 2건 폐기). 최종 deny 63개:

- **계정/아이덴티티 통제 플레인** (whole-service): `iam:*`, `organizations:*`, `account:*`,
  `sso:*`, `sso-directory:*`, `identitystore:*`.
- **교차계정 공유** (aws:ResourceAccount 우회): `ram:*` — in-account 리소스를 외부 계정/조직에
  공유하면 그 외부 주체가 인가됨. 조건 키로 막을 수 없는 유일한 깨끗한 우회 경로.
- **Lake Formation** IAM-유사 데이터 권한 부여: `lakeformation:Grant/BatchGrant/PutDataLakeSettings`.
- **자격증명 피벗**: `sts:AssumeRole*`, `sts:GetFederationToken/GetSessionToken`.
- **KMS** 키 파괴/정책: `kms:ScheduleKeyDeletion/DisableKey/PutKeyPolicy/CreateGrant`.
- **리소스정책/공개 노출**: `*:AddPermission/RemovePermission`, `s3:Put(Bucket)Policy/Acl/
  PutAccountPublicAccessBlock/DeleteBucketPolicy`, `dynamodb:Put/DeleteResourcePolicy`,
  `secretsmanager:Put/DeleteResourcePolicy`, `ecr:SetRepositoryPolicy/Put/DeleteRegistryPolicy`,
  `events:PutPermission`, `glue:PutResourcePolicy`, `ssm:ModifyDocumentPermission`,
  `backup:Put/DeleteBackupVaultAccessPolicy`, `codebuild:UpdateProjectVisibility`,
  `logs:Put/DeleteResourcePolicy/PutDestinationPolicy`, `elasticfilesystem:Put/DeleteFileSystemPolicy`,
  `kinesis:Put/DeleteResourcePolicy`, `codeartifact:Put*PermissionsPolicy`, `acm-pca:Put/DeletePolicy`.
- **신청가능 서비스 위 노출** (검증기도 거부 — 무silent-deny): `eks:Create/Update/AssociateAccessEntry/
  AccessPolicy`(self 클러스터 admin), `ec2:ModifySnapshotAttribute/ModifyImageAttribute`(공개 EBS/AMI).
- **네트워크 노출**: `ec2:Authorize/ModifySecurityGroup*`.

**read-tier ⇄ whole-service deny 일관성 (PR #71 리뷰 반영):** tiered 검증기는 읽기(`List*`/`Describe*`/
`Get*`)를 *전 서비스* 허용한다. 그런데 boundary 는 `iam`/`organizations`/`account`/`sso`/`sso-directory`/
`identitystore`/`ram` 을 **통째로(`service:*`) deny** 한다. 따라서 이들 서비스의 *읽기* 신청
(예: `organizations:DescribeOrganization`)이 검증을 통과한 뒤 런타임에 silent-deny 될 수 있다 —
ADR-030 이 없애려던 바로 그 문제. → 검증기 `DEFAULT_DANGEROUS` 에 이들 whole-service 를 **전 tier
거부**(`^(iam|organizations|account|sso|sso-directory|identitystore|ram):`, `^sts:(assumerole|
getfederationtoken|getsessiontoken)`)로 추가해 request-time 에 차단한다. CI 불변식 (d)가 강제:
boundary 의 whole-service deny + read-verb 형 deny 액션은 모두 검증기가 거부해야 한다.

### 수용된 잔여 위험 (의도적으로 플로어에 넣지 않음 — 문서화)
- **기존 컴퓨팅 confused-deputy**: `lambda:UpdateFunctionCode`, `ssm:SendCommand/StartSession`,
  `ecs:ExecuteCommand`, `cloudformation:UpdateStack`, `codebuild:StartBuild`, `glue:StartJobRun`,
  `ec2:ModifyInstanceAttribute(userData)/launch-template/ASG`. → **합법적 dev 용도가 있어** 하드
  플로어로 막으면 플랫폼이 깨진다. **admin 승인이 사용자 소유 ARN 으로 스코프**하고, *새* 강력
  역할 부착은 `iam:PassRole`(deny)로 차단됨. 잔여 = "이미 강력한 역할을 가진 기존 리소스 탈취"로,
  admin 스코핑으로 완화.
- **표현 불가 long-tail**: `sqs:SetQueueAttributes`/`sns:SetTopicAttributes`(정당한 큐/토픽 설정에도
  필요 — 위험한 Policy 속성만 분리 불가), `s3:PutObjectAcl`/access-point ACL, `lambda:*FunctionUrlConfig`.
  → IAM 으로 위험 부분만 분리 불가. 검증기 dangerous(`:set*attributes$` 등)가 request-time 에 거르고,
  해당 서비스는 admin 게이트. 비-신청가능 서비스의 모든 리소스정책 액션을 망라하는 것은 불가능(표현 벽).
- **`iam:*` over-broad**: `iam:Get*`/`SimulatePrincipalPolicy` 도 막아 dev 가 자기 역할 디버깅 불가.
  → 단순·안전 우선으로 `iam:*` 유지. 지원 부하가 크면 read-only carve-out 재검토.
- `ec2:RevokeSecurityGroup*` 는 boundary deny 에 없음(검증기는 `revoke` 포함). revoke 는 SG 허용
  규칙을 *제거*해 접근을 줄이므로 escalation 이 아님 — boundary 에서 굳이 막지 않음(검증기가 거부해도
  silent-deny 아님: 승인 단계에서 안 넘어갈 뿐). 의도된 비대칭.
- 패널 이견 기록: Codex 는 `sts:GetFederationToken/GetSessionToken` 추가를 "fail-closed 로 이미
  무력, 불필요"로 봄(Gemini 는 추가 권고). harmless belt-and-suspenders 로 **유지**. Codex 는
  `kms` 수명주기·`lambda:PutFunctionConcurrency` 를 "escalation 아닌 DoS"로 분류 — defense-in-depth
  로 **유지**.

## Consequences

**긍정**
- boundary 가 신청가능 서비스 추가마다 깨지지 않음 — read 는 전 서비스, write 는 admin 게이트.
- 4000-user 하드 플로어가 명시·검증됨(CI 불변식 + Access Analyzer + 멀티모델 리뷰).
- request-time 검증기와 runtime boundary 가 신청가능 서비스에서 **일관**(silent-deny 제거).

**부정/리스크**
- boundary 가 "in-account 거의 전부 허용"으로 넓어짐 — 통제가 **admin 승인 품질**에 더 의존.
  완화: 검증기 dangerous 거부 + DenyEscalation 하드 플로어 + 컴퓨팅 탈취 잔여 위험 문서화.
- deny 플로어는 비-신청가능 서비스 리소스정책을 **망라하지 못함**(IAM 표현 벽). out-of-band(검증
  플로우 우회) 수동 부여가 잔여 벡터 — admin 운영 규율로 완화.
- **커플링**: request-time 변경(tier 검증기 + JSON 신청 모드)은 boundary X 없이 단독 배포 금지 —
  allowlist 밖 서비스 신청이 검증 통과 후 런타임 silent-deny. **전체 묶음을 함께 머지/배포.**

## Verification
- `bash tests/run-all.sh` GREEN (vitest 127, pytest 4, boundary 불변식 self-test + synth 템플릿).
- `cd cdk && npx cdk synth CcOnBedrock-Security` OK.
- `aws accessanalyzer validate-policy`(IDENTITY_POLICY)로 최종 boundary X core clean
  (`bedrock:Converse/ConverseStream` 의 "does not exist" 2건은 Access Analyzer DB 시차, 실제 유효 — 무시).
- 배포: `cdk deploy CcOnBedrock-Security`. **T4 완전성 리뷰 통과 후에만**, request-time 변경과 함께.
