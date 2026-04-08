# EC2-Only 전환 + 부서 예산 + 신청/승인 Workflow

## 1. Context

CC-on-Bedrock Enterprise는 ECS Task에서 EC2-per-user로 아키텍처를 전환했으나(ADR-004), ECS devenv 코드가 잔존하여 이중 유지보수 부담. 부서 예산 관리, tier/DLP/IAM 변경 신청 기능도 미완성.

**목표:**
- ECS devenv 코드 완전 제거 (EC2-only)
- 부서별 예산 한도 + 사용량 모니터링
- 유저별 tier/DLP/IAM 변경 신청 → admin 승인 workflow
- Bedrock per-user instance profile 추적 검증

**대상 규모:** 4,000명 등록, 동시 ~400명

---

## 2. EC2-Only 전환

### 2.1 제거 대상

| 파일/리소스 | 줄 수 | 내용 |
|------------|:-----:|------|
| `04-ecs-devenv-stack.ts` task def 루프 | ~120 | devenv task def 6개 (ubuntu/al2023 x light/standard/power) |
| `lambda/ebs-lifecycle.py` | 486 | EBS snapshot/restore/resize |
| `lambda/warm-stop.py` | 760 | ECS idle detection + EBS snapshot orchestration |
| `lambda/idle-check.py` | 303 | ECS Container Insights metrics checker |
| `entrypoint.sh` EBS symlink 로직 | ~50 | /data mount, /usr/local symlink, chown |
| `idle-monitor.sh` | 87 | Container 내부 CloudWatch custom metrics |
| `aws-clients.ts` ECS 함수 | ~400 | startContainer, stopContainer, listContainers, describeContainer |
| `config/default.ts` storageType | - | 'efs'\|'ebs' toggle |
| `config/default.ts` computeMode | - | 'ecs'\|'ec2' toggle |
| DynamoDB `cc-user-volumes` | - | EBS snapshot 추적 테이블 |
| `03-usage-tracking-stack.ts` EBS Lambda | ~100 | warm-stop, idle-check, ebs-lifecycle Lambda + EventBridge |
| 중복 subscription filter | 1 | `/aws/bedrock/invocation-logs` 에 filter 2개 → 1개로 |

**총 제거: ~2,300줄**

### 2.2 유지

| 항목 | 이유 |
|------|------|
| Stack 04: ECS Cluster + Nginx Service | Dashboard + Nginx는 ECS에서 실행 |
| Stack 05: Dashboard ECS Service | Next.js Dashboard |
| Stack 07: EC2 DevEnv | per-user EC2 인스턴스 인프라 |
| `ec2-clients.ts` | EC2 lifecycle (start/stop/list/terminate) |
| `ec2-idle-stop.py` | EC2 idle detection (220줄) |
| `docker/devenv/` Dockerfile + scripts | AMI 빌드에 재사용 (setup-common.sh) |

### 2.3 Config 변경

```typescript
// 제거
storageType: 'efs' | 'ebs';   // ECS mode 전용, 더 이상 불필요
computeMode: 'ecs' | 'ec2';   // EC2 고정

// 유지
devenvInstanceType: string;     // 기본 instance type (t4g.large)
```

### 2.4 API 정리

모든 route에서 `const computeMode = process.env.COMPUTE_MODE ?? "ec2"` 및 `if (computeMode === "ec2")` 분기를 제거. EC2 경로만 남김:

- `api/user/container/route.ts` — `listInstances()`, `startInstance()`, `stopInstance()` 직접 호출
- `api/user/container/stream/route.ts` — EC2 SSE 프로비저닝만
- `api/containers/route.ts` — `listInstances()`, `startInstance()`, `stopInstance()`, `terminateInstance()`
- `api/user/keep-alive/route.ts` — `cc-user-instances` 테이블만

### 2.5 Bedrock Instance Profile 추적 검증

| # | 검증 항목 | 방법 |
|---|----------|------|
| 1 | `identity.arn`에 `cc-on-bedrock-task-{subdomain}` 기록 | Bedrock invocation log 확인 |
| 2 | Subscription filter 패턴 매칭 | `cc-on-bedrock-task` 문자열 필터 |
| 3 | Lambda subdomain 추출 | `resolve_user_from_arn()` → `USER#{subdomain}` |
| 4 | budget-check deny policy 부착 | per-user role에 deny policy 확인 |
| 5 | 중복 subscription filter 정리 | 2개 → 1개 |
| 6 | model ID 정규화 | ARN → `claude-sonnet-4-6` short name |

