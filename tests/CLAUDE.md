# Tests Module

## Role
빠른 게이트, 단위 테스트, E2E 통합 테스트, Docker 컨테이너 테스트, Local Governance Mode E2E.

## Key Files
- `run-all.sh` - 빠른 게이트: Next.js `tsc --noEmit` + vitest, `pytest tests/unit scripts/__tests__ lambda/__tests__`, CLI 문법 검사, AMI 데이터 볼륨 정적 검사, PR-review panel stub, boundary 불변식 self-test, `terraform fmt -check`. 실제 AWS 호출은 없다.
- `unit/` - Python 단위 테스트 (nginx config-gen, usage-tracker pricing, Codex IAM parity, model ID 일관성, Terraform OTel/edge-auth 정적 검사 등) + 셸 단위 테스트
- `integration/test-e2e.sh` - 전체 E2E (Docker, Terraform, Next.js, ShellCheck)
- `integration/test-local-governance.sh` - Local Governance 시나리오: STS 자격증명 발급 → Bedrock 호출 → 토큰 한도 주입 → 1-3분 내 Deny 부착 → reset 검증 (ADR-006/008)
- `docker/test-devenv.sh` - DevEnv 컨테이너 통합 테스트

## Commands
```bash
bash tests/run-all.sh                                    # 빠른 게이트 (python3 -m pytest 필요)
bash tests/integration/test-e2e.sh                       # 전체 E2E
bash tests/integration/test-e2e.sh --skip-docker         # Docker 제외
bash tests/integration/test-e2e.sh --only-iac            # IaC 검증만
bash tests/docker/test-devenv.sh                         # 컨테이너 테스트

# Local Governance E2E (실제 AWS 환경 필요)
DASHBOARD_URL=https://<dashboard_subdomain>.<domain> \
  COGNITO_ACCESS_TOKEN=<token-from-cc-bedrock-local-client> \
  TEST_USER_EMAIL=<email> \
  TEST_USER_SUBDOMAIN=<subdomain> \
  TEST_USER_DEPT=<dept> \
  bash tests/integration/test-local-governance.sh
```

## Conventions
- 테스트는 반복 실행해도 같은 결과가 나오도록 idempotent하게 작성한다.
- 셸 테스트는 `run_test` 함수로 결과를 모으고 마지막에 summary를 출력한다.
- Local Governance E2E는 실제 Bedrock 호출과 IAM 변경을 일으키므로 격리된 테스트 사용자 email/subdomain으로 실행한다.
- `POLL_TIMEOUT_SECONDS`로 Deny 부착 대기 시간을 조정한다 (기본 300s). `ADMIN_TOKEN`을 주면 reset 단계까지 검증한다.
- `tests/docker/test-litellm.sh`는 제거된 LiteLLM 경로의 잔재다.
