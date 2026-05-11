# 작업계획서: Local Governance Mode (EC2-less)

> 작성: 2026-05-11 | 상태: 계획 중 | 관련 ADR: ADR-014

## 배경
로컬 PC에서 Claude Code를 사용하면서 EC2 운영 부담 없이 거버넌스(사용량 추적, 부서 예산, 모델 제한, 감사)만 유지하는 배포 프로파일.

## 목표
1. Cognito 로그인 → 단기 STS 자격증명(1h) 자동 발급
2. 로컬 Claude Code가 Bedrock 직접 호출 (`CLAUDE_CODE_USE_BEDROCK=1`)
3. Bedrock Invocation Logging → 기존 `bedrock-usage-tracker.py` 파이프라인 그대로
4. 대시보드에서 사용량/예산/감사 모두 조회
5. CDK context flag `--context governanceOnly=true` 로 EC2/ECS 스택 skip

## 아키텍처

```
로컬 PC
 ├─ tools/cc-bedrock-local.sh   (CLI wrapper)
 │   └─ ~/.aws/credentials [cc-bedrock] 프로파일 갱신
 └─ claude  (CLAUDE_CODE_USE_BEDROCK=1, AWS_PROFILE=cc-bedrock)
        │
        ▼ SigV4 (단기 자격증명)
   Bedrock InvokeModel
        ├─ Invocation Logging → CW Logs → Lambda → DynamoDB → Dashboard
        ├─ CloudTrail → 감사
        └─ Application Inference Profile 태그 → CUR 2.0
```

## 작업 항목

### Phase 1: CDK 인프라 (Day 1-2)

- [ ] **1-1. 새 stack `cdk/lib/08-local-governance-stack.ts`**
  - STS Issuer Lambda + Function URL (IAM auth)
  - Local user role factory IAM 정책 템플릿
  - Application Inference Profile per department (`bedrock:CreateInferenceProfile`)
  - DynamoDB 테이블 재사용 (UsageTrackingStack에서 import)

- [ ] **1-2. Context flag `governanceOnly` 처리** (`cdk/bin/cc-on-bedrock.ts`)
  - `true` 시 `EcsDevenvStack`, `Ec2DevenvStack` 인스턴스화 skip
  - Dashboard stack에 prop 전달 (UI 분기용)

- [ ] **1-3. STS Issuer Lambda** (`cdk/lib/lambda/sts-issuer.py`)
  - Cognito ID 토큰 verify (JWKS)
  - 사용자별 role 존재 확인, 없으면 create (ADR-011 태그 정책)
  - `sts:AssumeRole` 1h, session policy로 모델/리전 추가 제한
  - 응답: `{accessKeyId, secretAccessKey, sessionToken, expiration, profileSnippet}`

- [ ] **1-4. Per-user role 생성 로직**
  - 이름: `cc-on-bedrock-local-user-{cognito_sub_short}`
  - 신뢰 정책: STS Issuer Lambda role principal only
  - 권한: 부서 Inference Profile ARN + 승인 모델 ARN의 `bedrock:InvokeModel*`
  - Guardrail condition: `bedrock:GuardrailIdentifier`
  - 태그: `username`, `department`, `project`, `mode=local`

- [ ] **1-5. budget-check.py 확장**
  - Local mode role 이름 prefix(`cc-on-bedrock-local-user-`)도 스캔 대상에 포함
  - IAM Deny 부착 메커니즘 그대로

### Phase 2: Dashboard (Day 2-3)

- [ ] **2-1. `/local` 페이지 추가** (`shared/nextjs-app/app/local/page.tsx`)
  - "Get Bedrock Credentials" 버튼 → STS Issuer Lambda 호출
  - 결과:
    - `aws configure --profile cc-bedrock` 스니펫
    - 환경변수 export 스니펫 (`export CLAUDE_CODE_USE_BEDROCK=1 AWS_PROFILE=cc-bedrock AWS_REGION=ap-northeast-2`)
    - 만료 시각 카운트다운
  - 다운로드 버튼: `tools/cc-bedrock-local.sh`

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
3. DynamoDB `cc-on-bedrock-usage`에 PK=`USER#{username}` 레코드 생성
4. 대시보드 사용량 차트에 로컬 호출이 반영됨
5. 미승인 모델/리전 호출 거부됨 (IAM Deny)
6. 예산 초과 시 5분 내 IAM Deny 부착, 다음 호출 거부

## Out of Scope
- 실시간(<1초) 쿼터 강제 → LLM Gateway 도입 시 (Phase 2 별도 ADR)
- 프롬프트 단위 커스텀 DLP → Bedrock Guardrails로 한정
- SSO Federation 통합 → ADR-008 후속 작업

## 마이그레이션 노트
- 기존 EC2 모드 사용자가 Local 모드로 전환 시: ECS task 정리 후 새 role 발급
- 같은 사용자가 두 모드 병행은 비권장 (사용량 attribute 혼선)
