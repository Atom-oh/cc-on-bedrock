# Next.js Dashboard Module

## Role
관리자/사용자 대시보드. 사용량 분석, 운영 모니터링, EC2 인스턴스 관리, 셀프서비스 환경 포털.

## Pages
- `src/app/` - Home 대시보드 (비용/토큰/인스턴스 요약)
- `src/app/user/` - **사용자 셀프서비스 포털** (3-탭: 환경/스토리지/설정)
- `src/app/dept/` - 부서 관리자 대시보드 (멤버, 예산, 사용량)
- `src/app/analytics/` - 토큰 사용량, 모델 비율, 비용 트렌드 차트
- `src/app/monitoring/` - EC2 인스턴스 메트릭, Bedrock 사용량 (DynamoDB), 실시간 세션
- `src/app/ai/` - AI Assistant (Bedrock Converse API + AgentCore Memory, Tool Use)
- `src/app/security/` - Security Dashboard (IAM, DLP 정책, DNS Firewall 현황)
- `src/app/admin/` - 사용자 CRUD, API 키 관리
- `src/app/admin/instances/` - EC2 인스턴스 할당/시작/중지
- `src/app/admin/budgets/` - 부서 예산 관리
- `src/app/admin/tokens/` - 토큰 사용량 대시보드
- `src/app/admin/approvals/` - EBS 확장 등 승인 요청 관리
- `src/app/admin/dlp/` - DLP 정책 관리 (도메인 차단/허용)
- `src/app/admin/mcp/` - MCP 카탈로그/게이트웨이 관리 (서버 할당, 동기화)
- `src/app/docs/` - 내장 문서 (getting-started, user-guide, admin-guide, architecture, security, faq)
- `src/app/login/` - 로그인 페이지 (direct form, no Cognito redirect)

## API Routes

### Admin
- `src/app/api/containers/route.ts` - EC2 인스턴스 관리 (Admin)
- `src/app/api/container-metrics/route.ts` - EC2 CloudWatch 메트릭 + Bedrock 사용량(DynamoDB) (Admin)
- `src/app/api/users/route.ts` - Cognito 사용자 관리 (Admin)
- `src/app/api/usage/route.ts` - Usage Analytics API (Admin)
- `src/app/api/security/route.ts` - 보안 현황 조회 (Admin)
- `src/app/api/admin/ebs-resize/route.ts` - EBS 리사이즈 승인/거부 (Admin)
- `src/app/api/admin/budgets/route.ts` - 부서 예산 관리 (Admin)
- `src/app/api/admin/tokens/route.ts` - 토큰 관리 (Admin)
- `src/app/api/admin/approval-requests/route.ts` - 승인 요청 관리 (Admin)
- `src/app/api/admin/dlp/domains/route.ts` - DLP 도메인 차단/허용 (Admin)
- `src/app/api/admin/mcp/catalog/route.ts` - MCP 서버 카탈로그 CRUD (Admin)
- `src/app/api/admin/mcp/gateways/route.ts` - MCP 게이트웨이 관리 (Admin)
- `src/app/api/admin/mcp/gateways/sync/route.ts` - MCP 게이트웨이 동기화 트리거 (Admin)
- `src/app/api/admin/mcp/assignments/route.ts` - MCP 서버-부서 할당 (Admin, ADR-007)
- `src/app/api/admin/mcp/marketplaces/route.ts` - 부서별 플러그인 마켓플레이스 관리 (Admin)
- `src/app/api/dept/mcp/route.ts` - 부서 MCP 할당 현황 조회 (Dept Manager, read-only)

### User Self-Service
- `src/app/api/user/container/route.ts` - EC2 인스턴스 시작/중지
- `src/app/api/user/container/stream/route.ts` - **SSE 프로비저닝 진행상황** (6단계 실시간)
- `src/app/api/user/container-metrics/route.ts` - 사용자 인스턴스 메트릭
- `src/app/api/user/disk-usage/route.ts` - 디스크 사용량 (CloudWatch)
- `src/app/api/user/ebs-resize/route.ts` - EBS 확장 신청/상태/취소
- `src/app/api/user/password/route.ts` - 비밀번호 조회/변경 (Cognito + Secrets Manager)
- `src/app/api/user/usage/route.ts` - 일일 토큰 사용량
- `src/app/api/user/keep-alive/route.ts` - 유휴 타임아웃 연장 (EBS)
- `src/app/api/user/resource-review/route.ts` - AI 리소스 리뷰 (EBS 확장 전 사용량 분석)
- `src/app/api/user/container-request/route.ts` - 인스턴스 생성 요청