---

## 3. 부서 예산 관리

### 3.1 DynamoDB Schema

**테이블: `cc-user-budgets`** (기존, 확장)

| Field | Type | 설명 |
|-------|------|------|
| `dept_id` (PK) | String | "engineering", "design" 등 |
| `monthlyBudgetUsd` | Number | 부서 월간 예산 한도 |
| `dailyLimitPerUser` | Number | 사용자당 일일 토큰 비용 한도 |
| `allowedTiers` | List | ["light","standard"] 등 |
| `managerId` | String | dept-manager email |
| `memberCount` | Number | 부서 인원 수 |
| `currentMonthSpend` | Number | 이번 달 누적 비용 (budget-check에서 갱신) |
| `updatedAt` | String (ISO) | |

### 3.2 API

| Method | Path | 역할 | 접근 |
|--------|------|------|------|
| GET | `/api/dept` | 본인 부서 정보 + 멤버 목록 | dept-manager |
| GET | `/api/dept?action=usage` | 부서 멤버별 사용량 | dept-manager |
| PUT | `/api/admin/budgets` | 부서 예산 설정/변경 | admin |
| GET | `/api/admin/budgets` | 전체 부서 예산 현황 | admin |

### 3.3 Budget Enforcement

```
EventBridge (5분 주기) → budget-check Lambda
  1. DynamoDB cc-on-bedrock-usage Scan (DEPT# prefix)
     → 부서별 이번 달 합산
  2. cc-user-budgets 한도 비교
  3. 초과 시:
     → Cognito에서 해당 부서 멤버 목록 조회
     → 각 멤버의 cc-on-bedrock-task-{subdomain} role에 BedrockDeny policy 부착
  4. SNS 알림 (dept-manager + admin)
```

### 3.4 dept-manager 대시보드

`/dept` 페이지:
- 부서 예산 현황 (gauge chart)
- 멤버별 사용량 테이블 (token, cost, requests)
- 월간 트렌드 차트

---

## 4. 신청/승인 Workflow

### 4.1 DynamoDB Schema

**테이블: `cc-approval-requests`** (기존, 확장)

| Field | Type | 설명 |
|-------|------|------|
| `PK` | String | `REQUEST#{requestId}` |
| `SK` | String | `META` |
| `requestId` | String | UUID |
| `type` | String | `tier_change` \| `dlp_change` \| `iam_extension` |
| `email` | String | 신청자 |
| `subdomain` | String | |
| `department` | String | |
| `status` | String | `pending` \| `approved` \| `rejected` |
| `details` | Map | 타입별 상세 (아래 참조) |
| `requestedAt` | String (ISO) | |
| `reviewedAt` | String (ISO) | |
| `reviewedBy` | String | admin email |

**details by type:**

```json
// tier_change
{ "currentTier": "light", "requestedTier": "power", "reason": "대규모 빌드 필요" }

// dlp_change
{ "currentPolicy": "restricted", "requestedPolicy": "open", "reason": "외부 API 연동" }

// iam_extension
{ "service": "dynamodb", "actions": ["Scan","Query","PutItem","GetItem"],
  "resourceArn": "arn:aws:dynamodb:ap-northeast-2:*:table/my-project-*",
  "reason": "프로젝트 DB 필요", "duration": "30days" }
```

### 4.2 Tier 변경 신청

```
User → POST /api/user/container-request
  body: { type: "tier_change", details: { requestedTier: "power", reason: "..." } }
  → DynamoDB pending 저장
  → Admin Dashboard에 표시

Admin → PUT /api/admin/approval-requests
  body: { requestId, action: "approve" }
  → Cognito custom:resource_tier 업데이트
  → DynamoDB status → "approved"
  → 다음 Start 시 ModifyInstanceAttribute로 새 tier 적용
```

### 4.3 DLP 변경 (Open/Restricted/Locked)

```
User → POST /api/user/container-request
  body: { type: "dlp_change", details: { requestedPolicy: "open", reason: "..." } }

Admin 승인 →
  → Cognito custom:security_policy 업데이트
  → 실행 중 인스턴스: ec2:ModifyInstanceAttribute로 SG 즉시 교체
  → 정지 인스턴스: 다음 Start 시 적용
```

### 4.4 IAM 확장 (DynamoDB 등)

