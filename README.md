# CC-on-Bedrock

AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼.

CDK(TypeScript), Terraform(HCL), CloudFormation(YAML) 3가지 IaC로 동일 아키텍처를 배포합니다.

## Architecture

- **LiteLLM Proxy:** EC2 ASG x2 → Bedrock (Opus 4.6 / Sonnet 4.6)
- **ECS Dev Environment:** code-server + Claude Code + Kiro (Ubuntu/AL2023 선택)
- **Next.js Dashboard:** 사용자 관리, 사용량 분석, 컨테이너 제어
- **Authentication:** Amazon Cognito
- **Region:** ap-northeast-2 (Seoul)

## Quick Start

### 1. Docker Images

```bash
# Create ECR repositories
bash scripts/create-ecr-repos.sh

# Build and push all images
cd docker && bash build.sh all all
```

### 2. Deploy Infrastructure

Choose one of:

```bash
# CDK
cd cdk && npm install && cdk deploy --all

# Terraform
cd terraform && terraform init && terraform apply

# CloudFormation
cd cloudformation && bash deploy.sh
```

## Documentation

- [Architecture Design Spec](docs/superpowers/specs/2026-03-19-cc-on-bedrock-design.md)
- [Implementation Plans](docs/superpowers/plans/)

## License

MIT
