# 작업계획서: Local Governance Mode (EC2-less)

> 작성: 2026-05-11 | 상태: 계획 중 | 관련 ADR: ADR-014

## 배경
로컬 PC에서 Claude Code를 사용하면서 EC2 운영 부담 없이 거버넌스(사용량 추적, 부서 예산, 모델 제한, 감사)만 유지하는 배포 프로파일.

## 목표
1. Cognito 로그인 → STS 자격증명 **8h** 자동 발급 (`MaxSessionDuration=12h`)
2. 로컬 Claude Code가 Bedrock 직접 호출 (`CLAUDE_CODE_USE_BEDROCK=1`)
3. **핵심: 합산 normalized token 한도 도달 시 IAM Deny policy 부착으로 차단**
4. Bedrock Invocation Logging → 기존 `bedrock-usage-tracker.py` 파이프라인 재사용
5. 대시보드에서 사용량/한도/예산/감사 조회
6. CDK context flag `--context governanceOnly=true` 로 EC2/ECS 스택 skip

## 아키텍처

```
로컬 PC
 ├─ tools/cc-bedrock-local.sh   (CLI wrapper)
 │   └─ ~/.aws/credentials [cc-bedrock] 프로파일 갱신 (TTL 8h)
 └─ claude  (CLAUDE_CODE_USE_BEDROCK=1, AWS_PROFILE=cc-bedrock)
        │
        ▼ SigV4
   Bedrock InvokeModel (Application Inference Profile)
        ├─ Invocation Logging → CW Logs → bedrock-usage-tracker → DynamoDB usage
        │                                                              │
        │                                                              ▼ Stream
        │                                                    token-limit-enforcer
        │                                                              │
        │                                            ┌─────────────────┴─────────────┐
        │                                            ▼                               │
        │                              사용자/부서 normalized 합산                   │
        │                                            │                               │
        │                                            ▼ 한도 초과?                    │
        │                                            └─→ user role에 Deny attach ────┘
        ├─ CloudTrail → 감사
        └─ Application Inference Profile 태그 → CUR 2.0
```

## 토큰 한도 데이터 모델 (`cc-on-bedrock-limits` DynamoDB)

| Item | PK | SK | 속성 |
|---|---|---|---|
| 사용자 한도 | `USER#{sub}` | `LIMIT#{period}` | `max_normalized`, `weights{Opus/Sonnet/Haiku}` |
| 부서 한도 | `DEPT#{dept}` | `LIMIT#{period}` | `max_normalized` |
| 사용량 카운터 | `USER#{sub}` | `COUNTER#{period}#{bucket}` | `normalized`, `ttl` |
| Deny 부착 상태 | `USER#{sub}` | `DENY#active` | `attached_at`, `reason`, `reset_at` |

`period` ∈ {`daily`, `weekly`, `monthly`}. bucket = period 식별자(예: `2026-05-11`, `2026-W19`, `2026-05`).

## 작업 항목

### Phase 1: CDK 인프라 (Day 1-2)

- [ ] **1-1. 새 stack `cdk/lib/08-local-governance-stack.ts`**
  - STS Issuer Lambda + Function URL (IAM auth)
  - Local user role factory IAM 정책 템플릿 (`MaxSessionDuration=43200` = 12h)
  - Application Inference Profile per department
  - `cc-on-bedrock-limits` DynamoDB 테이블 (Stream **불필요**, limits 정책만)
  - `cc-on-bedrock-usage` 테이블에 **DynamoDB Streams 활성화** (UsageTrackingStack 수정)
  - `token-limit-enforcer` Lambda (Stream consumer)
  - `limit-reset` Lambda + EventBridge cron 3개 (일/주/월)

- [ ] **1-2. Context flag `governanceOnly` 처리** (`cdk/bin/cc-on-bedrock.ts`)
  - `true` 시 `EcsDevenvStack`, `Ec2DevenvStack` 인스턴스화 skip
  - Dashboard stack에 prop 전달 (UI 분기용)

