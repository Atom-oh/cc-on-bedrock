# Docker Module

## Role
Docker 이미지 빌드 및 관리. devenv (Ubuntu/AL2023) 개발환경 이미지 → AMI 베이킹에 사용.

## Key Files
- `devenv/Dockerfile.ubuntu` - Ubuntu 24.04 ARM64 개발환경
- `devenv/Dockerfile.al2023` - Amazon Linux 2023 ARM64 개발환경
- `devenv/scripts/entrypoint.sh` - CLAUDE_CODE_USE_BEDROCK=1 설정, Kiro config, code-server DLP 보안 정책 적용
- `devenv/scripts/setup-common.sh` - 공통 설치 (Node.js, Python, AWS CLI)
- `devenv/scripts/setup-claude-code.sh` - Claude Code CLI 설치
- `devenv/scripts/setup-kiro.sh` - Kiro CLI 설치
- `devenv/scripts/s3-sync.sh` - S3 배포 아티팩트 동기화
- `devenv/scripts/sync-mcp-config.sh` - EC2 부팅 시 DDB에서 MCP Gateway URL 읽어 `mcp_servers.json` 생성 (ADR-007)
- `devenv/systemd/cc-mcp-sync.service` - MCP config 동기화 systemd 서비스 (부팅 시 실행)
- `devenv/config/extensions.txt` - code-server 기본 확장 목록
- `devenv/config/settings.json` - code-server 기본 설정
- `otel-collector/` - OpenTelemetry Collector (contrib) image for native Claude Code OTEL (ADR-009 P1). Receives OTLP/HTTP :4318 (gRPC unreliable over the L4 NLB — not used). `config.yaml`: metrics + logs pipelines → `awss3` (S3 `otlp-metrics/`·`otlp-logs/`). **logs pipeline DLP-scrubs** — keeps only records carrying a `tool_name` attribute (`tool_result`/`tool_decision`; `event.name`-based filtering doesn't work since OTLP puts the event name in the LogRecord's `event_name` field, not attributes), lifts `skill_name`/`subagent_type`, then `keep_keys` allowlist (break-closed: drops `tool_parameters`/`tool_input`/`prompt`/content). Bucket/region via `${env:...}`.
- `litellm/` - LiteLLM proxy (deprecated, 제거 예정)
- `build.sh` - ECR 빌드/푸시 스크립트

## Rules
- ARM64 (aarch64) 타겟으로 빌드
- code-server는 entrypoint.sh에서 SECURITY_POLICY 환경변수로 DLP 적용
- AMI 빌드: `scripts/build-ami.sh` 에서 Docker 이미지 기반 EC2 설정 후 AMI 생성
