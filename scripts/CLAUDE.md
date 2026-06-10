# Scripts Module

## Role
순서 기반 배포 가이드(00-08), AMI 빌드, 검증, 테스트 데이터 생성 등 운영 스크립트.

## Deployment Guide (순서대로 실행)
- `00-check-prerequisites.sh` - 사전 조건 점검 (CLI tools, AWS credentials, Bedrock access, Route 53)
- `01-create-ecr-repos.sh` - ECR 리포지토리 생성 (devenv, dashboard, nginx) + lifecycle policy
- `02-cdk-bootstrap.sh` - CDK bootstrap (primary region + us-east-1 for WAF)
- `03-deploy-base-stacks.sh` - Network + Security 스택 배포
- `04-setup-cognito-auth.sh` - Cognito 설정 (native/SAML/OIDC), admin 유저 생성, SSM 파라미터
- `05-build-docker-images.sh` - ARM64 Docker 이미지 빌드 (devenv Ubuntu/AL2023 + dashboard)
- `06-deploy-service-stacks.sh` - 나머지 5개 CDK 스택 순차 배포
- `07-build-ami.sh` - AMI 빌드 wrapper (ubuntu/al2023/both), `build-ami.sh` 호출
- `08-verify-deployment.sh` - 배포 후 인프라 검증 (8개 카테고리)

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
- `check-policyset-boundary.py` - CI 불변식: `cc-on-bedrock-task-boundary` ⊇ 신청가능 서비스(DEFAULT_SERVICE_ALLOWLIST) **및** wildcard-ok 액션 커버(action-level). cdk synth JSON vs TS 비교. `--self-test` 픽스처. `tests/run-all.sh` 가 호출.
- `reconcile-iam-grants-to-local.py` - 기존 EC2-only 부여분(Grant-*/PolicySet-*)을 대응 Local 역할에 소급 복사 (dry-run 기본, `--apply`). subdomain→sub 는 Cognito 매핑.

## Utility
- (없음 — IAM role 태그는 ec2-clients.ts에서 매 시작 시 자동 upsert)

## Rules
- 모든 스크립트는 `set -euo pipefail`로 시작
- AWS CLI 호출 시 `--region` 파라미터 명시
- 실패 시 명확한 에러 메시지 출력
- 번호 스크립트는 순서대로 실행 (각 스크립트 끝에 "Next: ./0N-..." 안내 표시)