```
User → POST /api/user/container-request
  body: { type: "iam_extension", details: { service: "dynamodb", actions: [...], reason: "..." } }

Admin 승인 →
  → iam:PutRolePolicy로 cc-on-bedrock-task-{subdomain}에 추가 정책 부착
  → Permission boundary (cc-on-bedrock-task-boundary)가 최대 범위 제한
  → duration 설정 시: EventBridge 스케줄로 자동 만료
```

### 4.5 Admin UI

`/admin` 페이지 "승인 대기" 섹션:
- 신청 목록 (type별 아이콘 + 필터)
- 상세 보기 (현재값 → 요청값 diff)
- 승인/거부 버튼
- 승인 시 자동 적용 (Cognito + IAM + EC2)

---

## 5. Files to Modify

### 제거

| File | Action |
|------|--------|
| `cdk/lib/lambda/ebs-lifecycle.py` | 삭제 |
| `cdk/lib/lambda/warm-stop.py` | 삭제 |
| `cdk/lib/lambda/idle-check.py` | 삭제 |
| `docker/devenv/scripts/idle-monitor.sh` | 삭제 |

### 수정

| File | Action |
|------|--------|
| `cdk/lib/04-ecs-devenv-stack.ts` | task def 루프 제거, EBS volume 제거 |
| `cdk/lib/03-usage-tracking-stack.ts` | ECS Lambda 제거, ec2-idle-stop만 유지, subscription filter 정리 |
| `cdk/config/default.ts` | storageType, computeMode 제거 |
| `cdk/bin/app.ts` | computeMode 조건 제거 (Stack 07 항상 배포) |
| `shared/nextjs-app/src/lib/aws-clients.ts` | ECS 함수 제거 |
| `shared/nextjs-app/src/app/api/user/container/*.ts` | computeMode 분기 제거 |
| `shared/nextjs-app/src/app/api/containers/route.ts` | ECS 분기 제거 |
| `shared/nextjs-app/src/app/api/dept/route.ts` | 부서 사용량 API 완성 |
| `shared/nextjs-app/src/app/api/admin/budgets/route.ts` | 부서 예산 CRUD 완성 |
| `shared/nextjs-app/src/app/api/user/container-request/route.ts` | tier/dlp/iam 신청 확장 |
| `shared/nextjs-app/src/app/api/admin/approval-requests/route.ts` | 승인 시 자동 적용 로직 |
| `shared/nextjs-app/src/app/dept/dept-dashboard.tsx` | 부서 대시보드 UI 완성 |
| `cdk/lib/lambda/budget-check.py` | 부서별 합산 + deny policy |
| `cdk/lib/lambda/bedrock-usage-tracker.py` | model ID 정규화, 중복 제거, department 추출 |
| `docker/devenv/scripts/entrypoint.sh` | EBS symlink 로직 제거 |

---

## 6. UI 미구현/미완성 항목

### 6.1 i18n 키 미번역

| 페이지 | 미번역 키 | 수정 필요 |
|--------|----------|----------|
| 홈 | `home.totalTokens` | "총 토큰" / "Total Tokens" |
| 홈 | `home.costTrend` | "비용 트렌드" / "Cost Trend" |
| 홈 | `home.modelUsage` | "모델 사용량" / "Model Usage" |
| 홈 | `home.activeContainers` | "실행 인스턴스" / "Running Instances" |
| 사용자 관리 | `USERS.WITHENV` | "환경 보유" / "With Environment" |
| 토큰 사용량 | `TOTAL TOKENS` | "총 토큰" |
| 예산 설정 | `DEPARTMENTS`, `TOTAL BUDGET`, `TOTAL SPEND`, `OVER BUDGET` | 한글 번역 |
| 내 환경 | `user.selectTier` | "리소스 등급 선택" / "Select Tier" |

**파일:** `shared/nextjs-app/src/lib/i18n.tsx`

### 6.2 ECS → EC2 용어 미전환