### Common
- `src/app/api/ai/route.ts` - Bedrock Converse API (Tool Use, 5 tools, max 5 iterations)
- `src/app/api/ai/memory/route.ts` - AgentCore Memory 관리
- `src/app/api/ai/runtime/route.ts` - AgentCore Runtime 관리
- `src/app/api/dept/route.ts` - 부서 정보
- `src/app/api/dept/list/route.ts` - 부서 목록 조회
- `src/app/api/health/route.ts` - 헬스체크
- `src/app/api/slack/commands/route.ts` - Slack slash command 핸들러
- `src/app/api/slack/events/route.ts` - Slack event subscription 핸들러

## Components

### User Portal (`src/components/user/`)
- `environment-tab.tsx` - 환경 정보 탭 (프로비저닝, 상태, 멀티URL [IDE/WEB/API], 메트릭, 사용량)
- `provisioning-progress.tsx` - SSE 6단계 프로비저닝 프로그레스 (Cancel, ARIA)
- `storage-tab.tsx` - 스토리지 탭 (디스크 게이지, EBS 확장 신청, Keep-Alive)
- `settings-tab.tsx` - 설정 탭 (비밀번호 관리, 계정 정보)
- `first-launch-guide.tsx` - 첫 실행 가이드 (환경 설정 안내)
- `welcome-onboarding.tsx` - 온보딩 워크플로우

### Charts (`src/components/charts/`)
- Recharts 기반: token-usage, model-ratio, cost-trend, leaderboard, horizontal-bar, area-trend, multi-line, donut

### Other
- `src/components/tables/` - 데이터 테이블 (users-table, containers-table)
- `src/components/cards/` - 상태 카드 (stat-card, health-card)
- `src/components/app-shell.tsx` - 앱 레이아웃 셸 (사이드바 + 콘텐츠)
- `src/components/container-metrics.tsx` - CPU/Memory/Network/Disk I/O 게이지 + 차트
- `src/components/sidebar.tsx` - 사이드바 네비게이션
- `src/components/filter-bar.tsx` - 필터 바
- `src/components/dept/` - 부서 관련 (dept-selector, dept-card)

## Lib
- `src/lib/auth.ts` - Cognito + NextAuth 설정 (JWT, 8h session, custom attributes, `.atomai.click` 쿠키 도메인)
- `src/lib/aws-clients.ts` - Cognito 사용자 관리 + DynamoDB 라우팅 테이블
  - `listCognitoUsers()`, `createCognitoUser()`, `deleteCognitoUser()` 등
  - `registerContainerRoute()` / `deregisterContainerRoute()` — Nginx 라우팅 등록
- `src/lib/ec2-clients.ts` - EC2 인스턴스 관리 (start/stop, RunInstances, password sync, gateway policy)
- `src/lib/cloudwatch-client.ts` - CloudWatch 메트릭 (EC2 CPU/Memory/Network/Disk)
- `src/lib/usage-client.ts` - DynamoDB 기반 사용량 조회 + Bedrock 모니터링 메트릭 (cc-on-bedrock 프로젝트 전용)
- `src/lib/slack-client.ts` - Slack API 클라이언트 (알림, 명령 처리)
- `src/lib/validation.ts` - 입력 검증 유틸리티
- `src/lib/utils.ts` - 공통 유틸리티 함수
- `src/lib/i18n.tsx` - 다국어(한/영) 지원
- `src/lib/types.ts` - 공유 타입 정의 (Provisioning, DiskUsage, Password, UserPortalTab 등)
- `src/middleware.ts` - 인증 + admin/dept-manager 라우트 보호

## Testing
- Framework: vitest (`npx vitest` or `npx vitest run`)
- Test location: `src/lib/__tests__/`
- Type check: `npx tsc --noEmit`

## Rules
- Server Components 기본, 차트/인터랙티브 UI만 'use client'
- Admin 페이지는 Cognito 'admin' 그룹 필수
- User API는 세션 기반 본인 데이터만 접근
- 환경변수는 `.env.example` 참조
- API routes에서 session 검증 필수
- ARIA 접근성: 탭(tablist/tab/tabpanel), 프로그레스바(progressbar), 폼(htmlFor/id), 알림(aria-live)
- Bedrock 사용량 메트릭은 DynamoDB `cc-on-bedrock-usage` 테이블에서 조회 (CloudWatch AWS/Bedrock은 계정 전체이므로 사용하지 않음)
