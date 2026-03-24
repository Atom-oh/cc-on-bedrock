# Next.js Dashboard Module

## Role
관리자/사용자 대시보드. 사용량 분석, 운영 모니터링, 사용자/컨테이너 관리.

## Pages
- `src/app/analytics/` - 토큰 사용량, 모델 비율, 비용 트렌드 차트
- `src/app/monitoring/` - Container Insights, ECS 컨테이너, 실시간 세션
- `src/app/ai/` - AI Assistant (Bedrock Converse API + AgentCore Memory, Tool Use)
- `src/app/security/` - Security Dashboard (IAM, DLP 정책, DNS Firewall 현황)
- `src/app/admin/` - 사용자 CRUD, API 키 관리
- `src/app/admin/containers/` - 컨테이너 할당/시작/중지

## API Routes
- `src/app/api/ai/route.ts` - Bedrock Converse API (Tool Use, 5 tools, max 5 iterations)
- `src/app/api/container-metrics/route.ts` - CloudWatch Container Insights 메트릭
- `src/app/api/security/route.ts` - 보안 현황 조회
- `src/app/api/health/route.ts` - 헬스체크
- `src/app/api/litellm/route.ts` - LiteLLM API (레거시, DynamoDB 전환 예정)
- `src/app/api/users/route.ts` - Cognito 사용자 관리
- `src/app/api/containers/route.ts` - ECS 컨테이너 관리

## Components
- `src/components/charts/` - Recharts 기반 차트 (token-usage, model-ratio, cost-trend, leaderboard, horizontal-bar, area-trend, multi-line, donut)
- `src/components/tables/` - 데이터 테이블 (users-table, containers-table)
- `src/components/cards/` - 상태 카드 (stat-card, health-card)
- `src/components/sidebar.tsx` - 사이드바 네비게이션
- `src/components/filter-bar.tsx` - 필터 바

## Lib
- `src/lib/auth.ts` - Cognito + NextAuth 설정
- `src/lib/usage-client.ts` - DynamoDB 기반 사용량 조회 클라이언트 (CloudTrail → EventBridge → Lambda → DynamoDB)
- `src/lib/aws-clients.ts` - Cognito, ECS SDK 클라이언트
- `src/lib/cloudwatch-client.ts` - CloudWatch 메트릭 클라이언트
- `src/lib/i18n.tsx` - 다국어(한/영) 지원
- `src/lib/types.ts` - 공유 타입 정의
- `src/middleware.ts` - 인증 + admin 라우트 보호

## Rules
- Server Components 기본, 차트/인터랙티브 UI만 'use client'
- Admin 페이지는 Cognito 'admin' 그룹 필수
- 환경변수는 `.env.example` 참조
- API routes에서 session 검증 필수
