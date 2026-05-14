# Tests Module

## Role
E2E 통합 테스트, Docker 컨테이너 테스트, Next.js 단위 테스트.

## Key Files
- `integration/test-e2e.sh` - 전체 E2E 테스트 (Docker, CDK, TF, CFN, Next.js, ShellCheck)
- `integration/test-mcp-gateway.sh` - MCP Gateway E2E 테스트 (ADR-007, 41 checks)
- `docker/test-devenv.sh` - DevEnv 컨테이너 통합 테스트
- `../shared/nextjs-app/src/lib/__tests__/` - Dashboard 단위 테스트 (vitest)

## Commands
```bash
# E2E / Integration
bash tests/integration/test-e2e.sh              # 전체 E2E
bash tests/integration/test-e2e.sh --skip-docker # Docker 제외
bash tests/integration/test-e2e.sh --only-iac    # IaC만
bash tests/integration/test-mcp-gateway.sh       # MCP Gateway E2E (41 checks)
bash tests/docker/test-devenv.sh                 # 컨테이너 테스트

# Dashboard Unit Tests (vitest)
cd shared/nextjs-app && npx vitest run           # 전체 실행
cd shared/nextjs-app && npx vitest run --reporter=verbose  # 상세

# Type Check
cd shared/nextjs-app && npx tsc --noEmit         # TypeScript 타입 검증
cd cdk && npx tsc --noEmit                       # CDK 타입 검증
```

## Rules
- 테스트는 idempotent (반복 실행 가능)
- `run_test` 함수로 결과 수집, 마지막에 summary 출력
- CI: GitHub Actions `ci.yml`에서 PR마다 자동 실행
