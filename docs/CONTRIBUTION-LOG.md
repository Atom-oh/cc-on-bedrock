# CC-on-Bedrock Contribution Log

## Session: 2026-03-28 ~ 2026-03-30

### 세션 요약
AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼의 엔터프라이즈 기능 구현.
Dashboard UX 개선, NLB→Nginx→ECS 라우팅 전환, per-user 보안 격리, 컨테이너 관리 안정화.

---

### 1. Dashboard UX 개선

#### 1.1 화면 깜빡임 수정 (8개 페이지)
- **문제**: 15초 polling마다 `setLoading(true)` → 전체 UI 언마운트/리마운트
- **해결**: 초기 로드만 loading 표시, 백그라운드 리프레시는 상태 유지
- **파일**: container-management, user-management, budget-management, token-dashboard, security-dashboard, dept-dashboard, user-portal, monitoring-dashboard

#### 1.2 사이드바 Active State 수정
- **문제**: `/admin/containers`에서 `/admin` 부모 메뉴도 활성화
- **해결**: `hasChildNav` 정확 매칭 로직
- **파일**: `components/sidebar.tsx`

#### 1.3 부서 대시보드 필터링
- **설계**: Designer + Architect + Claude 3-AI 교차 검증
- **구현**: Pill selector, DeptCard grid, 2-mode view (overview/detail)
- **파일**: `dept-dashboard.tsx`, `dept-selector.tsx`, `dept-card.tsx`, `/api/dept/list/route.ts`

#### 1.4 Container StorageType 표시
- EBS/EFS 뱃지 (dropdown, config preview, containers table)
- **파일**: `container-management.tsx`, `containers-table.tsx`

#### 1.5 Health-aware URL
- RUNNING+HEALTHY일 때만 URL 링크, 그 외 "Starting..." 표시
- **파일**: `containers-table.tsx`

#### 1.6 Fast Polling
- 컨테이너 시작 중 5초 polling, HEALTHY 후 30초로 복원
- **파일**: `user-portal.tsx`

#### 1.7 Container Stop UI 즉시 업데이트
- stop 성공 후 `fetchData()` 즉시 호출
- **파일**: `environment-tab.tsx`

---

### 2. NLB → Nginx → ECS 라우팅 전환

#### 2.1 아키텍처 전환
- **이전**: CloudFront → ALB → per-user Target Group/Rule (100 rule 제한)
- **이후**: CloudFront → NLB → Nginx ECS Service → ECS Task:8080 (무제한)
- **설계**: Kiro CLI + Gemini + Claude 3-AI 교차 검증

#### 2.2 DynamoDB Routing Table
- `cc-routing-table`: subdomain → targetIp 매핑
- `registerContainerRoute()` / `deregisterContainerRoute()` 함수
- ALB 함수는 `_legacy` 접미사로 보존
- **파일**: `aws-clients.ts`, `containers/route.ts`, `user/container/route.ts`

#### 2.3 Nginx 설정 최적화
- SSL 제거 (CloudFront가 TLS 종료)
- `/health` 엔드포인트 (NLB health check)
- `X-Custom-Secret` CloudFront 헤더 검증
- Passive health check (`max_fails=3 fail_timeout=30s`)
- S3 polling 30초→5초, 시작 전 S3 config 선행 다운로드
- `server_names_hash_bucket_size 128` (4000+ 서버 블록 지원)
- **파일**: `nginx.conf.template`, `reload.sh`, `Dockerfile`, `nginx-config-gen.py`

#### 2.4 CDK 인프라
- NLB (internet-facing, CloudFront prefix list SG)
- Nginx ECS Service (desiredCount: 2, HA)
- ALB 완전 제거
- CloudFront origin: ALB → NLB
- DevEnv ACM wildcard cert (`*.dev.atomai.click`)
- **파일**: `04-ecs-devenv-stack.ts`, `05-dashboard-stack.ts`, `bin/app.ts`

#### 2.5 Lambda Field Name 수정
- DynamoDB `targetIp` ↔ Lambda `container_ip` 불일치 해결
- `DEV_DOMAIN` 환경변수 (기본값 `dev.example.com` → `dev.atomai.click`)
- **파일**: `nginx-config-gen.py`

---

### 3. 보안 및 Per-user 격리

