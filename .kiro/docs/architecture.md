# CC-on-Bedrock Architecture

## System Overview

5개의 독립적인 스택/모듈로 구성된 멀티유저 개발 플랫폼.

```
Users (Browser)
  ├── Dashboard (CloudFront → ALB → Next.js)
  │     ├── Cognito 인증 (OAuth2 + OIDC)
  │     ├── Analytics Dashboard (비용/토큰/사용자 분석)
  │     ├── AI Assistant (AgentCore Runtime + Gateway)
  │     ├── Monitoring (Container Insights + CloudWatch)
  │     └── Container/User 관리
  │
  └── DevEnv (CloudFront → ALB → ECS Task per user)
        ├── code-server (VS Code Web)
        ├── Claude Code CLI → Bedrock (직접 호출)
        ├── Kiro CLI
        └── EFS (영구 스토리지)

Internal:
  LiteLLM Proxy (ALB:4000) → Bedrock Models
  ├── 17 model aliases
  ├── Serverless Valkey (TLS, 캐시)
  ├── RDS PostgreSQL (사용량 DB)
  └── API Key 예산 관리
```

## Bedrock Access
- **컨테이너 (Claude Code)**: ECS Instance Role → Bedrock 직접 호출
- **Dashboard (LiteLLM 경유)**: LiteLLM API Key → LiteLLM Proxy → Bedrock API

## Authentication Flow
```
Browser → CloudFront → Dashboard → NextAuth.js → Cognito (OAuth2 code flow)
  → Hosted UI 로그인 → Callback → JWT 세션
```

## DLP Security Policies
| Policy | Description |
|--------|-------------|
| open | 모든 아웃바운드 허용 (SG: 0.0.0.0/0) |
| restricted | 화이트리스트만 허용 (SG: AWS 서비스 + 특정 IP) |
| locked | VPC 내부만 허용 (SG: VPC CIDR only) |

## Key Design Decisions
- **서브도메인 라우팅** (`user01.dev.example.com`) - CloudFront + ALB Host-header 규칙
- **Claude Code → Bedrock 직접** - ECS Instance Role 활용
- **6 Task Definitions** - Ubuntu/AL2023 × Light/Standard/Power
- **EFS → `/home/coder`** - 컨테이너 재시작 시 작업 파일 보존
- **Serverless Valkey** - ~$8/month, TLS 기본, LiteLLM 캐시
- **DLP 4-layer** - code-server flags → SG → DNS Firewall → Extension