| 위치 | 현재 텍스트 | 변경 |
|------|-----------|------|
| 홈 카드 | "Live ECS Task Instances" | "Running EC2 Instances" |
| 홈 카드 | "Active Containers: 0" | EC2 인스턴스 수 연동 |
| 모니터링 subtitle | "Proxy health, ECS status, active sessions, and error rates" | "Instance health, active sessions, and error rates" |
| 인스턴스 관리 title | "Container Management" | 이미 i18n에서 변경했지만 영어 fallback 미변경 |
| 인스턴스 관리 subtitle | "Start, stop, and manage ECS dev environment containers" | "Start, stop, and manage dev environment instances" |
| 인스턴스 관리 카드 | "EFS STORAGE" | 제거 또는 "EBS Storage" |
| 내 환경 subtitle | "Your container status, usage, and workspace info" | "Your instance status, usage, and workspace info" |
| Storage 탭 | "Container must be running to view disk usage" | "Instance must be running" |

**파일:** `i18n.tsx`, `home-dashboard.tsx`, `monitoring-dashboard.tsx`, `containers-page.tsx`, `user-portal.tsx`, `storage-tab.tsx`

### 6.3 기능 미연동

| 페이지 | 문제 | 수정 |
|--------|------|------|
| 홈 Active Instances | 항상 0 | `listInstances()` 결과 연동 |
| 홈 Cluster Insights | CPU/Memory/Network 전부 0 | EC2 `AWS/EC2` + `CWAgent` 메트릭 연동 |
| 보안 DNS Firewall | 0 표시 | VPC DNS Firewall 규칙 조회 확인 |
| 보안 방화벽 규칙 | 0 표시 | Security Group 규칙 카운트 연동 |
| 예산 Departments | 0 | `cc-user-budgets` 테이블 연동 |
| 토큰 비용 | $0.00 vs 168 토큰 | `estimatedCost` 필드 합산 로직 |
| Storage Disk Usage | "Container must be running" | EC2 CWAgent `disk_used_percent` 메트릭 |
| Storage EBS Expansion | ECS ebs-lifecycle Lambda 기반 | EC2 `ec2:ModifyVolume` 직접 호출로 변경 |
| Storage Keep-Alive | `cc-user-volumes` 테이블 사용 | `cc-user-instances` 테이블로 변경 (완료) |

### 6.4 미구현 기능

| 기능 | 현재 상태 | 구현 내용 |
|------|----------|----------|
| **Tier 변경 신청** | UI에 tier select 있지만 직접 적용 (신청 workflow 없음) | POST `/api/user/container-request` type=tier_change → admin 승인 → Cognito + ModifyInstanceAttribute |
| **DLP 정책 변경 신청** | 미구현 | POST `/api/user/container-request` type=dlp_change → admin 승인 → Cognito + SG swap |
| **IAM 확장 신청** | 미구현 | POST `/api/user/container-request` type=iam_extension → admin 승인 → PutRolePolicy |
| **부서 예산 설정** | UI shell만 존재 (Department Budgets 0) | `/api/admin/budgets` CRUD + DynamoDB 연동 |
| **부서 상세 페이지** | 부서 카드 클릭 시 상세 없음 | 멤버 목록, 개별 사용량, 예산 소진율 |
| **Admin 승인 대기 섹션** | `/admin` 페이지에 미구현 | 신청 목록 + 승인/거부 UI |
| **EBS 리사이즈 (EC2)** | ECS Lambda 기반, EC2 미동작 | `ec2:ModifyVolume` API 직접 호출 |
| **model ID 정규화** | DynamoDB에 "arn"으로 저장 | `normalize_model()` ARN → short name |
| **department 추출** | 항상 "default" | Cognito `custom:department` 또는 DynamoDB에서 조회 |

---

## 7. Verification

### 7.1 빌드 검증

| # | 항목 | 절차 | 기대 결과 |
|---|------|------|----------|
| B-1 | CDK synth | `cd cdk && npx cdk synth --all` | 에러 없이 6개 스택 출력 (ECS devenv task def 없음) |
| B-2 | TypeScript | `cd shared/nextjs-app && npx tsc --noEmit` | 에러 0개 |
| B-3 | CDK deploy | `npx cdk deploy --all --exclusively` | 모든 스택 UPDATE_COMPLETE |
| B-4 | Dashboard 배포 | GitHub Actions workflow 성공 | SHA-tagged 이미지 → ECS service stable |

### 7.2 EC2 인스턴스 Lifecycle

