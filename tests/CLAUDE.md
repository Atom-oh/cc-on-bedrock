# Tests Module

## Role
E2E 통합 테스트, Docker 컨테이너 테스트, Local Governance Mode E2E.

## Key Files
- `integration/test-e2e.sh` - 전체 E2E 테스트 (Docker, CDK, TF, CFN, Next.js, ShellCheck)
- `integration/test-local-governance.sh` - Local Governance Mode 시나리오 (STS 자격증명 발급 → Bedrock 호출 → 토큰한도 주입 → 1-3분 내 Deny 부착 → reset 검증, ADR-014/015)
- `docker/test-devenv.sh` - DevEnv 컨테이너 통합 테스트

## Commands
```bash
bash tests/integration/test-e2e.sh                       # 전체 E2E
bash tests/integration/test-e2e.sh --skip-docker         # Docker 제외
bash tests/integration/test-e2e.sh --only-iac            # IaC만
bash tests/docker/test-devenv.sh                         # 컨테이너 테스트

# Local Governance E2E (실제 AWS 환경 필요)
DASHBOARD_URL=https://cconbedrock-dashboard.<domain> \
  CC_BEDROCK_TOKEN=<token> \
  TEST_USER_SUB=<cognito-sub> \
  TEST_USER_DEPT=<dept> \
  bash tests/integration/test-local-governance.sh
```

## Rules
- 테스트는 idempotent (반복 실행 가능)
- `run_test` 함수로 결과 수집, 마지막에 summary 출력
- Local Governance 테스트는 실제 Bedrock 호출과 IAM 변경이 일어남 — 격리된 테스트 사용자 sub로 실행할 것
- `POLL_TIMEOUT_SECONDS` 환경변수로 Deny 부착 대기 시간 조정 (기본 300s)
- 옵션 `ADMIN_TOKEN` 지정 시 reset 단계까지 검증
