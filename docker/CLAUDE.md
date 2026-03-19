# Docker Module

## Role
Docker 이미지 빌드 및 관리. devenv (Ubuntu/AL2023) + LiteLLM proxy 이미지.

## Key Files
- `devenv/Dockerfile.ubuntu` - Ubuntu 24.04 ARM64 개발환경
- `devenv/Dockerfile.al2023` - Amazon Linux 2023 ARM64 개발환경
- `devenv/scripts/entrypoint.sh` - DLP 보안 정책 적용 + code-server 시작
- `devenv/scripts/setup-common.sh` - 공통 설치 (Node.js, Python, AWS CLI)
- `litellm/Dockerfile` - LiteLLM proxy (Secrets Manager 연동)
- `build.sh` - ECR 빌드/푸시 스크립트

## Rules
- ARM64 (aarch64) 타겟으로 빌드
- code-server는 entrypoint.sh에서 SECURITY_POLICY 환경변수로 DLP 적용
- LiteLLM config는 envsubst로 환경변수 치환