| # | 항목 | 절차 | 기대 결과 | 검증 방법 |
|---|------|------|----------|----------|
| E-1 | 신규 시작 | Dashboard `/user` → "인스턴스 시작" | 7단계 프로그레스바 → code-server URL 표시 | `aws ec2 describe-instances --filters "Name=tag:subdomain"` → running |
| E-2 | code-server 접속 | URL 클릭 → 비밀번호 입력 | VS Code 에디터 로드 | 브라우저에서 확인 |
| E-3 | 파일 보존 | 파일 생성 → Stop → Start | 파일 존재 | `cat /home/coder/test.txt` |
| E-4 | 패키지 보존 | `npm install -g cowsay` → Stop → Start | `cowsay` 동작 | `which cowsay` |
| E-5 | Stop 상태 표시 | Stop 클릭 | "Stopping..." badge → 30초 후 "인스턴스 시작" 버튼 | UI 확인 |
| E-6 | Tier 변경 | Stop → 다른 tier로 Start | instance type 변경, EBS 동일 | `aws ec2 describe-instances` → InstanceType 확인 |

### 7.3 토큰 사용량 추적

| # | 항목 | 절차 | 기대 결과 | 검증 방법 |
|---|------|------|----------|----------|
| T-1 | Bedrock 호출 기록 | code-server에서 Claude Code 사용 | `/aws/bedrock/invocation-logs`에 로그 | `aws logs filter-log-events --filter-pattern "cc-on-bedrock-task"` |
| T-2 | Identity 매핑 | 위 로그의 identity.arn | `cc-on-bedrock-task-{subdomain}` | 로그에서 arn 필드 확인 |
| T-3 | Lambda 처리 | usage-tracker Lambda 실행 | "Resolved EC2 role → {subdomain}" | Lambda CloudWatch 로그 |
| T-4 | DynamoDB 기록 | Lambda → DynamoDB | `USER#{subdomain}` 레코드, inputTokens/outputTokens > 0 | `aws dynamodb query --key-condition-expression "PK = :pk"` |
| T-5 | 비용 계산 | DynamoDB estimatedCost | $0 아닌 값 | DynamoDB 레코드 확인 |
| T-6 | Dashboard 표시 | `/user` Environment 탭 "오늘 사용량" | 토큰 수 > 0, 비용 > $0 | UI 확인 |
| T-7 | model ID 정규화 | DynamoDB SK 필드 | `2026-04-08#claude-sonnet-4-6` ("arn" 아님) | DynamoDB scan |
| T-8 | 비-cc-on-bedrock 필터 | 다른 역할의 Bedrock 호출 | DynamoDB에 기록 안 됨 | Lambda 로그 "Skipping non-cc-on-bedrock role" |
| T-9 | Admin 토큰 페이지 | `/admin/tokens` | 사용자별 토큰/비용 표시 | UI 확인 |

### 7.4 신청/승인 Workflow

| # | 항목 | 절차 | 기대 결과 | 검증 방법 |
|---|------|------|----------|----------|
| A-1 | Tier 신청 | user → `/user` → tier 변경 → "신청" | DynamoDB `cc-approval-requests` status=pending | DynamoDB scan |
| A-2 | Tier 승인 | admin → `/admin` → 승인 대기 → "승인" | Cognito `custom:resource_tier` 업데이트 | `aws cognito-idp admin-get-user` |
| A-3 | Tier 적용 | user → Stop → Start | 새 instance type으로 시작 | `aws ec2 describe-instances` → InstanceType |
| A-4 | DLP 신청 | user → DLP 변경 신청 (open → restricted) | DynamoDB pending | DynamoDB 확인 |
| A-5 | DLP 승인 | admin 승인 | Cognito `custom:security_policy` 업데이트 | Cognito 확인 |
| A-6 | DLP 적용 (실행 중) | 승인 즉시 | SG 교체 | `aws ec2 describe-instances` → SecurityGroups |
| A-7 | DLP 적용 (정지) | 다음 Start 시 | 새 SG로 시작 | SecurityGroups 확인 |
| A-8 | IAM 신청 | user → DynamoDB 접근 신청 | DynamoDB pending | DynamoDB 확인 |
| A-9 | IAM 승인 | admin 승인 | `cc-on-bedrock-task-{subdomain}`에 policy 추가 | `aws iam get-role-policy` |
| A-10 | IAM 적용 | user code-server에서 DynamoDB 접근 | 성공 | `aws dynamodb list-tables` in code-server |
| A-11 | 거부 | admin → "거부" | status=rejected, 적용 없음 | DynamoDB + Cognito 변경 없음 |

### 7.5 부서 예산 관리