- [ ] **1-3. STS Issuer Lambda** (`cdk/lib/lambda/sts-issuer.py`)
  - Cognito ID 토큰 verify (JWKS)
  - 사용자별 role 존재 확인, 없으면 create (ADR-011 태그 정책, MaxSessionDuration=12h)
  - `sts:AssumeRole` DurationSeconds=28800 (8h), session policy로 모델/리전 추가 제한
  - 응답: `{accessKeyId, secretAccessKey, sessionToken, expiration, profileSnippet}`
  - 현재 Deny 부착 상태(`DENY#active`) 조회해 응답에 `limit_status` 포함

- [ ] **1-4. Per-user role 생성 로직**
  - 이름: `cc-on-bedrock-local-user-{cognito_sub_short}`
  - 신뢰 정책: STS Issuer Lambda role principal only
  - 권한: 부서 Inference Profile ARN + 승인 모델 ARN의 `bedrock:InvokeModel*`
  - Guardrail condition: `bedrock:GuardrailIdentifier`
  - 태그: `username`, `department`, `project`, `mode=local`

- [ ] **1-5. budget-check.py 확장 (backup path)**
  - Local mode role prefix(`cc-on-bedrock-local-user-`)도 스캔 대상에 포함
  - 달러 예산뿐 아니라 **normalized token 한도**도 함께 검사 (Stream consumer 실패 대비)
  - IAM Deny 부착/탈착 메커니즘 그대로

- [ ] **1-6. token-limit-enforcer Lambda** (`cdk/lib/lambda/token-limit-enforcer.py`)
  - DynamoDB Stream(usage table) consumer, batch size 10
  - 이벤트에서 `username`, `model`, `input/output tokens` 추출
  - normalized 계산: `input * w_in + output * w_out` (weights는 `limits` 테이블에서 사용자별 override 가능, 기본은 환경변수)
  - `limits` 테이블에서 사용자/부서 한도 + 현재 카운터 조회 (atomic UpdateExpression `ADD normalized :n`)
  - 한도 초과 시:
    1. `cc-bedrock-local-deny-{sub}` inline policy를 user role에 PutRolePolicy
    2. `DENY#active` 아이템 저장 (reason, period, reset_at)
    3. SNS 알림 발행
  - 80%/95% 임계 도달 시 SNS 경고 (Deny 없음)

- [ ] **1-7. limit-reset Lambda** (`cdk/lib/lambda/limit-reset.py`)
  - EventBridge cron: 일일(00:00 KST), 주간(월 00:00 KST), 월간(1일 00:00 KST) 3개
  - 해당 period의 `COUNTER#` 아이템 삭제 또는 TTL 만료 대기
  - `DENY#active`가 해당 period 사유면 `DeleteRolePolicy` + 아이템 삭제

- [ ] **1-8. UsageTrackingStack DynamoDB Stream 활성화**
  - `cc-on-bedrock-usage` 테이블에 `stream: StreamViewType.NEW_IMAGE` 추가
  - token-limit-enforcer가 Stream을 이벤트 소스로 구독

### Phase 2: Dashboard (Day 2-3)

- [ ] **2-1. `/local` 페이지 추가** (`shared/nextjs-app/app/local/page.tsx`)
  - "Get Bedrock Credentials" 버튼 → STS Issuer Lambda 호출
  - 결과:
    - `aws configure --profile cc-bedrock` 스니펫
    - 환경변수 export 스니펫 (`export CLAUDE_CODE_USE_BEDROCK=1 AWS_PROFILE=cc-bedrock AWS_REGION=ap-northeast-2`)
    - 만료 시각 카운트다운 (8h)
  - **남은 토큰 게이지**: 일/주/월별 사용량/한도 진행률 바, reset 까지 남은 시간
  - 차단 상태 배너: Deny 부착 중이면 사유와 reset 시각 표시
  - 다운로드 버튼: `tools/cc-bedrock-local.sh`

- [ ] **2-1b. 관리자 한도 페이지** (`shared/nextjs-app/app/admin/limits/page.tsx`)
  - 사용자/부서 normalized token 한도 CRUD (period × max_normalized)
  - normalized weight 글로벌 기본값 설정
  - 강제 reset 버튼 (관리자만): Deny detach + 카운터 리셋

