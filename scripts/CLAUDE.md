# Scripts Module

## Role
Terraform 배포를 돕는 보조 스크립트, AMI 빌드, 배포 검증, 테스트 데이터 유틸리티. 배포의 기준 순서는 Terraform plan/apply이고, 번호 스크립트는 그 앞뒤를 돕는 도구다.

## Deployment helpers
- `00-check-prerequisites.sh` - 사전 조건 점검 (CLI 도구, AWS 자격 증명, Bedrock 접근, Route 53, Terraform)
- `01-create-ecr-repos.sh` - Terraform 밖의 ECR 리포지토리(devenv, nginx) 생성 + lifecycle policy. dashboard ECR은 Terraform 소유다.
- `04-setup-cognito-auth.sh` - Cognito 설정 (native/SAML/OIDC), admin 사용자 생성, SSM 파라미터 기록
- `05-build-docker-images.sh [all|devenv|dashboard]` - ARM64 이미지 빌드/푸시. dashboard는 immutable `IMAGE_TAG`가 필요하고, Terraform이 dashboard ECR repo를 먼저 만들어 두어야 한다.
- `07-build-ami.sh` - AMI 빌드 wrapper (ubuntu/al2023/both) → `build-ami.sh`
- `08-verify-deployment.sh` - 배포 후 인프라 검증

## Standalone
- `build-ami.sh <ubuntu|al2023>` - AMI 빌드 본체 (임시 EC2 → SSM setup → AMI 생성 → SSM 파라미터 갱신)
- `verify-deployment.sh <domain> [--region <region>]` - 운영 검증 (CloudFront, ECS, DynamoDB, Cognito, ECR, AMI, Lambda, IAM, Bedrock)
- `validate-deployment.sh` - 보안 중심 검증 (IMDS 차단, per-user IAM, nginx routing, CloudFront)

## IAM 권한 신청/승인 (ADR-007)
- `check-policyset-boundary.py` - 불변식 검사: `cc-on-bedrock-task-boundary` deny floor와 request validator의 위험 액션 판정이 일치하는지 확인. `--self-test` 픽스처를 `tests/run-all.sh`가 실행한다.
- `reconcile-iam-grants-to-local.py` - 기존 EC2 전용 부여분(Grant-*/PolicySet-*)을 대응 Local 역할로 소급 복사. 기본 dry-run, `--apply`로 실행. subdomain→sub는 Cognito 매핑을 쓴다.

## Test data and one-off migrations
- `create-test-users-30.sh` (5개 부서 30명; 도메인이 하드코딩되어 있으니 실행 전 확인), `create-enterprise-test-data.sh`, `generate-usage-data.py`, `seed-mcp-catalog.py`
- `migrate_usage_to_email.py`, `migrate-adr025-usage-to-sub.py`, `backfill-local-user-roles.sh`, `cleanup-stale-budget-users.py` - 과거 마이그레이션/정리용. 새 작업의 기반으로 삼지 않는다.
- IAM role 태그는 `ec2-clients.ts`가 인스턴스 시작마다 upsert하므로 별도 스크립트가 없다.

## Conventions
- 셸 스크립트는 `set -euo pipefail`을 쓴다.
- AWS CLI 호출에는 `--region`을 명시한다 (기본 리전에 의존하면 다른 계정/리전에서 깨진다).
- 실패 시 원인과 다음 조치를 알려주는 에러 메시지를 출력한다.

## PR review
CI runs a Codex lens panel (`global.openai.gpt-6.1-sol`, one cell per lens) and then a Claude Opus 5.5 chair VERDICT (`ROLE_REVIEW=0`, ADR-013 amendment 2026-10-21). The specialist protocol is retained behind `ROLE_REVIEW=1`. Offline checks and the provider/custody rules belong to `pr-review/CLAUDE.md` and `pr-review/README.md`.
