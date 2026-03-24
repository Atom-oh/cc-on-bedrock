# Next.js Dashboard Module

## Role
관리자/사용자 대시보드. 사용량 분석, 운영 모니터링, 사용자/컨테이너 관리, AI Assistant.

## Pages
- `src/app/page.tsx` - Home (AWSops-style hero cards, insights, system status)
- `src/app/ai/` - AI Assistant (AgentCore Runtime, SSE streaming, tool use)
- `src/app/analytics/` - Analytics (9 sections: cost, tokens, leaderboard, heatmap)
- `src/app/monitoring/` - Monitoring (Container Insights, CPU/Memory/Network)
- `src/app/admin/` - User CRUD (Cognito)
- `src/app/admin/containers/` - Container start/stop, subdomain routing

## API Routes
- `src/app/api/ai/route.ts` - AgentCore Runtime invocation
- `src/app/api/container-metrics/route.ts` - CloudWatch Container Insights
- `src/app/api/litellm/route.ts` - LiteLLM proxy API
- `src/app/api/users/route.ts` - Cognito user management
- `src/app/api/containers/route.ts` - ECS container management
- `src/app/api/health/route.ts` - Health check

## Key Libraries
- `src/lib/auth.ts` - Cognito + NextAuth
- `src/lib/usage-client.ts` - DynamoDB usage queries
- `src/lib/aws-clients.ts` - Cognito, ECS SDK clients
- `src/lib/cloudwatch-client.ts` - CloudWatch metrics
- `src/lib/i18n.tsx` - Korean/English toggle (~130 translation keys)

## Rules
- Server Components 기본, 차트/인터랙티브 UI만 'use client'
- Admin 페이지는 Cognito 'admin' 그룹 필수
- API routes에서 session 검증 필수
- Dark theme: AWSops-style navy (#0a0f1a)
- 30초 자동 새로고침

## Commands
```bash
cd shared/nextjs-app && npm install && npm run dev
cd shared/nextjs-app && npx tsc --noEmit
```
