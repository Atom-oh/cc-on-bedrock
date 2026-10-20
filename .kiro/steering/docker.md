# Docker Module

## Role
Docker 이미지 빌드. devenv(Ubuntu/AL2023) 이미지는 AMI 베이킹용이고, dashboard·nginx·otel-collector 이미지는 ECR로 push된다. 상세는 `docker/CLAUDE.md`.

## Key Files
- `devenv/Dockerfile.ubuntu`, `devenv/Dockerfile.al2023` - ARM64 개발환경
- `devenv/scripts/entrypoint.sh` - `CLAUDE_CODE_USE_BEDROCK=1`, Kiro config, `SECURITY_POLICY` DLP, `/etc/codex/config.toml`
- `devenv/scripts/setup-*.sh` - 공통 도구, Claude Code, Kiro, Codex CLI 설치
- `dashboard/`, `nginx/`, `otel-collector/` - 대시보드, DevEnv 라우터, 네이티브 OTel collector 이미지
- `build.sh` - `[build|push|all] [devenv-ubuntu|devenv-al2023|dashboard|otel-collector]` (dashboard는 immutable `IMAGE_TAG` 필요)

## Notes
- ARM64(aarch64) 대상으로 빌드한다.
- DLP 정책은 `SECURITY_POLICY`(open/restricted/locked)로 적용된다.
- LiteLLM 이미지는 제거되었다.
