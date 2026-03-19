# Next.js Dashboard Module

## Role
관리자/사용자 대시보드. 사용량 분석, 운영 모니터링, 사용자/컨테이너 관리.

## Key Files
- `src/app/analytics/` - 토큰 사용량, 모델 비율, 비용 트렌드 차트
- `src/app/monitoring/` - 프록시 상태, ECS 컨테이너, 실시간 세션
- `src/app/admin/` - 사용자 CRUD, API 키 관리
- `src/app/admin/containers/` - 컨테이너 할당/시작/중지
- `src/app/api/` - NextAuth, health, LiteLLM, users, containers API routes
- `src/lib/auth.ts` - Cognito + NextAuth 설정
- `src/lib/litellm-client.ts` - LiteLLM Admin API 클라이언트
- `src/lib/aws-clients.ts` - Cognito, ECS SDK 클라이언트
- `src/middleware.ts` - 인증 + admin 라우트 보호

## Rules
- Server Components 기본, 차트/인터랙티브 UI만 'use client'
- Admin 페이지는 Cognito 'admin' 그룹 필수
- 환경변수는 `.env.example` 참조
- API routes에서 session 검증 필수
