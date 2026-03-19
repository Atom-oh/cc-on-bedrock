# CC-on-Bedrock

AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼.

CDK(TypeScript), Terraform(HCL), CloudFormation(YAML) 3가지 IaC로 동일 아키텍처를 배포합니다.

## Architecture Overview

5개의 독립적인 스택/모듈로 구성된 멀티유저 개발 플랫폼입니다.

```
Users (Browser)
  |
  +-- dashboard.example.com --> CloudFront --> ALB --> Next.js Dashboard
  |                                                     |-- Cognito (사용자 관리)
  |                                                     |-- ECS (컨테이너 제어)
  |                                                     +-- LiteLLM (사용량 조회)
  |
  +-- user01.dev.example.com --> CloudFront --> ALB --> ECS Task (code-server)
                                                         |-- Claude Code --> LiteLLM --> Bedrock
                                                         |-- Kiro
                                                         +-- EFS (영구 스토리지)
```

| Stack | 설명 | 주요 리소스 |
|-------|------|-------------|
| 01 Network | 네트워크 기반 | VPC, Subnets (3-tier), NAT GW x2, VPC Endpoints x8, Route 53 |
| 02 Security | 인증/보안 | Cognito User Pool, ACM 인증서, KMS, Secrets Manager, IAM Roles |
| 03 LiteLLM | AI 프록시 | EC2 ASG x2 (Internal ALB), RDS PostgreSQL, Serverless Valkey |
| 04 ECS DevEnv | 개발환경 | ECS Cluster (EC2 mode), 6 Task Defs, EFS, ALB, CloudFront |
| 05 Dashboard | 관리 대시보드 | Next.js 14, EC2 ASG, ALB, CloudFront |

### Models

- **Opus 4.6**: `global.anthropic.claude-opus-4-6-v1[1m]` (cross-region inference)
- **Sonnet 4.6**: `global.anthropic.claude-sonnet-4-6[1m]` (cross-region inference)

### Bedrock Access Paths

| 경로 | 용도 | 사용량 추적 |
|------|------|:---:|
| Claude Code -> LiteLLM (Internal ALB) -> Bedrock | Primary | O |
| SDK/boto3 -> Task Role IAM -> Bedrock VPC Endpoint | Secondary (개발) | X |
| Claude Code -> Task Role IAM -> Bedrock | Fallback (LiteLLM 장애 시) | X |

---

## Quick Start

### 1. Prerequisites

```bash
# 필수 도구 확인
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

#### CDK (TypeScript)
```bash
cd cdk
npm install
cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-2
cdk deploy --all -c domainName=your-domain.com
```

#### Terraform (HCL)
```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# terraform.tfvars에서 domain_name 수정
terraform init && terraform apply
```

#### CloudFormation (YAML)
```bash
cd cloudformation
# params/default.json에서 DomainName 수정
bash deploy.sh
```

### 4. Post-Deploy

```bash
# 배포 검증
bash scripts/verify-deployment.sh your-domain.com

# 첫 관리자 계정 생성 (docs/deployment-guide.md 참조)
```

### 5. Access

- Dashboard: `https://dashboard.your-domain.com`
- Dev Environment: `https://<subdomain>.dev.your-domain.com`

---

## Project Structure

