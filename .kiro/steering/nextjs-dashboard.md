# Next.js Dashboard Module

## Role
관리자/사용자 대시보드 (7 pages). 사용량 분석, 모니터링, AI Assistant, 보안, 사용자/컨테이너 관리.

## Pages (7)
| Page | Access | Features |
|------|--------|----------|
| Home | All | Cost/token/user summary, cluster metrics |
| AI Assistant | All | Bedrock Converse + Tool Use, AgentCore Memory, copy, voice |
| Analytics | All | Model/department/user cost trends, leaderboard |
| Monitoring | Admin | Container Insights (CPU/Memory/Network), ECS status |
| Security | Admin | IAM, DLP, DNS Firewall, CloudTrail audit, checklist |
| Users | Admin | Cognito CRUD, sort/filter (OS, Tier, Security, Status) |
| Containers | Admin | ECS start/stop, sort/filter, EFS panel, duplicate prevention |

## API Routes (8)
- `api/ai/route.ts` - Bedrock Converse API (Tool Use, 5 tools, max 5 iterations)
- `api/ai/runtime/route.ts` - AgentCore Runtime invocation
- `api/container-metrics/route.ts` - CloudWatch Container Insights
- `api/security/route.ts` - 보안 현황 조회
- `api/health/route.ts` - 헬스체크
- `api/litellm/route.ts` - LiteLLM API (레거시)
- `api/users/route.ts` - Cognito 사용자 관리
- `api/containers/route.ts` - ECS 컨테이너 관리

## AI Assistant — Hybrid Architecture
```
Dashboard (fast): Browser → /api/ai → Bedrock Converse API → SSE streaming, 1~5s, 3 inline tools
Slack (shared):   Slack Bot → /api/ai/runtime → AgentCore Runtime → Gateway (MCP) → Lambda, 10~20s, 8 tools
Both share:       AgentCore Memory (per-user session isolation)
```

## Key Libs
- `src/lib/auth.ts` - Cognito + NextAuth
- `src/lib/usage-client.ts` - DynamoDB 기반 사용량 조회 (CloudTrail → EventBridge → Lambda → DynamoDB)
- `src/lib/aws-clients.ts` - Cognito, ECS SDK clients
- `src/lib/cloudwatch-client.ts` - CloudWatch metrics
- `src/lib/i18n.tsx` - 다국어(한/영) 지원

## Rules
- Server Components 기본, 차트/인터랙티브 UI만 'use client'
- Admin 페이지는 Cognito 'admin' 그룹 필수
- API routes에서 session 검증 필수