- [ ] **2-2. 모드 분기** (`governanceOnly`)
  - EC2/ECS 의존 페이지(컨테이너 시작/정지/스냅샷) 숨김
  - 사용량 분석 / 부서 예산 / 감사 페이지는 유지
  - 사이드바에 "Local Credentials" 메뉴 추가

- [ ] **2-3. API route `/api/local/credentials`**
  - 서버사이드에서 STS Issuer Lambda 호출 (NextAuth 세션 검증)
  - 응답 캐싱 금지 헤더

### Phase 3: 로컬 CLI 도우미 (Day 3)

- [ ] **3-1. `tools/cc-bedrock-local.sh`**
  ```bash
  cc-bedrock-local refresh    # Dashboard에 OIDC 로그인 → 자격증명 갱신
  cc-bedrock-local run -- claude  # 자격증명 보장 후 claude 실행
  cc-bedrock-local status     # 남은 TTL, 사용량 요약
  ```
  - 자격증명을 `~/.aws/credentials [cc-bedrock]` 프로파일에 기록
  - `~/.config/cc-bedrock/config.json`: dashboard URL, 사용자 sub

- [ ] **3-2. 자동 갱신 데몬 (옵션)**
  - launchd / systemd-user 단위 파일 템플릿
  - 50분마다 silent refresh (NextAuth refresh token 이용)

### Phase 4: 문서/테스트 (Day 4)

- [ ] **4-1. `docs/deployment-guide.md`에 "Local Governance Mode" 섹션**
  - `npx cdk deploy --all --context governanceOnly=true`
  - 사용자 온보딩 흐름 (Cognito 가입 → 대시보드 → CLI 다운로드 → `claude` 실행)

- [ ] **4-2. `docs/runbooks/local-governance-onboarding.md`** 신규
  - 신규 사용자 추가, role 비활성화, 모델 권한 변경 절차

- [ ] **4-3. E2E 테스트** `tests/integration/test-local-governance.sh`
  - STS Issuer Lambda 호출 → 자격증명 받기
  - 받은 자격증명으로 `bedrock:InvokeModel` 성공
  - 미승인 모델 호출 시 Deny 확인
  - DynamoDB 사용량 레코드 도착 확인 (Invocation Logging 지연 고려, 최대 60s 폴링)
  - Budget 초과 시 IAM Deny 부착 검증

- [ ] **4-4. README 업데이트** — Local Governance Mode 한 줄 요약 + ADR-014 링크

## 검증 기준
1. EC2/ECS 스택이 deploy되지 않는다 (`cdk ls` 확인)
2. 로컬 PC에서 `claude` 실행 시 Bedrock 호출 성공, CloudTrail에 `cc-on-bedrock-local-user-*` principal로 기록
3. STS 자격증명 TTL = 8시간 (Expiration 검증)
4. DynamoDB `cc-on-bedrock-usage`에 PK=`USER#{username}` 레코드 생성, Stream 트리거 호출됨
5. 대시보드 사용량 차트 + 남은 토큰 게이지에 로컬 호출이 반영됨
6. 미승인 모델/리전 호출 거부됨 (IAM Deny)
7. **토큰 한도 차단 시나리오**:
   - 한도를 작게 설정한 테스트 사용자로 반복 호출
   - normalized 누적이 한도 초과 → 1-3분 내 Deny 부착
   - 다음 호출이 `AccessDeniedException`으로 거부
   - reset cron 실행 후 Deny 해제, 호출 재개
8. 부서 한도 초과 시 같은 부서 전체 차단 (사용자 한도와 AND 조건)
9. Stream consumer 장애 시뮬레이션 시 backup `budget-check.py`가 5분 내 차단

## Out of Scope
- 실시간(<1초) 쿼터 강제 → LLM Gateway 도입 시 (Phase 2 별도 ADR)
- 프롬프트 단위 커스텀 DLP → Bedrock Guardrails로 한정
- SSO Federation 통합 → ADR-008 후속 작업

## 마이그레이션 노트
- 기존 EC2 모드 사용자가 Local 모드로 전환 시: ECS task 정리 후 새 role 발급
- 같은 사용자가 두 모드 병행은 비권장 (사용량 attribute 혼선)