```
cc-on-bedrock/
|-- docker/                          # Docker images
|   |-- devenv/                      #   code-server + Claude Code + Kiro
|   |   |-- Dockerfile.ubuntu        #     Ubuntu 24.04 base
|   |   |-- Dockerfile.al2023        #     Amazon Linux 2023 base
|   |   |-- scripts/                 #     Setup & entrypoint scripts
|   |   +-- config/                  #     VS Code settings & extensions
|   +-- litellm/                     #   LiteLLM proxy
|       |-- Dockerfile               #     Based on ghcr.io/berriai/litellm
|       |-- litellm-config.yaml      #     Model & router config template
|       +-- scripts/entrypoint.sh    #     Secrets fetch + startup
|
|-- cdk/                             # AWS CDK (TypeScript)
|   |-- bin/app.ts                   #   Stack composition
|   |-- config/default.ts            #   Typed configuration
|   +-- lib/                         #   5 Stack classes (01-05)
|
|-- terraform/                       # Terraform (HCL)
|   |-- main.tf                      #   Root module wiring
|   |-- variables.tf / outputs.tf    #   Variables & outputs
|   |-- providers.tf                 #   AWS provider
|   |-- terraform.tfvars.example     #   Example variables
|   +-- modules/                     #   5 modules (network/security/litellm/ecs-devenv/dashboard)
|
|-- cloudformation/                  # CloudFormation (YAML)
|   |-- 01-network.yaml              #   5 templates
|   |-- 02-security.yaml
|   |-- 03-litellm.yaml
|   |-- 04-ecs-devenv.yaml
|   |-- 05-dashboard.yaml
|   |-- deploy.sh / destroy.sh       #   Deploy & teardown scripts
|   +-- params/default.json          #   Default parameters
|
|-- shared/                          # Shared components
|   +-- nextjs-app/                  #   Next.js 14 Dashboard
|       |-- src/app/                 #     App Router pages & API routes
|       |-- src/components/          #     UI components (charts, tables, sidebar)
|       +-- src/lib/                 #     Auth, AWS clients, LiteLLM client
|
|-- scripts/                         # Utility scripts
|   |-- create-ecr-repos.sh          #   ECR repository setup
|   +-- verify-deployment.sh         #   Post-deploy health check
|
|-- tests/                           # Tests
|   |-- docker/                      #   Docker container tests
|   +-- integration/                 #   E2E integration tests
|
+-- docs/                            # Documentation
    |-- deployment-guide.md          #   Step-by-step deployment (Korean)
    |-- iac-comparison.md            #   CDK vs Terraform vs CloudFormation (Korean)
    |-- architecture.md              #   Mermaid architecture diagrams
    +-- superpowers/                 #   Design specs & plans
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
| **Total (excl. Bedrock)** | | **~$1,500-1,530/month** |

> Bedrock 비용은 사용량에 따라 별도 과금됩니다.
> ECS ASG Min:0 설정으로 비활동 시 ECS Host 비용 절감 가능.

### Production (100 users)

| Change | Estimated Total |
|--------|:---:|
| ECS Host ~15x m7g.4xlarge, Multi-AZ RDS | **~$10,200-10,500/month** |

---

## Documentation

| Document | Description |
|----------|-------------|
| [Deployment Guide](docs/deployment-guide.md) | 전체 배포 가이드 (Korean) |
| [IaC Comparison](docs/iac-comparison.md) | CDK / Terraform / CloudFormation 비교 (Korean) |
| [Architecture Diagrams](docs/architecture.md) | Mermaid 아키텍처 다이어그램 |
| [Design Specification](docs/superpowers/specs/2026-03-19-cc-on-bedrock-design.md) | 상세 설계 문서 |
| [Implementation Plans](docs/superpowers/plans/) | 구현 계획 (Plan 1-5) |

---

## Testing

```bash
# Docker container tests
bash tests/docker/test-devenv.sh
bash tests/docker/test-litellm.sh
bash tests/docker/test-scripts.sh

# E2E integration tests (IaC validation + Docker + Next.js)
bash tests/integration/test-e2e.sh

# Post-deployment verification
bash scripts/verify-deployment.sh your-domain.com
```

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make changes following the existing code style:
   - CDK: TypeScript, 5 Stack classes in `lib/`
   - Terraform: HCL, module-per-stack in `modules/`
   - CloudFormation: YAML, one template per stack
   - Docker: ARM64 (Graviton) images
4. Run tests: `bash tests/integration/test-e2e.sh`
5. Commit with conventional commit messages: `feat:`, `fix:`, `docs:`, `test:`
6. Submit a Pull Request

### Commit Message Convention

```
feat: add new feature
fix: fix bug
docs: update documentation
test: add/update tests
refactor: code refactoring
chore: build/tooling changes
```

---

## License

MIT
