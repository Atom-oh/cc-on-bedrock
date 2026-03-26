# Scripts & Tests

## Scripts (`scripts/`)
- `create-ecr-repos.sh` - ECR 리포지토리 생성
- `verify-deployment.sh` - 배포 후 전체 서비스 검증 (23개 체크 항목)
- `create-test-users-30.sh` - 30명 테스트 유저 생성 (5개 부서)
- `generate-usage-data.py` - DynamoDB 사용량 시뮬레이션 데이터 생성

## Tests (`tests/`)
- `integration/test-e2e.sh` - 전체 E2E 테스트 (Docker, CDK, TF, CFN, Next.js, ShellCheck)
- `docker/test-devenv.sh` - DevEnv 컨테이너 통합 테스트

## Rules
- 모든 스크립트는 `set -euo pipefail`로 시작
- AWS CLI 호출 시 `--region` 파라미터 명시
- 테스트는 idempotent (반복 실행 가능)
