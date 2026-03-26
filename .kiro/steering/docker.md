# Docker Module

## Role
Docker 이미지 빌드 및 관리. devenv (Ubuntu/AL2023) 개발환경 이미지.

## Key Files
- `devenv/Dockerfile.ubuntu` - Ubuntu 24.04 ARM64 개발환경
- `devenv/Dockerfile.al2023` - Amazon Linux 2023 ARM64 개발환경
- `devenv/scripts/entrypoint.sh` - CLAUDE_CODE_USE_BEDROCK=1, Kiro config, DLP 보안 정책
- `devenv/scripts/setup-common.sh` - 공통 설치 (Node.js, Python, AWS CLI)
- `litellm/` - LiteLLM proxy (deprecated, 제거 예정)
- `build.sh` - ECR 빌드/푸시 스크립트

## Rules
- ARM64 (aarch64) 타겟으로 빌드
- SECURITY_POLICY 환경변수로 DLP 적용 (open/restricted/locked)