#### 3.1 Per-user storageType 세션/API/UI
- `UserSession`에 `storageType` 추가 (JWT에서 추출)
- Self-service container에 `storageType` 전달
- EBS resize API: 글로벌 env → per-user 체크
- Users table: Storage 정렬/필터 추가
- **파일**: `types.ts`, `auth.ts`, `user/container/route.ts`, `ebs-resize/route.ts`, `users-table.tsx`

#### 3.2 IMDS 차단 → Per-user Task Role
- `ECS_AWSVPC_BLOCK_IMDS=true` (ECS agent config)
- `requireImdsv2: true` (Launch Template)
- Instance Role에서 Bedrock 권한 제거 (임시 복원 — instance refresh 대기)
- entrypoint.sh: `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` 검증 로그
- **파일**: `04-ecs-devenv-stack.ts`, `entrypoint.sh`

#### 3.3 EFS Access Point Per-user 격리
- `ensureUserAccessPoint()` — per-user AP 자동 생성
- `STORAGE_ISOLATED=true` 환경변수 → symlink 생성 스킵
- `chown` 에러 무시 (`|| true`)
- Stale symlink/users dir 정리
- **파일**: `aws-clients.ts`, `entrypoint.sh`

#### 3.4 Permission Boundary 수정
- KMS Decrypt + deploy bucket 추가
- S3Access 확장
- **파일**: `02-security-stack.ts`

---

### 4. Cognito 인증

#### 4.1 OAuth 로그인 수정
- `scope: openid email profile` 추가
- 미들웨어 쿠키명: `__Secure-next-auth.session-token`
- SSM Parameter Store로 Client ID/Secret 관리
- 불필요한 User Pool/App Client 삭제
- **파일**: `auth.ts`, `middleware.ts`, `05-dashboard-stack.ts`, `cdk.context.json`

#### 4.2 Cognito IAM 수정
- `AdminSetUserPassword` 권한 추가
- **파일**: `02-security-stack.ts`

---

### 5. 컨테이너 관리

#### 5.1 code-server 비밀번호 동기화
- `CODESERVER_PASSWORD` 환경변수로 직접 전달
- entrypoint.sh: env var > Secrets Manager > random 우선순위
- config.yaml 강제 덮어쓰기 (EFS stale config 방지)
- **파일**: `aws-clients.ts`, `entrypoint.sh`

#### 5.2 Docker 이미지 빌드
- devenv Ubuntu: ECR push (`cc-on-bedrock/devenv:ubuntu-latest`)
- Nginx: ECR push (`cc-on-bedrock/nginx:latest`)
- entrypoint.sh crontab fallback (background loop)
- **파일**: `Dockerfile.ubuntu`, `entrypoint.sh`, `nginx/Dockerfile`

#### 5.3 Idle Timeout Lambda 수정
- `warm-stop.py`: 메트릭 없으면 idle=False (fail safe)
- 시작 후 10분 grace period
- **파일**: `warm-stop.py`, `idle-check.py`

---

### 6. CDK Cross-stack 해결
- `userPoolClient` export 제거 (SSM으로 전환)
- `devenvAlbListenerArn` export 제거 (NLB 전환)
- `cloudfrontSecret` direct import (fromSecretCompleteArn)
- **파일**: `bin/app.ts`, `04-ecs-devenv-stack.ts`, `05-dashboard-stack.ts`

---

### 7. 검증
- `scripts/validate-deployment.sh` 자동 검증 스크립트 (17/20 pass)
- Playwright E2E 테스트 (로그인 → 컨테이너 시작 → URL 접속)
- 비밀번호 동기화 확인 (Secrets Manager = config.yaml)
- IMDS 차단 확인 (Task Role credentials 사용)
- EFS Access Point 격리 확인

---

### 커밋 수 (feat/enterprise-edition)
약 26개 커밋

### 다음 세션 TODO
1. 셀프서비스 환경 신청 (User Portal → 신청 → Admin 승인)
2. Storage 전환 (EFS ↔ EBS + S3 백업/복원)
3. Instance Refresh 재시작
4. CloudFront VPC Origins
5. Resource 모니터링 0 문제
6. 대규모 UX (200+ 부서)
7. ASG desiredCapacity 제거
