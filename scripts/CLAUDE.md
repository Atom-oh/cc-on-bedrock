# Scripts Module

## Role
Terraform-only deployment helpers, AMI build scripts, verification scripts, and test data utilities.

## Deployment Guide
- `00-check-prerequisites.sh` - 사전 조건 점검 (CLI tools, AWS credentials, Bedrock access, Route 53, Terraform)
- `01-create-ecr-repos.sh` - ECR 리포지토리 생성 (devenv, dashboard, nginx) + lifecycle policy
- Terraform root: `terraform -chdir=terraform init && terraform -chdir=terraform plan`
- `04-setup-cognito-auth.sh` - Cognito 설정 (native/SAML/OIDC), admin 유저 생성, SSM 파라미터
- `05-build-docker-images.sh` - ARM64 Docker 이미지 빌드 (devenv Ubuntu/AL2023 + dashboard)
- `07-build-ami.sh` - AMI 빌드 wrapper (ubuntu/al2023/both), `build-ami.sh` 호출
- `08-verify-deployment.sh` - 배포 후 인프라 검증

## Standalone Scripts
- `build-ami.sh` - AMI 빌드 본체 (EC2 launch → SSM setup → AMI create → SSM param update, ubuntu/al2023 지원)
- `verify-deployment.sh` - E2E 운영 검증 (CloudFront, ECS, DynamoDB, Cognito, ECR, AMI, Lambda, IAM, Bedrock)
- `validate-deployment.sh` - 보안 중심 검증 (IMDS block, per-user IAM, nginx routing, CloudFront)

## Test Data
- `create-test-users-30.sh` - 30명 테스트 유저 생성 (5개 부서) — 하드코딩 도메인 주의
- `create-enterprise-test-data.sh` - 엔터프라이즈 테스트 데이터
- `generate-usage-data.py` - DynamoDB 사용량 시뮬레이션 데이터 생성
- `seed-mcp-catalog.py` - MCP 서버 카탈로그 시드 데이터

## ADR-026 (IAM 권한 신청/승인)
- `check-policyset-boundary.py` - CI 불변식: `cc-on-bedrock-task-boundary` deny floor와 request validator의 위험 액션 판정 정합성. `--self-test` 픽스처. `tests/run-all.sh` 가 호출.
- `reconcile-iam-grants-to-local.py` - 기존 EC2-only 부여분(Grant-*/PolicySet-*)을 대응 Local 역할에 소급 복사 (dry-run 기본, `--apply`). subdomain→sub 는 Cognito 매핑.

## Utility
- (없음 — IAM role 태그는 ec2-clients.ts에서 매 시작 시 자동 upsert)

## Rules
- 모든 스크립트는 `set -euo pipefail`로 시작
- AWS CLI 호출 시 `--region` 파라미터 명시
- 실패 시 명확한 에러 메시지 출력
- 번호 스크립트는 보조 도구이며, 배포의 기준 순서는 Terraform plan/apply이다.
