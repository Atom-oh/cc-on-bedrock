# CC-on-Bedrock 리뷰 수정 현황 (2026-03-29)

> **이 문서는 3차에 걸친 리뷰 결과와 수정 이력을 추적하는 단일 진실 소스(SSOT)입니다.**

---

## 리뷰 이력

| 날짜 | 라운드 | 리뷰어 | 결과 |
|------|--------|--------|------|
| 03/27 | 1차 초기 스캔 | Kiro CLI | 76건 발견 |
| 03/27 | 1차 검증 | Claude Opus 4.6 | 33건 검증 + 6건 신규 |
| 03/27 | 1차 심층 | Gemini 2.5 Pro | 7건 신규 (CRITICAL 2, HIGH 2) |
| 03/28 | 2차 아키텍처 | Claude Opus 4.6 | 39건 재분류 → 20건 수정 (Phase 1-4) |
| 03/29 | 2차 외부 검증 | Gemini 2.5 Pro | **Approve** (추가 제안 2건) |
| 03/29 | 2차 보안 감사 | Kiro CLI | 14건 발견 → 3건 즉시 수정 |

---

## 수정 완료 항목 (6 커밋, 20+ 건)

### Phase 1: Critical Fixes (`6cfed6f`)

| ID | 이슈 | 수정 내용 |
|----|------|----------|
| C-1 | Lambda `lambda_handler` vs CDK `handler` 불일치 | `ebs-lifecycle.py` → `def handler` |
| C-2 | `/api/ai/runtime` API 키 미설정 시 인증 우회 | 키 없으면 403 반환 |
| C-3 | DynamoDB 테이블명 `cc-on-bedrock-department-budgets` 불일치 | `cc-department-budgets`로 수정 |
| C-3b | `keep-alive` DynamoDB 키명 `userId` → `user_id` | PK 일치시킴 |
| C-4 | Terraform `litellm_alb_dns` 필수 변수 → `terraform plan` 실패 | 변수 제거 + `CLAUDE_CODE_USE_BEDROCK=1` |

### Phase 2: Security Hardening (`172219a`)

| ID | 이슈 | 수정 내용 |
|----|------|----------|
| H-4 | ECS Instance Role에 Bedrock 권한 | Instance Role에서 제거 (Task Role만) |
| H-7a | Dashboard Bedrock `resources: ['*']` | Claude 모델 ARN으로 스코핑 |
| H-7b | ECS 권한 `arn:aws:ecs:*:*:*` | 클러스터/태스크/태스크정의 ARN 스코핑 |
| H-6 | NextAuth 쿠키 `secure: false` 하드코딩 | HTTPS URL 감지 시 자동 secure |
| H-11a | uv 버전 미고정 | `0.6.12` 고정 |
| H-11b | code-server 버전 미고정 | `4.96.4` 고정 |

### Phase 3: Performance & Reliability (`8dc3eb6`)

| ID | 이슈 | 수정 내용 |
|----|------|----------|
| H-3a | `usage-client.ts` DynamoDB Scan 7건 | userId 시 Query 전환 + 전체 페이지네이션 |
| H-3b | `budget-check.py` `get_monthly_usage_by_department` 미페이지네이션 | 페이지네이션 추가 |
| H-3c | `budget-check.py` `get_department_budgets` 미페이지네이션 | 페이지네이션 추가 |
| H-10 | Cognito `ListUsers` Limit: 60 하드코딩 | PaginationToken 기반 전체 조회 |
| H-8 | ALB 등록 `setTimeout` fire-and-forget | `void async` + 에러 추적 + 타임아웃 로그 |

### Phase 4: Cleanup (`6c8f67e` + `421cb5d`)

