# Docker Module

## Role
Docker 이미지 빌드. devenv 이미지(Ubuntu/AL2023)는 AMI 베이킹에 쓰이고, dashboard·nginx·otel-collector 이미지는 ECR로 push되어 각각 대시보드 EC2 ASG와 ECS Fargate에서 실행된다.

## Key Files
- `devenv/Dockerfile.ubuntu` - Ubuntu 24.04 ARM64 개발환경
- `devenv/Dockerfile.al2023` - Amazon Linux 2023 ARM64 개발환경
- `devenv/scripts/entrypoint.sh` - `CLAUDE_CODE_USE_BEDROCK=1`, Kiro config, `SECURITY_POLICY`(open/restricted/locked)에 따른 code-server DLP 적용, `/etc/codex/config.toml` 생성(provider `amazon-bedrock-runtime`, region, `CODEX_MODEL_ID`, analytics off; ADR-014)
- `devenv/scripts/setup-common.sh` - 공통 설치 (Node.js, Python, AWS CLI)
- `devenv/scripts/setup-claude-code.sh` / `setup-kiro.sh` / `setup-codex.sh` - Claude Code, Kiro, Codex CLI 설치 (`@openai/codex`를 `CODEX_CLI_VERSION`으로 고정 설치; `shared/nextjs-app/src/lib/codex-model.ts`와 버전 일치 유지)
- `devenv/scripts/s3-sync.sh` - S3 배포 아티팩트 동기화
- `devenv/scripts/sync-mcp-config.sh` + `devenv/systemd/cc-mcp-sync.service` - 부팅 시 DynamoDB에서 MCP Gateway URL을 읽어 `mcp_servers.json` 생성 (MCP Gateway는 BASELINE 범위 밖 — history/brainstorm)
- `devenv/config/extensions.txt`, `devenv/config/settings.json` - code-server 기본 확장/설정
- `dashboard/Dockerfile` - Next.js standalone 대시보드 이미지 (빌드 컨텍스트 = repo root)
- `nginx/` - DevEnv 라우터 이미지 (`deployment_mode = "devenv"`에서만 배포) (`nginx.conf.template`, `reload.sh`)
- `otel-collector/` - OpenTelemetry Collector (contrib), 네이티브 Claude Code OTel 수집 (ADR-009). `deployment_mode = "devenv"`에서만 배포된다. OTLP/HTTP :4318만 사용(L4 NLB 위 gRPC는 불안정). `config.yaml`의 metrics/logs 파이프라인 → `awss3`(S3 `otlp-metrics/`, `otlp-logs/`). logs 파이프라인은 DLP scrub을 한다: `tool_name` 속성이 있는 레코드(`tool_result`/`tool_decision`)만 남기고, `skill_name`/`subagent_type`을 끌어올린 뒤 `keep_keys` allowlist로 `tool_parameters`/`tool_input`/`prompt`/본문을 버린다(break-closed). `event.name` 기반 필터는 동작하지 않는다 — OTLP는 이벤트 이름을 attribute가 아닌 LogRecord `event_name` 필드에 둔다. 버킷/리전은 `${env:...}`.
- `build.sh` - 빌드/푸시 스크립트: `bash docker/build.sh [build|push|all] [devenv-ubuntu|devenv-al2023|dashboard|otel-collector]`. dashboard 타깃은 immutable `IMAGE_TAG`가 필요하다.

## Notes
Local checks from the repository root:

```bash
for task_script in docker/build.sh docker/devenv/scripts/*.sh docker/nginx/reload.sh; do
  bash -n "$task_script" || exit
done
IMAGE_TAG=local-check bash docker/build.sh build dashboard
```

The image build requires Docker/Buildx and installed dependencies; container
integration uses `bash tests/docker/test-devenv.sh`. Syntax checking alone does
not prove image/runtime behavior.

- 모든 이미지는 ARM64(aarch64) 대상이다 (Graviton).
- `build.sh`의 `all` 타깃은 아직 삭제된 `litellm/` 이미지를 포함하므로 실패한다. 개별 타깃을 쓰거나 `scripts/05-build-docker-images.sh`를 사용한다.
- AMI는 `scripts/build-ami.sh`가 임시 EC2에서 setup 스크립트를 실행해 만든다.
- `entrypoint.sh`에는 과거 ECS/EFS 컨테이너 경로(`STORAGE_TYPE=efs`) 코드가 남아 있다. 현재 DevEnv는 EC2 + 2-볼륨 EBS(ADR-002)다.
