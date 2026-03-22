# CC-on-Bedrock

AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼.

CDK(TypeScript), Terraform(HCL), CloudFormation(YAML) 3가지 IaC로 동일 아키텍처를 구현하며, 교육/워크숍/프로덕션 환경에서 활용할 수 있습니다.

## Architecture Overview

5개의 독립적인 스택/모듈로 구성된 멀티유저 개발 플랫폼입니다.

```
Users (Browser)
  │
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
  ├── 17 model aliases (global/apac/us prefix 매핑)
  ├── Serverless Valkey (TLS, 캐시)
  ├── RDS PostgreSQL (사용량 DB)
  └── API Key 예산 관리
```

| Stack | 설명 | 주요 리소스 |
|-------|------|-------------|
| 01 Network | 네트워크 기반 | VPC (3-tier), NAT GW x2, VPC Endpoints x8, Route 53 |
| 02 Security | 인증/보안 | Cognito, ACM, KMS, Secrets Manager, IAM, DLP 정책 |
| 03 LiteLLM | AI 프록시 | EC2 ASG x2, Internal ALB, RDS PostgreSQL, Serverless Valkey |
| 04 ECS DevEnv | 개발환경 | ECS Cluster (EC2), 6 Task Defs, EFS, ALB, CloudFront |
| 05 Dashboard | 관리 대시보드 | Next.js 14, EC2 ASG, ALB, CloudFront |

### Models (Bedrock Inference Profiles)

| Model | Inference Profile ID | 용도 |
|-------|---------------------|------|
| Claude Sonnet 4.6 | `global.anthropic.claude-sonnet-4-6` | Claude Code 기본 모델 |
| Claude Opus 4.6 | `global.anthropic.claude-opus-4-6-v1` | 고성능 작업 |
| Claude Haiku 4.5 | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | 빠른 응답 |

### Bedrock Access Architecture

```
컨테이너 (Claude Code CLI)
  │ ANTHROPIC_MODEL=global.anthropic.claude-sonnet-4-6
  │ (ECS Instance Role → Bedrock 직접 호출)
  ▼
Bedrock API (global inference profiles)

Dashboard (LiteLLM 경유)
  │ LiteLLM API Key (sk-xxx)
  │ 17 model aliases + budget tracking
  ▼
LiteLLM Proxy → Bedrock API
```

### AI Assistant (AgentCore Runtime)

```
Dashboard (/ai) → InvokeAgentRuntimeCommand
  ▼
AgentCore Runtime (cconbedrock_agent)
  ├── Strands Agent (Claude Sonnet 4.6)
  │     ├── get_spend_summary (LiteLLM)
  │     ├── get_api_key_budgets (LiteLLM)
  │     ├── get_system_health (LiteLLM)
  │     ├── get_container_status (ECS)
  │     └── get_container_metrics (CloudWatch)
  └── Gateway (cconbedrock-analytics-gateway, MCP)
```

---

## Dashboard Features

### Home (`/`)
- **Hero Cards**: 총 비용, 요청수, 사용자, 컨테이너 (AWSops-style 6열 그리드)
- **Cost & Token Insights**: Monthly Est, Avg Cost/Req, Budget 사용률
- **Infrastructure**: Proxy/DB/Cache/모델 상태, API Key 수
- **Container Insights**: CPU/Memory/Network from CloudWatch
- **System Status**: 5개 서비스 dot indicators
- **Quick Actions**: 각 페이지 바로가기

### AI Assistant (`/ai`)
- **AgentCore Runtime** 기반 자연어 분석
- 6개 프리셋 질문 (비용 분석, 시스템 상태, 예산 관리 등)
- SSE 스트리밍 응답 + 마크다운 렌더링
- Tool 호출 상태 실시간 표시

### Analytics (`/analytics`)
- **Overview**: 총 비용/요청/사용자/응답시간
- **Insights**: 일일 Burn Rate, 월간 예측, 요청당 비용, 예산 사용률
- **System Health**: Proxy, DB, Cache, LiteLLM 버전
- **API Key Budget**: 키별 사용률 progress bar
- **Bedrock Model**: 모델별 요청/토큰/비용/지연시간
- **Leaderboard**: 사용자 TOP 10 (총/Input/Output 토큰)
- **User × Model Matrix**: 히트맵 + 모델 선호도 + 토큰 효율
- **Token Trends**: Area/Line 차트
- **Usage Patterns**: 사용자별 요청, 모델별 비용

### Monitoring (`/monitoring`)
- **Service Health**: Proxy/DB/Cache 상태 카드
- **Container Insights**: CPU/Memory utilization + Network I/O (CloudWatch)
- **6시간 시계열**: Area 차트 (CPU+Memory, Network Rx/Tx)
- **Per-TaskDef**: 각 Task Definition별 리소스 사용량
- **Container Distribution**: OS/Tier 분포 바