| ID | 이슈 | 수정 내용 |
|----|------|----------|
| M-2a | `litellm-client.ts` 208줄 미사용 코드 | 삭제 |
| M-2b | `/api/litellm/` 혼동 유발 라우트명 | `/api/usage/`로 리네임 |
| M-2c | 프론트엔드 7곳 `/api/litellm` 참조 | `/api/usage`로 일괄 교체 |
| M-2d | `LiteLLMKey` 미사용 타입 | 삭제, `ProxyHealth` → `SystemHealth` |
| M-6 | `example.com` 하드코딩 7곳 | `atomai.click` 통일 + `.env` 생성 |

### Phase 5: Kiro 보안 감사 수정 (`c5fbcac`)

| ID | 이슈 | 수정 내용 |
|----|------|----------|
| K-H6 | 쿠키 secure: `NEXTAUTH_URL` 의존만 | `NODE_ENV=production` 시 강제 true |
| K-H3 | Bedrock 리전 `*` 와일드카드 | `${cdk.Aws.REGION}` 스코핑 |
| K-M9 | `.env.example`에 실제 도메인 노출 | `your-domain.com` 플레이스홀더 |

---

## 미수정 잔여 항목 (우선순위별)

### CRITICAL (3건)

| # | 이슈 | 파일 | 미수정 사유 | 난이도 |
|---|------|------|-----------|--------|
| 1 | EFS root directory — 사용자 격리 미보장 | `04-ecs-devenv-stack.ts` | 런타임 Access Point 동적 생성 필요 | HIGH |
| 2 | `unsafeUnwrap()` 4곳 — CF 시크릿 노출 | `04-ecs`, `05-dashboard` | CloudFormation 동적 참조로 실제 평문은 아니나, WAF 전환 권장 | MEDIUM |
| 3 | API 라우트 입력 검증 없음 — subdomain 인젝션 | `aws-clients.ts` | Zod 스키마 추가 필요 | MEDIUM |

### HIGH (10건)

| # | 이슈 | 상태 |
|---|------|------|
| 1 | DNS Firewall 미구현 | Route 53 Resolver Firewall 리소스 추가 필요 |
| 2 | EBS Lifecycle Lambda wildcard EC2 권한 | `aws:ResourceTag` 조건 키 추가 |
| 3 | TF/CFN 03-UsageTracking 미구현 | CDK-only 명시 또는 TF/CFN 모듈 추가 |
| 4 | Per-user IAM Bedrock `Resource: "*"` | `aws-clients.ts` 동적 역할 생성 시 모델 ARN 스코핑 |
| 5 | API 미들웨어 `/api/*` 미포함 | Next.js middleware에 API 라우트 인증 통합 |
| 6 | TF ECS Instance Profile 누락 | Terraform 모듈 보완 |
| 7 | TF/CFN LiteLLM 잔존 디렉토리 | `modules/litellm/`, `03-litellm.yaml` 정리 |
| 8 | CDK LiteLLM 시크릿/IAM Role 유지 중 | CF 스택 삭제 후 제거 (TODO 명시됨) |
| 9 | UserData Cognito Secret 평문 | SSM Parameter Store 전환 (**완료됨 — 외부 수정 확인**) |
| 10 | Budget Lambda DynamoDB Scan (3함수) | GSI 재설계 또는 Query 패턴 전환 |

### MEDIUM (12건)

