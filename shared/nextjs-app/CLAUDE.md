# Next.js Dashboard Module

## Role
관리자/사용자 대시보드. 사용량 분석, 운영 모니터링, 사용자/컨테이너 관리, 셀프서비스 환경 포털.

## Pages
- `src/app/` - Home 대시보드 (비용/토큰/클러스터 요약)
- `src/app/user/` - **사용자 셀프서비스 포털** (3-탭: 환경/스토리지/설정)
- `src/app/dept/` - 부서 관리자 대시보드 (멤버, 예산, 사용량)
- `src/app/analytics/` - 토큰 사용량, 모델 비율, 비용 트렌드 차트
- `src/app/monitoring/` - Container Insights, ECS 컨테이너, 실시간 세션
- `src/app/ai/` - AI Assistant (Bedrock Converse API + AgentCore Memory, Tool Use)
- `src/app/security/` - Security Dashboard (IAM, DLP 정책, DNS Firewall 현황)
- `src/app/admin/` - 사용자 CRUD, API 키 관리
- `src/app/admin/containers/` - 컨테이너 할당/시작/중지

## API Routes

### Admin
- `src/app/api/containers/route.ts` - ECS 컨테이너 관리 (Admin)
- `src/app/api/container-metrics/route.ts` - CloudWatch Container Insights (Admin)
- `src/app/api/users/route.ts` - Cognito 사용자 관리 (Admin)
- `src/app/api/usage/route.ts` - Usage Analytics API (Admin)
- `src/app/api/security/route.ts` - 보안 현황 조회 (Admin)
- `src/app/api/admin/ebs-resize/route.ts` - EBS 리사이즈 승인/거부 (Admin)
- `src/app/api/admin/budgets/route.ts` - 부서 예산 관리 (Admin)
- `src/app/api/admin/tokens/route.ts` - 토큰 관리 (Admin)

### User Self-Service
- `src/app/api/user/container/route.ts` - 컨테이너 시작/중지
- `src/app/api/user/container/stream/route.ts` - **SSE 프로비저닝 진행상황** (6단계 실시간)
- `src/app/api/user/container-metrics/route.ts` - 사용자 컨테이너 메트릭
- `src/app/api/user/disk-usage/route.ts` - 디스크 사용량 (CloudWatch)
- `src/app/api/user/ebs-resize/route.ts` - EBS 확장 신청/상태/취소
- `src/app/api/user/password/route.ts` - 비밀번호 조회/변경 (Cognito + Secrets Manager)
- `src/app/api/user/usage/route.ts` - 일일 토큰 사용량
- `src/app/api/user/keep-alive/route.ts` - 유휴 타임아웃 연장 (EBS)

### Common
- `src/app/api/ai/route.ts` - Bedrock Converse API (Tool Use, 5 tools, max 5 iterations)
- `src/app/api/dept/route.ts` - 부서 정보
- `src/app/api/health/route.ts` - 헬스체크

## Components

### User Portal (`src/components/user/`)
- `environment-tab.tsx` - 환경 정보 탭 (프로비저닝, 상태, URL, 메트릭, 사용량)
- `provisioning-progress.tsx` - SSE 6단계 프로비저닝 프로그레스 (Cancel, ARIA)
- `storage-tab.tsx` - 스토리지 탭 (디스크 게이지, EBS 확장 신청, Keep-Alive)
- `settings-tab.tsx` - 설정 탭 (비밀번호 관리, 계정 정보)

### Charts (`src/components/charts/`)
- Recharts 기반: token-usage, model-ratio, cost-trend, leaderboard, horizontal-bar, area-trend, multi-line, donut

### Other
- `src/components/tables/` - 데이터 테이블 (users-table, containers-table)
- `src/components/cards/` - 상태 카드 (stat-card, health-card)
- `src/components/container-metrics.tsx` - CPU/Memory/Network/Disk I/O 게이지 + 차트
- `src/components/sidebar.tsx` - 사이드바 네비게이션
- `src/components/filter-bar.tsx` - 필터 바
- `src/components/dept/` - 부서 관련 (dept-selector, dept-card)

## Lib
- `src/lib/auth.ts` - Cognito + NextAuth 설정 (JWT, 8h session, custom attributes)
- `src/lib/aws-clients.ts` - Cognito, ECS, IAM, EFS, Secrets Manager SDK 클라이언트
  - `startContainer()` - 기존 컨테이너 시작
  - `startContainerWithProgress()` - SSE 콜백 기반 단계별 시작
  - `createCognitoUser()` - 초기 비밀번호 Cognito + Secrets Manager 동기화
- `src/lib/cloudwatch-client.ts` - CloudWatch 메트릭 클라이언트
- `src/lib/usage-client.ts` - DynamoDB 기반 사용량 조회 (CloudTrail → EventBridge → Lambda → DynamoDB)
- `src/lib/i18n.tsx` - 다국어(한/영) 지원
- `src/lib/types.ts` - 공유 타입 정의 (Provisioning, DiskUsage, Password, UserPortalTab 등)
- `src/middleware.ts` - 인증 + admin/dept-manager 라우트 보호

## Rules
- Server Components 기본, 차트/인터랙티브 UI만 'use client'
- Admin 페이지는 Cognito 'admin' 그룹 필수
- User API는 세션 기반 본인 데이터만 접근
- 환경변수는 `.env.example` 참조
- API routes에서 session 검증 필수
- ARIA 접근성: 탭(tablist/tab/tabpanel), 프로그레스바(progressbar), 폼(htmlFor/id), 알림(aria-live)
