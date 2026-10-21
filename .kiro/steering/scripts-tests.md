# Scripts & Tests

상세는 `scripts/CLAUDE.md`, `tests/CLAUDE.md`.

## Scripts (`scripts/`)
- `00-check-prerequisites.sh` - 사전 조건 점검
- `01-create-ecr-repos.sh` - Terraform 밖의 ECR 리포지토리(devenv, nginx) 생성
- `05-build-docker-images.sh` - ARM64 이미지 빌드/푸시 (dashboard는 immutable `IMAGE_TAG`)
- `build-ami.sh <ubuntu|al2023>` - DevEnv AMI 빌드 + SSM 등록
- `verify-deployment.sh <domain>` - 배포 후 전체 서비스 검증
- `check-policyset-boundary.py --self-test` - permission boundary ↔ IAM 신청 validator 정합성
- `create-test-users-30.sh`, `generate-usage-data.py` - 테스트 데이터

## Tests (`tests/`)
- `run-all.sh` - 빠른 게이트 (tsc + vitest, pytest, boundary 불변식, `terraform fmt -check`)
- `integration/test-e2e.sh` - 전체 E2E (Docker, Terraform, Next.js, ShellCheck)
- `integration/test-local-governance.sh` - Local Governance E2E (실제 AWS 필요)
- `docker/test-devenv.sh` - DevEnv 컨테이너 테스트

## Conventions
- 셸 스크립트는 `set -euo pipefail`을 쓰고, AWS CLI 호출에는 `--region`을 명시한다.
- 테스트는 반복 실행 가능하게(idempotent) 작성한다.