| # | 이슈 |
|---|------|
| 1 | CloudTrail 트레일 미생성 |
| 2 | 라우팅 테이블 DynamoDB 암호화 누락 |
| 3 | GSI `dept-date-index` PK 설계 오류 (department가 아닌 USER# PK) |
| 4 | Lambda 전체 디렉토리 번들링 |
| 5 | Dashboard UserData 셸 확장 위험 |
| 6 | TF Remote State 백엔드 미설정 |
| 7 | TF Provider 버전 `~> 5.0` 너무 광범위 |
| 8 | TF/CDK VPC CIDR 불일치 |
| 9 | CloudFront Prefix List ID 하드코딩 |
| 10 | WAF 미설정 (CloudFront, ALB) |
| 11 | 페이지네이션 무제한 반복 (MAX_PAGES 필요) |
| 12 | `curl \| sh` 패턴 체크섬 미검증 |

---

## 리뷰 문서 인덱스

| 파일 | 내용 | 상태 |
|------|------|------|
| `review-status-2026-03-29.md` | **이 문서** — SSOT 수정 추적 | CURRENT |
| `project-review-consolidated-2026-03-29.md` | 1차 3-reviewer 통합 리뷰 (76건) | 참조용 |
| `project-review-2026-03-29.md` | Kiro 초기 스캔 원본 (76건) | 아카이브 |
| `summary.md` | 초기 요약 | 아카이브 |
| `claude.md` / `gemini.md` / `kiro.md` | 개별 리뷰어 원본 | 아카이브 |
| `codex.md` | Codex 리뷰 원본 | 아카이브 |
| `cost-arch-*.md` | 비용/아키텍처 리뷰 | 별도 주제 |
| `architecture-review-multi-llm.md` | 멀티 LLM 리뷰 프로세스 기록 | 아카이브 |

---

## 보완 플랜

### Sprint 1: 보안 강화 (1주)

| 작업 | 파일 | 예상 |
|------|------|------|
| API 입력 검증 (Zod 스키마) | `aws-clients.ts`, API routes | 4h |
| EFS Access Point 동적 생성 | `aws-clients.ts`, `04-ecs-devenv-stack.ts` | 8h |
| Per-user IAM Bedrock 모델 ARN 스코핑 | `aws-clients.ts` ensureUserTaskRole | 2h |
| EBS Lambda 리소스 태그 조건 | `04-ecs-devenv-stack.ts` | 1h |
| DNS Firewall 기본 규칙 | `01-network-stack.ts` | 4h |
| 페이지네이션 MAX_PAGES 제한 | `usage-client.ts`, `budget-check.py`, `aws-clients.ts` | 1h |

### Sprint 2: IaC 동기화 (2주)

| 작업 | 파일 | 예상 |
|------|------|------|
| TF/CFN LiteLLM 잔존 디렉토리 삭제 | `terraform/modules/litellm/`, `cloudformation/03-litellm.yaml` | 1h |
| TF Remote State S3 백엔드 | `terraform/backend.tf` | 2h |
| TF Provider 버전 고정 | `terraform/versions.tf` | 30m |
| TF/CDK CIDR 통일 | `terraform/variables.tf`, `cdk/config/default.ts` | 30m |
| CloudFront Prefix List 동적 조회 | TF `data.aws_ec2_managed_prefix_list` | 1h |
| WAF 기본 규칙 (CloudFront) | CDK + TF + CFN | 8h |

### Sprint 3: 코드 품질 (3주)

| 작업 | 파일 | 예상 |
|------|------|------|
| GSI `dept-date-index` 재설계 (PK=department) | `03-usage-tracking-stack.ts` | 4h |
| Budget Lambda Scan→Query 전환 | `budget-check.py` | 4h |
| Lambda 개별 번들링 | `03-usage-tracking-stack.ts` | 2h |
| `analytics-dashboard.tsx` 컴포넌트 분리 | `src/app/analytics/` | 8h |
| Next.js middleware API 라우트 통합 | `middleware.ts` | 4h |
| ADR: Bedrock Direct 전환 기록 | `docs/decisions/` | 2h |
| 운영 Runbook 작성 | `docs/runbooks/` | 4h |

### 수정 불가 / 보류 항목

| 이슈 | 사유 |
|------|------|
| CDK LiteLLM 시크릿/Role | CF 스택 삭제 전까지 유지 필요 (TODO 명시) |
| `unsafeUnwrap()` | CloudFormation 동적 참조로 실제 평문 아님 — WAF 전환은 장기 과제 |
| TF/CFN Usage Tracking | CDK-only 전략 또는 별도 프로젝트로 분리 검토 |