| # | 항목 | 절차 | 기대 결과 | 검증 방법 |
|---|------|------|----------|----------|
| D-1 | 예산 설정 | admin → `/admin/budgets` → engineering 부서 $100/월 | DynamoDB `cc-user-budgets` 기록 | DynamoDB 확인 |
| D-2 | 예산 표시 | `/admin/budgets` | Departments > 0, 금액 표시 | UI 확인 |
| D-3 | 부서 사용량 | dept-manager → `/dept` → engineering 클릭 | 멤버별 토큰/비용 테이블 | UI 확인 |
| D-4 | 예산 초과 감지 | 부서 사용량 > 월 예산 | budget-check Lambda 감지 | Lambda 로그 |
| D-5 | Deny policy 부착 | 예산 초과 | 부서 멤버 전원 role에 BedrockDeny | `aws iam get-role-policy --policy-name BedrockDenyBudget` |
| D-6 | Bedrock 차단 확인 | deny 후 Claude Code 사용 | AccessDeniedException | code-server에서 확인 |
| D-7 | 예산 증액 → 복구 | admin이 예산 증액 | deny policy 제거 | role policy 확인 |

### 7.6 Idle Detection + Auto-Stop

| # | 항목 | 절차 | 기대 결과 | 검증 방법 |
|---|------|------|----------|----------|
| I-1 | Grace period | 인스턴스 시작 직후 | 10분간 idle 체크 skip | Lambda 로그 |
| I-2 | Active 감지 | CPU > 5% 또는 Network > 1KB/s | NOT idle | Lambda 로그 |
| I-3 | Token active | Bedrock 호출 15분 이내 | NOT idle | Lambda 로그 |
| I-4 | Keep-alive | `/user` Storage 탭 → Keep-Alive 연장 | `cc-user-instances` keep_alive_until 설정 | DynamoDB 확인 |
| I-5 | Idle 경고 | 30분 idle | SNS 알림 | SNS + Lambda 로그 |
| I-6 | Auto-stop | 45분 idle | StopInstances | `aws ec2 describe-instances` → stopped |
| I-7 | EOD 종료 | 18:00 KST | running 인스턴스 전부 stop (no_auto_stop 제외) | 다음 날 확인 |
| I-8 | Nginx 라우팅 해제 | Stop 시 | `cc-routing-table`에서 삭제 | DynamoDB 확인 |

### 7.7 UI/i18n 검증

| # | 항목 | 절차 | 기대 결과 | 검증 방법 |
|---|------|------|----------|----------|
| U-1 | i18n 한글 | 한글 모드로 전체 페이지 순회 | 영어 키 노출 없음 | 브라우저 전체 탐색 |
| U-2 | i18n 영어 | ENG 모드로 전체 페이지 순회 | 정상 영어 표시 | 브라우저 전체 탐색 |
| U-3 | EC2 용어 | 모든 페이지 | "Container", "ECS", "EFS" 문구 없음 | 텍스트 검색 |
| U-4 | 홈 대시보드 | Active Instances, Cluster Insights | 실제 EC2 데이터 반영 | 인스턴스 시작 후 확인 |
| U-5 | 모니터링 | 인스턴스 목록, CPU/Memory | EC2 메트릭 표시 | CWAgent 데이터 확인 |
| U-6 | 보안 | DNS Firewall, 방화벽 규칙 | 0 아닌 값 | 실제 규칙 존재 시 |

### 7.8 보안 검증

| # | 항목 | 절차 | 기대 결과 | 검증 방법 |
|---|------|------|----------|----------|
| S-1 | SSH 차단 | `ssh coder@{instance-ip}` | 연결 거부 | SG에 port 22 없음 |
| S-2 | SSM 접근 | `aws ssm start-session --target {instance-id}` | 셸 접근 가능 | SSM Session Manager |
| S-3 | DLP Open | Open SG 인스턴스에서 `curl google.com` | 성공 | code-server 터미널 |
| S-4 | DLP Restricted | Restricted SG에서 `curl google.com` | 실패 (HTTPS만 허용) | code-server 터미널 |
| S-5 | DLP Locked | Locked SG에서 외부 접근 | 전부 차단 (VPC 내부만) | code-server 터미널 |
| S-6 | Permission boundary | user role에서 IAM 변경 시도 | 거부 | `aws iam create-role` → AccessDenied |
| S-7 | AI Assistant | 일반 사용자 `/ai` 접근 | 403 | 비-admin 계정으로 테스트 |