### User Management (`/admin`)
- User CRUD (Cognito)
- 인사이트: 활성 사용자, API Key 보유, OS/Tier/Security Policy 분포

### Container Management (`/admin/containers`)
- 컨테이너 시작/중지
- 인사이트: 사용률, OS/Tier breakdown
- 서브도메인별 ALB 라우팅

### 공통 기능
- **다크 테마**: AWSops-style 네이비 (#0a0f1a)
- **한/영 토글**: 사이드바 상단, ~130 번역 키
- **30초 자동 새로고침**
- **접이식 섹션**

---

## Quick Start

### 1. Prerequisites

```bash
aws --version          # AWS CLI v2.15+
docker --version       # Docker 24+
node --version         # Node.js 20+
```

### 2. Docker Images

```bash
# ECR 리포지토리 생성
bash scripts/create-ecr-repos.sh

# 모든 이미지 빌드 + 푸시 (ARM64)
cd docker && bash build.sh all all
```

### 3. Deploy Infrastructure

3가지 IaC 도구 중 하나를 선택합니다:

#### CDK (TypeScript) — 추천
```bash
cd cdk
npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-2
npx cdk deploy --all
```

#### Terraform (HCL)
```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply
```

#### CloudFormation (YAML)
```bash
cd cloudformation
bash deploy.sh
```

### 4. Post-Deploy

```bash
# 배포 검증 (23개 항목 체크)
bash scripts/verify-deployment.sh your-domain.com

# Dashboard 접속
open https://<cloudfront-domain>
```

### 5. 사용자 생성 & 컨테이너 시작

1. Dashboard → Admin → Users → Create User
2. Dashboard → Admin → Containers → Start Container
3. 사용자가 `https://<subdomain>.dev.your-domain.com` 접속
4. code-server 비밀번호 입력 → Claude Code 사용

---

## Project Structure

```
cc-on-bedrock/
├── agent/                          # AgentCore Runtime Agent
│   ├── agent.py                    #   Strands Agent + 5 tools
│   ├── Dockerfile                  #   Python 3.11 container
│   └── requirements.txt            #   bedrock-agentcore, strands-agents
│
├── docker/                         # Docker images
│   ├── devenv/                     #   code-server + Claude Code + Kiro
│   │   ├── Dockerfile.ubuntu       #     Ubuntu 24.04 ARM64
│   │   ├── Dockerfile.al2023       #     Amazon Linux 2023 ARM64
│   │   └── scripts/                #     Setup & entrypoint (DLP 정책)
│   └── litellm/                    #   LiteLLM proxy
│       ├── Dockerfile              #     python:3.11-slim
│       ├── litellm-config.yaml     #     17 model aliases
│       └── scripts/entrypoint.sh   #     Secrets Manager → envsubst
│
├── cdk/                            # AWS CDK (TypeScript)
│   ├── bin/app.ts                  #   Stack composition + dependencies
│   ├── config/default.ts           #   Typed configuration
│   └── lib/                        #   5 Stacks (01-Network ~ 05-Dashboard)
│
├── terraform/                      # Terraform (HCL)
│   ├── main.tf                     #   Root module wiring
│   ├── variables.tf / outputs.tf
│   └── modules/                    #   5 modules
│
├── cloudformation/                 # CloudFormation (YAML)
│   ├── 01-network.yaml ~ 05-dashboard.yaml
│   ├── deploy.sh / destroy.sh
│   └── params/default.json
│
├── shared/nextjs-app/              # Next.js 14 Dashboard
│   ├── src/app/                    #   App Router pages
│   │   ├── page.tsx                #     Home (AWSops-style cards)
│   │   ├── ai/                     #     AI Assistant (AgentCore)
│   │   ├── analytics/              #     Analytics (9 sections)
│   │   ├── monitoring/             #     Monitoring (Container Insights)
│   │   ├── admin/                  #     Users + Containers
│   │   └── api/                    #     API routes (litellm, containers, ai, health)
│   ├── src/components/             #   Charts, Tables, Cards, Sidebar
│   └── src/lib/                    #   Auth, AWS clients, LiteLLM, CloudWatch, i18n
│
├── scripts/                        # Utility scripts
│   ├── create-ecr-repos.sh
│   └── verify-deployment.sh        #   23-item health check
│
├── tests/                          # Tests
│   ├── docker/                     #   Container tests
│   └── integration/                #   E2E tests
│
└── docs/                           # Documentation
    ├── deployment-guide.md
    ├── iac-comparison.md
    ├── architecture.md
    └── decisions/                   #   ADR templates
```

---

## Key Design Decisions

| 결정 | 이유 |
|------|------|
| **서브도메인 라우팅** (`user01.dev.example.com`) | 포트 기반보다 직관적, CloudFront + ALB Host-header 규칙 |
| **Claude Code → Bedrock 직접** | ECS 환경에서 `ANTHROPIC_BASE_URL` 무시됨, Instance Role 활용 |
| **LiteLLM → Dashboard API 추적** | 사용자별 예산/토큰 관리, 17개 모델 alias 매핑 |
| **6 Task Definitions** | Ubuntu/AL2023 × Light/Standard/Power = 6 조합 |
| **EFS → `/home/coder`** | 컨테이너 재시작 시 작업 파일 보존 |
| **Serverless Valkey** | ~$8/month, TLS 기본, LiteLLM 캐시 |
| **DLP 4-layer** | code-server flags → SG → DNS Firewall → Extension |
| **ECS Exec 활성화** | 관리자 컨테이너 직접 접속 (`initProcessEnabled: true`) |
| **AgentCore Runtime** | AI 분석 에이전트, Tool Use 기반 실시간 데이터 조회 |

---

## Security

### DLP (Data Loss Prevention) Policies

| Policy | 설명 | 구현 |
|--------|------|------|
| **open** | 모든 아웃바운드 허용 | SG: 0.0.0.0/0 |
| **restricted** | 화이트리스트만 허용 | SG: AWS 서비스 + 특정 IP |
| **locked** | VPC 내부만 허용 | SG: VPC CIDR only |

### Authentication Flow

```
Browser → CloudFront → Dashboard → NextAuth.js → Cognito (OAuth2 code flow)
                                                    ↓
                                              Hosted UI 로그인
                                                    ↓
                                              Callback → JWT 세션
```

---

## Cost Estimate

### Education (20 users, Seoul Region)

| Resource | Spec | Monthly |
|----------|------|---------|
| EC2 - LiteLLM x2 | t4g.xlarge | ~$290 |
| EC2 - ECS Host (avg ~1.5) | m7g.4xlarge | ~$700 |
| EC2 - Dashboard | t4g.xlarge | ~$145 |
| RDS PostgreSQL | db.t4g.medium | ~$80 |
| Serverless Valkey | min 100MB | ~$8 |
| EFS | 20 users x 10GB | ~$20-40 |
| NAT Gateway x2 | | ~$90 |
| ALB x3 | 2 external + 1 internal | ~$60 |
| CloudFront x2 | Dashboard + DevEnv | ~$2-7 |
| VPC Endpoints x7 | Interface type | ~$102 |
| Route 53 + ACM + ECR | | ~$5 |
| AgentCore Runtime | Serverless | ~$5-10 |
| **Total (excl. Bedrock)** | | **~$1,510-1,540/month** |

> Bedrock 비용은 사용량에 따라 별도 과금됩니다.
> ECS ASG Min:0 설정으로 비활동 시 ECS Host 비용을 55-65% 절감할 수 있습니다.

### Production (100 users)

| Change | Estimated Total |
|--------|:---:|
| ECS Host ~15x m7g.4xlarge, Multi-AZ RDS | **~$10,200-10,500/month** |

---

## Documentation

| Document | Description |
|----------|-------------|
| [Deployment Guide](docs/deployment-guide.md) | 전체 배포 가이드 |
| [IaC Comparison](docs/iac-comparison.md) | CDK / Terraform / CloudFormation 비교 |
| [Architecture Diagrams](docs/architecture.md) | Mermaid 아키텍처 다이어그램 |

---

## Testing

```bash
# E2E 통합 테스트 (IaC + Docker + Next.js)
bash tests/integration/test-e2e.sh

# Docker 컨테이너 테스트만
bash tests/integration/test-e2e.sh --only-iac

# 배포 후 검증 (23개 항목)
bash scripts/verify-deployment.sh your-domain.com
```

---

## Tech Stack

| Category | Technology |
|----------|-----------|
| **IaC** | CDK v2 (TypeScript), Terraform ≥1.5, CloudFormation (YAML) |
| **Container** | Docker (Ubuntu 24.04 / AL2023, ARM64) |
| **Frontend** | Next.js 14 (App Router), Tailwind CSS, Recharts |
| **Auth** | Amazon Cognito + NextAuth.js |
| **AI** | Bedrock Claude (Opus 4.6, Sonnet 4.6, Haiku 4.5) |
| **Agent** | AgentCore Runtime + Gateway, Strands SDK |
| **Proxy** | LiteLLM (17 model aliases, budget tracking) |
| **Dev Tools** | code-server, Claude Code CLI, Kiro CLI |
| **AWS Services** | ECS (EC2), ALB, CloudFront, RDS, ElastiCache Valkey, EFS, Route 53, KMS, Secrets Manager, CloudWatch |
| **Region** | ap-northeast-2 (Seoul) |

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Follow code conventions:
   - CDK: TypeScript, 5 Stack classes
   - Terraform: HCL, module-per-stack
   - CloudFormation: YAML, one template per stack
   - Docker: ARM64 (Graviton)
   - Dashboard: Next.js 14, Tailwind dark theme
4. Run tests: `bash tests/integration/test-e2e.sh`
5. Commit: conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
6. Submit a Pull Request

---

## License

MIT
